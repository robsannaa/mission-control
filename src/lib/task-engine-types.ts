/**
 * Wire shapes for the dispatch engine.
 *
 * Kept apart from the engine itself so the SSE layer and the route handlers can
 * describe a card without importing the machinery that drives one.
 */

import type { DispatchAssignee, DispatchStatus, TaskTransition } from "./kanban-store";

/**
 * One line in a card's live log.
 *
 * These come from the gateway's own `agent` stream, which already formats tool
 * calls as readable titles ("exec run sleep 5 → print…"). Nothing is
 * reconstructed or paraphrased here.
 */
export type TaskActivityLine = {
  /** Stable within a run — safe as a list key. */
  id: string;
  at: number;
  kind: "lifecycle" | "tool" | "assistant" | "question" | "result" | "error" | "system";
  text: string;
  /**
   * Set on tool lines. The gateway reports one item several times as it runs
   * (start, then end), retitling it each time; the line is rewritten in place
   * rather than appended, so the log reads as a list of steps rather than an
   * echo of every phase change.
   */
  itemId?: string;
  /** True while the step is still running — worth a spinner of its own. */
  pending?: boolean;
};

export type TaskQuestion = {
  text: string;
  /**
   * `high` — the agent emitted `NEEDS_INPUT:`. Say "the agent asked".
   * `low`  — inferred from a run that ended with no marker at all. Say "this
   *          may need your input" and offer both answering and marking done.
   */
  confidence: "high" | "low";
  /** Column to restore when the answer is sent. */
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
  /** 1 on dispatch, +1 per answered question. */
  turns: number;
  /** The current turn's assistant text as it is typed. Null when not streaming. */
  streamingText: string | null;
  /** Newest last, bounded. Empty after a restart until the card runs again. */
  activity: TaskActivityLine[];
  question: TaskQuestion | null;
  result: TaskRunResult | null;
  error: string | null;
  /** Why this card is where it is, newest last. */
  transitions: TaskTransition[];
  /**
   * Whether this snapshot is backed by a live event feed. False means the
   * WebSocket is down and the card is being reconciled by polling instead —
   * the UI should soften "live" affordances rather than claim freshness it
   * does not have.
   */
  live: boolean;
};
