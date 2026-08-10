/**
 * The dispatch engine: cards as live agent runs.
 *
 * A column on this board is not a label a person types, it is a statement about
 * what an agent is doing right now. Keeping that true is this module's whole
 * job — start runs, watch them at gateway speed, move cards when reality moves,
 * and record why so the UI can explain a move nobody made by hand.
 *
 * Three things are worth knowing before reading further.
 *
 * 1. **Events, not polling.** `task`, `agent` and `chat` events reach any
 *    authenticated operator connection with no subscribe call, ~10-20ms after
 *    the fact. The engine holds one socket and fans them out. Polling exists
 *    only as the degraded path (see `reconcile`), never as the normal one.
 *
 * 2. **A question is an outcome.** The gateway cannot tell us whether a run
 *    ended because it finished or because it wants to ask something: verified
 *    on a live gateway, the two are identical in `task.status`,
 *    `terminalSummary`, `agent.wait.status`, `lifecycle.aborted`, `stopReason`
 *    and `session.status`. So the prompt asks the agent to mark it, and
 *    `classifyFinalText` reads the mark. When the mark is missing we say we do
 *    not know instead of inventing a verdict — the old code called every
 *    successful run "done", which is how a question ends up buried in Done.
 *
 * 3. **The board is the durable state.** Run status, the question, the column
 *    it came from and the transition log all live in `kanban.json`, written
 *    through the store's serialised queue. Only the live log and streaming text
 *    are in memory, because those are worth nothing after a restart anyway —
 *    and the card that owns them is reconciled on the way back up.
 */

import { gatewayCall } from "./openclaw";
import { getGatewayRpcChannel } from "./gateway-rpc-channel";
import { notifyTaskRun } from "./kanban-live";
import {
  ACTIVE_DISPATCH_STATUSES,
  getTask,
  patchTask,
  readKanban,
  transitionTask,
  type DispatchAssignee,
  type DispatchStatus,
  type KanbanTask,
  type TaskTransition,
} from "./kanban-store";
import {
  abortRun,
  boundText,
  describeSession,
  errorMessage,
  fetchHistory,
  finalAssistantText,
  lastToolError,
  mainTaskSessionKey,
  sessionIsRunning,
  subagentSessionKey,
  type AgentAccepted,
} from "./task-dispatch";
import { buildAnswerPrompt, buildCardPrompt, classifyFinalText } from "./task-markers";
import type {
  TaskActivityLine,
  TaskQuestion,
  TaskRunResult,
  TaskRunSnapshot,
} from "./task-engine-types";

/* ── tuning ───────────────────────────────────────── */

/** Live log depth per card. Enough to see what it is doing, not a transcript. */
const MAX_ACTIVITY = 60;

/**
 * Grace period between "the run ended" and deciding what that meant.
 *
 * The terminal signals race: `task` flips to completed, `agent` lifecycle hits
 * `end`, and `chat` publishes the final text, all within a few milliseconds and
 * in no guaranteed order. Settling on the first one would classify a card
 * before its text arrived and cost a `chat.history` round-trip to recover.
 */
const SETTLE_GRACE_MS = 700;

/** How often stalled cards are checked against the gateway. */
const WATCHDOG_INTERVAL_MS = 20_000;

/**
 * Silence that makes a running card suspicious. Long enough that a thinking
 * agent is never disturbed, short enough that a dropped socket or a restart
 * does not leave a card spinning forever — the failure mode of the old
 * `agent.wait` path, which simply gave up after 300s and never said so.
 */
const STALE_AFTER_MS = 60_000;

/**
 * Cap for an unmarked run's final text when it is stored as the card's open
 * question. It lands in the user's kanban.json and in every later snapshot, so
 * it cannot be unbounded — a run can end with a whole file listing.
 */
const MAX_QUESTION_CHARS = 2000;

/* ── in-memory run registry ───────────────────────── */

type TerminalSignal = "completed" | "failed" | "cancelled" | "timed_out";

type RunState = {
  taskId: number;
  agentId: string;
  assignee: DispatchAssignee;
  sessionKey: string;
  runId: string | null;
  sessionId: string | null;
  status: DispatchStatus;
  column: string;
  turns: number;
  startedAt: number | null;
  endedAt: number | null;
  updatedAt: number;
  activity: TaskActivityLine[];
  streamingText: string;
  question: TaskQuestion | null;
  result: TaskRunResult | null;
  error: string | null;
  transitions: TaskTransition[];

  /** Final assistant text, from whichever source got there first. */
  finalText: string | null;
  stopReason: string | null;
  usage: { runtimeMs?: number; totalTokens?: number; costUsd?: number };
  terminal: TerminalSignal | null;
  settleTimer: ReturnType<typeof setTimeout> | null;
  /** Guards the settle path against the three terminal signals racing. */
  settling: boolean;
  /**
   * Consecutive reconcile passes where the gateway reported no such session.
   * Two in a row means the run is genuinely gone, not briefly unregistered.
   */
  missingChecks?: number;
  activitySeq: number;
  /**
   * Tool calls already titled by the richer `tool` view of an item. The gateway
   * reports one exec twice — once as `kind:"tool"` and once as `kind:"command"`,
   * sharing a `toolCallId` — and a log that lists every step twice is noise
   * wearing the costume of detail.
   */
  toolTitled: Set<string>;
  /** True while a reconcile is in flight, so the watchdog does not pile on. */
  reconciling: boolean;
};

type Registry = {
  runs: Map<number, RunState>;
  bySession: Map<string, number>;
  byRun: Map<string, number>;
  unsubscribe: (() => void) | null;
  /** The channel the subscription is attached to — see `ensureTaskEngine`. */
  channel: unknown;
  /** The module evaluation that owns the subscription — see `MODULE_INSTANCE`. */
  owner: unknown;
  watchdog: ReturnType<typeof setInterval> | null;
  started: boolean;
  hydrating: Promise<void> | null;
};

type Holder = { __mcTaskEngine?: Registry };

/**
 * Identity of this module evaluation.
 *
 * The registry lives on globalThis so live runs survive a hot reload, but the
 * event handler is a closure over *this* module's code. Without a token to
 * compare against, a reloaded module would find `started: true`, leave the old
 * subscription in place, and keep running the previous build's handler against
 * the new build's state — a class of bug that presents as "my change had no
 * effect" and would eventually present as two builds fighting over one board.
 */
const MODULE_INSTANCE = {};

function registry(): Registry {
  const holder = globalThis as Holder;
  holder.__mcTaskEngine ??= {
    runs: new Map(),
    bySession: new Map(),
    byRun: new Map(),
    unsubscribe: null,
    channel: null,
    owner: null,
    watchdog: null,
    started: false,
    hydrating: null,
  };
  return holder.__mcTaskEngine;
}

function indexRun(state: RunState): void {
  const reg = registry();
  reg.runs.set(state.taskId, state);
  reg.bySession.set(state.sessionKey, state.taskId);
  if (state.runId) reg.byRun.set(state.runId, state.taskId);
}

function newRunState(input: {
  task: KanbanTask;
  agentId: string;
  assignee: DispatchAssignee;
  sessionKey: string;
}): RunState {
  return {
    taskId: input.task.id,
    agentId: input.agentId,
    assignee: input.assignee,
    sessionKey: input.sessionKey,
    runId: null,
    sessionId: input.task.dispatchSessionId ?? null,
    status: "dispatching",
    column: input.task.column,
    turns: input.task.dispatchTurns ?? 0,
    startedAt: Date.now(),
    endedAt: null,
    updatedAt: Date.now(),
    activity: [],
    streamingText: "",
    question: null,
    result: null,
    error: null,
    transitions: input.task.dispatchTransitions ?? [],
    finalText: null,
    stopReason: null,
    usage: {},
    terminal: null,
    settleTimer: null,
    settling: false,
    activitySeq: 0,
    toolTitled: new Set(),
    reconciling: false,
  };
}

/* ── snapshots ────────────────────────────────────── */

function snapshot(state: RunState): TaskRunSnapshot {
  return {
    taskId: state.taskId,
    status: state.status,
    column: state.column,
    agentId: state.agentId,
    assignee: state.assignee,
    runId: state.runId,
    sessionKey: state.sessionKey,
    sessionId: state.sessionId,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    updatedAt: state.updatedAt,
    turns: state.turns,
    streamingText: state.streamingText || null,
    activity: state.activity,
    question: state.question,
    result: state.result,
    error: state.error,
    transitions: state.transitions,
    live: getGatewayRpcChannel().getEventsStatus().connected,
  };
}

/** Snapshot every card the engine knows about. Memory only — safe to poll hard. */
export function listRunSnapshots(): TaskRunSnapshot[] {
  return [...registry().runs.values()].map(snapshot);
}

export function getRunSnapshot(taskId: number): TaskRunSnapshot | null {
  const state = registry().runs.get(taskId);
  return state ? snapshot(state) : null;
}

export function getEventsStatus() {
  return getGatewayRpcChannel().getEventsStatus();
}

function touch(state: RunState, push = true): void {
  state.updatedAt = Date.now();
  if (push) notifyTaskRun(snapshot(state));
}

function addActivity(
  state: RunState,
  kind: TaskActivityLine["kind"],
  text: string,
  at = Date.now(),
  item?: { itemId: string | null; pending: boolean; preferred: boolean },
): void {
  const trimmed = boundText(text, 400).text;
  if (!trimmed) return;

  // One line per step. The gateway reports the same item at start and at end,
  // retitling it; appending each phase would turn a two-step run into an
  // eight-line log that reads like a stutter.
  if (item?.itemId) {
    const existing = state.activity.find((line) => line.itemId === item.itemId);
    if (existing) {
      // A `command` echo of an item already titled by its `tool` view still
      // carries the phase — take the progress, leave the wording alone.
      if (item.preferred || !state.toolTitled.has(item.itemId)) {
        existing.text = trimmed;
      }
      if (item.preferred) state.toolTitled.add(item.itemId);
      existing.at = at;
      existing.pending = item.pending;
      return;
    }
    if (item.preferred) state.toolTitled.add(item.itemId);
  } else {
    const last = state.activity[state.activity.length - 1];
    if (last && last.kind === kind && last.text === trimmed) return;
  }

  state.activitySeq += 1;
  state.activity.push({
    id: `${state.taskId}-${state.activitySeq}`,
    at,
    kind,
    text: trimmed,
    ...(item?.itemId ? { itemId: item.itemId, pending: item.pending } : {}),
  });
  if (state.activity.length > MAX_ACTIVITY) {
    state.activity.splice(0, state.activity.length - MAX_ACTIVITY);
  }
}

/* ── engine lifecycle ─────────────────────────────── */

/**
 * Start the engine if it is not already running. Idempotent and cheap — every
 * tasks route calls it, because a Next route module is only loaded when it is
 * first hit and there is no other moment that reliably happens.
 */
export function ensureTaskEngine(): void {
  const reg = registry();
  const channel = getGatewayRpcChannel();

  // Re-attach whenever either side of the subscription has been replaced: the
  // channel (a new socket) or this module (a new build). Trusting the `started`
  // flag alone leaves a live subscription pointing at code that no longer
  // exists, and a card that stops moving looks exactly like a card whose agent
  // is thinking.
  if (reg.owner !== MODULE_INSTANCE && reg.watchdog) {
    // The timer closes over the old build too.
    clearInterval(reg.watchdog);
    reg.watchdog = null;
  }
  if (!reg.watchdog) {
    reg.watchdog = setInterval(() => void runWatchdog(), WATCHDOG_INTERVAL_MS);
    reg.watchdog.unref?.();
  }

  if (reg.channel !== channel || reg.owner !== MODULE_INSTANCE) {
    reg.unsubscribe?.();
    reg.unsubscribe = channel.subscribeEvents((event) => {
      try {
        handleGatewayEvent(event.event, event.payload);
      } catch (err) {
        console.warn("[task-engine] event handler failed:", errorMessage(err));
      }
    });
    reg.channel = channel;
    reg.owner = MODULE_INSTANCE;
  }

  if (reg.started) return;
  reg.started = true;

  // Pick up runs that were live when this process last stopped.
  reg.hydrating = hydrateFromBoard().catch((err) => {
    console.warn("[task-engine] hydrate failed:", errorMessage(err));
  });
}

/**
 * Rebuild the registry from the board.
 *
 * A card whose stored status says it was running has to be re-checked against
 * the gateway: the run may have finished, failed, or still be going. Restoring
 * it as "running" and letting the watchdog reconcile is what makes a restart
 * invisible instead of leaving a permanently spinning card.
 */
async function hydrateFromBoard(): Promise<void> {
  const board = await readKanban().catch(() => null);
  if (!board) return;

  for (const task of board.tasks) {
    const status = task.dispatchStatus;
    if (!status || status === "idle") continue;
    if (!task.dispatchSessionKey || !task.agentId) continue;
    if (registry().runs.has(task.id)) continue;

    const state = newRunState({
      task,
      agentId: task.agentId,
      assignee: task.dispatchAssignee ?? "agent",
      sessionKey: task.dispatchSessionKey,
    });
    state.runId = task.dispatchRunId ?? null;
    state.status = status;
    state.startedAt = task.dispatchedAt ?? null;
    state.endedAt = task.completedAt ?? null;
    state.error = task.dispatchError ?? null;
    state.stopReason = task.dispatchStopReason ?? null;
    state.turns = task.dispatchTurns ?? 1;
    state.question = task.dispatchQuestion
      ? {
          text: task.dispatchQuestion,
          confidence: task.dispatchConfidence ?? "low",
          askedFromColumn: task.askedFromColumn ?? null,
          askedAt: task.completedAt ?? Date.now(),
        }
      : null;
    state.result = task.dispatchResultText
      ? {
          text: task.dispatchResultText,
          truncated: task.dispatchResultTruncated === true,
          stopReason: task.dispatchStopReason ?? null,
          runtimeMs: task.dispatchRuntimeMs ?? null,
          totalTokens: task.dispatchTotalTokens ?? null,
          costUsd: task.dispatchCostUsd ?? null,
        }
      : null;
    indexRun(state);

    if (ACTIVE_DISPATCH_STATUSES.has(status)) {
      addActivity(state, "system", "Mission Control restarted — re-checking this run.");
      void reconcile(task.id);
    }
  }
}

/* ── event handling ───────────────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Find the card an event belongs to. runId is exact; sessionKey is the durable handle. */
function stateFor(runId: string | null, sessionKey: string | null): RunState | null {
  const reg = registry();
  if (runId) {
    const byRun = reg.byRun.get(runId);
    if (byRun !== undefined) return reg.runs.get(byRun) ?? null;
  }
  if (sessionKey) {
    const bySession = reg.bySession.get(sessionKey);
    if (bySession !== undefined) {
      const state = reg.runs.get(bySession) ?? null;
      // Late binding: the first event may arrive before the accept response has
      // been written back, so learn the runId from whichever gets here first.
      if (state && runId && !state.runId) {
        state.runId = runId;
        reg.byRun.set(runId, state.taskId);
      }
      return state;
    }
  }
  return null;
}

function handleGatewayEvent(event: string, payload: Record<string, unknown>): void {
  switch (event) {
    case "task":
      return handleTaskEvent(payload);
    case "agent":
      return handleAgentEvent(payload);
    case "chat":
      return handleChatEvent(payload);
    case "rpc.result":
      return handleRunResult(payload);
    case "rpc.disconnected":
      // Nothing to update on the cards themselves — `live: false` in the
      // snapshot already tells the UI to stop trusting freshness, and the
      // watchdog picks up whatever was missed.
      return;
    default:
      return;
  }
}

/** Ledger row for the run. The only signal with no ceiling on how long a run may take. */
function handleTaskEvent(payload: Record<string, unknown>): void {
  const task = asRecord(payload.task);
  if (!task) return;
  const state = stateFor(
    str(task.runId),
    str(task.sessionKey) ?? str(task.ownerKey) ?? str(task.childSessionKey),
  );
  if (!state) return;

  const status = str(task.status);
  const startedAt = num(task.startedAt);
  if (startedAt && !state.startedAt) state.startedAt = startedAt;

  if (status === "running" && state.status === "dispatching") {
    void markRunning(state, "The agent picked up the card.");
    return;
  }
  if (status === "completed" || status === "failed" || status === "cancelled" || status === "timed_out") {
    state.endedAt = num(task.endedAt) ?? Date.now();
    const error = str(task.error);
    if (error) state.error = error;
    signalTerminal(state, status);
    return;
  }
  touch(state);
}

/** The agent's own stream: lifecycle, tool activity, and text as it is typed. */
function handleAgentEvent(payload: Record<string, unknown>): void {
  const state = stateFor(str(payload.runId), str(payload.sessionKey));
  if (!state) return;

  const sessionId = str(payload.sessionId);
  if (sessionId && sessionId !== state.sessionId) state.sessionId = sessionId;

  const stream = str(payload.stream);
  const data = asRecord(payload.data) ?? {};
  const at = num(payload.ts) ?? Date.now();

  if (stream === "lifecycle") {
    const phase = str(data.phase);
    if (phase === "start") {
      // The gateway emits `start` for every model turn inside one run, not once
      // per run. Re-stamping here reset the on-card elapsed clock at each tool
      // round-trip, so a long multi-step run always looked like it had just
      // begun. Keep the first start we saw, exactly as `handleTaskEvent` does.
      state.startedAt ??= num(data.startedAt) ?? Date.now();
      // A resumed turn re-enters `running` from `asking`; both go through here.
      void markRunning(state, "The agent started working.");
      return;
    }
    if (phase === "end") {
      state.endedAt = num(data.endedAt) ?? Date.now();
      state.stopReason = str(data.stopReason) ?? state.stopReason;
      signalTerminal(state, data.aborted === true ? "cancelled" : "completed");
      return;
    }
    touch(state);
    return;
  }

  if (stream === "item") {
    // The gateway already writes these for humans ("exec run sleep 5 → print…"),
    // so the live log is its words, not a paraphrase of them.
    const title = str(data.title);
    if (title) {
      const phase = str(data.phase);
      // Key on the tool call, not the item: one exec arrives as two items
      // (`tool:<id>` and `command:<id>`) that describe the same step.
      addActivity(state, "tool", title, at, {
        itemId: str(data.toolCallId) ?? str(data.itemId),
        pending: phase !== "end" && phase !== "error",
        preferred: str(data.kind) !== "command",
      });
      touch(state);
    }
    return;
  }

  if (stream === "assistant") {
    const text = str(data.text);
    if (text) {
      state.streamingText = text;
    } else {
      const delta = str(data.delta);
      if (delta) state.streamingText += delta;
    }
    touch(state);
    return;
  }
}

/** `chat` state:"final" carries the answer text with no extra round-trip. */
function handleChatEvent(payload: Record<string, unknown>): void {
  const state = stateFor(str(payload.runId), str(payload.sessionKey));
  if (!state) return;
  if (str(payload.state) !== "final") return;

  const message = asRecord(payload.message);
  const text = messageText(message);
  if (text) state.finalText = text;
  state.stopReason = str(payload.stopReason) ?? state.stopReason;
  touch(state, false);
}

function messageText(message: Record<string, unknown> | null): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const rec = asRecord(block);
      // An assistant turn can lead with an empty `thinking` block; only `text`
      // blocks are the answer.
      return rec && rec.type === "text" && typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/**
 * The `agent` RPC's second response — the finished run, with its text, duration
 * and token usage. Free: it arrives on a request we already resolved.
 */
function handleRunResult(payload: Record<string, unknown>): void {
  const state = stateFor(str(payload.runId), null);
  if (!state) return;

  const result = asRecord(payload.result);
  const payloads = Array.isArray(result?.payloads) ? result!.payloads : [];
  const first = asRecord(payloads[0]);
  const text = first ? str(first.text) : null;
  if (text && !state.finalText) state.finalText = text;

  const meta = asRecord(result?.meta);
  const durationMs = num(meta?.durationMs);
  if (durationMs !== null) state.usage.runtimeMs = durationMs;

  const agentMeta = asRecord(meta?.agentMeta);
  const sessionId = agentMeta ? str(agentMeta.sessionId) : null;
  if (sessionId) state.sessionId = sessionId;
  const usage = asRecord(agentMeta?.usage);
  const total = usage ? num(usage.total) : null;
  if (total !== null) state.usage.totalTokens = total;

  state.stopReason = str(payload.stopReason) ?? state.stopReason;

  const status = str(payload.status);
  if (status === "timeout" && str(payload.summary) === "aborted") {
    signalTerminal(state, "cancelled");
    return;
  }
  touch(state, false);
}

/* ── status transitions ───────────────────────────── */

async function markRunning(state: RunState, reason: string): Promise<void> {
  if (state.status === "running") {
    touch(state);
    return;
  }
  state.status = "running";
  state.terminal = null;
  state.settling = false;
  addActivity(state, "lifecycle", reason);
  touch(state);

  const patched = await transitionTask(state.taskId, {
    to: "running",
    toColumnRole: "in-progress",
    by: "agent",
    reason,
  }).catch(() => null);
  if (patched) applyBoard(state, patched);
}

/** Record a terminal signal and start the grace timer. First one wins. */
function signalTerminal(state: RunState, signal: TerminalSignal): void {
  if (state.settling) return;
  // A cancel is more specific than a plain completion and may arrive second.
  if (state.terminal && !(signal === "cancelled" && state.terminal === "completed")) {
    touch(state, false);
    return;
  }
  state.terminal = signal;
  touch(state, false);

  if (state.settleTimer) clearTimeout(state.settleTimer);
  state.settleTimer = setTimeout(() => {
    state.settleTimer = null;
    void settle(state);
  }, SETTLE_GRACE_MS);
  state.settleTimer.unref?.();
}

/**
 * Decide what the finished run meant and move the card accordingly.
 *
 * This is where the vision lives or dies. The old code moved every successful
 * run to Done; a run that ended by asking a question therefore landed in Done
 * with the question buried in its result text. Here a question is a first-class
 * outcome, and an unmarked ending is admitted as unknown rather than guessed.
 */
async function settle(state: RunState): Promise<void> {
  if (state.settling) return;
  state.settling = true;
  const terminal = state.terminal ?? "completed";

  try {
    // One `chat.history` call, and only when the event stream did not already
    // hand us the text. This is the fallback, not the path.
    if (!state.finalText || terminal === "failed") {
      const history = await fetchHistory(state.sessionKey, state.agentId, 50).catch(() => null);
      if (history) {
        if (!state.finalText) state.finalText = finalAssistantText(history.messages) || null;
        if (terminal === "failed" && !state.error) {
          state.error = lastToolError(history.messages) || null;
        }
        const info = history.sessionInfo;
        state.sessionId = history.sessionId ?? state.sessionId;
        state.usage.runtimeMs ??= info?.runtimeMs ?? undefined;
        state.usage.totalTokens ??= info?.totalTokens ?? undefined;
        state.usage.costUsd ??= info?.estimatedCostUsd ?? undefined;
      }
    }

    // Price the run. `chat.history` reports `estimatedCostUsd` as null on runs
    // where `sessions.describe` returns a real figure, so this one extra call
    // at the end of a run is the difference between showing a cost and not.
    if (state.usage.costUsd === undefined || state.usage.totalTokens === undefined) {
      const session = await describeSession(state.sessionKey).catch(() => null);
      if (session) {
        state.usage.costUsd ??= session.estimatedCostUsd ?? undefined;
        state.usage.totalTokens ??= session.totalTokens ?? undefined;
        state.usage.runtimeMs ??= session.runtimeMs ?? undefined;
        state.sessionId ??= session.sessionId ?? null;
      }
    }

    state.endedAt ??= Date.now();
    state.streamingText = "";

    if (terminal === "cancelled") return finishCancelled(state);
    if (terminal === "failed" || terminal === "timed_out") return finishFailed(state, terminal);
    return finishCompleted(state);
  } catch (err) {
    state.error = errorMessage(err);
    await applyTransition(state, {
      to: "failed",
      by: "system",
      reason: `Could not read how the run ended: ${state.error}`,
    });
  }
}

function buildResult(state: RunState): TaskRunResult {
  const bounded = boundText(state.finalText ?? "");
  return {
    text: bounded.text || null,
    truncated: bounded.truncated,
    stopReason: state.stopReason,
    runtimeMs:
      state.usage.runtimeMs ??
      (state.startedAt && state.endedAt ? state.endedAt - state.startedAt : null),
    totalTokens: state.usage.totalTokens ?? null,
    costUsd: state.usage.costUsd ?? null,
  };
}

async function finishCompleted(state: RunState): Promise<void> {
  const verdict = classifyFinalText(state.finalText);
  const result = buildResult(state);
  state.result = result;

  if (verdict.kind === "question") {
    /*
     * Where the card goes back to must come from the BOARD, not from engine
     * memory. `state.column` only tracks the engine's own moves, so any write
     * from elsewhere — a second tab, another client, or the agent editing
     * kanban.json as TASKS.md tells it to — leaves it stale, and the card is
     * later "restored" to a column it had already left. The patch callback runs
     * inside the store lock with the real task, so read it there.
     */
    let askedFrom = state.column;
    addActivity(state, "question", verdict.question);
    await applyTransition(state, {
      to: "asking",
      toColumnRole: "review",
      by: "agent",
      reason: "The agent stopped to ask you a question.",
      patch: (task) => {
        askedFrom = task.column;
        return {
          dispatchQuestion: verdict.question,
          dispatchConfidence: "high",
          askedFromColumn: task.column,
          ...resultPatch(result),
          dispatchError: undefined,
          completedAt: state.endedAt ?? Date.now(),
        };
      },
    });
    state.question = {
      text: verdict.question,
      confidence: "high",
      askedFromColumn: askedFrom,
      askedAt: Date.now(),
    };
    return;
  }

  if (verdict.kind === "done") {
    state.question = null;
    addActivity(state, "result", verdict.summary);
    await applyTransition(state, {
      to: "completed",
      toColumnRole: "done",
      by: "agent",
      reason: `The agent finished: ${boundText(verdict.summary, 120).text}`,
      patch: {
        dispatchQuestion: undefined,
        dispatchConfidence: "high",
        askedFromColumn: undefined,
        ...resultPatch(result),
        dispatchError: undefined,
        completedAt: state.endedAt ?? Date.now(),
      },
    });
    return;
  }

  // No marker. The run ended cleanly and we genuinely cannot tell whether that
  // was an answer or a question. Leave the card where it is and hand the call
  // to the user — a regex guess here is what strands cards in Review.
  // Unbounded: an unmarked run can end with a whole file listing or stack
  // trace, and this text is persisted to the user's kanban.json and pushed in
  // every later snapshot. Every other stored run text is capped; so is this.
  const questionText = boundText(verdict.text, MAX_QUESTION_CHARS).text;

  let askedFrom = state.column;
  addActivity(state, "result", verdict.text || "The run ended without a summary.");
  await applyTransition(state, {
    to: "needs-review",
    by: "agent",
    reason: "The run ended without saying whether it finished or needs input.",
    // Same reason as the question branch: the board is the truth about which
    // column this card is actually in.
    patch: (task) => {
      askedFrom = task.column;
      return {
        dispatchQuestion: questionText || undefined,
        dispatchConfidence: "low",
        askedFromColumn: task.column,
        ...resultPatch(result),
        dispatchError: undefined,
        completedAt: state.endedAt ?? Date.now(),
      };
    },
  });
  state.question = {
    text: questionText,
    confidence: "low",
    askedFromColumn: askedFrom,
    askedAt: Date.now(),
  };
}

async function finishFailed(state: RunState, terminal: TerminalSignal): Promise<void> {
  const result = buildResult(state);
  state.result = result;
  const error =
    state.error ||
    (terminal === "timed_out" ? "The run timed out." : "The run failed for an unknown reason.");
  state.error = error;
  addActivity(state, "error", error);
  await applyTransition(state, {
    to: "failed",
    by: "agent",
    reason: `The run failed: ${boundText(error, 120).text}`,
    patch: {
      ...resultPatch(result),
      dispatchError: boundText(error, 1000).text,
      completedAt: state.endedAt ?? Date.now(),
    },
  });
}

/**
 * Text that only exists BECAUSE the run was aborted.
 *
 * Killing a run surfaces through the model client as a timeout or a transport
 * error, and `settle()` has already adopted whatever arrived as the final text.
 * Showing that under "Last thing it said" presents plumbing to the user as if
 * the agent had said it.
 */
const ABORT_ARTEFACT_RE =
  /^(llm request timed out|request (was )?aborted|aborted|the operation was aborted|socket hang up|fetch failed)\.?$/i;

async function finishCancelled(state: RunState): Promise<void> {
  const result = buildResult(state);
  if (result.text && ABORT_ARTEFACT_RE.test(result.text.trim())) {
    result.text = null;
    result.truncated = false;
  }
  state.result = result;
  state.error = null;
  addActivity(state, "lifecycle", "Stopped.");
  await applyTransition(state, {
    to: "cancelled",
    by: "user",
    reason: "You stopped this run.",
    patch: {
      ...resultPatch(result),
      dispatchError: undefined,
      completedAt: state.endedAt ?? Date.now(),
    },
  });
}

function resultPatch(result: TaskRunResult): Partial<KanbanTask> {
  return {
    dispatchResultText: result.text ?? undefined,
    dispatchResultTruncated: result.truncated || undefined,
    dispatchStopReason: result.stopReason ?? undefined,
    dispatchRuntimeMs: result.runtimeMs ?? undefined,
    dispatchTotalTokens: result.totalTokens ?? undefined,
    dispatchCostUsd: result.costUsd ?? undefined,
  };
}

/**
 * Write a transition to the board and mirror the result back into memory.
 *
 * `patch` is an object here, never a function: this always layers the session id
 * on top, and a function patch would have to be silently discarded or silently
 * composed. Neither is a thing to leave for the next reader to discover.
 */
async function applyTransition(
  state: RunState,
  input: Parameters<typeof transitionTask>[1],
): Promise<void> {
  /*
   * Keep the callback form the store supports: it runs inside the write lock
   * with the card as it really is, which is the only way to read a column that
   * something else may have changed under us.
   */
  const patch = (task: KanbanTask): Partial<KanbanTask> => ({
    ...(typeof input.patch === "function" ? input.patch(task) : (input.patch ?? {})),
    dispatchSessionId: state.sessionId ?? undefined,
  });

  const patched = await transitionTask(state.taskId, { ...input, patch }).catch((err) => {
    console.warn("[task-engine] could not write transition:", errorMessage(err));
    return null;
  });

  state.status = input.to;
  if (patched) applyBoard(state, patched);
  touch(state);
}

/** Keep the in-memory view honest about what actually landed on the board. */
function applyBoard(state: RunState, task: KanbanTask): void {
  state.column = task.column;
  state.status = task.dispatchStatus ?? state.status;
  state.transitions = task.dispatchTransitions ?? state.transitions;
  state.turns = task.dispatchTurns ?? state.turns;
}

/* ── public actions ───────────────────────────────── */

export type DispatchInput = {
  taskId: number;
  agentId?: string;
  assignee?: DispatchAssignee;
  /** Free-form extra context typed by the user at dispatch time. */
  context?: string;
};

export type DispatchResult =
  | { ok: true; taskId: number; runId: string; sessionKey: string; agentId: string; assignee: DispatchAssignee }
  | { ok: false; status: number; error: string; detail?: Record<string, unknown> };

/**
 * Start an agent on a card.
 *
 * Guarded twice over: an in-process set covers the window between claiming the
 * card and writing the runId back, and a stored active status is re-checked
 * against the gateway rather than trusted — a card can read "running" only
 * because the server died mid-run, and that must not block a retry forever.
 */
export async function dispatchTask(input: DispatchInput): Promise<DispatchResult> {
  ensureTaskEngine();

  const board = await readKanban().catch(() => null);
  if (!board) return { ok: false, status: 500, error: "Could not read kanban.json" };

  const task = board.tasks.find((t) => t.id === input.taskId);
  if (!task) return { ok: false, status: 404, error: `Task ${input.taskId} not found` };

  const agentId = input.agentId || task.agentId;
  if (!agentId) {
    return {
      ok: false,
      status: 400,
      error: "No agent assigned. Assign an agent before dispatching.",
    };
  }

  const assignee: DispatchAssignee =
    input.assignee ?? task.dispatchAssignee ?? "agent";

  if (inFlight().has(task.id)) {
    return { ok: false, status: 409, error: "A dispatch for this card is already in flight." };
  }

  if (
    task.dispatchStatus &&
    ACTIVE_DISPATCH_STATUSES.has(task.dispatchStatus) &&
    task.dispatchSessionKey
  ) {
    const live = await fetchHistory(task.dispatchSessionKey, agentId, 1).catch(() => null);
    if (live?.sessionInfo?.hasActiveRun) {
      return {
        ok: false,
        status: 409,
        error: "This card is already running.",
        detail: {
          alreadyRunning: true,
          runId: task.dispatchRunId ?? null,
          sessionKey: task.dispatchSessionKey,
        },
      };
    }
  }

  // A subagent gets a fresh, isolated transcript every dispatch; the agent's own
  // session is reused so a card keeps its history across retries — but only
  // while the same agent owns it. A session key encodes its agent
  // (`agent:<id>:task-<n>`), so reusing one after the card was reassigned would
  // quietly hand the new agent the old one's transcript.
  const reusable =
    assignee === "agent" &&
    task.dispatchAssignee === "agent" &&
    task.agentId === agentId &&
    task.dispatchSessionKey;
  const sessionKey =
    assignee === "subagent"
      ? subagentSessionKey(agentId)
      : reusable || mainTaskSessionKey(agentId, task.id);

  const column = board.columns.find((c) => c.id === task.column);
  const message = buildCardPrompt({
    title: task.title,
    description: task.description,
    priority: task.priority,
    column: task.column,
    columnTitle: column?.title,
    attachments: task.attachments,
    context: input.context,
  });

  const state = newRunState({ task, agentId, assignee, sessionKey });
  state.turns = (task.dispatchTurns ?? 0) + 1;
  addActivity(state, "lifecycle", "Dispatching to the agent…");

  inFlight().add(task.id);
  try {
    // Drop the old index entry: a subagent redispatch gets a new session key.
    const previous = registry().runs.get(task.id);
    if (previous) {
      registry().bySession.delete(previous.sessionKey);
      if (previous.runId) registry().byRun.delete(previous.runId);
      if (previous.settleTimer) clearTimeout(previous.settleTimer);
    }
    indexRun(state);

    const claimed = await transitionTask(task.id, {
      to: "dispatching",
      toColumnRole: "in-progress",
      by: "user",
      reason: "You dispatched this card.",
      patch: {
        agentId,
        dispatchAssignee: assignee,
        dispatchSessionKey: sessionKey,
        dispatchedAt: Date.now(),
        dispatchTurns: state.turns,
        dispatchRunId: undefined,
        dispatchError: undefined,
        completedAt: undefined,
        dispatchResultText: undefined,
        dispatchResultTruncated: undefined,
        dispatchStopReason: undefined,
        dispatchRuntimeMs: undefined,
        dispatchTotalTokens: undefined,
        dispatchCostUsd: undefined,
        dispatchQuestion: undefined,
        dispatchConfidence: undefined,
        askedFromColumn: undefined,
      },
    });
    if (!claimed) return { ok: false, status: 404, error: `Task ${task.id} not found` };
    applyBoard(state, claimed);

    const runId = await sendToAgent({
      agentId,
      message,
      sessionKey,
      state,
      onError: async (err) => {
        state.error = err;
        addActivity(state, "error", err);
        await applyTransition(state, {
          to: "failed",
          by: "system",
          reason: `The gateway refused the dispatch: ${boundText(err, 120).text}`,
          patch: { dispatchError: boundText(err, 1000).text },
        });
      },
    });
    if (!runId.ok) return { ok: false, status: 502, error: runId.error };

    return {
      ok: true,
      taskId: task.id,
      runId: runId.runId,
      sessionKey: runId.sessionKey,
      agentId,
      assignee,
    };
  } finally {
    inFlight().delete(task.id);
  }
}

/**
 * Hand a message to the agent and record the canonical handles it answers with.
 *
 * Both are persisted: `sessionKey` is the durable one that resume and abort need,
 * `runId` identifies this single turn.
 */
async function sendToAgent(input: {
  agentId: string;
  message: string;
  sessionKey: string;
  state: RunState;
  onError: (message: string) => Promise<void>;
}): Promise<{ ok: true; runId: string; sessionKey: string } | { ok: false; error: string }> {
  const idempotencyKey = crypto.randomUUID();
  let accepted: AgentAccepted;
  try {
    accepted = await gatewayCall<AgentAccepted>(
      "agent",
      {
        agentId: input.agentId,
        message: input.message,
        sessionKey: input.sessionKey,
        idempotencyKey,
        label: "mission-control-tasks",
        // Mission Control reads the transcript itself; nothing should be pushed
        // to a chat channel on the user's behalf.
        deliver: false,
        inputProvenance: {
          kind: "external_user",
          sourceChannel: "web",
          sourceTool: "mission-control",
        },
      },
      30000,
    );
  } catch (err) {
    const message = errorMessage(err);
    await input.onError(message);
    return { ok: false, error: message };
  }

  const runId = String(accepted?.runId || idempotencyKey);
  // The gateway canonicalises the key ("task-7" comes back "agent:main:task-7").
  // Store what it returned, not what we asked for.
  const canonicalKey = accepted?.sessionKey || input.sessionKey;

  const reg = registry();
  reg.bySession.delete(input.state.sessionKey);
  input.state.sessionKey = canonicalKey;
  input.state.runId = runId;
  reg.bySession.set(canonicalKey, input.state.taskId);
  reg.byRun.set(runId, input.state.taskId);

  await patchTask(input.state.taskId, {
    dispatchRunId: runId,
    dispatchSessionKey: canonicalKey,
  }).catch(() => null);
  touch(input.state);

  return { ok: true, runId, sessionKey: canonicalKey };
}

/**
 * Answer the agent's question and let it carry on.
 *
 * Resume is the same `agent` call with the same `sessionKey` and a fresh
 * idempotency key — verified: the session id is unchanged, the transcript
 * continues, and the agent still has its context. Creating a new session or
 * reaching for `sessions.send` throws that away.
 */
export async function answerTask(input: {
  taskId: number;
  answer: string;
  agentId?: string;
}): Promise<DispatchResult> {
  ensureTaskEngine();

  const task = await getTask(input.taskId).catch(() => null);
  if (!task) return { ok: false, status: 404, error: `Task ${input.taskId} not found` };

  const agentId = input.agentId || task.agentId;
  const sessionKey = task.dispatchSessionKey;
  if (!agentId || !sessionKey) {
    return { ok: false, status: 400, error: "This card has no run to continue." };
  }
  if (!input.answer.trim()) {
    return { ok: false, status: 400, error: "An answer is required." };
  }

  /*
   * Same guard `dispatchTask` uses. Without it, two tabs on the same card — or
   * one impatient double-submit — both pass validation and both start a turn on
   * the SAME sessionKey. `sendToAgent` then rebinds the run index to whichever
   * lands second, orphaning the first: its terminal events are attributed to
   * the wrong run and its result is lost.
   */
  if (inFlight().has(task.id)) {
    return { ok: false, status: 409, error: "This card is already being sent an answer." };
  }
  if (task.dispatchStatus && ACTIVE_DISPATCH_STATUSES.has(task.dispatchStatus)) {
    return { ok: false, status: 409, error: "This card is already running." };
  }

  const state =
    registry().runs.get(task.id) ??
    newRunState({ task, agentId, assignee: task.dispatchAssignee ?? "agent", sessionKey });
  state.sessionKey = sessionKey;
  state.agentId = agentId;
  indexRun(state);

  // Back where it came from — recorded when it asked, never assumed.
  const restoreColumn = task.askedFromColumn ?? null;
  const turns = (task.dispatchTurns ?? 1) + 1;

  state.turns = turns;
  state.finalText = null;
  state.terminal = null;
  state.settling = false;
  state.endedAt = null;
  // A resumed turn is new work: the card's elapsed clock should time the agent,
  // not the minutes the user spent composing an answer.
  state.startedAt = null;
  state.error = null;
  state.question = null;
  state.streamingText = "";
  if (state.settleTimer) {
    clearTimeout(state.settleTimer);
    state.settleTimer = null;
  }
  addActivity(state, "lifecycle", `You answered: ${boundText(input.answer, 160).text}`);

  const claimed = await transitionTask(task.id, {
    to: "dispatching",
    ...(restoreColumn ? { toColumn: restoreColumn } : { toColumnRole: "in-progress" }),
    by: "user",
    reason: "You answered the agent's question, so the card went back to work.",
    patch: {
      dispatchQuestion: undefined,
      dispatchConfidence: undefined,
      askedFromColumn: undefined,
      dispatchTurns: turns,
      dispatchError: undefined,
      completedAt: undefined,
      dispatchedAt: Date.now(),
    },
  });
  if (!claimed) return { ok: false, status: 404, error: `Task ${task.id} not found` };
  applyBoard(state, claimed);

  inFlight().add(task.id);
  try {
    const sent = await sendToAgent({
      agentId,
      message: buildAnswerPrompt(input.answer, task.dispatchQuestion),
      sessionKey,
      state,
      onError: async (err) => {
        state.error = err;
        await applyTransition(state, {
          to: "failed",
          by: "system",
          reason: `Could not send your answer: ${boundText(err, 120).text}`,
          patch: { dispatchError: boundText(err, 1000).text },
        });
      },
    });
    if (!sent.ok) return { ok: false, status: 502, error: sent.error };

    return {
      ok: true,
      taskId: task.id,
      runId: sent.runId,
      sessionKey: sent.sessionKey,
      agentId,
      assignee: state.assignee,
    };
  } finally {
    inFlight().delete(task.id);
  }
}

/**
 * Stop a run.
 *
 * `sessions.abort` is the only call that actually kills one. `tasks.cancel`
 * marks the ledger cancelled and lets the agent keep running to completion —
 * bookkeeping dressed as a kill.
 */
export async function cancelTask(input: {
  taskId: number;
  agentId?: string;
}): Promise<
  | { ok: true; taskId: number; cancelled: boolean; status: string; abortedRunId: string | null }
  | { ok: false; status: number; error: string }
> {
  ensureTaskEngine();

  const task = await getTask(input.taskId).catch(() => null);
  if (!task) return { ok: false, status: 404, error: `Task ${input.taskId} not found` };

  const agentId = input.agentId || task.agentId;
  const sessionKey = task.dispatchSessionKey;
  if (!agentId || !sessionKey) {
    return { ok: false, status: 400, error: "This card has no run to stop." };
  }

  let aborted;
  try {
    aborted = await abortRun(sessionKey, task.dispatchRunId, agentId);
  } catch (err) {
    return { ok: false, status: 502, error: errorMessage(err) };
  }

  const state = registry().runs.get(task.id);

  if (aborted?.status === "no-active-run") {
    // Already over, or never started. Say so rather than faking a cancellation;
    // if a run really is settling, its own terminal signal owns the outcome.
    if (state && ACTIVE_DISPATCH_STATUSES.has(state.status)) void reconcile(task.id);
    return {
      ok: true,
      taskId: task.id,
      cancelled: false,
      status: "no-active-run",
      abortedRunId: null,
    };
  }

  if (state) {
    state.endedAt = Date.now();
    signalTerminal(state, "cancelled");
  } else {
    await transitionTask(task.id, {
      to: "cancelled",
      by: "user",
      reason: "You stopped this run.",
      patch: { completedAt: Date.now(), dispatchError: undefined },
    }).catch(() => null);
  }

  return {
    ok: true,
    taskId: task.id,
    cancelled: true,
    status: aborted?.status ?? "aborted",
    abortedRunId: aborted?.abortedRunId ?? null,
  };
}

/**
 * The user's verdict on a card the engine was honest about not understanding.
 *
 * Only `needs-review` cards get here: the run ended with no marker, so the UI
 * offered "Mark done" alongside "Answer" and the person chose.
 */
export async function resolveTask(input: {
  taskId: number;
  outcome: "done" | "reopen";
}): Promise<{ ok: true; task: KanbanTask } | { ok: false; status: number; error: string }> {
  ensureTaskEngine();

  const task = await getTask(input.taskId).catch(() => null);
  if (!task) return { ok: false, status: 404, error: `Task ${input.taskId} not found` };

  const done = input.outcome === "done";
  const patched = await transitionTask(task.id, {
    to: done ? "completed" : "idle",
    ...(done
      ? { toColumnRole: "done" as const }
      : task.askedFromColumn
        ? { toColumn: task.askedFromColumn }
        : {}),
    by: "user",
    reason: done ? "You marked this card done." : "You sent this card back to be worked again.",
    patch: {
      dispatchQuestion: undefined,
      dispatchConfidence: done ? "high" : undefined,
      askedFromColumn: undefined,
      completedAt: done ? Date.now() : undefined,
    },
  });
  if (!patched) return { ok: false, status: 404, error: `Task ${task.id} not found` };

  const state = registry().runs.get(task.id);
  if (state) {
    state.question = null;
    applyBoard(state, patched);
    touch(state);
  }
  return { ok: true, task: patched };
}

/* ── degraded path: reconcile by asking ───────────── */

/**
 * Ask the gateway what happened to a card we stopped hearing about.
 *
 * Used on three occasions and no others: after a restart, when the watchdog
 * finds a card that has gone quiet, and when a cancel reports no active run.
 * Never per poll tick.
 */
export async function reconcile(taskId: number): Promise<void> {
  const state = registry().runs.get(taskId);
  if (!state || state.reconciling || state.settling) return;
  state.reconciling = true;
  try {
    // Vitals first — it answers "is it still going?" without pulling a
    // transcript, which matters because a long, quiet tool call gets asked this
    // question repeatedly.
    /*
     * `describeSession` returns null for two very different things: the call
     * failed (transient — ask again later), and the gateway HAS no such session
     * (`{session: null}` is a success). Treating both as "come back later" left
     * a card spinning "Working" forever after a gateway restart evicted the
     * session, which is the one outcome this board must never produce.
     */
    let session: Awaited<ReturnType<typeof describeSession>> | null = null;
    let describeFailed = false;
    try {
      session = await describeSession(state.sessionKey);
    } catch {
      describeFailed = true;
    }

    if (describeFailed) return;

    if (!session) {
      if (!ACTIVE_DISPATCH_STATUSES.has(state.status)) return;
      // Two strikes: a session can be briefly unknown right after dispatch, and
      // declaring a healthy run dead is worse than settling one tick late.
      state.missingChecks = (state.missingChecks ?? 0) + 1;
      if (state.missingChecks < 2) return;

      addActivity(
        state,
        "system",
        "OpenClaw no longer has any record of this run — it was most likely interrupted by a restart.",
      );
      state.error ??=
        "The run was interrupted before it finished, most likely by OpenClaw restarting. Nothing was reported back.";
      state.endedAt ??= Date.now();
      state.terminal = "failed";
      await settle(state);
      return;
    }

    state.missingChecks = 0;
    state.sessionId ??= session.sessionId ?? null;

    if (sessionIsRunning(session)) {
      // Still going. Say so out loud: silence on a live card reads as a hang.
      addActivity(state, "system", "Still running.");
      touch(state);
      return;
    }
    if (!ACTIVE_DISPATCH_STATUSES.has(state.status)) return;

    state.usage.runtimeMs ??= session.runtimeMs ?? undefined;
    state.usage.totalTokens ??= session.totalTokens ?? undefined;
    state.usage.costUsd ??= session.estimatedCostUsd ?? undefined;
    state.endedAt ??= session.endedAt ?? Date.now();

    addActivity(state, "system", "The run had already ended — catching the card up.");
    state.terminal = session.abortedLastRun ? "cancelled" : "completed";
    // settle() reads the transcript itself when it needs the final text.
    await settle(state);
  } finally {
    state.reconciling = false;
  }
}

/**
 * How long a settled run stays in memory before the prune pass stops looking
 * for it. Long enough that a user coming back to the tab still sees the live
 * log; short enough that a finished card does not keep the board file being
 * read for the life of the server.
 */
const SETTLED_RETENTION_MS = 15 * 60_000;

async function runWatchdog(): Promise<void> {
  const now = Date.now();
  let active = false;

  for (const state of registry().runs.values()) {
    if (!ACTIVE_DISPATCH_STATUSES.has(state.status)) {
      // A settled run still counts as worth pruning for a while, but not
      // forever — otherwise one finished card means a board read every 20s
      // until the process dies, with every tab closed.
      if (now - state.updatedAt < SETTLED_RETENTION_MS) active = true;
      continue;
    }
    active = true;
    if (state.settling || state.reconciling) continue;
    if (now - state.updatedAt < STALE_AFTER_MS) continue;
    await reconcile(state.taskId).catch(() => undefined);
  }

  if (active) await pruneDeletedCards();
}

/**
 * Forget runs the board no longer claims.
 *
 * Two ways that happens: the card was deleted, or the card was rewritten
 * without its dispatch fields — kanban.json is a file in the user's workspace
 * and agents are told to edit it, so an out-of-band rewrite is a normal event,
 * not an anomaly. Either way the board is the durable truth and memory must not
 * keep publishing a run it has disowned. A registry that only ever grows would
 * also hold every deleted card's activity log for the life of the process.
 *
 * One board read per watchdog tick, never per request.
 */
async function pruneDeletedCards(): Promise<void> {
  const reg = registry();
  if (reg.runs.size === 0) return;

  const board = await readKanban().catch(() => null);
  if (!board) return;
  const byId = new Map(board.tasks.map((t) => [t.id, t]));

  for (const [taskId, state] of reg.runs) {
    // An in-flight run outranks the file: the watchdog's reconcile owns it, and
    // dropping it here would orphan a live agent.
    if (ACTIVE_DISPATCH_STATUSES.has(state.status)) continue;

    const task = byId.get(taskId);
    const disowned =
      !task ||
      task.dispatchStatus === undefined ||
      (task.dispatchSessionKey !== undefined && task.dispatchSessionKey !== state.sessionKey);
    if (!disowned) continue;

    if (state.settleTimer) clearTimeout(state.settleTimer);
    reg.runs.delete(taskId);
    reg.bySession.delete(state.sessionKey);
    if (state.runId) reg.byRun.delete(state.runId);
  }
}

/* ── dispatch in-flight guard ─────────────────────── */

function inFlight(): Set<number> {
  const holder = globalThis as unknown as { __mcDispatchInFlight?: Set<number> };
  holder.__mcDispatchInFlight ??= new Set<number>();
  return holder.__mcDispatchInFlight;
}
