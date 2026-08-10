/**
 * Shapes the task board and its run UI share.
 *
 * These mirror the server contract in `src/lib/kanban-store.ts` and
 * `src/lib/task-engine-types.ts`. Everything the engine owns is optional on
 * `Task`: boards written before dispatch existed must keep rendering, and a
 * client must never send an engine-owned field back.
 */

export type Column = { id: string; title: string; color: string };

/** Where a dispatched card runs. Absent means "agent" — the original behaviour. */
export type DispatchAssignee = "agent" | "subagent";

/**
 * What the agent is doing. `column` is where the card sits; the engine keeps the
 * two consistent and records why every time it moves one.
 *
 *   idle → dispatching → running ─┬→ completed    (agent said DONE:)
 *                                 ├→ asking       (agent said NEEDS_INPUT:)
 *                                 ├→ needs-review (no marker — we do not know)
 *                                 ├→ failed
 *                                 └→ cancelled
 */
export type DispatchStatus =
  | "idle"
  | "dispatching"
  | "running"
  | "asking"
  | "needs-review"
  | "completed"
  | "failed"
  | "cancelled";

/** How much to trust a question. See `questionCopy` below. */
export type QuestionConfidence = "high" | "low";

export type TaskTransition = {
  at: number;
  from: DispatchStatus | null;
  to: DispatchStatus;
  /** Present only when the card actually moved column. */
  fromColumn?: string;
  toColumn?: string;
  by: "user" | "agent" | "system";
  /** Written for a human. Render verbatim. */
  reason: string;
};

export type Task = {
  id: number;
  title: string;
  description?: string;
  column: string;
  priority: string;
  assignee?: string;
  attachments?: string[];
  agentId?: string;
  /* ── engine-owned below: display, never send back ── */
  dispatchAssignee?: DispatchAssignee;
  dispatchStatus?: DispatchStatus;
  dispatchRunId?: string;
  dispatchSessionKey?: string;
  dispatchSessionId?: string;
  dispatchedAt?: number;
  completedAt?: number;
  dispatchError?: string;
  dispatchResultText?: string;
  dispatchResultTruncated?: boolean;
  dispatchStopReason?: string;
  dispatchRuntimeMs?: number;
  dispatchTotalTokens?: number;
  dispatchCostUsd?: number;
  /** The question, or the final text when confidence is low. */
  dispatchQuestion?: string;
  dispatchConfidence?: QuestionConfidence;
  /** Where the card returns to when the question is answered. */
  askedFromColumn?: string;
  /** 1 on dispatch, +1 per answer. */
  dispatchTurns?: number;
  dispatchTransitions?: TaskTransition[];
};

/**
 * Fields the engine owns. A board write must strip these — the server takes
 * them from disk regardless, but sending them back invites confusion.
 */
export const ENGINE_OWNED_FIELDS = [
  "dispatchAssignee",
  "dispatchStatus",
  "dispatchRunId",
  "dispatchSessionKey",
  "dispatchSessionId",
  "dispatchedAt",
  "completedAt",
  "dispatchError",
  "dispatchResultText",
  "dispatchResultTruncated",
  "dispatchStopReason",
  "dispatchRuntimeMs",
  "dispatchTotalTokens",
  "dispatchCostUsd",
  "dispatchQuestion",
  "dispatchConfidence",
  "askedFromColumn",
  "dispatchTurns",
  "dispatchTransitions",
] as const;

export type AgentInfo = { id: string; name: string; emoji: string };

export type KanbanData = {
  columns: Column[];
  tasks: Task[];
  /** Bumped on every server write. Send it back on PUT to get conflict detection. */
  rev?: number;
  _fileExists?: boolean;
};

/* ── live run state ───────────────────────────────── */

export type ActivityKind =
  | "lifecycle"
  | "tool"
  | "assistant"
  | "question"
  | "result"
  | "error"
  | "system";

export type TaskActivityLine = {
  /** Stable within a run — key the list on this, never on the index. */
  id: string;
  at: number;
  kind: ActivityKind;
  /** The gateway's own wording. Render as-is. */
  text: string;
  /** Tool lines are rewritten in place as the step progresses. */
  itemId?: string;
  /** True while the step is still running — worth its own small spinner. */
  pending?: boolean;
};

export type TaskQuestion = {
  text: string;
  confidence: QuestionConfidence;
  askedFromColumn: string | null;
  askedAt: number;
};

export type TaskRunResult = {
  text: string | null;
  truncated: boolean;
  stopReason: string | null;
  runtimeMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

/** Everything the board needs to render one card's live state. */
export type TaskRunSnapshot = {
  taskId: number;
  status: DispatchStatus;
  column: string;
  agentId: string | null;
  assignee: DispatchAssignee;
  runId: string | null;
  sessionKey: string | null;
  sessionId: string | null;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  turns: number;
  /** The current turn's text as it is typed — drives the live caret. */
  streamingText: string | null;
  activity: TaskActivityLine[];
  question: TaskQuestion | null;
  result: TaskRunResult | null;
  error: string | null;
  transitions: TaskTransition[];
  /** False means the gateway socket is down — soften "live" affordances. */
  live: boolean;
};

export type StreamEvents = {
  connected: boolean;
  subscribers: number;
  connectedSince: number | null;
  lastEventAt: number | null;
  lastError: string | null;
};

/* ── helpers ──────────────────────────────────────── */

/** States where the gateway may still be working. */
export function isRunActive(status: DispatchStatus | undefined | null): boolean {
  return status === "dispatching" || status === "running";
}

/** States where the card is waiting on the user and cannot proceed alone. */
export function isAwaitingUser(status: DispatchStatus | undefined | null): boolean {
  return status === "asking" || status === "needs-review";
}

/** States worth showing a run strip for at all. */
export function hasRun(task: Task): boolean {
  return Boolean(task.dispatchStatus && task.dispatchStatus !== "idle");
}

export type ColumnRole = "in-progress" | "review" | "done";

/**
 * Columns are user-editable, so a role is matched the way the server matches it
 * — canonical id, then id-as-title, then title. A board with a column called
 * "Doing" still counts as in-progress.
 */
const ROLE_TITLES: Record<ColumnRole, string[]> = {
  "in-progress": ["in progress", "in-progress", "inprogress", "doing", "active", "wip"],
  review: ["review", "needs review", "in review", "blocked", "waiting"],
  done: ["done", "complete", "completed", "finished", "shipped"],
};

export function columnHasRole(
  columns: Column[],
  columnId: string,
  role: ColumnRole,
): boolean {
  if (columnId === role) return true;
  const column = columns.find((c) => c.id === columnId);
  if (!column) return false;
  const wanted = ROLE_TITLES[role];
  return (
    wanted.includes(String(column.id).toLowerCase()) ||
    wanted.includes(String(column.title ?? "").toLowerCase().trim())
  );
}

/**
 * Should moving a card from `fromColumnId` to `toColumnId` start a run?
 *
 * The board's promise is that In Progress means an agent is working right now.
 * A card dropped there with nothing running breaks that promise, so the drop
 * IS the request to start. Pure and exported because it decides whether a real
 * agent runs on the user's machine, which is not a rule to leave implicit
 * inside a drag handler.
 *
 * Three things must stay true:
 *   - only a move that ENTERS in-progress starts anything, so reordering inside
 *     the column (or between two in-progress-ish columns) never double-runs;
 *   - a card that is already running is never dispatched again — the caller
 *     offers to stop it instead;
 *   - custom column names count, because the board is user-editable and a
 *     column called "Doing" carries the same meaning.
 */
export function shouldDispatchOnMove(input: {
  columns: Column[];
  fromColumnId: string;
  toColumnId: string;
  status?: DispatchStatus;
}): boolean {
  const { columns, fromColumnId, toColumnId, status } = input;
  if (fromColumnId === toColumnId) return false;
  if (isRunActive(status) || isAwaitingUser(status)) return false;
  if (!columnHasRole(columns, toColumnId, "in-progress")) return false;
  return !columnHasRole(columns, fromColumnId, "in-progress");
}

/**
 * Whether the status earns a label of its own next to the column name.
 *
 * The column already carries most of this: `completed` in Done and `running` in
 * In Progress say nothing the user cannot already see — and while running, the
 * run panel right below is showing a spinner and a clock as well, so a third
 * copy is pure noise.
 *
 * `asking`, `needs-review`, `failed` and `cancelled` always earn it. In
 * particular `needs-review` never moves the card, so without the label there
 * would be nothing at all to distinguish it.
 */
export function statusIsRedundant(
  status: DispatchStatus | undefined,
  columnId: string,
  columns: Column[] = [],
): boolean {
  if (!status || status === "idle") return true;
  if (status === "completed") return columnHasRole(columns, columnId, "done");
  if (status === "running" || status === "dispatching") {
    return columnHasRole(columns, columnId, "in-progress");
  }
  return false;
}

/**
 * Copy for a card waiting on the user. The two cases must never be collapsed:
 * one is the agent asking, the other is the board admitting it cannot tell
 * "finished" from "asking".
 */
export function questionCopy(confidence: QuestionConfidence | undefined): {
  heading: string;
  lead: string;
  short: string;
} {
  if (confidence === "low") {
    return {
      heading: "Finished — needs your review",
      lead: "The run ended without saying whether it was done or waiting on you. Here is the last thing it said.",
      short: "Needs your review",
    };
  }
  return {
    heading: "The agent asked",
    lead: "The agent stopped to ask you this:",
    short: "Waiting on you",
  };
}

const MARKER_PREFIX = /^\s*(?:DONE|NEEDS_INPUT)\s*:[ \t]*/i;

/**
 * `dispatchResultText` carries the agent's marker line — sometimes after the
 * body ("PELICAN\n\nDONE: Said PELICAN"), sometimes as the entire result
 * ("DONE: Ran sleep 25 and finished waiting.").
 *
 * When there is a body elsewhere the marker is bookkeeping and goes; when the
 * marker line is all there is, its own text is the result, so only the prefix
 * goes. Returning the raw string in that second case would show the user
 * "DONE:" in the middle of the card, which is what this used to do.
 */
export function stripMarker(text: string | null | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (!trimmed) return "";

  const lines = trimmed.split("\n");
  const markerIdx = lines.findIndex((line) => MARKER_PREFIX.test(line));
  if (markerIdx === -1) return trimmed;

  const rest = lines.filter((_, i) => i !== markerIdx).join("\n").trim();
  if (rest) return rest;
  return lines[markerIdx].replace(MARKER_PREFIX, "").trim() || trimmed;
}

/** `1:04`, `12s`, `2h 05m` — short enough to sit in a meta row. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `1.2k`, `18.4k`, `340` — token counts read as magnitude, not accountancy. */
export function formatTokens(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number | null | undefined): string | null {
  if (usd == null || !Number.isFinite(usd) || usd <= 0) return null;
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Offset from the run's first tick — `+0:04`. Absolute clocks are noise here. */
export function formatOffset(at: number | null, origin: number | null): string {
  if (at == null || origin == null) return "";
  // The prompt is stamped a beat before the session starts. Clamp rather than
  // leave a blank gutter where every other line has a time.
  const total = Math.max(0, Math.floor((at - origin) / 1000));
  const minutes = Math.floor(total / 60);
  return `+${minutes}:${String(total % 60).padStart(2, "0")}`;
}

export function agentLabel(agents: AgentInfo[], agentId: string | undefined | null): string {
  if (!agentId) return "Unassigned";
  const agent = agents.find((a) => a.id === agentId);
  return agent ? agent.name : agentId;
}

export function agentEmoji(agents: AgentInfo[], agentId: string | undefined | null): string {
  if (!agentId) return "";
  return agents.find((a) => a.id === agentId)?.emoji || "🤖";
}

export function columnTitle(columns: Column[], columnId: string | null | undefined): string {
  if (!columnId) return "";
  return columns.find((c) => c.id === columnId)?.title ?? columnId;
}
