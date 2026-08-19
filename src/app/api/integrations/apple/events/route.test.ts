/**
 * CI-safe route-handler test for the capability-refusal branch on
 * `GET /api/integrations/apple/events` (03-01-PLAN.md Task 2). The refusal
 * fires inside `requireCapability("appleCalendar")`, before
 * `readAppleCalendarEvents()` ever runs — this file needs no gateway and no
 * real Calendar access, so it belongs in the fast `unit` project. Follows
 * the `next-test-api-route-handler` pattern in
 * `src/app/api/logs/route.test.ts`.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appleEventsHandler from "@/app/api/integrations/apple/events/route";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { invalidateProbeCache } from "@/lib/capability-probes";

describe("GET /api/integrations/apple/events — capability refusal (no instance required)", () => {
  beforeEach(() => {
    invalidateProbeCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    invalidateProbeCache();
  });

  test("hosted mode returns 404 with the fixed refusal body, byte-identical to the Phase 2 envelope", async () => {
    // Hosted wins over any real icalBuddy binary this dev machine might have
    // installed (computeCapabilities' own precedence — proven separately in
    // capabilities.test.ts) — stubbing hosted alone is enough to force the
    // refusal branch deterministically, on any OS running this suite.
    vi.stubEnv("AGENTBAY_HOSTED", "true");

    await testApiHandler({
      appHandler: appleEventsHandler,
      url: "/api/integrations/apple/events",
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body).toStrictEqual({ ok: false, error: "This isn't available on your setup." });
      },
    });
  });
});
