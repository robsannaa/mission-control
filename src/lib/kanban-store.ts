/**
 * Kanban board file store — the single writer for `kanban.json`.
 *
 * The board lives in the user's real workspace and is a read-modify-write JSON
 * file with no locking of its own. Two writers that overlap (an API request and
 * the background run waiter, say) silently lose one of the two edits, so every
 * mutation here goes through one in-process queue: read, mutate, write, notify.
 *
 * The queue is parked on `globalThis` so `next dev` hot reloads do not hand out
 * a second, independent lock for the same file.
 */

import { join } from "path";
import { getDefaultWorkspace } from "./paths";
import { getClient } from "./openclaw";
import { notifyKanbanUpdated } from "./kanban-live";

/* ── types ────────────────────────────────────────── */

/** Where a dispatched task runs: the agent's own session, or an isolated subagent. */
export type DispatchAssignee = "agent" | "subagent";

/**
 * What the agent on this card is doing.
 *
 * Two states beyond "did it work":
 *
 *   - `asking`       — the agent stopped and asked the user a question, and
 *                      said so with the `NEEDS_INPUT:` marker. The card moved
 *                      itself to Review and is waiting for an answer.
 *   - `needs-review` — the run ended without either marker. We do not know
 *                      whether that was a question or a completion, so the card
 *                      stays where it is and asks the user to decide. Guessing
 *                      here is what buries questions in Done.
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

/** Why a card is where it is. Recorded so the UI can explain a move it did not make. */
export type TaskTransition = {
  at: number;
  /** Dispatch status before and after. */
  from: DispatchStatus | null;
  to: DispatchStatus;
  /** Board column before and after — absent when the card did not move. */
  fromColumn?: string;
  toColumn?: string;
  /** Who caused it: the person, the agent's own output, or a recovery path. */
  by: "user" | "agent" | "system";
  /** One line, written for a human reading the card. */
  reason: string;
};

/** How many transitions a card keeps. Enough to explain itself, not a log file. */
export const MAX_TRANSITIONS = 12;

export type KanbanTask = {
  id: number;
  title: string;
  description?: string;
  /** Standing instructions for the agent — used as the run context every time
   *  this card is dispatched. Authored by the user, so client-writable. */
  customPrompt?: string;
  column: string;
  priority: string;
  assignee?: string;
  attachments?: string[];
  /** Which agent owns this task. Unchanged meaning — existing boards keep working. */
  agentId?: string;
  /** Epoch ms. Backfilled on first write for boards that predate these. */
  createdAt?: number;
  /** Epoch ms, bumped only when a person edits the card — not by run activity. */
  updatedAt?: number;
  /** Run target. Absent means "agent" (the pre-existing behaviour). */
  dispatchAssignee?: DispatchAssignee;
  dispatchStatus?: DispatchStatus;
  dispatchRunId?: string;
  /** Session the run lives in — required to read progress, results, or abort. */
  dispatchSessionKey?: string;
  dispatchedAt?: number;
  completedAt?: number;
  dispatchError?: string;
  /** Final assistant text, bounded — see MAX_RESULT_CHARS. */
  dispatchResultText?: string;
  dispatchResultTruncated?: boolean;
  dispatchStopReason?: string;
  dispatchRuntimeMs?: number;
  dispatchTotalTokens?: number;
  dispatchCostUsd?: number;
  /** Gateway session id — stable across resumes, useful for deep links. */
  dispatchSessionId?: string;
  /** The question the agent stopped to ask. Present while `asking`. */
  dispatchQuestion?: string;
  /**
   * How sure we are that `dispatchQuestion` / the terminal state is right.
   * `high` = the agent emitted the marker. `low` = we are inferring.
   */
  dispatchConfidence?: "high" | "low";
  /**
   * Column the card sat in when the agent asked. Answering restores it — the
   * card came from somewhere and must go back there, not to a guessed default.
   */
  askedFromColumn?: string;
  /** Turns taken in this session: 1 on dispatch, +1 on every answer. */
  dispatchTurns?: number;
  /** Why the card moved, newest last. Bounded to MAX_TRANSITIONS. */
  dispatchTransitions?: TaskTransition[];
};

export type KanbanColumn = { id: string; title: string; color: string };

export type KanbanData = {
  columns: KanbanColumn[];
  tasks: KanbanTask[];
  /**
   * Bumped on every write. A client that read revision N and writes back with
   * `rev: N` is telling us what it believed; if the board has since moved on,
   * that write is rejected instead of silently erasing whatever changed. This is
   * the guard against the whole-blob overwrite that used to lose data.
   */
  rev?: number;
};

export const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: "backlog", title: "Backlog", color: "#6b7280" },
  { id: "in-progress", title: "In Progress", color: "#f59e0b" },
  { id: "review", title: "Review", color: "#8b5cf6" },
  { id: "done", title: "Done", color: "#10b981" },
];

/** Dispatch states where the gateway may still be working on the task. */
export const ACTIVE_DISPATCH_STATUSES: ReadonlySet<DispatchStatus> = new Set<DispatchStatus>([
  "dispatching",
  "running",
]);

/** States where the card is waiting on the user, not on the agent. */
export const WAITING_DISPATCH_STATUSES: ReadonlySet<DispatchStatus> = new Set<DispatchStatus>([
  "asking",
  "needs-review",
]);

/**
 * Fields Mission Control owns. A board written by the UI carries whatever it
 * last read for these, which may be minutes stale — the engine changes them
 * from under it. They are always taken from disk, never from the request.
 */
const ENGINE_OWNED_FIELDS = [
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
] as const satisfies readonly (keyof KanbanTask)[];

/* ── paths ────────────────────────────────────────── */

export async function getKanbanPath(): Promise<string> {
  const ws = await getDefaultWorkspace();
  return join(ws, "kanban.json");
}

/* ── raw read / write ─────────────────────────────── */

export async function readKanban(): Promise<KanbanData> {
  const client = await getClient();
  const raw = await client.readFile(await getKanbanPath());
  const parsed = JSON.parse(raw) as KanbanData;
  return {
    ...parsed,
    columns: Array.isArray(parsed.columns) ? parsed.columns : DEFAULT_COLUMNS,
    tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
    rev: typeof parsed.rev === "number" ? parsed.rev : 0,
  };
}

export async function writeKanban(data: KanbanData): Promise<void> {
  const client = await getClient();
  await client.writeFile(await getKanbanPath(), JSON.stringify(data, null, 2));
}

/** Raised when a whole-board write is based on a revision that has moved on. */
export class KanbanConflictError extends Error {
  constructor(
    readonly expectedRev: number,
    readonly actualRev: number,
    readonly current: KanbanData,
  ) {
    super(
      `Board changed while you were editing it (you had revision ${expectedRev}, it is now ${actualRev}).`,
    );
    this.name = "KanbanConflictError";
  }
}

/**
 * Fold an incoming whole-board write onto what is actually on disk.
 *
 * The UI sends the entire board, which is fine for the fields a person edits and
 * wrong for the fields a running agent edits. A card that moved itself to Review
 * two seconds ago must not snap back because the browser was still holding the
 * old copy. So: user fields from the request, engine fields from disk — except
 * on a card the user is dispatching for the first time, which has none.
 */
/**
 * Fields a person edits. `updatedAt` tracks these and not the engine's own
 * writes — otherwise a running card would restamp itself every few seconds and
 * "last edited" would mean nothing.
 */
const AUTHORED_FIELDS: (keyof KanbanTask)[] = [
  "title",
  "description",
  "customPrompt",
  "column",
  "priority",
  "assignee",
  "agentId",
  "attachments",
];

function authoredContentChanged(next: KanbanTask, prev: KanbanTask): boolean {
  return AUTHORED_FIELDS.some(
    (field) => JSON.stringify(next[field]) !== JSON.stringify(prev[field]),
  );
}

export function mergeBoardWrite(incoming: KanbanData, current: KanbanData): KanbanData {
  const now = Date.now();
  const byId = new Map(current.tasks.map((t) => [t.id, t]));
  const tasks = incoming.tasks.map((task) => {
    const disk = byId.get(task.id);
    if (!disk) return { ...task, createdAt: task.createdAt ?? now, updatedAt: now };

    const merged: KanbanTask = { ...task };
    for (const field of ENGINE_OWNED_FIELDS) {
      if (disk[field] === undefined) delete merged[field];
      else Object.assign(merged, { [field]: disk[field] });
    }

    // The assignee (agent vs. isolated subagent) is the user's choice for the
    // NEXT run, so it is client-writable — except while a run is in flight, when
    // the live run's assignee is a fact the browser must not override. It is
    // pinned above with the other dispatch* fields; take the request's value
    // back whenever the card is idle. (Without this the picker silently did
    // nothing on any card that had run before.)
    if (
      !ACTIVE_DISPATCH_STATUSES.has(disk.dispatchStatus as DispatchStatus) &&
      task.dispatchAssignee !== undefined
    ) {
      merged.dispatchAssignee = task.dispatchAssignee;
    }

    // A board is stored as a file, so these can be missing on older boards or
    // on cards an agent wrote by hand. Backfill rather than leaving a gap.
    merged.createdAt = disk.createdAt ?? task.createdAt ?? now;
    merged.updatedAt = authoredContentChanged(merged, disk)
      ? now
      : (disk.updatedAt ?? task.updatedAt);
    return merged;
  });

  // Deleting a card is a legitimate edit — unless the card is mid-run or
  // holding an unanswered question, and the writer simply never knew it existed.
  // A client that sends a board it read before the card was dispatched would
  // otherwise silently orphan a live agent: the run keeps going with nothing on
  // the board to stop it, show it, or answer it.
  const kept = new Set(tasks.map((t) => t.id));
  const rescued = current.tasks.filter(
    (t) =>
      !kept.has(t.id) &&
      t.dispatchStatus !== undefined &&
      (ACTIVE_DISPATCH_STATUSES.has(t.dispatchStatus) ||
        WAITING_DISPATCH_STATUSES.has(t.dispatchStatus)),
  );

  return { columns: incoming.columns, tasks: [...tasks, ...rescued], rev: current.rev ?? 0 };
}

/* ── serialised mutation ──────────────────────────── */

type QueueHolder = { __mcKanbanQueue?: Promise<unknown> };

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const holder = globalThis as unknown as QueueHolder;
  const prev = holder.__mcKanbanQueue ?? Promise.resolve();
  // Run the job whether the previous one settled or threw — one failed write
  // must not wedge the queue for the lifetime of the process.
  const next = prev.then(job, job);
  holder.__mcKanbanQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export type Mutation<T> = (data: KanbanData) => { save: boolean; result: T };

/**
 * Read the board, apply `mutator`, and write it back — serialised against every
 * other mutation in this process. Keep the mutator synchronous and cheap: it
 * holds the lock, so no gateway calls inside it.
 */
export async function mutateKanban<T>(mutator: Mutation<T>): Promise<T> {
  return enqueue(async () => {
    const data = await readKanban();
    const { save, result } = mutator(data);
    if (save) {
      data.rev = (data.rev ?? 0) + 1;
      await writeKanban(data);
      notifyKanbanUpdated();
    }
    return result;
  });
}

/**
 * Replace the whole board (the PUT path), serialised with everything else.
 *
 * `expectedRev` makes the write conditional: pass the revision the client read
 * and a concurrent change rejects it instead of erasing it. Omitting it keeps
 * the older, unconditional behaviour for clients that predate revisions — those
 * are still protected by the engine-owned field merge, which is the half that
 * actually lost run state.
 */
export async function saveKanban(
  data: KanbanData,
  expectedRev?: number,
): Promise<KanbanData> {
  return enqueue(async () => {
    const current = await readKanban().catch(
      (): KanbanData => ({ columns: DEFAULT_COLUMNS, tasks: [], rev: 0 }),
    );
    const actualRev = current.rev ?? 0;
    if (typeof expectedRev === "number" && expectedRev !== actualRev) {
      throw new KanbanConflictError(expectedRev, actualRev, current);
    }
    const merged = mergeBoardWrite(data, current);
    merged.rev = actualRev + 1;
    await writeKanban(merged);
    notifyKanbanUpdated();
    return merged;
  });
}

/**
 * Patch one task by id. Returns the patched task, or null when the task is gone
 * (it may have been deleted while a run was in flight — that is not an error).
 */
export async function patchTask(
  taskId: number,
  patch: Partial<KanbanTask> | ((task: KanbanTask) => Partial<KanbanTask>),
): Promise<KanbanTask | null> {
  return mutateKanban((data) => {
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return { save: false, result: null };
    const current = data.tasks[idx];
    const delta = typeof patch === "function" ? patch(current) : patch;
    const next = { ...current, ...delta };
    data.tasks[idx] = next;
    return { save: true, result: next };
  });
}

/* ── column roles ─────────────────────────────────── */

/**
 * The three columns the engine moves cards into. Columns are user-editable, so
 * a role is resolved against the actual board rather than assumed: match the
 * canonical id, then the title, then give up. Giving up is a real outcome — a
 * board with no Review column keeps its asking cards where they are instead of
 * dumping them somewhere arbitrary.
 */
export type ColumnRole = "in-progress" | "review" | "done";

const ROLE_TITLES: Record<ColumnRole, string[]> = {
  "in-progress": ["in progress", "in-progress", "inprogress", "doing", "active", "wip"],
  review: ["review", "needs review", "in review", "blocked", "waiting"],
  done: ["done", "complete", "completed", "finished", "shipped"],
};

export function resolveColumnRole(data: KanbanData, role: ColumnRole): string | null {
  const columns = data.columns ?? [];
  const exact = columns.find((c) => c.id === role);
  if (exact) return exact.id;

  const wanted = ROLE_TITLES[role];
  const byId = columns.find((c) => wanted.includes(String(c.id).toLowerCase()));
  if (byId) return byId.id;

  const byTitle = columns.find((c) =>
    wanted.includes(String(c.title ?? "").toLowerCase().trim()),
  );
  return byTitle?.id ?? null;
}

/**
 * Apply a status change and record why, in one locked write.
 *
 * Every self-driven card move goes through here. The transition list is the
 * only thing that lets the UI say "this moved to Review because the agent asked
 * a question" instead of leaving the user to wonder who touched their board.
 *
 * `toColumnRole` is resolved inside the lock, against the board as it is at that
 * instant — the user may have renamed a column since the run started.
 */
export async function transitionTask(
  taskId: number,
  input: {
    to: DispatchStatus;
    toColumnRole?: ColumnRole;
    /** Explicit column id, used when restoring a remembered one. Wins over the role. */
    toColumn?: string;
    by: TaskTransition["by"];
    reason: string;
    patch?: Partial<KanbanTask> | ((task: KanbanTask) => Partial<KanbanTask>);
  },
): Promise<KanbanTask | null> {
  return mutateKanban((data) => {
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return { save: false, result: null };
    const task = data.tasks[idx];

    const delta =
      typeof input.patch === "function" ? input.patch(task) : (input.patch ?? {});
    const fromStatus = task.dispatchStatus ?? null;
    const fromColumn = task.column;

    const resolved =
      input.toColumn ??
      (input.toColumnRole ? resolveColumnRole(data, input.toColumnRole) : null);
    const toColumn = resolved && data.columns.some((c) => c.id === resolved)
      ? resolved
      : fromColumn;

    const moved = fromColumn !== toColumn;
    const changed = fromStatus !== input.to || moved;
    const entry: TaskTransition = {
      at: Date.now(),
      from: fromStatus,
      to: input.to,
      ...(moved ? { fromColumn, toColumn } : {}),
      by: input.by,
      reason: input.reason,
    };

    const next: KanbanTask = {
      ...task,
      ...delta,
      dispatchStatus: input.to,
      column: toColumn,
      dispatchTransitions: changed
        ? [...(task.dispatchTransitions ?? []), entry].slice(-MAX_TRANSITIONS)
        : task.dispatchTransitions,
    };
    data.tasks[idx] = next;
    return { save: true, result: next };
  });
}

export async function getTask(taskId: number): Promise<KanbanTask | null> {
  const data = await readKanban();
  return data.tasks.find((t) => t.id === taskId) ?? null;
}
