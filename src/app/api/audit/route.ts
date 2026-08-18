import { NextResponse } from "next/server";
import { readAuditEvents, type AuditEventKind, type AuditEventStatus, type AuditFilters } from "@/lib/audit";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

const VALID_KINDS = new Set<string>(["agent_run", "tool_action"]);
const VALID_STATUSES = new Set<string>([
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "blocked",
  "unknown",
]);

function clampLimit(raw: string | null): number {
  const n = raw !== null ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return 100;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

function parseFilters(searchParams: URLSearchParams): AuditFilters {
  const filters: AuditFilters = { limit: clampLimit(searchParams.get("limit")) };

  const kind = searchParams.get("kind");
  if (kind && VALID_KINDS.has(kind)) filters.kind = kind as AuditEventKind;

  const status = searchParams.get("status");
  if (status && VALID_STATUSES.has(status)) filters.status = status as AuditEventStatus;

  const agentId = searchParams.get("agentId") ?? searchParams.get("agent");
  if (agentId) filters.agentId = agentId;

  const sessionKey = searchParams.get("sessionKey") ?? searchParams.get("session");
  if (sessionKey) filters.sessionKey = sessionKey;

  const runId = searchParams.get("runId") ?? searchParams.get("run");
  if (runId) filters.runId = runId;

  const after = searchParams.get("after");
  if (after) filters.after = after;

  const before = searchParams.get("before");
  if (before) filters.before = before;

  const cursor = searchParams.get("cursor");
  if (cursor) filters.cursor = cursor;

  return filters;
}

export const GET = withRoute({ name: "/api/audit" }, async (request) => {
  const filters = parseFilters(request.nextUrl.searchParams);
  try {
    const result = await readAuditEvents(filters);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    // `readAuditEvents` already fails soft, so this only catches something
    // unexpected upstream (e.g. a pairing refusal bubbling out of the
    // shared client) — surface it the same way the rest of Mission Control does.
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { available: false, reason: message, events: [] },
      { headers: { "cache-control": "no-store" } },
    );
  }
});
