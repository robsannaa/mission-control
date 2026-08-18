/**
 * CI-safe route-handler test for POST /api/agents — runs in the `unit`
 * project under `environment: 'node'` (next-test-api-route-handler patches
 * Next.js internals; jsdom breaks that patching, so this file must never be
 * collected by the `component` project).
 *
 * This file deliberately exercises only the pre-gateway validation branches
 * of the POST handler: missing name, malformed name, and malformed JSON.
 * Every one of those returns before `gatewayCallWithRetry` is reached, so
 * this file stays green with no OpenClaw instance running and creates zero
 * agents as a side effect. Anything that needs to reach the real gateway
 * belongs in a `*.live.test.ts` file (the `live` project), never here.
 *
 * The assertions below pin the Phase 2 (server-contract-hardening) canonical
 * API error envelope — `{ ok: false, error: string, details?: unknown }`
 * (D-01, docs/API-CONTRACT.md) — which every route in this codebase now
 * answers with. This is a deliberate change from the Phase-1 pin (which
 * asserted `{ error: string }` with no `ok` property, per D-02 in
 * `.planning/phases/02-server-contract-hardening/02-CONTEXT.md`). A future
 * change to the envelope shape should fail this test first.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appHandler from "@/app/api/agents/route";
import { describe, test, expect } from "vitest";

describe("POST /api/agents — pre-gateway validation (no instance required)", () => {
  test("missing name → 400 with the project error envelope", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        // A missing required field is checked directly by the route handler
        // (not by the Zod schema), so it carries no `details` tree — see
        // `src/lib/schemas/agents.ts`.
        expect(body).toStrictEqual({ ok: false, error: "Agent name is required" });
      },
    });
  });

  test("name starting with a hyphen fails the name-format guard → 400", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "create", name: "-bad" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        // A present-but-malformed field IS caught by the Zod schema, so this
        // response carries a `details` tree (`z.treeifyError()` output).
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
        const body = await res.json();
        expect(body).toStrictEqual({ ok: false, error: "Invalid JSON body" });
      },
    });
  });
});
