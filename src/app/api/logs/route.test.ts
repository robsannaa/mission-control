/**
 * CI-safe route-handler tests for the logs, chat-attachment and
 * session-activity rejection branches (02-11-PLAN.md Task 3) — runs in the
 * `unit` project under `environment: 'node'` (next-test-api-route-handler
 * patches Next.js internals; jsdom breaks that patching, so this file must
 * never be collected by the `component` project). Follows the NTARH pattern
 * in `src/app/api/agents/route.test.ts` and the rejection-pin shape in
 * `src/app/api/vector/route.test.ts`.
 *
 * Every case here is rejected by `withRoute`'s schema validation in
 * `resolveInputs()` (`src/lib/api-route.ts`) BEFORE the route handler — and
 * therefore any log file/attachment filesystem read inside it — ever runs,
 * so no live gateway or OpenClaw instance is required for this file to stay
 * green.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as logsHandler from "@/app/api/logs/route";
import * as chatFilesPreviewHandler from "@/app/api/chat/files/preview/route";
import * as activitySessionHandler from "@/app/api/activity/session/route";
import { describe, test, expect } from "vitest";

describe("GET /api/logs — line-count and type rejection (no instance required)", () => {
  test("a limit beyond the bound returns 400 with ok false and no file read is attempted", async () => {
    await testApiHandler({
      appHandler: logsHandler,
      url: "/api/logs?limit=999999",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        // Rejected by logsLimitSchema inside withRoute's resolveInputs(),
        // before the handler (and its readFile/stat calls) ever runs — a
        // real log read of an oversized limit would instead answer 200.
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });

  test("a type outside the enumerated log-source set returns 400 with ok false", async () => {
    await testApiHandler({
      appHandler: logsHandler,
      url: "/api/logs?type=not-a-real-source",
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
});

describe("GET /api/chat/files/preview — attachment path rejection (no instance required)", () => {
  test("a path with a parent-directory traversal segment returns 400 and never echoes the path", async () => {
    const traversalPath = "../../../../etc/passwd";
    await testApiHandler({
      appHandler: chatFilesPreviewHandler,
      url: `/api/chat/files/preview?path=${encodeURIComponent(traversalPath)}`,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        // Rejected by chatAttachmentPathSchema before path.resolve/stat/
        // readFile ever run — a real filesystem read of a traversing path
        // would instead answer 200 (content leaked), 404, or 502.
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
      appHandler: chatFilesPreviewHandler,
      url: `/api/chat/files/preview?path=${encodeURIComponent(absolutePath)}`,
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
});

describe("GET /api/activity/session — pagination rejection (no instance required)", () => {
  test("a non-integer limit returns 400 with ok false and a details tree naming the field", async () => {
    await testApiHandler({
      appHandler: activitySessionHandler,
      url: "/api/activity/session?sessionKey=agent:dev:chat:abc123&limit=not-a-number",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        // z.treeifyError() output — the field-level issue is reported
        // under the "limit" property.
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("limit");
      },
    });
  });
});
