/**
 * Live proof that the served capability matrix (`GET /api/capabilities`,
 * `src/app/api/capabilities/route.ts`, plan 03-01) is well-shaped, uncached,
 * refreshable, and cannot drift from what the server actually enforces
 * (`.planning/phases/03-runtime-capability-detection/03-05-PLAN.md`, Task 1).
 *
 * This spec observes the running instance — it never restarts Mission
 * Control, never sets the hosted-deployment env flag, and never launches a
 * subprocess to reconfigure the machine. The CAP-04 flag-switch proof
 * (stop/start against `npm run dev:vpc`, same build) is a human checkpoint
 * (03-05 Task 3) — a live spec running inside the same `next dev` process
 * it would be restarting cannot prove that without tearing down its own
 * server.
 *
 * Six declared capability keys, `src/lib/capabilities.ts`:
 *   appleCalendar, calendarWorkspace, tailscaleNetworking, hostInfrastructure,
 *   localGatewayControl, localModelAuth.
 *
 * A red assertion here means the served matrix's wire shape changed, its
 * cache-control header regressed, or the served `appleCalendar` value and
 * the actual `/api/integrations/apple/events` enforcement disagree — not
 * that the test is wrong.
 */
import { test, expect } from "@playwright/test";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

const DECLARED_CAPABILITY_KEYS = [
  "appleCalendar",
  "calendarWorkspace",
  "tailscaleNetworking",
  "hostInfrastructure",
  "localGatewayControl",
  "localModelAuth",
] as const;

const REFUSAL_BODY = { ok: false, error: "This isn't available on your setup." };

interface CapabilitySnapshotBody {
  capabilities: Record<string, unknown>;
  hosted: unknown;
}

/**
 * Assert the exact wire-shape contract T-03-06 depends on: top-level keys
 * are exactly `capabilities` and `hosted`, `capabilities`' own keys are
 * exactly the six declared keys, and every capability value is a real
 * boolean — never a string, `null`, or nested object.
 */
function assertCanonicalSnapshotShape(body: unknown): asserts body is CapabilitySnapshotBody {
  expect(body).not.toBeNull();
  expect(typeof body).toBe("object");
  const topLevelKeys = Object.keys(body as object).sort();
  expect(topLevelKeys).toEqual(["capabilities", "hosted"]);

  const snapshot = body as CapabilitySnapshotBody;
  expect(typeof snapshot.hosted).toBe("boolean");

  expect(snapshot.capabilities).not.toBeNull();
  expect(typeof snapshot.capabilities).toBe("object");
  const capabilityKeys = Object.keys(snapshot.capabilities).sort();
  expect(capabilityKeys).toEqual([...DECLARED_CAPABILITY_KEYS].sort());

  for (const key of DECLARED_CAPABILITY_KEYS) {
    expect(typeof snapshot.capabilities[key], `capabilities.${key} must be a boolean`).toBe(
      "boolean",
    );
  }
}

test.describe("@live capability matrix", () => {
  test("GET /api/capabilities returns the canonical wire shape with no-store", async ({
    request,
  }) => {
    const res = await request.get(`${LIVE_BASE}/api/capabilities`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    const body = await res.json();
    assertCanonicalSnapshotShape(body);
  });

  test("GET /api/capabilities?refresh=1 forces a re-probe without changing the contract", async ({
    request,
  }) => {
    const res = await request.get(`${LIVE_BASE}/api/capabilities?refresh=1`);
    expect(res.status()).toBe(200);
    expect(res.headers()["cache-control"]).toBe("no-store");
    const body = await res.json();
    assertCanonicalSnapshotShape(body);
  });

  test("two successive plain reads return the same capability values (cache stability within the TTL)", async ({
    request,
  }) => {
    const first = await (await request.get(`${LIVE_BASE}/api/capabilities`)).json();
    const second = await (await request.get(`${LIVE_BASE}/api/capabilities`)).json();
    assertCanonicalSnapshotShape(first);
    assertCanonicalSnapshotShape(second);
    expect(second.capabilities).toEqual(first.capabilities);
    expect(second.hosted).toBe(first.hosted);
  });

  test("hosted/capability relationship holds, honest on any machine", async ({ request }) => {
    const body = await (await request.get(`${LIVE_BASE}/api/capabilities`)).json();
    assertCanonicalSnapshotShape(body);

    // If hosted is true, every capability must be false — a hosted process
    // never has a real UI/API surface for any of the six keys.
    if (body.hosted === true) {
      for (const key of DECLARED_CAPABILITY_KEYS) {
        expect(body.capabilities[key], `capabilities.${key} must be false when hosted`).toBe(
          false,
        );
      }
    }

    // appleCalendar may only be true when hosted is false — it's gated by
    // hosted AND platform AND the icalBuddy probe (src/lib/capabilities.ts).
    if (body.capabilities.appleCalendar === true) {
      expect(body.hosted).toBe(false);
    }

    // This machine (self-hosted macOS, dev instance running): hosted is
    // false and the five deployment-scoped keys (everything but
    // appleCalendar, which also depends on the icalBuddy probe) are true.
    if (body.hosted === false) {
      const deploymentScopedKeys = DECLARED_CAPABILITY_KEYS.filter(
        (key) => key !== "appleCalendar",
      );
      for (const key of deploymentScopedKeys) {
        expect(body.capabilities[key], `capabilities.${key} must be true when not hosted`).toBe(
          true,
        );
      }
    }
  });

  test("served appleCalendar value is consistent with /api/integrations/apple/events enforcement", async ({
    request,
  }) => {
    const snapshot = await (await request.get(`${LIVE_BASE}/api/capabilities`)).json();
    assertCanonicalSnapshotShape(snapshot);

    const eventsRes = await request.get(`${LIVE_BASE}/api/integrations/apple/events`);
    const eventsBody = await eventsRes.json();

    if (snapshot.capabilities.appleCalendar === false) {
      expect(eventsRes.status()).toBe(404);
      expect(eventsBody).toEqual(REFUSAL_BODY);
    } else {
      // Capability present: the route must not answer with the fixed
      // refusal body — its real success/failure shape is out of scope here.
      expect(eventsBody).not.toEqual(REFUSAL_BODY);
    }
  });
});
