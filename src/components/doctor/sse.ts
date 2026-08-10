/**
 * Read a `text/event-stream` POST response.
 *
 * `EventSource` cannot POST, so both Doctor streams are plain fetches whose
 * bodies happen to be SSE. This reader handles the two things a naive
 * implementation gets wrong: a `data:` payload split across chunk boundaries,
 * and multi-line `data:` frames.
 */
export async function readEventStream<T>(
  response: Response,
  onEvent: (event: T) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!response.body) throw new Error("The server sent no stream to read.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const abort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", abort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (payload) {
          try {
            onEvent(JSON.parse(payload) as T);
          } catch {
            // A frame we cannot parse is not worth tearing the stream down for.
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/** Pull a server error message out of a non-2xx JSON body, with a fallback. */
export async function errorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}
