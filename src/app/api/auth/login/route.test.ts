/**
 * CI-safe route-handler test for POST /api/auth/login — runs in the `unit`
 * project under `environment: 'node'` (next-test-api-route-handler patches
 * Next.js internals; jsdom breaks that patching, so this file must never be
 * collected by the `component` project).
 *
 * This file exercises only the pre-comparison rejection branches:
 * malformed JSON and a missing/empty `token` field. Both return before
 * `constantTimeEquals` is ever called (T-02-21,
 * `.planning/phases/02-server-contract-hardening/02-05-PLAN.md` must_haves —
 * "A malformed sign-in ... payload is rejected ... before any credential
 * comparison ... happens"), so this file creates no session cookie and needs
 * no OpenClaw gateway. A present-but-wrong token (the 401 `invalid_token`
 * path) is already pinned live by `e2e/auth.spec.ts#login with a wrong token
 * is rejected` — not duplicated here.
 *
 * `MISSION_CONTROL_AUTH`/`MISSION_CONTROL_AUTH_TOKEN` are read dynamically by
 * `src/lib/auth.ts` on every call, so setting them in `beforeEach` is enough
 * to put the route in "token" mode for each test without module reloading.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appHandler from "@/app/api/auth/login/route";
import { describe, test, expect, beforeEach, afterEach } from "vitest";

const ORIGINAL_MODE = process.env.MISSION_CONTROL_AUTH;
const ORIGINAL_TOKEN = process.env.MISSION_CONTROL_AUTH_TOKEN;

beforeEach(() => {
  process.env.MISSION_CONTROL_AUTH = "token";
  process.env.MISSION_CONTROL_AUTH_TOKEN = "route-test-real-token";
});

afterEach(() => {
  if (ORIGINAL_MODE === undefined) delete process.env.MISSION_CONTROL_AUTH;
  else process.env.MISSION_CONTROL_AUTH = ORIGINAL_MODE;
  if (ORIGINAL_TOKEN === undefined) delete process.env.MISSION_CONTROL_AUTH_TOKEN;
  else process.env.MISSION_CONTROL_AUTH_TOKEN = ORIGINAL_TOKEN;
});

describe("POST /api/auth/login — pre-comparison validation (no instance required)", () => {
  test("malformed JSON body → 400, ok false, plain-language message, no session cookie set", async () => {
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
        expect(res.headers.get("set-cookie")).toBeNull();
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });

  test("missing/empty token field → 400 with a details tree naming the token path, no submitted value leaked, no cookie set", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        // `decoy` proves the schema rejection never echoes the raw request
        // body back to the caller — the regression this task exists to catch.
        const sentinel = "SENTINEL-LOGIN-DECOY-9f2a1c";
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "", decoy: sentinel }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("set-cookie")).toBeNull();
        const raw = await res.text();
        const body = JSON.parse(raw);
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.details).toBeDefined();
        // The details tree names the `token` field path...
        expect(JSON.stringify(body.details)).toContain("token");
        // ...but never contains the decoy value that was submitted alongside it.
        expect(raw).not.toContain(sentinel);
      },
    });
  });
});
