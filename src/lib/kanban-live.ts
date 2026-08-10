/**
 * In-memory broadcast for the tasks board.
 *
 * Two kinds of news travel here:
 *
 *   - `kanban-updated` — the board file changed; refetch it.
 *   - `task-run`       — something happened inside a running card (a new
 *                        activity line, streaming text, a status change). These
 *                        arrive at gateway speed (~10-20ms) and are far too
 *                        frequent to answer with a board refetch, so they carry
 *                        their own small payload.
 *
 * Works on any install (Mac, VPC) — no Redis or file watcher required.
 */

import type { TaskRunSnapshot } from "./task-engine-types";

export type KanbanLiveEvent =
  | { type: "kanban-updated" }
  | { type: "task-run"; run: TaskRunSnapshot }
  | { type: "ping" };

/**
 * Parked on globalThis: a `next dev` hot reload would otherwise hand the engine
 * a fresh subscriber set while every open SSE stream still holds the old one,
 * and live cards would go quiet until the page reloaded.
 */
type Holder = { __mcKanbanSubscribers?: Set<(event: KanbanLiveEvent) => void> };

function subscribers(): Set<(event: KanbanLiveEvent) => void> {
  const holder = globalThis as Holder;
  holder.__mcKanbanSubscribers ??= new Set();
  return holder.__mcKanbanSubscribers;
}

export function subscribeKanban(send: (event: KanbanLiveEvent) => void): () => void {
  const set = subscribers();
  set.add(send);
  return () => set.delete(send);
}

function broadcast(event: KanbanLiveEvent): void {
  const set = subscribers();
  for (const send of set) {
    try {
      send(event);
    } catch {
      set.delete(send);
    }
  }
}

export function notifyKanbanUpdated(): void {
  broadcast({ type: "kanban-updated" });
}

/** Push one card's live state to every open board. */
export function notifyTaskRun(run: TaskRunSnapshot): void {
  broadcast({ type: "task-run", run });
}
