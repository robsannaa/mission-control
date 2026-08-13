/**
 * Audit trace — pure, client-safe types and grouping logic.
 *
 * This module has NO Node/server imports on purpose: both the server reader
 * (`audit.ts`) and the client Activity "Trace" view import from here, so the
 * grouping code can run in the browser bundle without dragging `child_process`
 * (via the OpenClaw CLI client) into it.
 */

// ── Types ────────────────────────────────────────────────────────────────

export type AuditEventKind = "agent_run" | "tool_action";

export type AuditEventStatus =
  | "started"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "blocked"
  | "unknown";

export interface AuditActor {
  type: string;
  id: string;
}

export interface AuditEvent {
  eventId: string;
  sequence: number;
  sourceSequence?: number;
  occurredAt: number; // epoch ms
  kind: AuditEventKind;
  action: string; // e.g. agent.run.started | tool.action.finished
  status: AuditEventStatus;
  actor?: AuditActor;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName?: string;
  toolCallId?: string;
  redaction?: string;
}

export interface AuditFilters {
  limit?: number;
  kind?: AuditEventKind;
  status?: AuditEventStatus;
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  after?: string | number;
  before?: string | number;
  cursor?: string | number;
}

export interface AuditResult {
  available: boolean; // false when the CLI is missing, unsupported, or the gateway refused
  reason?: string; // human explanation when unavailable
  events: AuditEvent[];
  cursor?: string | number; // pass back as `cursor` to page further back in time
}

export interface AuditToolCall {
  toolCallId: string;
  toolName: string;
  startedAt: number;
  endedAt?: number;
  status: AuditEventStatus;
  durationMs?: number;
}

export interface AuditRun {
  runId: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  startedAt: number;
  endedAt?: number;
  status: AuditEventStatus;
  kind?: AuditEventKind; // present when an agent_run event anchored this run
  tools: AuditToolCall[];
}

// ── Runtime validation ──────────────────────────────────────────────────
// Query results are JSON off a subprocess boundary (and, for tests, hand
// built fixtures), so validate defensively rather than trusting the static
// type at runtime.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const VALID_KINDS = new Set<string>(["agent_run", "tool_action"]);
export const VALID_STATUSES = new Set<string>([
  "started",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "blocked",
  "unknown",
]);

function toOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toActor(value: unknown): AuditActor | undefined {
  if (!isRecord(value)) return undefined;
  const type = toOptionalString(value.type);
  const id = toOptionalString(value.id);
  return type && id ? { type, id } : undefined;
}

/** Validate + normalize a single raw record into an `AuditEvent`, or `null` if malformed. */
export function toAuditEvent(raw: unknown): AuditEvent | null {
  if (!isRecord(raw)) return null;
  const { eventId, sequence, occurredAt, kind, action, status } = raw;
  if (typeof eventId !== "string" || eventId.length === 0) return null;
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return null;
  if (typeof occurredAt !== "number" || !Number.isFinite(occurredAt)) return null;
  if (typeof kind !== "string" || !VALID_KINDS.has(kind)) return null;
  if (typeof action !== "string" || action.length === 0) return null;
  if (typeof status !== "string" || !VALID_STATUSES.has(status)) return null;

  return {
    eventId,
    sequence,
    sourceSequence: typeof raw.sourceSequence === "number" ? raw.sourceSequence : undefined,
    occurredAt,
    kind: kind as AuditEventKind,
    action,
    status: status as AuditEventStatus,
    actor: toActor(raw.actor),
    agentId: toOptionalString(raw.agentId),
    sessionKey: toOptionalString(raw.sessionKey),
    sessionId: toOptionalString(raw.sessionId),
    runId: toOptionalString(raw.runId),
    toolName: toOptionalString(raw.toolName),
    toolCallId: toOptionalString(raw.toolCallId),
    redaction: toOptionalString(raw.redaction),
  };
}

// ── Pure grouping (no I/O — unit-testable) ─────────────────────────────

interface ToolAccumulator {
  toolCallId: string;
  started?: AuditEvent;
  finished?: AuditEvent;
}

function buildToolCall(acc: ToolAccumulator): AuditToolCall {
  const toolName = acc.started?.toolName ?? acc.finished?.toolName ?? "unknown";
  if (acc.started && acc.finished) {
    const startedAt = acc.started.occurredAt;
    const endedAt = acc.finished.occurredAt;
    return {
      toolCallId: acc.toolCallId,
      toolName,
      startedAt,
      endedAt,
      status: acc.finished.status,
      durationMs: Math.max(0, endedAt - startedAt),
    };
  }
  if (acc.started) {
    return {
      toolCallId: acc.toolCallId,
      toolName,
      startedAt: acc.started.occurredAt,
      status: acc.started.status,
    };
  }
  // Only a finished event survived (e.g. its start fell off the page window).
  const finished = acc.finished as AuditEvent;
  return {
    toolCallId: acc.toolCallId,
    toolName,
    startedAt: finished.occurredAt,
    endedAt: finished.occurredAt,
    status: finished.status,
    durationMs: 0,
  };
}

function buildRun(runId: string, events: AuditEvent[]): AuditRun {
  const agentRunEvents = events.filter((e) => e.kind === "agent_run");
  const toolEvents = events.filter((e) => e.kind === "tool_action");

  const startEvent = agentRunEvents.find((e) => e.status === "started");
  const finishEvents = agentRunEvents
    .filter((e) => e.status !== "started")
    .sort((a, b) => b.occurredAt - a.occurredAt);
  const endEvent = finishEvents[0];

  // Fallback anchor when no agent_run event made it into this page — still
  // group the orphaned tool_action events under their shared runId.
  const earliest = events.reduce((min, e) => (e.occurredAt < min.occurredAt ? e : min), events[0] as AuditEvent);

  const toolCallsByCallId = new Map<string, ToolAccumulator>();
  for (const ev of toolEvents) {
    if (!ev.toolCallId) continue; // can't pair without an id — drop it
    let acc = toolCallsByCallId.get(ev.toolCallId);
    if (!acc) {
      acc = { toolCallId: ev.toolCallId };
      toolCallsByCallId.set(ev.toolCallId, acc);
    }
    if (ev.status === "started") {
      if (!acc.started || ev.occurredAt < acc.started.occurredAt) acc.started = ev;
    } else {
      if (!acc.finished || ev.occurredAt > acc.finished.occurredAt) acc.finished = ev;
    }
  }

  const tools = Array.from(toolCallsByCallId.values())
    .map(buildToolCall)
    .sort((a, b) => a.startedAt - b.startedAt);

  const anchor = startEvent ?? endEvent ?? earliest;
  const startedAt = startEvent?.occurredAt ?? earliest.occurredAt;
  const endedAt = endEvent?.occurredAt;
  const status: AuditEventStatus = endEvent?.status ?? (startEvent ? "started" : anchor.status);

  return {
    runId,
    agentId: anchor.agentId,
    sessionKey: anchor.sessionKey,
    sessionId: anchor.sessionId,
    startedAt,
    endedAt,
    status,
    kind: startEvent || endEvent ? "agent_run" : undefined,
    tools,
  };
}

/**
 * Fold a flat page of audit events into per-run traces for the UI. Pure and
 * synchronous — no I/O — so it is directly unit-testable with synthetic
 * events. Malformed entries (missing required fields, unknown kind/status,
 * or no `runId` to group under) are silently dropped. Newest run first.
 */
export function groupRunsFromEvents(events: AuditEvent[]): AuditRun[] {
  const byRun = new Map<string, AuditEvent[]>();
  for (const raw of events) {
    const event = toAuditEvent(raw);
    if (!event || !event.runId) continue;
    const list = byRun.get(event.runId);
    if (list) list.push(event);
    else byRun.set(event.runId, [event]);
  }

  const runs = Array.from(byRun.entries()).map(([runId, evs]) => buildRun(runId, evs));
  runs.sort((a, b) => b.startedAt - a.startedAt);
  return runs;
}
