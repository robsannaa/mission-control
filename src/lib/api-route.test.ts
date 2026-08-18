/**
 * Unit coverage for `src/lib/api-route.ts` — the `withRoute` /
 * `withPassthroughRoute` wrapper contracts. Drives the wrappers directly
 * with plain `NextRequest` objects (no NTARH/full route module needed —
 * the wrapper itself is what's under test here, not a specific route).
 */
import { describe, test, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { z } from "zod";
import { withRoute, withPassthroughRoute } from "./api-route";

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function makeRequest(url: string, init?: NextRequestInit): NextRequest {
  return new NextRequest(url, init);
}

const emptyParams = { params: Promise.resolve({}) };

describe("withRoute — body schema validation", () => {
  test("returns 400 and never invokes the handler when the body fails the schema", async () => {
    const schema = z.object({ name: z.string().min(1, "name required") });
    const handler = vi.fn();
    const wrapped = withRoute({ name: "/test", bodySchema: schema }, handler);

    const req = makeRequest("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const res = await wrapped(req, emptyParams);

    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  test("invokes the handler with the parsed body when validation passes", async () => {
    const schema = z.object({ name: z.string() });
    const handler = vi.fn(async (_req, ctx) => Response.json({ echoed: ctx.body.name }));
    const wrapped = withRoute({ name: "/test", bodySchema: schema }, handler);

    const req = makeRequest("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "ok" }),
    });

    const res = await wrapped(req, emptyParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ echoed: "ok" });
  });
});

describe("withRoute — thrown errors", () => {
  test("returns 500 with only the error message, no stack text, when the handler throws", async () => {
    const wrapped = withRoute({ name: "/test" }, async () => {
      throw new Error("kaboom");
    });

    const req = makeRequest("http://localhost/test", { method: "GET" });
    const res = await wrapped(req, emptyParams);

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toStrictEqual({ ok: false, error: "kaboom" });
    // No stack-trace-shaped text ("at file:line:col") leaks into the body.
    expect(JSON.stringify(body)).not.toMatch(/at .+:\d+:\d+/);
  });
});

describe("withRoute — raw Response passthrough", () => {
  test("returns the identical Response object when the handler returns a raw Response", async () => {
    const raw = Response.json({ custom: true }, { status: 202 });
    const wrapped = withRoute({ name: "/test" }, async () => raw);

    const req = makeRequest("http://localhost/test", { method: "GET" });
    const res = await wrapped(req, emptyParams);

    expect(res).toBe(raw);
  });
});

describe("withRoute — dynamic route params", () => {
  test("a DELETE-shaped handler still resolves its dynamic route params", async () => {
    const handler = vi.fn(async (_req, ctx) => Response.json({ id: ctx.params.id }));
    const wrapped = withRoute<unknown, unknown, { id: string }>({ name: "/test/[id]" }, handler);

    const req = makeRequest("http://localhost/test/abc123", { method: "DELETE" });
    const res = await wrapped(req, { params: Promise.resolve({ id: "abc123" }) });

    expect(res.status).toBe(200);
    expect(await res.json()).toStrictEqual({ id: "abc123" });
  });
});

describe("withPassthroughRoute — streaming responses", () => {
  test("preserves content-type and does not consume the stream body", async () => {
    let enqueueLater: ((chunk: Uint8Array) => void) | undefined;
    let closeLater: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueueLater = (chunk) => controller.enqueue(chunk);
        closeLater = () => controller.close();
      },
    });
    const streamingResponse = new Response(stream, {
      headers: { "Content-Type": "text/event-stream" },
    });

    const wrapped = withPassthroughRoute({ name: "/stream" }, async () => streamingResponse);
    const req = makeRequest("http://localhost/stream", { method: "GET" });
    const res = await wrapped(req, emptyParams);

    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.bodyUsed).toBe(false);

    // The stream is still live after the wrapper returns — it was never
    // drained or re-wrapped.
    enqueueLater?.(new TextEncoder().encode("data: hello\n\n"));
    closeLater?.();
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toContain("hello");
  });

  test("still returns a validation error for a malformed body before the handler runs", async () => {
    const schema = z.object({ mode: z.enum(["quick", "full"]) });
    const handler = vi.fn();
    const wrapped = withPassthroughRoute({ name: "/stream", bodySchema: schema }, handler);

    const req = makeRequest("http://localhost/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "bogus" }),
    });

    const res = await wrapped(req, emptyParams);
    expect(res.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.ok).toBe(false);
  });
});
