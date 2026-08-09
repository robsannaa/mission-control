/**
 * Gateway RPC channel — the control plane Mission Control actually runs on.
 *
 * The gateway's RPC surface is a WebSocket protocol, not an HTTP one. It used
 * to be reached through the HTTP transport, which meant a failure of the
 * unrelated `POST /tools/invoke` probe disabled config, sessions, cron, usage
 * and skills across the whole dashboard. Current OpenClaw denies `exec` on
 * that HTTP endpoint by default, so that probe now fails on every healthy
 * install. RPC therefore owns its own connection and its own health here.
 *
 * Order of preference:
 *   1. Direct WebSocket RPC (fast, no subprocess).
 *   2. `openclaw gateway call <method>` (slower, but has the CLI's own auth and
 *      works when the dashboard cannot authenticate as a local operator).
 */

import { GatewayRpcClient, GatewayRpcError } from "./gateway-rpc";
import { invalidateGatewayToken } from "./paths";

/** Cooldown before retrying the WebSocket path after a transport failure. */
const WS_RETRY_COOLDOWN_MS = 15_000;

/**
 * Whether a failure means "we never reached the gateway" (worth falling back to
 * the CLI) rather than "the gateway answered with an error" (the CLI would
 * return the same error, so don't pay for a subprocess).
 */
function isTransportFailure(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return true;
  // Errors the gateway itself produced carry its own machine-readable code.
  // MISSING_SCOPES is ours, and specifically means the CLI may do better.
  if (err.code && err.code !== "MISSING_SCOPES") return false;
  return true;
}

/**
 * Whether the gateway refused our shared-secret credentials. Distinct from a
 * transport failure: the gateway answered, but the cached token/password no
 * longer matches — typically because the user rotated `gateway.auth.token`
 * after this process memoized it. A live gateway rejects the connect with
 * `code: "INVALID_REQUEST"`, `message: "unauthorized: gateway token mismatch
 * (provide gateway auth token)"` and `details: { code: "AUTH_TOKEN_MISMATCH",
 * authReason: "token_mismatch", ... }`.
 */
function isAuthFailure(err: unknown): boolean {
  if (!(err instanceof GatewayRpcError)) return false;
  if (err.details && typeof err.details === "object") {
    const details = err.details as Record<string, unknown>;
    if (String(details.code || "").startsWith("AUTH_")) return true;
    if (String(details.authReason || "").includes("mismatch")) return true;
  }
  const msg = err.message.toLowerCase();
  return msg.includes("unauthorized") || msg.includes("token mismatch");
}

export class GatewayRpcChannel {
  private client: GatewayRpcClient | null = null;
  private wsUnavailableUntil = 0;
  private lastWsError: string | null = null;

  constructor(
    private readonly gatewayUrl?: string,
    private readonly token?: string,
  ) {}

  /** Human-readable reason the WebSocket path is currently skipped, if any. */
  getWsStatus(): { available: boolean; reason: string | null } {
    if (Date.now() < this.wsUnavailableUntil) {
      return { available: false, reason: this.lastWsError };
    }
    return { available: true, reason: null };
  }

  private getClient(): GatewayRpcClient {
    if (!this.client) {
      this.client = new GatewayRpcClient(this.gatewayUrl, this.token);
    }
    return this.client;
  }

  private markWsFailed(err: unknown): void {
    this.lastWsError = err instanceof Error ? err.message : String(err);
    this.wsUnavailableUntil = Date.now() + WS_RETRY_COOLDOWN_MS;
    // Drop the client so the next attempt reconnects from scratch.
    this.client = null;
  }

  /**
   * Call a gateway RPC method, preferring the WebSocket control plane and
   * falling back to the CLI when the socket path is unusable.
   */
  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 15_000,
  ): Promise<T> {
    const wsUsable = Date.now() >= this.wsUnavailableUntil;

    if (wsUsable) {
      try {
        return await this.requestOverWs<T>(method, params, timeout);
      } catch (err) {
        if (!isTransportFailure(err)) throw err;
        this.markWsFailed(err);
        console.warn(
          `[GatewayRpc] WebSocket RPC unavailable (${this.lastWsError}); falling back to \`openclaw gateway call\` for ${method}.`,
        );
      }
    }

    // CLI fallback. Imported lazily so the CLI module is only loaded when a
    // subprocess is actually needed.
    const { gatewayCall } = await import("./openclaw-cli");
    return gatewayCall<T>(method, params, timeout);
  }

  /**
   * One WebSocket attempt, plus a single retry with freshly-read credentials
   * when the gateway rejects our auth. The token is memoized process-wide, so
   * without this a `gateway.auth.token` rotation on disk would 401 every RPC
   * until the process restarts. A constructor-injected token cannot be
   * refreshed from disk, so those channels surface the failure unchanged.
   */
  private async requestOverWs<T>(
    method: string,
    params: Record<string, unknown>,
    timeout: number,
  ): Promise<T> {
    try {
      return await this.getClient().request<T>(method, params, timeout);
    } catch (err) {
      if (this.token || !isAuthFailure(err)) throw err;
      invalidateGatewayToken();
      // Drop the client so the reconnect picks up the re-read credentials.
      this.client = null;
      return await this.getClient().request<T>(method, params, timeout);
    }
  }
}

// ── Process-wide singleton ────────────────────────

let _channel: GatewayRpcChannel | null = null;

export function getGatewayRpcChannel(): GatewayRpcChannel {
  if (!_channel) _channel = new GatewayRpcChannel();
  return _channel;
}

/** Reset the singleton (for testing). */
export function resetGatewayRpcChannel(): void {
  _channel = null;
}
