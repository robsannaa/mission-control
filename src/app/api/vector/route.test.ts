/**
 * CI-safe route-handler tests for the media/vector-store/docs route group —
 * runs in the `unit` project under `environment: 'node'`
 * (next-test-api-route-handler patches Next.js internals; jsdom breaks that
 * patching, so this file must never be collected by the `component`
 * project). Follows the NTARH pattern in `src/app/api/agents/route.test.ts`.
 *
 * Pins the rejection branches from `src/lib/schemas/media.ts` and
 * `src/lib/schemas/knowledge.ts` (02-08-PLAN.md Task 3): an unrecognized
 * vector action, an out-of-bounds vector search limit, and a docs path
 * carrying a traversal segment or an absolute-path prefix. Every case here
 * is rejected by `withRoute`'s schema validation in `resolveInputs()`
 * (`src/lib/api-route.ts`) BEFORE the route handler — and therefore any
 * filesystem or embedding call inside it — ever runs, so no live gateway or
 * OpenClaw instance is required for this file to stay green.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as vectorHandler from "@/app/api/vector/route";
import * as docsHandler from "@/app/api/docs/route";
import { describe, test, expect } from "vitest";

describe("POST /api/vector — action rejection (no instance required)", () => {
  test("an unrecognized action returns 400 with a details tree naming the action field", async () => {
    await testApiHandler({
      appHandler: vectorHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "definitely-not-a-real-action" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        // z.treeifyError() output — the discriminated union's issue is
        // reported under the "action" property.
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("action");
      },
    });
  });
});

describe("GET /api/vector — numeric limit rejection (no instance required)", () => {
  test("a search `max` beyond the bound returns 400 with the project error envelope", async () => {
    await testApiHandler({
      appHandler: vectorHandler,
      url: "/api/vector?scope=search&q=hello&max=99999",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });

  test("a negative search `max` returns 400 with the project error envelope", async () => {
    await testApiHandler({
      appHandler: vectorHandler,
      url: "/api/vector?scope=search&q=hello&max=-1",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
      },
    });
  });
});

describe("GET /api/docs — path rejection (no instance required)", () => {
  test("a path with a parent-directory traversal segment returns 400 and never echoes the path", async () => {
    const traversalPath = "../../../../etc/passwd";
    await testApiHandler({
      appHandler: docsHandler,
      url: `/api/docs?path=${encodeURIComponent(traversalPath)}`,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        // Rejected by docPathSchema inside withRoute's resolveInputs(),
        // before the handler (and its readFile call) ever runs — a real
        // filesystem read of a traversing path would instead answer 200
        // (content leaked) or 500 (an fs error), never this schema 400.
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        const raw = JSON.stringify(body);
        expect(raw).not.toContain("etc/passwd");
        expect(raw).not.toContain("..");
      },
    });
  });

  test("an absolute path returns 400 and never echoes the path", async () => {
    const absolutePath = "/etc/passwd";
    await testApiHandler({
      appHandler: docsHandler,
      url: `/api/docs?path=${encodeURIComponent(absolutePath)}`,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        const raw = JSON.stringify(body);
        expect(raw).not.toContain("/etc/passwd");
      },
    });
  });

  test("DELETE with a traversal path is rejected the same way, before any unlink call", async () => {
    const traversalPath = "../../../../etc/passwd";
    await testApiHandler({
      appHandler: docsHandler,
      url: `/api/docs?path=${encodeURIComponent(traversalPath)}`,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "DELETE" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(JSON.stringify(body)).not.toContain("etc/passwd");
      },
    });
  });
});
