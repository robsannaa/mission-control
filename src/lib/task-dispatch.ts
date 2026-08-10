/**
 * Gateway plumbing for dispatching a Kanban card as a real agent run.
 *
 * Verified against a live gateway (OpenClaw 2026.7.x):
 *
 * - Both assignees use the same `agent` RPC. The ONLY difference is the shape
 *   of `sessionKey`: `agent:<id>:task-<n>` continues the agent's own session,
 *   `agent:<id>:subagent:<uuid>` gets a fresh, isolated transcript with the
 *   session-management tools stripped from the profile.
 * - The ledger row for either shape is `kind:"cli"`, and its `terminalSummary`
 *   is the literal string "completed". Do not read results from `tasks.*`.
 *
 * `agent.wait` used to drive completion from here and no longer does. It is
 * capped at 300000ms, so a longer run left its card spinning on `running`
 * forever with no recovery. Completion now comes from pushed `task` and `agent`
 * events (see task-engine.ts), which have no such ceiling. Do not reintroduce
 * it as a progress signal.
 */

import { gatewayCall } from "./openclaw";

/** How much run output we are willing to write into the user's kanban.json. */
export const MAX_RESULT_CHARS = 4000;

/* ── session keys ─────────────────────────────────── */

export function mainTaskSessionKey(agentId: string, taskId: number): string {
  return `agent:${agentId}:task-${taskId}`;
}

export function subagentSessionKey(agentId: string): string {
  return `agent:${agentId}:subagent:${crypto.randomUUID()}`;
}

/* ── chat.history shapes ──────────────────────────── */

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments?: Record<string, unknown> }
  | { type: string; [key: string]: unknown };

export type ChatMessage = {
  role: "user" | "assistant" | "toolResult" | string;
  content: string | ChatBlock[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  timestamp?: number;
  stopReason?: string;
  __openclaw?: { id?: string; seq?: number };
};

export type ChatSessionInfo = {
  status?: "running" | "done" | "killed" | string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
  abortedLastRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  lastActivityAt?: number;
};

export type ChatHistory = {
  sessionKey: string;
  sessionId?: string;
  messages: ChatMessage[];
  sessionInfo?: ChatSessionInfo;
};

export async function fetchHistory(
  sessionKey: string,
  agentId: string,
  limit = 50,
  timeout = 20000,
): Promise<ChatHistory> {
  const res = await gatewayCall<ChatHistory>(
    "chat.history",
    { sessionKey, agentId, limit },
    timeout,
  );
  return { ...res, messages: Array.isArray(res?.messages) ? res.messages : [] };
}

/* ── session vitals ───────────────────────────────── */

export type SessionDescription = {
  key?: string;
  sessionId?: string;
  status?: "running" | "done" | string;
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
  startedAt?: number;
  endedAt?: number;
  runtimeMs?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  lastActivityAt?: number;
};

/**
 * Vitals for one session, without its transcript.
 *
 * Cheaper than `chat.history` and the only place the run's cost actually shows
 * up — `chat.history`'s `sessionInfo` reports `estimatedCostUsd` as null on
 * runs where this returns a real figure. Use it to answer "is it still going?"
 * and to price a finished run; use `chat.history` only when the text is needed.
 */
export async function describeSession(
  sessionKey: string,
  timeout = 15000,
): Promise<SessionDescription | null> {
  const res = await gatewayCall<{ session?: SessionDescription }>(
    "sessions.describe",
    { key: sessionKey },
    timeout,
  ).catch(() => null);
  return res?.session ?? null;
}

/** Whether a described session still has a run in flight. */
export function sessionIsRunning(session: SessionDescription | null): boolean {
  if (!session) return false;
  return session.hasActiveRun === true || session.status === "running";
}

/* ── reading a run ────────────────────────────────── */

function blocksOf(message: ChatMessage): ChatBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

/** Plain text of a message, whether the content is a string or block array. */
export function textOf(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  return blocksOf(message)
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

/** The run's answer: the last assistant message that actually said something. */
export function finalAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = textOf(m);
    if (text) return text;
  }
  return "";
}

/**
 * The real reason a run failed. The terminal signals carry only a stop reason;
 * the message the user needs is in the last errored tool result.
 */
export function lastToolError(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "toolResult" || !m.isError) continue;
    const text = textOf(m);
    if (text) return m.toolName ? `${m.toolName}: ${text}` : text;
  }
  return "";
}

export function boundText(text: string, max = MAX_RESULT_CHARS): {
  text: string;
  truncated: boolean;
} {
  const trimmed = (text ?? "").trim();
  if (trimmed.length <= max) return { text: trimmed, truncated: false };
  return { text: `${trimmed.slice(0, max)}…`, truncated: true };
}

/* ── compact activity feed for the card ───────────── */

export type TaskActivityEntry = {
  seq: number;
  at: number | null;
  kind: "prompt" | "text" | "thinking" | "tool" | "tool-result";
  /** Tool name for tool entries, otherwise absent. */
  name?: string;
  text: string;
  isError?: boolean;
};

const ACTIVITY_SNIPPET_CHARS = 400;

function snippet(text: string): string {
  return boundText(text, ACTIVITY_SNIPPET_CHARS).text;
}

/**
 * Flatten a transcript into something a card can render as "what it is doing
 * right now" — one entry per meaningful block, newest last, all bounded.
 */
export function activityOf(messages: ChatMessage[]): TaskActivityEntry[] {
  const out: TaskActivityEntry[] = [];
  for (const m of messages) {
    const seq = m.__openclaw?.seq ?? out.length;
    const at = typeof m.timestamp === "number" ? m.timestamp : null;

    if (m.role === "user") {
      out.push({ seq, at, kind: "prompt", text: snippet(textOf(m)) });
      continue;
    }
    if (m.role === "toolResult") {
      out.push({
        seq,
        at,
        kind: "tool-result",
        name: m.toolName,
        text: snippet(textOf(m)),
        isError: m.isError === true,
      });
      continue;
    }
    if (m.role !== "assistant") continue;

    for (const block of blocksOf(m)) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
        out.push({ seq, at, kind: "text", text: snippet(block.text) });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        out.push({ seq, at, kind: "thinking", text: snippet(block.thinking) });
      } else if (block.type === "toolCall") {
        const name = typeof block.name === "string" ? block.name : "tool";
        out.push({ seq, at, kind: "tool", name, text: snippet(summarizeArgs(block.arguments)) });
      }
    }
  }
  return out;
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  try {
    return JSON.stringify(args);
  } catch {
    return "";
  }
}

/* ── agent RPC ────────────────────────────────────── */

export type AgentAccepted = {
  runId?: string;
  sessionKey?: string;
  status?: string;
  acceptedAt?: number;
};

export type SessionsAbortResult = {
  ok?: boolean;
  abortedRunId?: string | null;
  status?: "aborted" | "no-active-run" | string;
};

/** The only call that actually stops a run. Requires operator.admin. */
export async function abortRun(
  sessionKey: string,
  runId: string | undefined,
  agentId: string,
): Promise<SessionsAbortResult> {
  return gatewayCall<SessionsAbortResult>(
    "sessions.abort",
    { key: sessionKey, runId, agentId },
    20000,
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
