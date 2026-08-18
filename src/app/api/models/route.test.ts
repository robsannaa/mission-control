/**
 * CI-safe route-handler tests for the usage/models/search batch (02-07) —
 * runs in the `unit` project under `environment: 'node'`
 * (next-test-api-route-handler patches Next.js internals; jsdom breaks that
 * patching, so this file must never be collected by the `component`
 * project).
 *
 * Every case here rejects before any provider call, pricing lookup, or
 * search-backend call is reached: `modelsPostSchema` (a discriminated
 * union), `usageProviderRouteParamsSchema` (a route-param enum), and
 * `searchQuerySchema` (a length-bounded query field) all run inside
 * `withRoute`'s pre-handler validation step, before the route handler
 * itself is ever invoked. Anything that needs the real gateway or a real
 * search backend belongs in a `*.live.test.ts` file (the `live` project),
 * never here.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as modelsHandler from "@/app/api/models/route";
import * as usageProviderHandler from "@/app/api/usage/providers/[provider]/route";
import * as searchHandler from "@/app/api/search/route";
import { MAX_SEARCH_QUERY_LENGTH } from "@/lib/schemas/search";
import { describe, test, expect } from "vitest";

describe("POST /api/models — pre-gateway validation (no instance required)", () => {
  test("unrecognized action → 400 with the project error envelope and a details tree naming the action field", async () => {
    await testApiHandler({
      appHandler: modelsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "not-a-real-action" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        // `details` is a Zod treeifyError() tree — the discriminated
        // union's invalid-discriminator issue is reported against the
        // `action` field path.
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("action");
      },
    });
  });

  test("malformed JSON body → 400 with the project error envelope", async () => {
    await testApiHandler({
      appHandler: modelsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });
});

describe("GET /api/usage/providers/[provider] — route-param validation (no instance required)", () => {
  test("unknown provider segment → 400 with the project error envelope, no pricing lookup attempted", async () => {
    await testApiHandler({
      appHandler: usageProviderHandler,
      params: { provider: "not-a-real-provider" },
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        // The route's own success shape carries a `snapshot` field
        // (getProviderSnapshot's return value) — its absence here proves
        // the handler (and therefore any pricing lookup) never ran.
        expect(body).not.toHaveProperty("snapshot");
      },
    });
  });
});

describe("GET /api/search — query length validation (no instance required)", () => {
  test("oversized query → 400 with the project error envelope, response body does not echo the query", async () => {
    const sentinel = "SENTINEL_OVERSIZED_QUERY_MARKER";
    const oversizedQuery = sentinel + "x".repeat(MAX_SEARCH_QUERY_LENGTH + 1 - sentinel.length);
    expect(oversizedQuery.length).toBeGreaterThan(MAX_SEARCH_QUERY_LENGTH);

    await testApiHandler({
      appHandler: searchHandler,
      url: `/api/search?q=${encodeURIComponent(oversizedQuery)}`,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const raw = await res.text();
        // The length-rejection response must never echo the oversized
        // input back to the caller (T-02-32) — proven by asserting the
        // sentinel marker never appears anywhere in the raw response body.
        expect(raw).not.toContain(sentinel);
        const body = JSON.parse(raw);
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });
});
