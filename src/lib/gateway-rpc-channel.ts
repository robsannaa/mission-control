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

import { GatewayRpcClient, GatewayRpcError, type GatewayEventSink } from "./gateway-rpc";
import { invalidateGatewayToken } from "./paths";
import { childLogger } from "./logger";

const log = childLogger({ source: "GatewayRpc" });

/** Cooldown before retrying the WebSocket path after a transport failure. */
const WS_RETRY_COOLDOWN_MS = 15_000;

/**
 * How often a channel with live event subscribers checks that the socket is
 * still up. Events only arrive while a connection exists, and the RPC path
 * reconnects lazily — nobody would notice a dead socket until the next request.
 */
const EVENT_KEEPALIVE_MS = 3_000;

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

export type GatewayEventsStatus = {
  /** Whether pushed events are reaching us right now. */
  connected: boolean;
  /** How many consumers are listening. Zero means the keepalive is idle. */
  subscribers: number;
  connectedSince: number | null;
  lastEventAt: number | null;
  lastError: string | null;
};

export class GatewayRpcChannel {
  private client: GatewayRpcClient | null = null;
  private wsUnavailableUntil = 0;
  private lastWsError: string | null = null;

  /** Event fan-out state — see `subscribeEvents`. */
  private eventSinks = new Set<GatewayEventSink>();
  private detachClientSink: (() => void) | null = null;
  private keepAlive: ReturnType<typeof setInterval> | null = null;
  private eventsConnected = false;
  private eventsConnectedSince: number | null = null;
  private lastEventAt: number | null = null;
  private lastEventError: string | null = null;
  private connecting = false;

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
      // A fresh client is a fresh socket with no sinks on it. Re-bridge, or the
      // first transport hiccup would silently end event delivery for good.
      this.detachClientSink = this.client.addEventSink((event) => {
        this.lastEventAt = Date.now();
        if (event.event === "rpc.connected") {
          this.eventsConnected = true;
          this.eventsConnectedSince = Date.now();
          this.lastEventError = null;
        } else if (event.event === "rpc.disconnected") {
          this.eventsConnected = false;
          this.eventsConnectedSince = null;
          this.lastEventError = String(event.payload.reason ?? "socket closed");
        }
        for (const sink of this.eventSinks) {
          try {
            sink(event);
          } catch {
            this.eventSinks.delete(sink);
          }
        }
      });
    }
    return this.client;
  }

  private markWsFailed(err: unknown): void {
    this.lastWsError = err instanceof Error ? err.message : String(err);
    this.wsUnavailableUntil = Date.now() + WS_RETRY_COOLDOWN_MS;
    // Drop the client so the next attempt reconnects from scratch.
    this.detachClientSink?.();
    this.detachClientSink = null;
    this.client = null;
    this.eventsConnected = false;
    this.eventsConnectedSince = null;
  }

  /* ── pushed events ──────────────────────────────── */

  /**
   * Listen to everything the gateway pushes on this connection.
   *
   * There is no subscribe RPC: `task`, `agent` and `chat` events reach any
   * authenticated operator connection automatically. What this adds is the part
   * the request path never needed — keeping the socket up. Returns an
   * unsubscribe; the keepalive stops when the last consumer leaves.
   */
  subscribeEvents(sink: GatewayEventSink): () => void {
    this.eventSinks.add(sink);
    this.startKeepAlive();
    return () => {
      this.eventSinks.delete(sink);
      if (this.eventSinks.size === 0) this.stopKeepAlive();
    };
  }

  getEventsStatus(): GatewayEventsStatus {
    return {
      connected: this.eventsConnected && this.getClient().isConnected(),
      subscribers: this.eventSinks.size,
      connectedSince: this.eventsConnectedSince,
      lastEventAt: this.lastEventAt,
      lastError: this.lastEventError,
    };
  }

  private startKeepAlive(): void {
    if (this.keepAlive) return;
    void this.pokeConnection();
    this.keepAlive = setInterval(() => void this.pokeConnection(), EVENT_KEEPALIVE_MS);
    // Node keeps the process alive for pending timers; a background reconnect
    // loop is not a reason to hold a server open.
    this.keepAlive.unref?.();
  }

  private stopKeepAlive(): void {
    if (!this.keepAlive) return;
    clearInterval(this.keepAlive);
    this.keepAlive = null;
  }

  /** Reconnect if the socket is down. Cheap and idempotent when it is up. */
  private async pokeConnection(): Promise<void> {
    if (this.connecting) return;
    const client = this.getClient();
    if (client.isConnected()) return;
    this.connecting = true;
    try {
      await client.ensureConnected(15_000);
    } catch (err) {
      this.eventsConnected = false;
      this.eventsConnectedSince = null;
      this.lastEventError = err instanceof Error ? err.message : String(err);
    } finally {
      this.connecting = false;
    }
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
        log.warn(
          { method, wsError: this.lastWsError },
          "WebSocket RPC unavailable — falling back to `openclaw gateway call`",
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

/**
 * Parked on globalThis, not a module local.
 *
 * The channel now owns a long-lived socket and a set of event subscribers, so
 * "one per module instance" is not good enough: a `next dev` hot reload would
 * mint a second channel with a second socket while every existing subscriber
 * kept listening to the first. Cards would go quiet with nothing in the logs to
 * say why. One channel per process, whatever the module registry does.
 */
type ChannelHolder = { __mcGatewayRpcChannel?: GatewayRpcChannel };

export function getGatewayRpcChannel(): GatewayRpcChannel {
  const holder = globalThis as ChannelHolder;
  holder.__mcGatewayRpcChannel ??= new GatewayRpcChannel();
  return holder.__mcGatewayRpcChannel;
}

/** Reset the singleton (for testing). */
export function resetGatewayRpcChannel(): void {
  delete (globalThis as ChannelHolder).__mcGatewayRpcChannel;
}
