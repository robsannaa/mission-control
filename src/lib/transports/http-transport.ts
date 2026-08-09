/**
 * HTTP transport — talks to the Gateway's HTTP API endpoints.
 *
 * Used for hosted deployments where the platform communicates with
 * the Gateway over HTTP, and for self-hosted users who prefer HTTP over CLI subprocesses.
 *
 * Primary endpoint: POST /tools/invoke (always enabled on the Gateway)
 * Auth: Authorization: Bearer <OPENCLAW_GATEWAY_TOKEN>
 */

import { getGatewayPassword, getGatewayToken, getGatewayUrl } from "../paths";
import { GatewayRpcChannel } from "../gateway-rpc-channel";
import { parseJsonFromCliOutput, type RunCliResult } from "../openclaw-cli";
import type { OpenClawClient, TransportMode } from "../openclaw-client";

export class HttpTransport implements OpenClawClient {
  private token: string;
  private gatewayUrlCache: string | null = null;
  private rpcChannel: GatewayRpcChannel | null = null;

  constructor(gatewayUrl?: string, token?: string) {
    // Fall back to openclaw.json, not just the env var: token mode usually
    // stores the secret in `gateway.auth.token`, and password mode has no token
    // at all. Either shared secret authenticates this host as a local operator.
    this.token = token || getGatewayToken() || getGatewayPassword();
    this.gatewayUrlCache = gatewayUrl || null;
  }

  getTransport(): TransportMode {
    return "http";
  }

  async resolveTransport(): Promise<TransportMode> {
    return "http";
  }

  private async getGwUrl(): Promise<string> {
    if (this.gatewayUrlCache) return this.gatewayUrlCache;
    this.gatewayUrlCache = await getGatewayUrl();
    return this.gatewayUrlCache;
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) return {};
    return { Authorization: `Bearer ${this.token}` };
  }

  /**
   * Invoke a Gateway tool via POST /tools/invoke.
   * Returns the parsed JSON response body.
   */
  private async invoke<T>(
    tool: string,
    args: Record<string, unknown> = {},
    timeout = 15000,
    action?: "json",
  ): Promise<T> {
    const gwUrl = await this.getGwUrl();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`${gwUrl}/tools/invoke`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          tool,
          args,
          ...(action ? { action } : {}),
        }),
        signal: controller.signal,
      });
      const body = (await res.json().catch(() => null)) as
        | { ok?: boolean; result?: T; error?: { message?: string } }
        | T
        | null;
      if (!res.ok) {
        const text =
          (body && typeof body === "object" && "error" in body && body.error?.message) ||
          JSON.stringify(body) ||
          "";
        throw new Error(
          `Gateway /tools/invoke ${tool} returned ${res.status}: ${text}`,
        );
      }
      if (body && typeof body === "object" && "ok" in body) {
        if (body.ok === false) {
          throw new Error(body.error?.message || `Tool ${tool} failed`);
        }
        return (body.result as T) ?? ({} as T);
      }
      return (body || {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Execute a shell command inside the Gateway via the exec tool.
   * Returns the raw stdout.
   */
  private resultToText(
    result:
      | { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown; text?: string }
      | string,
  ): string {
    if (typeof result === "string") return result;
    if (typeof result.output === "string") return result.output;
    if (typeof result.stdout === "string") return result.stdout;
    if (typeof result.result === "string") return result.result;
    if (typeof result.text === "string") return result.text;
    if (Array.isArray(result.content)) {
      const text = result.content
        .map((item) =>
          item && typeof item === "object" && "text" in item ? String(item.text || "") : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
    if (typeof result.details === "string") return result.details;
    return JSON.stringify(result.details || result);
  }

  private async execCommand(
    command: string,
    timeout = 15000,
  ): Promise<string> {
    const result = await this.invoke<
      { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown } | string
    >("exec", { command }, timeout, "json");
    return this.resultToText(result);
  }

  // ── OpenClawClient interface ──────────────────────

  async runJson<T>(args: string[], timeout = 15000): Promise<T> {
    const command = `openclaw ${args.join(" ")} --json`;
    const raw = await this.execCommand(command, timeout);
    return parseJsonFromCliOutput<T>(raw, command);
  }

  async run(
    args: string[],
    timeout = 15000,
    stdin?: string,
  ): Promise<string> {
    const command = `openclaw ${args.join(" ")}`;
    if (stdin) {
      const result = await this.invoke<
        { output?: string; stdout?: string; result?: string; content?: unknown; details?: unknown } | string
      >("exec", { command, stdin }, timeout, "json");
      return this.resultToText(result);
    }
    return this.execCommand(command, timeout);
  }

  async runCapture(args: string[], timeout = 15000): Promise<RunCliResult> {
    const command = `openclaw ${args.join(" ")}`;
    try {
      const stdout = await this.execCommand(command, timeout);
      return { stdout, stderr: "", code: 0 };
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
      };
    }
  }

  async gatewayRpc<T>(
    method: string,
    params?: Record<string, unknown>,
    timeout = 15000,
  ): Promise<T> {
    // Gateway RPC is a WebSocket protocol; it is only reached from here because
    // this class is also the "remote gateway" transport. The channel handles
    // connection reuse and the CLI fallback.
    if (!this.rpcChannel) {
      this.rpcChannel = new GatewayRpcChannel(this.gatewayUrlCache || undefined, this.token);
    }
    return this.rpcChannel.request<T>(method, params || {}, timeout);
  }

  /**
   * The gateway deliberately exposes no filesystem tools on
   * `POST /tools/invoke` — `fs_write`, `fs_delete`, `fs_move` and `apply_patch`
   * are on its default deny list, and there is no `read`/`write` tool to call.
   * Say so instead of returning a 404 from a generic tool invocation.
   */
  private unsupportedFileOperation(operation: string): Error {
    return new Error(
      `Cannot ${operation} over the gateway HTTP transport: OpenClaw does not expose ` +
        "filesystem tools on POST /tools/invoke. Run Mission Control on the gateway host " +
        "with OPENCLAW_TRANSPORT=auto (or cli) so file access uses the local filesystem.",
    );
  }

  async readFile(path: string): Promise<string> {
    throw this.unsupportedFileOperation(`read ${path}`);
  }

  async writeFile(path: string): Promise<void> {
    throw this.unsupportedFileOperation(`write ${path}`);
  }

  async readdir(path: string): Promise<string[]> {
    throw this.unsupportedFileOperation(`list ${path}`);
  }

  async gatewayFetch(path: string, init?: RequestInit): Promise<Response> {
    const gwUrl = await this.getGwUrl();
    return fetch(`${gwUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        ...this.authHeaders(),
      },
    });
  }
}
