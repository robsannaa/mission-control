/**
 * CI-safe route-handler tests for the capability-refusal branch on
 * `GET`/`POST /api/tailscale` (03-03-PLAN.md Task 1) — the second confirmed
 * CAP-03 violation in this codebase (T-03-09) and, before this plan, a
 * route with no availability gate of any kind. The refusal fires inside
 * `requireCapability("tailscaleNetworking")`, before any `tailscale` CLI
 * invocation ever runs — this file needs no gateway and no `tailscale`
 * binary, so it belongs in the fast `unit` project. Follows the
 * `next-test-api-route-handler` pattern in `src/app/api/logs/route.test.ts`
 * and the hosted-flag-refusal pattern in
 * `src/app/api/integrations/apple/events/route.test.ts`.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as tailscaleHandler from "@/app/api/tailscale/route";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { invalidateProbeCache } from "@/lib/capability-probes";

const REFUSAL_BODY = { ok: false, error: "This isn't available on your setup." };

beforeEach(() => {
  invalidateProbeCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateProbeCache();
});

describe("GET /api/tailscale — capability refusal (no instance required)", () => {
  test("hosted mode returns 404 with the fixed refusal body, byte-identical to the Phase 2 envelope", async () => {
    vi.stubEnv("AGENTBAY_HOSTED", "true");

    await testApiHandler({
      appHandler: tailscaleHandler,
      url: "/api/tailscale",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toStrictEqual(REFUSAL_BODY);
      },
    });
  });

  test("with the hosted flag unset, the response is not the refusal body", async () => {
    await testApiHandler({
      appHandler: tailscaleHandler,
      url: "/api/tailscale",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).not.toBe(404);
        const body = await res.json();
        expect(body).not.toStrictEqual(REFUSAL_BODY);
      },
    });
  });
});

describe("POST /api/tailscale — capability refusal (no instance required)", () => {
  test("hosted mode returns 404 with the fixed refusal body before any tailscale CLI invocation", async () => {
    vi.stubEnv("AGENTBAY_HOSTED", "true");

    await testApiHandler({
      appHandler: tailscaleHandler,
      url: "/api/tailscale",
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "up" }),
        });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toStrictEqual(REFUSAL_BODY);
      },
    });
  });

  test("with the hosted flag unset, the response is not the refusal body", async () => {
    await testApiHandler({
      appHandler: tailscaleHandler,
      url: "/api/tailscale",
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "status" }),
        });
        expect(res.status).not.toBe(404);
        const body = await res.json();
        expect(body).not.toStrictEqual(REFUSAL_BODY);
      },
    });
  });
});
