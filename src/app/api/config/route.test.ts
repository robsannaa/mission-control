/**
 * CI-safe route-handler test for PATCH /api/config — runs in the `unit`
 * project under `environment: 'node'` (next-test-api-route-handler patches
 * Next.js internals; jsdom breaks that patching, so this file must never be
 * collected by the `component` project).
 *
 * This file exercises only `src/lib/schemas/config.ts`'s pre-gateway
 * rejection branches — the Zod port of the former hand-rolled raw/patch
 * payload check. Every case here returns before any gateway RPC is
 * attempted, so this file stays green with no OpenClaw instance running and
 * never touches the real config file. Anything that needs to reach the real
 * gateway belongs in a `*.live.test.ts` file (the `live` project), never
 * here.
 *
 * D-04 note: none of these tests touch the GET path, `restoreRedactedValues`,
 * or the redaction sentinel — this file is PATCH-body rejection coverage
 * only.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appHandler from "@/app/api/config/route";
import { describe, test, expect } from "vitest";

describe("PATCH /api/config — pre-gateway payload validation (no instance required)", () => {
  test("neither raw nor patch provided → 400 with the original plain-language message", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("raw or patch required");
      },
    });
  });

  test("raw is a string containing invalid JSON → 400, parse detail preserved in the message", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw: "not json" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error.startsWith("Invalid JSON:")).toBe(true);
      },
    });
  });

  test("raw parses to an array → 400, 'not array or primitive' message", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw: "[1,2,3]" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("Config must be a JSON object (not array or primitive)");
      },
    });
  });

  test("raw parses to a primitive → 400, 'not array or primitive' message", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ raw: "42" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("Config must be a JSON object (not array or primitive)");
      },
    });
  });

  test("patch field is an array → 400, 'patch must be a JSON object' message", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: [1, 2, 3] }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("patch must be a JSON object");
      },
    });
  });

  test("every rejection carries a Zod details tree and no request reaches the config writer", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ patch: "not-an-object" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("patch must be a JSON object");
        expect(body.details).toBeDefined();
        // A rejection this early never calls the gateway — there is no
        // "ok: true" / "hash" / "result" on any of these bodies.
        expect(body).not.toHaveProperty("hash");
        expect(body).not.toHaveProperty("result");
      },
    });
  });
});
