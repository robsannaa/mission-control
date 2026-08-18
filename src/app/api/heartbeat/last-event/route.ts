import { NextResponse } from "next/server";
import { runCliJson } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * Separate from `/api/heartbeat` on purpose: `openclaw system heartbeat last`
 * spawns a CLI process and consistently takes ~1.5-2s (verified locally),
 * which is fine for a "nice to have" proof snippet in the empty state but
 * much too slow to hold up the main page load. This route is fetched lazily
 * by the client, only while heartbeat is unconfigured, and is cached briefly
 * server-side so navigating back to the page doesn't re-pay the cost.
 */

type LastHeartbeatEvent = {
  ts: number;
  status: string;
  reason?: string;
  preview?: string;
} | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const CACHE_TTL_MS = 30_000;
let cache: { value: LastHeartbeatEvent; expiresAt: number } | null = null;
let inFlight: Promise<LastHeartbeatEvent> | null = null;

async function fetchLastHeartbeatEvent(): Promise<LastHeartbeatEvent> {
  try {
    const result = await runCliJson<Record<string, unknown>>(
      ["system", "heartbeat", "last", "--json"],
      6000
    );
    if (!isRecord(result) || typeof result.ts !== "number") return null;
    return {
      ts: result.ts,
      status: typeof result.status === "string" ? result.status : "unknown",
      reason: typeof result.reason === "string" ? result.reason : undefined,
      preview: typeof result.preview === "string" ? result.preview : undefined,
    };
  } catch {
    // Best-effort only — the empty state reads fine without this.
    return null;
  }
}

export const GET = withRoute({ name: "/api/heartbeat/last-event" }, async () => {
  const now = Date.now();
  if (cache && cache.expiresAt > now) {
    return NextResponse.json(
      { ok: true, lastEvent: cache.value },
      { headers: { "Cache-Control": "no-store" } }
    );
  }
  if (!inFlight) {
    inFlight = fetchLastHeartbeatEvent().finally(() => {
      inFlight = null;
    });
  }
  const value = await inFlight;
  cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
  return NextResponse.json(
    { ok: true, lastEvent: value },
    { headers: { "Cache-Control": "no-store" } }
  );
});
