/**
 * CI-safe route-handler tests for the capability-refusal branch on
 * `GET`/`POST /api/calendar` (03-03-PLAN.md Task 1). The refusal fires
 * inside `requireCapability("calendarWorkspace")`, before any calendar
 * store read/write ever runs — this file needs no gateway and no calendar
 * account state, so it belongs in the fast `unit` project. Follows the
 * `next-test-api-route-handler` pattern in `src/app/api/logs/route.test.ts`
 * and the hosted-flag-refusal pattern in
 * `src/app/api/integrations/apple/events/route.test.ts`.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as calendarHandler from "@/app/api/calendar/route";
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

describe("GET /api/calendar — capability refusal (no instance required)", () => {
  test("hosted mode returns 404 with the fixed refusal body, byte-identical to the Phase 2 envelope", async () => {
    vi.stubEnv("AGENTBAY_HOSTED", "true");

    await testApiHandler({
      appHandler: calendarHandler,
      url: "/api/calendar",
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
      appHandler: calendarHandler,
      url: "/api/calendar",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).not.toBe(404);
        const body = await res.json();
        expect(body).not.toStrictEqual(REFUSAL_BODY);
      },
    });
  });
});

describe("POST /api/calendar — capability refusal (no instance required)", () => {
  test("hosted mode returns 404 with the fixed refusal body and no calendar store write occurs", async () => {
    vi.stubEnv("AGENTBAY_HOSTED", "true");

    await testApiHandler({
      appHandler: calendarHandler,
      url: "/api/calendar",
      test: async ({ fetch }) => {
        // action=add-account would otherwise attempt a calendar-store write —
        // the refusal must fire before that call, not merely coincide with it.
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "add-account", provider: "google" }),
        });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toStrictEqual(REFUSAL_BODY);
      },
    });
  });
});
