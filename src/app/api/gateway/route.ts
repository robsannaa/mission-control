import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { getOpenClawBin, getGatewayUrl } from "@/lib/paths";
import { probeGatewayLiveness } from "@/lib/gateway-liveness";
import { gatewayConfigPatch } from "@/lib/gateway-config";
import { logRequest, logError } from "@/lib/request-log";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

// ── Auto-enable OpenResponses endpoint for streaming chat ──
// Uses a cooldown to avoid restart loops: once attempted (success or fail),
// waits RETRY_COOLDOWN_MS before trying again. Never resets on failure.
// Uses a cooldown to avoid restart loops (see issue #20).
let _responsesEndpointEnsured = false;
let _responsesLastAttempt = 0;
const RESPONSES_RETRY_COOLDOWN_MS = 5 * 60_000; // 5 minutes

/** Resolves when the setup attempt completes (success or fail). */
let _responsesSetupPromise: Promise<void> | null = null;

function ensureResponsesEndpoint(): void {
  if (_responsesEndpointEnsured) return;
  if (Date.now() - _responsesLastAttempt < RESPONSES_RETRY_COOLDOWN_MS) return;
  _responsesLastAttempt = Date.now();

  // Fire-and-forget — don't block the health check response
  _responsesSetupPromise = (async () => {
    try {
      const cfg = await gatewayCall<{
        hash?: string;
        parsed?: Record<string, unknown>;
        config?: Record<string, unknown>;
      }>(
        "config.get",
        undefined,
        8000,
      );
      // Check both parsed (standard) and config (legacy) shapes
      const root = cfg?.parsed ?? cfg?.config ?? {};
      const gw = (root as Record<string, unknown>)?.gateway as Record<string, unknown> | undefined;
      const http = gw?.http as Record<string, unknown> | undefined;
      const endpoints = http?.endpoints as Record<string, unknown> | undefined;
      const responses = endpoints?.responses as Record<string, unknown> | undefined;
      if (responses?.enabled === true) {
        _responsesEndpointEnsured = true; // Already enabled, no patch needed
        return;
      }

      await gatewayConfigPatch(
        {
          raw: JSON.stringify({
            gateway: { http: { endpoints: { responses: { enabled: true } } } },
          }),
          baseHash: String(cfg?.hash || ""),
          restartDelayMs: 3000,
        },
        10000,
      );
      _responsesEndpointEnsured = true;
    } catch {
      // Non-fatal — streaming falls back to non-streaming.
      // Do NOT reset _responsesEndpointEnsured; cooldown timer handles retry.
    } finally {
      _responsesSetupPromise = null;
    }
  })();
}

/**
 * Wait for the in-flight responses endpoint setup to finish.
 * Called by the chat route to avoid racing with the fire-and-forget setup.
 */
export async function waitForResponsesEndpoint(): Promise<void> {
  if (_responsesSetupPromise) {
    await _responsesSetupPromise;
  }
}

/**
 * Trigger the responses endpoint setup if it hasn't been attempted yet.
 * Called by the chat route when a user sends a message before the gateway
 * health poll has fired (which normally triggers ensureResponsesEndpoint).
 */
export function triggerResponsesEndpointSetup(): void {
  ensureResponsesEndpoint();
}

async function runGatewayServiceCommand(
  subcommand: "restart" | "stop" | "start",
  timeout = 25000
): Promise<{ stdout: string; stderr: string }> {
  const bin = await getOpenClawBin();
  return exec(bin, ["gateway", subcommand], {
    timeout,
    env: { ...process.env, NO_COLOR: "1", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
  });
}

/**
 * Quick gateway liveness check — just probe the HTTP endpoint.
 * This avoids the slow `openclaw health --json` CLI which loads all
 * plugins and takes 15-20s (often exceeding the frontend's 15s abort).
 */
async function probeGatewayHttp(): Promise<{
  ok: boolean;
  port: number;
  url: string;
}> {
  const url = await getGatewayUrl();
  const port = parseInt(new URL(url).port, 10) || 18789;
  return { ok: await probeGatewayLiveness(url), port, url };
}

type GatewayPayload = {
  status: "online" | "degraded" | "offline";
  health: Record<string, unknown>;
  gatewayStatus?: Record<string, unknown>;
};

const GATEWAY_RESPONSE_TTL_MS = 2500;
const GATEWAY_MAX_STALE_MS = 60000;
let gatewayResponseCache: { payload: GatewayPayload; expiresAt: number; fetchedAt: number } | null = null;
let gatewayResponseInFlight: Promise<GatewayPayload> | null = null;

function getCachedGatewayPayload(now = Date.now()): GatewayPayload | null {
  if (!gatewayResponseCache || gatewayResponseCache.expiresAt <= now) return null;
  return gatewayResponseCache.payload;
}

function getStaleCachedGatewayPayload(now = Date.now()): GatewayPayload | null {
  if (!gatewayResponseCache) return null;
  if (now >= gatewayResponseCache.fetchedAt + GATEWAY_MAX_STALE_MS) return null;
  return gatewayResponseCache.payload;
}

async function computeGatewayPayload(): Promise<GatewayPayload> {
  // Fast liveness check first
  const probe = await probeGatewayHttp();
  if (!probe.ok) {
    return {
      status: "offline",
      health: { ok: false, error: "Gateway HTTP endpoint not reachable" },
    };
  }

  // Gateway is alive — ensure OpenResponses endpoint is enabled for streaming chat
  ensureResponsesEndpoint();

  // Full health call first. Status call is optional and only fetched when healthy.
  try {
    const health = await gatewayCall<Record<string, unknown>>("health", {}, 12000);
    let status: Record<string, unknown> | null = null;
    if ((health as { ok?: unknown })?.ok === true) {
      status = await gatewayCall<Record<string, unknown>>("status", {}, 4000).catch(() => null);
    }
    const gwStatus: GatewayPayload["status"] =
      (health as { ok?: unknown })?.ok === true ? "online" : "degraded";
    return {
      status: gwStatus,
      health,
      ...(status ? { gatewayStatus: status } : {}),
    };
  } catch {
    // RPC failed — but gateway IS reachable via HTTP
  }

  // Gateway is reachable but full health data unavailable — report online
  return {
    status: "online",
    health: { ok: true, port: probe.port, note: "Lite probe (full health unavailable)" },
  };
}

/**
 * GET /api/gateway - Returns gateway health status.
 *
 * Strategy:
 *   1. Quick HTTP probe to the gateway (< 3s) for liveness.
 *   2. If alive, query `health` / `status` over Gateway RPC.
 *   3. Return online/offline based on the probe; include full health
 *      data when RPC completes in time.
 */
export async function GET() {
  const start = Date.now();
  try {
    const cached = getCachedGatewayPayload(start);
    if (cached) {
      logRequest("/api/gateway", 200, Date.now() - start, {
        gateway: cached.status,
        cached: true,
      });
      return NextResponse.json(cached);
    }

    const joinedInFlight = gatewayResponseInFlight !== null;
    if (!gatewayResponseInFlight) {
      gatewayResponseInFlight = computeGatewayPayload()
        .then((payload) => {
          const writtenAt = Date.now();
          gatewayResponseCache = {
            payload,
            expiresAt: writtenAt + GATEWAY_RESPONSE_TTL_MS,
            fetchedAt: writtenAt,
          };
          return payload;
        })
        .finally(() => {
          gatewayResponseInFlight = null;
        });
    }

    const payload = await gatewayResponseInFlight;
    logRequest("/api/gateway", 200, Date.now() - start, {
      gateway: payload.status,
      coalesced: joinedInFlight,
    });
    return NextResponse.json({ ...payload, stale: false });
  } catch (err) {
    logError("/api/gateway", err, { phase: "get" });

    // Serve stale cache during gateway restart window rather than erroring.
    const stale = getStaleCachedGatewayPayload(start);
    if (stale) {
      logRequest("/api/gateway", 200, Date.now() - start, {
        gateway: stale.status,
        stale: true,
      });
      return NextResponse.json({ ...stale, stale: true, restarting: true });
    }

    return NextResponse.json({
      status: "offline",
      health: { ok: false, error: "Gateway health check failed" },
      stale: true,
      restarting: true,
    });
  }
}
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const action = body.action as string;

    if (action === "restart" || action === "stop") {
      // Prefer service-manager commands (launchd/systemd/schtasks).
      // This avoids port-collision loops caused by manually spawning a second gateway process.
      if (action === "stop") {
        try {
          const out = await runGatewayServiceCommand("stop");
          return NextResponse.json({
            ok: true,
            message: "Gateway stop requested via service manager",
            output: `${out.stdout}\n${out.stderr}`.trim(),
            action: "stop",
          });
        } catch {
          // If service control is unavailable, fall back to process kill.
        }

        let pid: number | null = null;
        try {
          const { stdout } = await exec("pgrep", ["-f", "openclaw-gateway"], { timeout: 5000 });
          const pids = stdout
            .trim()
            .split("\n")
            .map((p) => parseInt(p, 10))
            .filter((p) => !isNaN(p));
          if (pids.length > 0) pid = pids[0];
        } catch {
          // no running process
        }
        if (!pid) {
          return NextResponse.json({
            ok: true,
            message: "Gateway is already stopped",
            action: "stop",
          });
        }
        process.kill(pid, "SIGTERM");
        return NextResponse.json({
          ok: true,
          message: "Gateway stop signal sent",
          pid,
          action: "stop",
        });
      }

      // action === "restart"
      try {
        const out = await runGatewayServiceCommand("restart", 35000);
        return NextResponse.json({
          ok: true,
          message: "Gateway restart requested via service manager",
          output: `${out.stdout}\n${out.stderr}`.trim(),
          action: "restart",
        });
      } catch (serviceErr) {
        // Fallback for unsupervised setups: stop then start via service commands.
        // Do not call bare `openclaw gateway` to avoid duplicate listeners.
        try {
          await runGatewayServiceCommand("stop", 20000).catch(() => null);
          await new Promise((resolve) => setTimeout(resolve, 800));
          const out = await runGatewayServiceCommand("start", 25000);
          return NextResponse.json({
            ok: true,
            message: "Gateway start requested (fallback path)",
            output: `${out.stdout}\n${out.stderr}`.trim(),
            action: "start",
          });
        } catch {
          return NextResponse.json(
            {
              ok: false,
              error: `Gateway restart failed: ${String(serviceErr)}`,
            },
            { status: 500 }
          );
        }
      }
    }

    return NextResponse.json(
      { error: `Unknown action: ${action}` },
      { status: 400 }
    );
  } catch (err) {
    logError("/api/gateway", err);
    return NextResponse.json(
      { error: String(err) },
      { status: 500 }
    );
  }
}
