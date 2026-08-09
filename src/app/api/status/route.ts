import { NextResponse } from "next/server";
import { getGatewayUrl } from "@/lib/paths";
import { probeGatewayLiveness } from "@/lib/gateway-liveness";
import { resolveTransport } from "@/lib/openclaw";

export const dynamic = "force-dynamic";

type StatusPayload = {
  ok: boolean;
  gateway: "online" | "offline" | "degraded";
  transport: string;
  transportConfigured: string;
  transportReason: string;
  port: number;
  timestamp: string;
  latencyMs: number;
};

const STATUS_CACHE_TTL_MS = 3000;
const STATUS_CACHE_MAX_STALE_MS = 60000;
let statusCache: { payload: StatusPayload; expiresAt: number; fetchedAt: number } | null = null;

/**
 * GET /api/status — lightweight system status check.
 *
 * Returns gateway reachability and transport mode without slow RPC calls.
 * Designed for health-check consumers, uptime monitors, and the frontend
 * status indicator. Serves stale data during transient gateway outages.
 */
export async function GET() {
  const start = Date.now();

  // Serve fresh cache if available.
  if (statusCache && start < statusCache.expiresAt) {
    return NextResponse.json({ ...statusCache.payload, stale: false });
  }

  try {
    const url = await getGatewayUrl();
    const port = parseInt(new URL(url).port, 10) || 18789;
    const configuredRaw = (process.env.OPENCLAW_TRANSPORT || "auto").toLowerCase();
    const transportConfigured =
      configuredRaw === "cli" || configuredRaw === "http" ? configuredRaw : "auto";
    let transport = transportConfigured;
    let transportReason: "forced_cli" | "forced_http" | "auto_http" | "auto_fallback_cli" =
      transportConfigured === "cli"
        ? "forced_cli"
        : transportConfigured === "http"
          ? "forced_http"
          : "auto_http";

    let gateway: "online" | "offline" | "degraded" = "offline";

    try {
      gateway = (await probeGatewayLiveness(url)) ? "online" : "degraded";
    } catch {
      // unreachable — gateway stays "offline"
    }

    try {
      transport = await resolveTransport();
    } catch {
      // leave configured transport as fallback
    }

    if (transportConfigured === "auto") {
      transportReason = transport === "cli" ? "auto_fallback_cli" : "auto_http";
    }

    const payload: StatusPayload = {
      ok: gateway === "online",
      gateway,
      transport,
      transportConfigured,
      transportReason,
      port,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - start,
    };

    const writtenAt = Date.now();
    statusCache = { payload, expiresAt: writtenAt + STATUS_CACHE_TTL_MS, fetchedAt: writtenAt };

    return NextResponse.json({ ...payload, stale: false });
  } catch (err) {
    // Serve stale cache during transient failures.
    if (statusCache && start < statusCache.fetchedAt + STATUS_CACHE_MAX_STALE_MS) {
      console.warn("Status API: serving stale cache due to error:", String(err));
      return NextResponse.json({ ...statusCache.payload, stale: true });
    }

    // No cache — return a minimal offline response rather than 500.
    console.warn("Status API: no cache available, returning offline response:", String(err));
    return NextResponse.json({
      ok: false,
      gateway: "offline",
      transport: "auto",
      transportConfigured: "auto",
      transportReason: "auto_fallback_cli",
      port: 18789,
      timestamp: new Date().toISOString(),
      latencyMs: Date.now() - start,
      stale: true,
    });
  }
}
