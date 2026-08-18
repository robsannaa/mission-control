/**
 * CI-safe route-handler tests pinning the system/runtime/device route
 * group's schema-boundary rejection branches AND the degraded-payload
 * contract (02-10 Task 3).
 *
 * This file drives three route modules:
 *
 *   - `@/app/api/permissions/route` — the exec-approval/elevated-tool
 *     policy POST action switch (T-02-44): an unrecognized action, and a
 *     structurally-valid-but-incomplete "set-approvals-defaults" payload,
 *     must both be rejected before any policy write.
 *   - `@/app/api/browser/relay/route` — the "open-test-tab" action's
 *     forwarding-target gate (T-02-45): a non-absolute-URL target must be
 *     rejected before the CLI subprocess that would navigate the browser to
 *     it is ever spawned.
 *   - `@/app/api/heartbeat/route` — the degraded-payload contract shared by
 *     every status-style route in this group (T-02-46): when the upstream
 *     gateway call fails, the route must still answer 200 with an
 *     explicitly degraded payload, never a 500. This is the point of this
 *     task: a future change to the shared wrapper that starts converting
 *     these into a 500 must fail this test, not silently break the offline
 *     dashboard experience Phase 5 depends on.
 *
 * The first two cases are rejected by `withRoute`'s schema-validation step
 * (`src/lib/api-route.ts#resolveInputs`) BEFORE the handler runs, so none of
 * these requests ever reach `gatewayCall`/`runCli`/`runCliJson`/
 * `gatewayConfigPatch` — this file stays green with no OpenClaw instance
 * running and writes nothing. The third case forces the upstream call to
 * reject deterministically (`gatewayCallWithRetry` mocked) so the degraded
 * branch is exercised regardless of whether a real gateway happens to be
 * reachable in the environment this file runs in. Anything that needs the
 * real gateway belongs in a `*.live.test.ts` file (the `live` project),
 * never here.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/openclaw", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/openclaw")>();
  return {
    ...actual,
    gatewayCall: vi.fn(actual.gatewayCall),
    runCli: vi.fn(actual.runCli),
    runCliJson: vi.fn(actual.runCliJson),
  };
});

vi.mock("@/lib/gateway-config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gateway-config")>();
  return {
    ...actual,
    gatewayConfigPatch: vi.fn(actual.gatewayConfigPatch),
    gatewayCallWithRetry: vi.fn().mockRejectedValue(new Error("Gateway unreachable (test)")),
  };
});

import * as permissionsRoute from "@/app/api/permissions/route";
import * as browserRelayRoute from "@/app/api/browser/relay/route";
import * as heartbeatRoute from "@/app/api/heartbeat/route";
import { gatewayCall, runCli, runCliJson } from "@/lib/openclaw";
import { gatewayConfigPatch } from "@/lib/gateway-config";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/permissions — rejection branches fire before any policy write (no instance required)", () => {
  test("unrecognized action → 400 with ok:false and a details issue tree naming the action field", async () => {
    await testApiHandler({
      appHandler: permissionsRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "not-a-real-action" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        // The discriminated union rejects the unrecognized action at the
        // `action` field — the details tree names it.
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("action");
      },
    });
    // The rejection happened at the schema boundary — no policy write was
    // ever attempted.
    expect(gatewayCall).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    expect(gatewayConfigPatch).not.toHaveBeenCalled();
  });

  test("set-approvals-defaults with no security/ask/askFallback → 400 with ok:false, no policy write occurs", async () => {
    await testApiHandler({
      appHandler: permissionsRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "set-approvals-defaults" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.error).toBe("At least one of security, ask, askFallback is required");
      },
    });
    // A structurally-valid action with an incomplete payload still never
    // reaches the write path.
    expect(gatewayCall).not.toHaveBeenCalled();
    expect(runCli).not.toHaveBeenCalled();
    expect(gatewayConfigPatch).not.toHaveBeenCalled();
  });
});

describe("POST /api/browser/relay — forwarding-target validation (no instance required)", () => {
  test("open-test-tab target that is not an absolute URL → 400 with ok:false, no outbound CLI action attempted", async () => {
    await testApiHandler({
      appHandler: browserRelayRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "open-test-tab", url: "not-a-url" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("url");
      },
    });
    // The rejection happened at the schema boundary — the CLI subprocess
    // that would have navigated the browser to the target was never spawned.
    expect(runCliJson).not.toHaveBeenCalled();
  });
});

describe("GET /api/heartbeat — degraded-payload contract survives the wrapper (no instance required)", () => {
  test("upstream unavailable → 200 with a degraded payload, not an error status", async () => {
    await testApiHandler({
      appHandler: heartbeatRoute,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        // The wrapper's own catch would answer a thrown error with a 500 —
        // this route swallows the error itself and stays 200, which is the
        // whole point of the degraded-payload rule (T-02-46).
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.degraded).toBe(true);
        expect(typeof body.warning).toBe("string");
      },
    });
  });
});
