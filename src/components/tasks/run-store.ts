"use client";

/**
 * One socket for the whole board.
 *
 * Every card needs live state, and the old shape of this — each card polling
 * `/api/tasks/dispatch-status` every two seconds — cost one request per card per
 * tick and still showed the user a two-second-old guess. `/api/tasks/stream`
 * pushes the same snapshots ~10-20ms behind reality, so the board opens exactly
 * one EventSource and hands each card the slice it cares about.
 *
 * The store is module-level and ref-counted: it connects when the first watcher
 * mounts and lets go a moment after the last one leaves, so navigating away and
 * back does not thrash the connection.
 */

import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { StreamEvents, TaskActivityLine, TaskRunSnapshot } from "./types";

const STREAM_URL = "/api/tasks/stream";
/** Keep the socket briefly after the last watcher so remounts reuse it. */
const LINGER_MS = 4000;
/** Reconnect backoff, capped so a dead server does not spin. */
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 15000;

const OFFLINE_EVENTS: StreamEvents = {
  connected: false,
  subscribers: 0,
  connectedSince: null,
  lastEventAt: null,
  lastError: null,
};

type Listener = () => void;

/* ── state ────────────────────────────────────────── */

let runs = new Map<number, TaskRunSnapshot>();
let events: StreamEvents = OFFLINE_EVENTS;
/** Bumped whenever the board file changes, so the board knows to refetch. */
let boardSignal = 0;
/** False until the first `snapshot` frame lands — "no run" vs "not known yet". */
let primed = false;

const listeners = new Set<Listener>();
/** Per-task listeners, so one card's tick does not wake the other columns. */
const taskListeners = new Map<number, Set<Listener>>();

let source: EventSource | null = null;
let refCount = 0;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = RETRY_MIN_MS;

function emitGlobal() {
  for (const listener of listeners) listener();
}

function emitTask(taskId: number) {
  const set = taskListeners.get(taskId);
  if (!set) return;
  for (const listener of set) listener();
}

/* ── connection ───────────────────────────────────── */

function applySnapshotList(list: TaskRunSnapshot[]) {
  const next = new Map<number, TaskRunSnapshot>();
  for (const run of list) next.set(run.taskId, run);
  const touched = new Set<number>([...runs.keys(), ...next.keys()]);
  runs = next;
  primed = true;
  for (const taskId of touched) emitTask(taskId);
  emitGlobal();
}

function applyRun(run: TaskRunSnapshot) {
  if (!run || typeof run.taskId !== "number") return;
  // Replace wholesale: the snapshot is already the complete state for this card,
  // and a fresh object reference is what tells `useSyncExternalStore` to repaint.
  runs = new Map(runs);
  runs.set(run.taskId, run);
  emitTask(run.taskId);
  emitGlobal();
}

function setEvents(next: StreamEvents | undefined) {
  if (!next) return;
  // Only the honesty flag drives UI, so avoid waking the tree for a timestamp.
  if (events.connected === next.connected && events.lastError === next.lastError) {
    events = next;
    return;
  }
  events = next;
  emitGlobal();
}

function handleMessage(raw: string) {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  const frame = payload as {
    type?: string;
    runs?: TaskRunSnapshot[];
    run?: TaskRunSnapshot;
    events?: StreamEvents;
  };

  switch (frame.type) {
    case "snapshot":
      setEvents(frame.events);
      applySnapshotList(Array.isArray(frame.runs) ? frame.runs : []);
      break;
    case "task-run":
      if (frame.run) applyRun(frame.run);
      break;
    case "kanban-updated":
      boardSignal += 1;
      emitGlobal();
      break;
    case "ping":
      setEvents(frame.events);
      break;
    default:
      break;
  }
}

function connect() {
  if (source || typeof window === "undefined") return;
  const es = new EventSource(STREAM_URL);
  source = es;

  es.onmessage = (e) => {
    retryDelay = RETRY_MIN_MS; // a frame arrived: the link is healthy
    handleMessage(e.data);
  };

  es.onerror = () => {
    // EventSource retries on its own, but a server that restarted mid-run leaves
    // the old socket half-dead. Tear it down and come back with backoff so the
    // "live" flag reflects reality rather than a stale connection object.
    es.close();
    if (source === es) source = null;
    if (events.connected) {
      events = { ...events, connected: false };
      emitGlobal();
    }
    if (refCount > 0 && !retryTimer) {
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (refCount > 0) connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }
  };
}

function disconnect() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  source?.close();
  source = null;
  primed = false;
  events = OFFLINE_EVENTS;
}

function acquire() {
  refCount += 1;
  if (lingerTimer) {
    clearTimeout(lingerTimer);
    lingerTimer = null;
  }
  connect();
}

function release() {
  refCount = Math.max(0, refCount - 1);
  if (refCount > 0 || lingerTimer) return;
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    if (refCount === 0) disconnect();
  }, LINGER_MS);
}

/* ── subscription plumbing ────────────────────────── */

function subscribeGlobal(listener: Listener): () => void {
  listeners.add(listener);
  acquire();
  return () => {
    listeners.delete(listener);
    release();
  };
}

function subscribeTask(taskId: number, listener: Listener): () => void {
  let set = taskListeners.get(taskId);
  if (!set) {
    set = new Set();
    taskListeners.set(taskId, set);
  }
  set.add(listener);
  acquire();
  return () => {
    const current = taskListeners.get(taskId);
    if (current) {
      current.delete(listener);
      if (current.size === 0) taskListeners.delete(taskId);
    }
    release();
  };
}

/* ── hooks ────────────────────────────────────────── */

/**
 * Live state for one card, or null if the engine has never seen it.
 *
 * Repaints only when *this* card changes: a run streaming three ticks a second
 * must not re-render the other columns.
 */
export function useTaskRun(taskId: number): TaskRunSnapshot | null {
  const subscribe = useCallback(
    (listener: Listener) => subscribeTask(taskId, listener),
    [taskId],
  );
  const getSnapshot = useCallback(() => runs.get(taskId) ?? null, [taskId]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}

/** Every known run — for board-level counts. */
export function useAllRuns(): Map<number, TaskRunSnapshot> {
  return useSyncExternalStore(
    subscribeGlobal,
    () => runs,
    () => runs,
  );
}

/** Gateway link health. `connected: false` means stop claiming freshness. */
export function useStreamEvents(): StreamEvents {
  return useSyncExternalStore(
    subscribeGlobal,
    () => events,
    () => OFFLINE_EVENTS,
  );
}

/** True once the opening snapshot frame has landed. */
export function useStreamPrimed(): boolean {
  return useSyncExternalStore(
    subscribeGlobal,
    () => primed,
    () => false,
  );
}

/**
 * Calls `onChange` whenever the board file is written by anyone — this tab, the
 * agent, or another window. The board answers by refetching `/api/tasks`.
 */
export function useKanbanSignal(onChange: () => void): void {
  const signal = useSyncExternalStore(
    subscribeGlobal,
    () => boardSignal,
    () => 0,
  );
  const first = signal === 0;
  useEffect(() => {
    if (first) return;
    onChange();
    // `onChange` is intentionally excluded: this fires on board changes, not on
    // every re-render that hands us a new callback identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signal]);
}

/* ── backfill after a server restart ──────────────── */

/**
 * The gateway's own transcript shape, which predates the engine's activity
 * lines. Only `dispatch-status?live=1` returns it, and only that endpoint can
 * rebuild a log the engine lost — `/api/tasks/runs` reads the same empty memory
 * we are trying to repair.
 */
type LegacyActivityEntry = {
  seq: number;
  at: number | null;
  kind: "prompt" | "text" | "thinking" | "tool" | "tool-result";
  name?: string;
  text: string;
  isError?: boolean;
};

function toActivityLine(entry: LegacyActivityEntry): TaskActivityLine {
  const kind: TaskActivityLine["kind"] =
    entry.isError
      ? "error"
      : entry.kind === "tool" || entry.kind === "tool-result"
        ? "tool"
        : entry.kind === "prompt"
          ? "system"
          : "assistant";
  const text =
    entry.kind === "tool" && entry.name ? `${entry.name} ${entry.text}`.trim() : entry.text;
  return { id: `backfill-${entry.seq}`, at: entry.at ?? 0, kind, text };
}

/**
 * Rebuild a card's log from the gateway when the engine's in-memory copy is
 * empty — which is what a server restart mid-run leaves behind.
 *
 * Used once, on demand, when a dialog opens on such a card. Never on a timer:
 * this one costs a real gateway round trip, unlike everything else here.
 */
/** In-flight backfills, so a double-invoked effect costs one round trip. */
const backfilling = new Map<number, Promise<void>>();

export function backfillRun(taskId: number): Promise<void> {
  const hit = backfilling.get(taskId);
  if (hit) return hit;
  const run = doBackfill(taskId).finally(() => backfilling.delete(taskId));
  backfilling.set(taskId, run);
  return run;
}

async function doBackfill(taskId: number): Promise<void> {
  try {
    const res = await fetch(
      `/api/tasks/dispatch-status?taskId=${taskId}&live=1&limit=100`,
    );
    if (!res.ok) return;
    const body = await res.json();

    // The engine may have known all along — prefer its own snapshot.
    if (body?.run && Array.isArray(body.run.activity) && body.run.activity.length > 0) {
      applyRun(body.run as TaskRunSnapshot);
      return;
    }

    const live = body?.live;
    const lines: TaskActivityLine[] = Array.isArray(live?.activity)
      ? (live.activity as LegacyActivityEntry[]).map(toActivityLine)
      : [];
    if (lines.length === 0 && !body?.run) return;

    const rebuilt: TaskRunSnapshot = {
      taskId,
      status: body.dispatchStatus ?? body.run?.status ?? "idle",
      column: body.column ?? body.run?.column ?? "",
      agentId: body.agentId ?? null,
      assignee: body.assignee ?? "agent",
      runId: body.dispatchRunId ?? null,
      sessionKey: body.dispatchSessionKey ?? null,
      sessionId: live?.sessionId ?? null,
      startedAt: body.dispatchedAt ?? live?.startedAt ?? null,
      endedAt: body.completedAt ?? live?.endedAt ?? null,
      updatedAt: Date.now(),
      turns: body.turns ?? 0,
      streamingText: null,
      activity: lines,
      question: body.question
        ? { ...body.question, askedAt: body.question.askedAt ?? 0 }
        : null,
      result: body.result ?? null,
      error: body.dispatchError ?? null,
      transitions: body.transitions ?? [],
      // Honest: this is a reconstruction. Whether it can go live again is
      // whatever the gateway link is actually doing right now.
      live: body?.events?.connected === true,
    };
    applyRun(rebuilt);
  } catch {
    /* the stream will bring us back */
  }
}
