import { NextResponse } from "next/server";

/**
 * Parse a JSON request body with a size guard.
 *
 * Two-layer defense against oversized payloads:
 *  1. Cheap fast-reject on the Content-Length header (when present).
 *  2. Fallback on the actual byte length after reading the body, so a
 *     client that omits or lies about Content-Length (e.g. chunked
 *     transfer-encoding) still cannot exceed `maxBytes`.
 *
 * Returns either a parsed body (`ok: true`) or a ready-to-send error
 * response (`ok: false`). Callers should `return result.response`
 * directly in the `ok: false` case.
 */
export async function readJsonBody(
  request: Request,
  { maxBytes }: { maxBytes: number },
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const contentLengthRaw = request.headers.get("content-length");
  if (contentLengthRaw) {
    const contentLength = Number.parseInt(contentLengthRaw, 10);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      return {
        ok: false,
        response: NextResponse.json({ error: "Payload too large" }, { status: 413 }),
      };
    }
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }

  // Fallback: catch cases where Content-Length was absent, chunked, or lied.
  if (raw.length > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Payload too large" }, { status: 413 }),
    };
  }

  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    return { ok: true, body };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }),
    };
  }
}
