/**
 * CI-safe route-handler tests for the secrets, workspace-file and backup
 * rejection branches (02-12-PLAN.md Task 3) — runs in the `unit` project
 * under `environment: 'node'` (next-test-api-route-handler patches Next.js
 * internals; jsdom breaks that patching, so this file must never be
 * collected by the `component` project). Follows the NTARH pattern in
 * `src/app/api/agents/route.test.ts`, the rejection-pin shape in
 * `src/app/api/logs/route.test.ts`, and the credential-sentinel assertion
 * pattern established in `src/app/api/auth/login/route.test.ts` (plan 02-05).
 *
 * Every case here is rejected by `withRoute`'s schema validation in
 * `resolveInputs()` (`src/lib/api-route.ts`) BEFORE the route handler — and
 * therefore any `openclaw secrets`/filesystem/`openclaw backup` call inside
 * it — ever runs, so no live gateway or OpenClaw instance is required for
 * this file to stay green.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as secretsHandler from "@/app/api/secrets/route";
import * as workspaceFileHandler from "@/app/api/workspace/file/route";
import * as backupHandler from "@/app/api/backup/route";
import { describe, test, expect } from "vitest";

describe("POST /api/secrets — pre-CLI-call rejection (no instance required)", () => {
  test("a missing action field returns 400 with ok false and a details tree naming the action path", async () => {
    await testApiHandler({
      appHandler: secretsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        // Rejected by secretsPostSchema's required `action` field before
        // `openclaw secrets ...` is ever invoked — an accepted request would
        // instead fall through to the handler's own switch.
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("action");
      },
    });
  });

  test("a planPath containing a traversal segment returns 400, ok false, and never echoes the submitted sentinel", async () => {
    // `sentinel` proves the schema rejection never echoes the raw request
    // body back to the caller — the regression this task exists to catch.
    const sentinel = "SENTINEL-SECRET-PLANPATH-7ab3f9";
    await testApiHandler({
      appHandler: secretsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "apply",
            planPath: `/tmp/${sentinel}/../../etc/passwd`,
          }),
        });
        // Rejected by secretsPlanPathSchema's traversal-segment check before
        // `openclaw secrets apply --from <path>` is ever invoked.
        expect(res.status).toBe(400);
        const raw = await res.text();
        const body = JSON.parse(raw);
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("planPath");
        // The rejection message/details never contain the submitted value.
        expect(raw).not.toContain(sentinel);
        expect(raw).not.toContain("etc/passwd");
      },
    });
  });
});

describe("GET /api/workspace/file — path-traversal rejection (no instance required)", () => {
  test("a path with a parent-directory traversal segment returns 400 and no filesystem read is attempted", async () => {
    const traversalPath = "../../../../etc/passwd";
    await testApiHandler({
      appHandler: workspaceFileHandler,
      url: `/api/workspace/file?path=${encodeURIComponent(traversalPath)}`,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        // Rejected by workspaceRelativePathSchema inside withRoute's
        // resolveInputs(), before getDefaultWorkspace()/resolve()/readFile
        // ever run — a real filesystem read of a traversing path would
        // instead answer 200 (content leaked), 403, or 404, never 400.
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
      appHandler: workspaceFileHandler,
      url: `/api/workspace/file?path=${encodeURIComponent(absolutePath)}`,
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

describe("POST /api/backup — archive-identifier rejection (no instance required)", () => {
  test("an out-of-format archive identifier returns 400, ok false, and no restore is started", async () => {
    await testApiHandler({
      appHandler: backupHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "verify", path: "/tmp/not-an-archive.exe" }),
        });
        // Rejected by backupArchivePathSchema's .tar.gz-extension check
        // before `openclaw backup verify <path>` is ever invoked — a real
        // verify attempt on a bad path would instead answer 200 or 500.
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("path");
      },
    });
  });

  test("a path with a parent-directory traversal segment returns 400 and no restore is started", async () => {
    await testApiHandler({
      appHandler: backupHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "verify", path: "/tmp/../../etc/openclaw-backup.tar.gz" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        const raw = JSON.stringify(body);
        expect(raw).not.toContain("etc/openclaw-backup");
      },
    });
  });
});
