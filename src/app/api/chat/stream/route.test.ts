/**
 * CI-safe route-handler test for POST /api/chat/stream — runs in the `unit`
 * project under `environment: 'node'` (next-test-api-route-handler patches
 * Next.js internals; jsdom breaks that patching, so this file must never be
 * collected by the `component` project).
 *
 * This file deliberately exercises only the pre-gateway rejection branch:
 * a body that fails `chatStreamPostSchema` (src/lib/schemas/streaming.ts)
 * is rejected by `withPassthroughRoute`'s setup-phase validation before the
 * handler runs, so no gateway call is ever attempted. Anything that reaches
 * `getDefaultAgentId()` or the gateway's `/v1/responses` endpoint belongs in
 * `e2e/streaming-integrity.spec.ts` (the `@live` lane), never here.
 *
 * This pins two of this plan's must-have truths (02-02-PLAN.md):
 *   - a malformed body is rejected before the stream opens, with the
 *     canonical `{ ok: false, error, details? }` envelope and a JSON
 *     content type
 *   - the response is JSON, never `text/event-stream` — a regression that
 *     routed a validation failure through the stream path would fail this
 *     test first.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appHandler from "@/app/api/chat/stream/route";
import { describe, test, expect } from "vitest";

describe("POST /api/chat/stream — pre-gateway validation (no instance required)", () => {
  test("malformed body → 400 with the project error envelope, not an event-stream", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          // `messages` must be an array per chatStreamPostSchema — a string
          // fails schema validation before the handler (and any gateway
          // call) ever runs.
          body: JSON.stringify({ messages: "not-an-array" }),
        });

        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("content-type")).not.toContain("text/event-stream");

        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
      },
    });
  });

  test("malformed JSON body → 400 with the project error envelope", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        });

        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        expect(res.headers.get("content-type")).not.toContain("text/event-stream");

        const body = await res.json();
        expect(body).toStrictEqual({ ok: false, error: "Invalid JSON body" });
      },
    });
  });
});
