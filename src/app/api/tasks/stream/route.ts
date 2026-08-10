import { NextRequest } from "next/server";
import { subscribeKanban, type KanbanLiveEvent } from "@/lib/kanban-live";
import { ensureTaskEngine, getEventsStatus, listRunSnapshots } from "@/lib/task-engine";

/**
 * SSE stream for the tasks board.
 *
 * Carries two things:
 *
 *   - `kanban-updated` — the board file changed; refetch `/api/tasks`.
 *   - `task-run`       — one card's live state, pushed as it changes. These
 *                        originate in gateway events (~10-20ms behind reality),
 *                        so a spinner driven off them is showing what the agent
 *                        is actually doing rather than a guess between polls.
 *
 * An opening `snapshot` frame carries every known run, so a page that connects
 * mid-run renders correctly without a separate fetch.
 *
 * No polling, no file watcher — works on any install (Mac, VPC).
 */
export async function GET(request: NextRequest) {
  ensureTaskEngine();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const write = (payload: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
          cleanup();
        }
      };

      const send = (event: KanbanLiveEvent) => write(event);

      const unsubscribe = subscribeKanban(send);

      // Heartbeat so proxies don't close the connection. It doubles as a
      // liveness report: a client that stops seeing `events.connected` knows the
      // gateway link is down without asking.
      const heartbeat = setInterval(() => {
        write({ type: "ping", events: getEventsStatus() });
      }, 15000);

      function cleanup() {
        unsubscribe();
        clearInterval(heartbeat);
      }

      request.signal.addEventListener("abort", () => {
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });

      write({ type: "snapshot", runs: listRunSnapshots(), events: getEventsStatus() });
    },
    cancel() {
      // Subscription removed in abort listener
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
