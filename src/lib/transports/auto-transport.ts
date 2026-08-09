/**
 * Auto transport — picks the best way to reach OpenClaw for each kind of call.
 *
 * There are two independent channels, and conflating them was the cause of the
 * "gateway is not reachable via HTTP" failures across the dashboard:
 *
 *   - Gateway RPC (WebSocket) drives config, sessions, cron, agents, models,
 *     channels, skills, usage and health. It is handled by GatewayRpcChannel,
 *     which has its own health and its own CLI fallback.
 *
 *   - Running `openclaw <cmd>` needs either a local subprocess or the gateway's
 *     `exec` tool over `POST /tools/invoke`. Current OpenClaw denies `exec`
 *     there by default (DEFAULT_GATEWAY_HTTP_TOOL_DENY), so the subprocess is
 *     the default and HTTP is used only where a probe proves `exec` is exposed.
 */

import type { OpenClawClient, TransportMode } from "../openclaw-client";
import type { RunCliResult } from "../openclaw-cli";
import { getGatewayRpcChannel } from "../gateway-rpc-channel";
import { CliTransport } from "./cli-transport";
import { HttpTransport } from "./http-transport";

function errorToMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** How long a verdict about the HTTP `exec` bridge stays valid. */
const EXEC_BRIDGE_TTL_MS = 5 * 60_000;

/** Patterns showing the gateway refused us outright rather than transiently. */
const PERMANENT_FAILURE_PATTERNS = [
  "missing scope",
  "forbidden",
  "unauthorized",
  "returned 403",
  "returned 401",
];

function isPermanentHttpFailure(reason: string): boolean {
  const lower = reason.toLowerCase();
  return PERMANENT_FAILURE_PATTERNS.some((p) => lower.includes(p));
}

type ExecBridge = "unknown" | "available" | "unavailable";

export class AutoTransport implements OpenClawClient {
  private cli = new CliTransport();
  private http = new HttpTransport();
  private rpc = getGatewayRpcChannel();

  /**
   * Whether `openclaw <cmd>` can be bridged through the gateway's `exec` tool.
   * Starts unknown, is probed once, then cached — a denied `exec` used to be
   * rediscovered through a 404 on every single call.
   */
  private execBridge: ExecBridge = "unknown";
  private execBridgeCheckedAt = 0;
  private execProbe: Promise<void> | null = null;

  /** CLI concurrency guard — prevents subprocess storms during restarts. */
  private activeCli = 0;
  private readonly maxCli = 6;

  getTransport(): TransportMode {
    return "auto";
  }

  /**
   * Report the channel that carries `openclaw <cmd>` invocations. RPC health is
   * separate and no longer implied by this value.
   */
  async resolveTransport(): Promise<TransportMode> {
    await this.probeExecBridge();
    return this.execBridge === "available" ? "http" : "cli";
  }

  /**
   * Establish whether the gateway exposes `exec` over `POST /tools/invoke`.
   *
   * `exec` is on OpenClaw's default HTTP deny list, so on a stock install this
   * settles on "unavailable" once and stays there for the TTL instead of
   * failing one call at a time.
   */
  private async probeExecBridge(): Promise<void> {
    if (this.execBridge !== "unknown" && Date.now() - this.execBridgeCheckedAt < EXEC_BRIDGE_TTL_MS) {
      return;
    }
    if (this.execProbe) return this.execProbe;

    this.execProbe = (async () => {
      try {
        const res = await this.http.gatewayFetch("/tools/invoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // A no-op command: enough to learn whether the tool is exposed at all
          // without depending on the host's shell environment.
          body: JSON.stringify({ tool: "exec", args: { command: "true" }, action: "json" }),
          signal: AbortSignal.timeout(4_000),
        });
        const previous = this.execBridge;
        if (res.status === 200) {
          this.execBridge = "available";
          if (previous !== "available") {
            console.info("[AutoTransport] Gateway exec bridge available over HTTP.");
          }
        } else {
          this.execBridge = "unavailable";
          if (previous === "unknown") {
            const detail =
              res.status === 404
                ? "exec is not exposed on POST /tools/invoke (OpenClaw denies it by default)"
                : `HTTP ${res.status}`;
            console.info(`[AutoTransport] Running openclaw via local CLI: ${detail}.`);
          }
        }
      } catch (err) {
        this.execBridge = "unavailable";
        console.info(
          `[AutoTransport] Running openclaw via local CLI: gateway HTTP probe failed (${errorToMessage(err)}).`,
        );
      } finally {
        this.execBridgeCheckedAt = Date.now();
        this.execProbe = null;
      }
    })();

    return this.execProbe;
  }

  private markExecBridgeUnavailable(reason: string): void {
    if (this.execBridge === "available") {
      console.warn(`[AutoTransport] Gateway exec bridge failed, using local CLI: ${reason}`);
    }
    this.execBridge = "unavailable";
    this.execBridgeCheckedAt = Date.now();
  }

  /** Pick the channel for `openclaw <cmd>` invocations. */
  private async pickCommandChannel(): Promise<OpenClawClient> {
    await this.probeExecBridge();
    return this.execBridge === "available" ? this.http : this.cli;
  }

  /** Run a command, falling back from the HTTP bridge to a local subprocess. */
  private async withFallback<T>(fn: (client: OpenClawClient) => Promise<T>): Promise<T> {
    const primary = await this.pickCommandChannel();
    if (primary === this.cli) return fn(this.cli);

    try {
      return await fn(this.http);
    } catch (err) {
      const reason = errorToMessage(err);
      this.markExecBridgeUnavailable(reason);
      if (isPermanentHttpFailure(reason)) {
        // Auth/scope mismatches never fix themselves within the TTL.
        this.execBridgeCheckedAt = Date.now();
      }
      if (this.activeCli >= this.maxCli) {
        throw new Error("Gateway busy — too many pending CLI operations");
      }
      this.activeCli++;
      try {
        return await fn(this.cli);
      } finally {
        this.activeCli--;
      }
    }
  }

  // ── OpenClawClient interface ──────────────────────

  runJson<T>(args: string[], timeout?: number): Promise<T> {
    return this.withFallback((c) => c.runJson<T>(args, timeout));
  }

  run(args: string[], timeout?: number, stdin?: string): Promise<string> {
    return this.withFallback((c) => c.run(args, timeout, stdin));
  }

  async runCapture(args: string[], timeout?: number): Promise<RunCliResult> {
    const primary = await this.pickCommandChannel();
    if (primary === this.cli) return this.cli.runCapture(args, timeout);

    const result = await this.http.runCapture(args, timeout);
    if (result.code !== 0 && result.stderr?.includes("/tools/invoke")) {
      this.markExecBridgeUnavailable(result.stderr);
      return this.cli.runCapture(args, timeout);
    }
    return result;
  }

  /**
   * Gateway RPC rides its own WebSocket channel with a CLI fallback, so it stays
   * available even when the HTTP `exec` bridge is denied.
   */
  gatewayRpc<T>(method: string, params?: Record<string, unknown>, timeout?: number): Promise<T> {
    return this.rpc.request<T>(method, params ?? {}, timeout);
  }

  // File operations run against the local filesystem: Mission Control is a
  // local dashboard, and the gateway does not expose filesystem tools over
  // HTTP (fs_write and friends are denied, and `read`/`write` are not tools).
  readFile(path: string): Promise<string> {
    return this.cli.readFile(path);
  }

  writeFile(path: string, content: string): Promise<void> {
    return this.cli.writeFile(path, content);
  }

  readdir(path: string): Promise<string[]> {
    return this.cli.readdir(path);
  }

  async gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
    return this.http.gatewayFetch(path, init);
  }
}
