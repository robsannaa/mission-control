/**
 * Audit trace reader — agent run / tool action history (SERVER ONLY).
 *
 * Wraps `openclaw audit --json`, which returns a bounded page of metadata-only
 * event records (see `openclaw audit --help`). This module shells out through
 * the shared OpenClaw client, so it must never be imported by client code —
 * client components import the pure types + `groupRunsFromEvents` from
 * `./audit-grouping` instead. Fails soft (mirrors `apple-calendar.ts`) so a
 * missing/older CLI or a gateway hiccup degrades to an empty, explained result
 * instead of a 500.
 */
import { runCliJson } from "@/lib/openclaw";
import {
  isRecord,
  toAuditEvent,
  type AuditEvent,
  type AuditFilters,
  type AuditResult,
} from "./audit-grouping";

// Re-export the pure surface so `@/lib/audit` stays the single server entry
// point (the API route and Node tests import from here).
export * from "./audit-grouping";

function clampLimit(limit: number | undefined): number {
  const n = Number(limit);
  if (!Number.isFinite(n)) return 100;
  return Math.min(500, Math.max(1, Math.floor(n)));
}

function buildAuditArgs(filters: AuditFilters): string[] {
  const args = ["audit", "--limit", String(clampLimit(filters.limit))];
  if (filters.kind) args.push("--kind", filters.kind);
  if (filters.status) args.push("--status", filters.status);
  if (filters.agentId) args.push("--agent", filters.agentId);
  if (filters.sessionKey) args.push("--session", filters.sessionKey);
  if (filters.runId) args.push("--run", filters.runId);
  if (filters.after !== undefined && filters.after !== "") args.push("--after", String(filters.after));
  if (filters.before !== undefined && filters.before !== "") args.push("--before", String(filters.before));
  if (filters.cursor !== undefined && filters.cursor !== "") args.push("--cursor", String(filters.cursor));
  return args;
}

/**
 * Read a bounded page of audit events via `openclaw audit --json`.
 *
 * Fails soft: any CLI/gateway error (missing binary, unsupported version,
 * pairing refusal, timeout, ...) resolves to `{ available: false, reason, events: [] }`
 * rather than throwing, so callers can render an explained empty state.
 */
export async function readAuditEvents(filters: AuditFilters = {}): Promise<AuditResult> {
  const args = buildAuditArgs(filters);
  try {
    // `runCliJson` appends `--json` itself (see src/lib/openclaw-cli.ts).
    const raw = await runCliJson<unknown>(args, 15000);
    if (!isRecord(raw) || !Array.isArray(raw.events)) {
      return { available: false, reason: "Unexpected response shape from `openclaw audit --json`.", events: [] };
    }
    const events: AuditEvent[] = [];
    for (const entry of raw.events) {
      const event = toAuditEvent(entry);
      if (event) events.push(event);
    }
    const cursorRaw = raw.nextCursor ?? raw.cursor;
    const cursor = typeof cursorRaw === "string" || typeof cursorRaw === "number" ? cursorRaw : undefined;
    return { available: true, events, cursor };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, reason: message, events: [] };
  }
}
