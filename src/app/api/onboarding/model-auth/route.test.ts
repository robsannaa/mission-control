/**
 * CI-safe route-handler test for POST /api/onboarding/model-auth — runs in
 * the `unit` project under `environment: 'node'` (next-test-api-route-handler
 * patches Next.js internals; jsdom breaks that patching, so this file must
 * never be collected by the `component` project).
 *
 * Both cases here return before any provider is probed or any credential is
 * written to disk (T-02-19 / the plan's must_haves: "A malformed model-auth
 * payload is rejected ... before any provider credential is written to
 * disk"), so this file needs no OpenClaw gateway and touches no config file.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appHandler from "@/app/api/onboarding/model-auth/route";
import { describe, test, expect } from "vitest";

describe("POST /api/onboarding/model-auth — pre-gateway validation (no instance required)", () => {
  test("unknown provider identifier → 400, ok false", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "validate-key",
            provider: "not-a-real-provider",
            token: "irrelevant-for-this-branch",
          }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error).toContain("Unknown provider");
      },
    });
  });

  test("missing credential field → 400, ok false, no credential value anywhere in the response body", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        // The credential itself is intentionally absent — this is the
        // "missing field" branch. A second request below proves that even
        // when a credential-shaped sentinel IS submitted (but rejected for
        // an unrelated reason), it never appears in the response body.
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "save-api-key", provider: "openai" }),
        });
        expect(res.status).toBe(400);
        const raw = await res.text();
        const body = JSON.parse(raw);
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.toLowerCase()).toContain("api key");
      },
    });
  });

  test("a submitted credential sentinel never appears in the response body of an unrelated rejection", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const sentinel = "SENTINEL-MODEL-AUTH-CREDENTIAL-7be0";
        // provider is missing/invalid (rejected before token is ever
        // inspected) — token still carries the sentinel to prove a
        // regression that echoes the raw body would be caught here.
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "save-api-key", provider: "", token: sentinel }),
        });
        expect(res.status).toBe(400);
        const raw = await res.text();
        const body = JSON.parse(raw);
        expect(body.ok).toBe(false);
        expect(raw).not.toContain(sentinel);
      },
    });
  });
});
