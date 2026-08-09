/**
 * Pairing-required error handling.
 *
 * 1. Unit-style tests of the classifier in src/lib/gateway-errors.ts, fed the
 *    real error strings the gateway produces (probed against OpenClaw
 *    v2026.7.1's connect-error-details module).
 * 2. The 428 route contract, exercised through the same helper the routes
 *    call, with an injected PairingRequiredError.
 * 3. Read-only round-trips against the live dev server on 127.0.0.1:3100
 *    (this machine's device IS approved, so these assert shape + no
 *    regression, not pairing content).
 */

import { test, expect } from "@playwright/test";
import {
  PairingRequiredError,
  classifyPairingError,
  isPairingRequiredError,
  pairingRequiredResponse,
  toPairingRequiredError,
} from "../src/lib/gateway-errors";
import { GatewayRpcError, GatewayScopeError } from "../src/lib/gateway-rpc";

const LIVE_BASE = "http://127.0.0.1:3100";

/* ── 1. Classifier ─────────────────────────────────────────────────────── */

test.describe("classifyPairingError", () => {
  test("connect res error: NOT_PAIRED + PAIRING_REQUIRED details", () => {
    const err = new GatewayRpcError(
      "pairing required: device is asking for more scopes than currently approved",
      "NOT_PAIRED",
      {
        code: "PAIRING_REQUIRED",
        reason: "scope-upgrade",
        requestId: "req-abc123",
        requestedRole: "operator",
        requestedScopes: ["operator.read", "operator.write"],
        approvedScopes: ["operator.read"],
      },
    );

    const detail = classifyPairingError(err);
    expect(detail).not.toBeNull();
    expect(detail?.reason).toBe("scope-upgrade");
    expect(detail?.requestId).toBe("req-abc123");
    expect(detail?.requestedRole).toBe("operator");
    expect(detail?.requestedScopes).toEqual(["operator.read", "operator.write"]);
    expect(detail?.approvedScopes).toEqual(["operator.read"]);
    expect(detail?.message).toContain("pairing required");
  });

  test("socket close 1008: reason parsed from message text", () => {
    const err = new GatewayRpcError(
      "Gateway RPC socket closed (1008): pairing required: device is asking for more scopes than currently approved",
    );
    const detail = classifyPairingError(err);
    expect(detail).not.toBeNull();
    expect(detail?.reason).toBe("scope-upgrade");
  });

  test("all four gateway requirement phrases map to reasons", () => {
    const cases: Array<[string, string]> = [
      ["pairing required: device is not approved yet", "not-paired"],
      [
        "pairing required: device is asking for a higher role than currently approved",
        "role-upgrade",
      ],
      [
        "pairing required: device is asking for more scopes than currently approved",
        "scope-upgrade",
      ],
      [
        "pairing required: device identity changed and must be re-approved",
        "metadata-upgrade",
      ],
    ];
    for (const [message, reason] of cases) {
      const detail = classifyPairingError(new GatewayRpcError(message));
      expect(detail, message).not.toBeNull();
      expect(detail?.reason, message).toBe(reason);
    }
  });

  test("CLI fallback: plain Error with embedded pairing text", () => {
    const err = new Error(
      "openclaw gateway call sessions.list failed: gateway closed (1008): pairing required",
    );
    const detail = classifyPairingError(err);
    expect(detail).not.toBeNull();
    expect(detail?.message).toContain("pairing required");
  });

  test("GatewayScopeError (zero granted scopes) classifies as not-paired", () => {
    const detail = classifyPairingError(new GatewayScopeError([]));
    expect(detail).not.toBeNull();
    expect(detail?.reason).toBe("not-paired");
  });

  test("non-pairing errors return null", () => {
    expect(
      classifyPairingError(new GatewayRpcError("Gateway RPC timed out for sessions.list")),
    ).toBeNull();
    expect(
      classifyPairingError(new GatewayRpcError("Gateway RPC socket is not connected")),
    ).toBeNull();
    expect(classifyPairingError(new Error("ECONNREFUSED 127.0.0.1:18789"))).toBeNull();
    expect(classifyPairingError(null)).toBeNull();
    expect(classifyPairingError("unrelated string")).toBeNull();
  });

  test("toPairingRequiredError wraps once and is idempotent", () => {
    const raw = new GatewayRpcError("pairing required", "NOT_PAIRED");
    const wrapped = toPairingRequiredError(raw);
    expect(wrapped).toBeInstanceOf(PairingRequiredError);
    expect(wrapped).toBeInstanceOf(GatewayRpcError);
    expect(wrapped?.code).toBe("PAIRING_REQUIRED");
    expect(isPairingRequiredError(wrapped)).toBe(true);
    // Idempotent: an already-typed error passes through unchanged.
    expect(toPairingRequiredError(wrapped)).toBe(wrapped);
    // Non-pairing errors are left alone.
    expect(toPairingRequiredError(new Error("boom"))).toBeNull();
    expect(isPairingRequiredError(new Error("boom"))).toBe(false);
  });
});

/* ── 2. 428 route contract (injected error class) ──────────────────────── */

test.describe("pairingRequiredResponse (route 428 contract)", () => {
  // Simulates exactly what the sessions/cron/activity routes do in their
  // catch blocks after gatewayCall throws a PairingRequiredError.
  async function simulateRoute(thrown: unknown): Promise<Response> {
    try {
      throw thrown;
    } catch (err) {
      const pairing = pairingRequiredResponse(err);
      if (pairing) return pairing;
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  test("pairing error → HTTP 428 { error: 'pairing_required', detail }", async () => {
    const res = await simulateRoute(
      new PairingRequiredError({
        message:
          "pairing required: device is asking for more scopes than currently approved",
        reason: "scope-upgrade",
        requestId: "req-abc123",
      }),
    );
    expect(res.status).toBe(428);
    expect(res.headers.get("X-Pairing-Required")).toBe("1");
    const body = await res.json();
    expect(body.error).toBe("pairing_required");
    expect(body.detail.reason).toBe("scope-upgrade");
    expect(body.detail.requestId).toBe("req-abc123");
  });

  test("raw (unwrapped) gateway pairing error also → 428", async () => {
    const res = await simulateRoute(
      new GatewayRpcError(
        "Gateway RPC socket closed (1008): pairing required: device is not approved yet",
      ),
    );
    expect(res.status).toBe(428);
    const body = await res.json();
    expect(body.error).toBe("pairing_required");
    expect(body.detail.reason).toBe("not-paired");
  });

  test("other errors keep the 500 path", async () => {
    const res = await simulateRoute(new Error("ECONNREFUSED"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("ECONNREFUSED");
  });
});

/* ── 3. Live round-trips (read-only, device is approved) ───────────────── */

test.describe("live endpoints on :3100 @live", () => {
  test("devices endpoint returns pending/paired shape", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/devices`, { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.pending)).toBe(true);
    expect(Array.isArray(body.paired)).toBe(true);
    // Assert shape, not content — a healthy machine usually has none pending.
    for (const req of body.pending) {
      expect(typeof req.requestId).toBe("string");
    }
    for (const dev of body.paired) {
      expect(typeof dev.deviceId).toBe("string");
      // Token values must be stripped by the route's sanitizer.
      for (const tok of dev.tokens || []) {
        expect(tok.token).toBeUndefined();
      }
    }
  });

  test("sessions endpoint still returns data (no 428 regression)", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/sessions`, { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  test("cron endpoint still returns jobs (no 428 regression)", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/cron`, { timeout: 30_000 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.jobs)).toBe(true);
  });

  test("activity endpoint still returns an array body", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/activity`, { timeout: 60_000 });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Approved device → the pairing header must be absent.
    expect(res.headers()["x-pairing-required"]).toBeUndefined();
  });
});
