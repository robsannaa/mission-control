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
 * The three assertions below also pin the project-wide API error envelope —
 * every route in this codebase answers `{ error: string }` plus a status
 * code. A future change to that shape should fail this test first.
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
        expect(body).toStrictEqual({ error: "Agent name is required" });
        expect(body).not.toHaveProperty("ok");
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
        expect(Object.keys(body)).toStrictEqual(["error"]);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });

  test("malformed JSON body → 400, error starts with 'Invalid JSON body:'", async () => {
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
        expect(Object.keys(body)).toStrictEqual(["error"]);
        expect(body.error).toMatch(/^Invalid JSON body:/);
      },
    });
  });
});
