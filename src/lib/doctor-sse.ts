/**
 * Server-sent-event plumbing shared by the run and fix endpoints.
 *
 * A doctor run takes 7–15 seconds and a repair can take longer. The UI has to
 * narrate that rather than freeze, so both endpoints stream typed events rather
 * than returning one late blob. Writes are guarded because the client can
 * disconnect at any point — a closed controller throws on enqueue, and an
 * unguarded throw inside a subprocess callback takes down the request handler.
 */

export type SseWriter = {
  send: (event: unknown) => void;
  close: () => void;
  /** True once the client has gone away. */
  closed: () => boolean;
};

export function sseResponse(
  start: (writer: SseWriter, signal: AbortSignal) => Promise<void> | void,
  abortController = new AbortController(),
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const writer: SseWriter = {
        send(event) {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          } catch {
            closed = true;
          }
        },
        close() {
          if (closed) return;
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed by the client */
          }
        },
        closed: () => closed,
      };

      try {
        await start(writer, abortController.signal);
      } catch (err) {
        writer.send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        writer.close();
      }
    },
    cancel() {
      abortController.abort();
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

/**
 * Canonical-envelope JSON error for the SSE routes (docs/API-CONTRACT.md
 * §1). Signature is unchanged so existing call sites keep working; `extra`
 * is still spread onto the body — callers pass `{ details: {...} }` rather
 * than spreading fields at the top level, so the body stays inside the
 * three-key envelope (`ok`, `error`, `details`).
 */
export function jsonError(message: string, status: number, extra: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ ok: false, error: message, ...extra }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
