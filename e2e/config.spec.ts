/**
 * Config API + gateway-token lifecycle.
 *
 * 1. GET /api/config canonical single-payload contract against the live dev
 *    server: { config, meta } — no rawConfig/resolvedConfig duplicates, and
 *    secrets served readable (product decision: protection comes from
 *    authenticating the caller, not from hiding values).
 * 2. Config round-trip: PATCH a harmless schema-valid key
 *    (wizard.lastRunVersion — `meta` is additionalProperties:false, so
 *    meta.note is rejected by the gateway), observe the change, restore the
 *    original. Every config.patch schedules a gateway restart, so polling is
 *    generous.
 * 3. Unit tests for the gateway-token cache: invalidateGatewayToken() forces
 *    a re-read from disk, and GatewayRpcChannel retries an auth-failed RPC
 *    exactly once with freshly-read credentials (the real gateway rejects a
 *    stale token with code INVALID_REQUEST / details.code AUTH_TOKEN_MISMATCH,
 *    probed against OpenClaw v2026.7.1-2).
 */

import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getGatewayToken,
  invalidateGatewayToken,
} from "../src/lib/paths";
import { GatewayRpcChannel } from "../src/lib/gateway-rpc-channel";
import { GatewayRpcError } from "../src/lib/gateway-rpc";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

const REDACTION_SENTINEL = "__OPENCLAW_" + "REDACTED__";

// The token unit tests read from a throwaway OPENCLAW_HOME. paths.ts memoizes
// the home directory on first use (not at import time), so setting the env at
// module scope — before any test body runs — is sufficient. paths.ts appends
// `.openclaw` to OPENCLAW_HOME.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "mc-config-spec-"));
process.env.OPENCLAW_HOME = FAKE_HOME;
delete process.env.OPENCLAW_GATEWAY_TOKEN;
delete process.env.OPENCLAW_GATEWAY_PASSWORD;
const FAKE_CONFIG_DIR = join(FAKE_HOME, ".openclaw");
mkdirSync(FAKE_CONFIG_DIR, { recursive: true });
const FAKE_CONFIG_PATH = join(FAKE_CONFIG_DIR, "openclaw.json");

function writeFakeConfig(token: string): void {
  writeFileSync(
    FAKE_CONFIG_PATH,
    JSON.stringify({ gateway: { auth: { mode: "token", token } } }, null, 2),
  );
}

function makeAuthError(): GatewayRpcError {
  // Exact shape the live gateway returns for a wrong shared-secret token.
  return new GatewayRpcError(
    "unauthorized: gateway token mismatch (provide gateway auth token)",
    "INVALID_REQUEST",
    {
      code: "AUTH_TOKEN_MISMATCH",
      authReason: "token_mismatch",
      canRetryWithDeviceToken: false,
      recommendedNextStep: "update_auth_credentials",
    },
  );
}

type StubbableChannel = {
  getClient: () => {
    request: (
      method: string,
      params?: Record<string, unknown>,
      timeout?: number,
    ) => Promise<unknown>;
  };
};

/* ── 1. Canonical payload shape ────────────────────────────────────────── */

test.describe("GET /api/config — canonical payload @live", () => {
  test("returns a single { config, meta } payload, no duplicate copies", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("meta");
    expect(body).not.toHaveProperty("rawConfig");
    expect(body).not.toHaveProperty("resolvedConfig");
    expect(body).not.toHaveProperty("baseHash"); // lives in meta now

    expect(typeof body.config).toBe("object");
    expect(Array.isArray(body.config)).toBe(false);
    expect(typeof body.meta.baseHash).toBe("string");
    expect(typeof body.meta.schema).toBe("object");
    expect(typeof body.meta.uiHints).toBe("object");

    // openclaw.json shape: top-level sections.
    expect(Object.keys(body.config)).toEqual(expect.arrayContaining(["gateway"]));
  });

  test("secrets are served readable — no gateway redaction sentinel", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    // The gateway blanks secrets to a sentinel in config.get; the route
    // restores the on-disk values because secrets are intentionally readable.
    expect(JSON.stringify(body.config)).not.toContain(REDACTION_SENTINEL);
  });

  test("scope=schema returns schema + uiHints", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config?scope=schema`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.schema).toBe("object");
    expect(typeof body.uiHints).toBe("object");
  });

  test("config editor page renders", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/config`);
    expect(res.status()).toBe(200);
  });
});

/* ── 2. Round-trip ─────────────────────────────────────────────────────── */

test.describe.serial("config round-trip @live", () => {
  test("PATCH a harmless key, observe it, restore the original", async ({ request }) => {
    // Each config.patch schedules a gateway restart (~2s later); leave room
    // for two writes plus two recoveries.
    test.setTimeout(150_000);

    const getPayload = async () => {
      const res = await request.get(`${LIVE_BASE}/api/config`);
      expect(res.status()).toBe(200);
      return res.json();
    };
    const patchConfig = async (patch: Record<string, unknown>, baseHash: string) => {
      const res = await request.patch(`${LIVE_BASE}/api/config`, {
        data: { patch, baseHash },
      });
      return { status: res.status(), body: await res.json() };
    };

    const initial = await getPayload();
    const original = initial.config?.wizard?.lastRunVersion;
    test.skip(typeof original !== "string", "wizard.lastRunVersion not present on this install");

    const testValue = `mc-e2e-${Date.now()}`;
    const first = await patchConfig({ wizard: { lastRunVersion: testValue } }, initial.meta.baseHash);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.ok).toBe(true);

    await expect
      .poll(
        async () => {
          try {
            const payload = await getPayload();
            return payload.config?.wizard?.lastRunVersion;
          } catch {
            return null; // gateway restarting
          }
        },
        { timeout: 45_000, intervals: [1_500] },
      )
      .toBe(testValue);

    // Restore. The gateway may still be settling from the restart the first
    // write scheduled, so retry the write until it is accepted.
    await expect
      .poll(
        async () => {
          try {
            const payload = await getPayload();
            const result = await patchConfig(
              { wizard: { lastRunVersion: original } },
              payload.meta.baseHash,
            );
            return result.body.ok === true;
          } catch {
            return false;
          }
        },
        { timeout: 45_000, intervals: [2_000] },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          try {
            const payload = await getPayload();
            return payload.config?.wizard?.lastRunVersion;
          } catch {
            return null;
          }
        },
        { timeout: 45_000, intervals: [1_500] },
      )
      .toBe(original);
  });
});

/* ── 3. Token rotation (unit) ──────────────────────────────────────────── */

test.describe("gateway token rotation (unit)", () => {
  test("invalidateGatewayToken() drops the memoized token so a rotation is picked up", () => {
    writeFakeConfig("token-a");
    invalidateGatewayToken(); // clear anything memoized earlier in this worker
    expect(getGatewayToken()).toBe("token-a");

    // Rotate on disk; the memoized value must survive until invalidated.
    writeFakeConfig("token-b");
    expect(getGatewayToken()).toBe("token-a");

    invalidateGatewayToken();
    expect(getGatewayToken()).toBe("token-b");
  });

  test("GatewayRpcChannel retries once with re-read credentials after an auth failure", async () => {
    writeFakeConfig("token-a");
    invalidateGatewayToken();
    expect(getGatewayToken()).toBe("token-a");
    writeFakeConfig("token-b"); // rotated on disk, cache now stale

    const tokensSeen: string[] = [];
    const channel = new GatewayRpcChannel();
    (channel as unknown as StubbableChannel).getClient = () => ({
      request: async () => {
        // Record which token the channel would connect with on each attempt.
        tokensSeen.push(getGatewayToken());
        if (tokensSeen.length === 1) throw makeAuthError();
        return { ok: true };
      },
    });

    await expect(channel.request("status")).resolves.toEqual({ ok: true });
    // First attempt used the stale cache; the retry re-read the rotated
    // token from disk after invalidateGatewayToken().
    expect(tokensSeen).toEqual(["token-a", "token-b"]);
  });

  test("a second consecutive auth failure surfaces the gateway error unchanged", async () => {
    writeFakeConfig("token-c");
    invalidateGatewayToken();

    const authError = makeAuthError();
    let attempts = 0;
    const channel = new GatewayRpcChannel();
    (channel as unknown as StubbableChannel).getClient = () => ({
      request: async () => {
        attempts += 1;
        throw authError;
      },
    });

    // Retried exactly once, then rethrown as-is (a gateway-produced error is
    // never routed to the CLI fallback).
    await expect(channel.request("status")).rejects.toBe(authError);
    expect(attempts).toBe(2);
  });
});
