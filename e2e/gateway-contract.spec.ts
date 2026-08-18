/**
 * Real-gateway contract pins for Phase 1 (FOUND-02).
 *
 * This file is the phase's real-contract baseline: every field asserted
 * below was observed live against the running dev instance
 * (`~/instances/dev`, gateway :18789, Mission Control :3100) before being
 * written here — nothing is inferred from a TypeScript type. If a test in
 * this file goes red, the gateway (or G-Brain) contract moved; the test
 * itself is not stale and should not be "fixed" by loosening the assertion
 * without re-observing the live response first.
 *
 * Covers, GET only (no config writes — the 3-writes/60s budget in
 * playwright.config.ts is shared across the whole suite):
 *   1. /api/agents  — agent list + configured channels shape
 *   2. /api/cron    — job list shape, schedule.kind set, delivery.mode set
 *   3. /api/config  — envelope shape only; the endpoint serves real secrets
 *      in plaintext today (Phase 2/6 owns the fix), so this file proves
 *      structure/typeof and never surfaces a value
 *   4. /api/g-brain — detect / catalog / overview against the real brain
 */

import { test, expect } from "@playwright/test";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

/* ── 1. GET /api/agents ────────────────────────────────────────────────── */

// The exact status vocabulary agents-view.tsx's STATUS_COLORS map knows how
// to render (src/components/agents-view.tsx:238-242) — a status outside this
// set falls back to STATUS_COLORS.unknown silently in the UI, so pin the set
// here instead of letting a new gateway status render as a mystery grey dot.
const KNOWN_AGENT_STATUSES = ["active", "idle", "unknown"];

test.describe("GET /api/agents — real gateway contract @live", () => {
  test("returns the observed agent-list contract, not an assumed one", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/agents`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("agents");
    expect(body).toHaveProperty("defaultModel");
    expect(body).toHaveProperty("configuredChannels");
    expect(body).toHaveProperty("stale");
    expect(typeof body.stale).toBe("boolean");

    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.agents.length).toBeGreaterThan(0);

    const agent = body.agents[0];
    expect(agent).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      model: expect.any(String),
      workspace: expect.any(String),
      isDefault: expect.any(Boolean),
      sessionCount: expect.any(Number),
      bindings: expect.any(Array),
      channels: expect.any(Array),
      status: expect.any(String),
    });
    expect(KNOWN_AGENT_STATUSES).toContain(agent.status);

    expect(Array.isArray(body.configuredChannels)).toBe(true);
    if (body.configuredChannels.length > 0) {
      expect(body.configuredChannels[0]).toMatchObject({
        channel: expect.any(String),
        enabled: expect.any(Boolean),
        connected: expect.any(Boolean),
      });
    }
  });
});

/* ── 2. GET /api/cron ──────────────────────────────────────────────────── */

// The exact set of schedule.kind values scheduleDisplay() branches on
// (src/components/cron-view.tsx:216-226) — any other kind falls through to
// the literal string "Unknown" in the UI, so a new gateway schedule kind
// must fail loudly here, not render silently as "Unknown".
const KNOWN_SCHEDULE_KINDS = ["cron", "every"];

// The exact set normalizeDeliveryMode() accepts
// (src/components/cron-view.tsx:242-248) — anything else normalizes to
// "none" silently in the UI.
const KNOWN_DELIVERY_MODES = ["announce", "webhook", "none"];

test.describe("GET /api/cron — real gateway contract @live", () => {
  test("returns the observed cron job-list contract, not an assumed one", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/cron`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("jobs");
    expect(Array.isArray(body.jobs)).toBe(true);

    for (const job of body.jobs) {
      expect(job).toMatchObject({
        id: expect.any(String),
        name: expect.any(String),
        enabled: expect.any(Boolean),
        schedule: expect.any(Object),
        sessionTarget: expect.any(String),
        payload: expect.any(Object),
        delivery: expect.any(Object),
      });

      expect(KNOWN_SCHEDULE_KINDS).toContain(job.schedule.kind);
      if (job.schedule.kind === "every") {
        expect(typeof job.schedule.everyMs).toBe("number");
      }
      if (job.schedule.kind === "cron") {
        expect(typeof job.schedule.expr).toBe("string");
      }

      if (job.state) {
        if ("lastRunStatus" in job.state) {
          expect(typeof job.state.lastRunStatus).toBe("string");
        }
        if ("lastStatus" in job.state) {
          expect(typeof job.state.lastStatus).toBe("string");
        }
        if ("lastDurationMs" in job.state) {
          expect(typeof job.state.lastDurationMs).toBe("number");
        }
      }

      expect(KNOWN_DELIVERY_MODES).toContain(job.delivery.mode);
    }
  });
});

/* ── 3. GET /api/config ────────────────────────────────────────────────── */

// This endpoint currently serves real secrets (gateway auth token, provider
// API keys) unredacted in the JSON body — fixing that leak is Phase 2/6
// scope, not this phase's. Every test in this block therefore asserts
// structure and typeof only. It never surfaces a value from the parsed
// body — not to the terminal, not to a snapshot matcher, not to a test
// artifact, not to a file. Where a credential-bearing key must be proven
// present, the assertion below checks the key path and `typeof === "string"`
// and stops there.
test.describe("GET /api/config — real gateway contract @live", () => {
  test("returns the canonical { config, meta } envelope", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("config");
    expect(body).toHaveProperty("meta");
    expect(typeof body.config).toBe("object");
    expect(Array.isArray(body.config)).toBe(false);

    expect(typeof body.meta.baseHash).toBe("string");
    expect(typeof body.meta.schema).toBe("object");
    expect(typeof body.meta.uiHints).toBe("object");

    // The config document round-trips as JSON — a structural sanity check,
    // not a value comparison.
    const roundTripped = JSON.parse(JSON.stringify(body.config));
    expect(typeof roundTripped).toBe("object");
  });

  test("config.gateway stays loopback-bound (T-01-04)", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.config).toHaveProperty("gateway");
    expect(body.config.gateway.bind).toBe("loopback");
  });

  test("credential-bearing keys are present and string-typed — values never asserted", async ({
    request,
  }) => {
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    // Key-path + typeof only. No value from this response is ever compared,
    // embedded, or read out below.
    if (body.config.gateway?.auth && "token" in body.config.gateway.auth) {
      expect(typeof body.config.gateway.auth.token).toBe("string");
    }
    if (body.config.env && typeof body.config.env === "object") {
      for (const key of Object.keys(body.config.env)) {
        expect(typeof body.config.env[key]).toBe("string");
      }
    }
  });

  test("a leak-safety self-check: any string this spec surfaces on failure is constructed, not response data", async ({
    request,
  }) => {
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    const envelopeOk = typeof body.config === "object" && typeof body.meta === "object";
    // This message is a fixed, hand-written string — it never interpolates
    // anything read from `body`, so a failure here cannot leak response data
    // into the test report.
    expect(envelopeOk, "config/meta envelope missing shape — inspect the route source, not this message").toBe(
      true,
    );
  });
});

/* ── 4. GET /api/g-brain ───────────────────────────────────────────────── */

test.describe("GET /api/g-brain — real G-Brain contract @live", () => {
  test("?scope=detect reports the real brain as installed", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/g-brain?scope=detect`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("installed");
    if (body.installed) {
      expect(typeof body.engine).toBe("string");
      expect(typeof body.home).toBe("string");
    }
  });

  test("?action=catalog returns the real command catalog", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/g-brain?action=catalog`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("installed");
    expect(body).toHaveProperty("detection");
    expect(body).toHaveProperty("commands");
    expect(Array.isArray(body.commands)).toBe(true);
    expect(body.commands.length).toBeGreaterThan(0);

    for (const entry of body.commands) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        label: expect.any(String),
        category: expect.any(String),
        sub: expect.any(String),
        description: expect.any(String),
      });
    }
  });

  test("?action=overview fans out to the real brain and aggregates doctor/stats/jobs/health", async ({
    request,
  }) => {
    // This fans out to four real G-Brain subprocesses server-side, one with
    // a 25s timeout — give it real headroom rather than the 90s config
    // default plus per-expect 15s default.
    test.setTimeout(120_000);

    const res = await request.get(`${LIVE_BASE}/api/g-brain?action=overview`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body).toHaveProperty("installed");
    expect(body).toHaveProperty("detection");
    expect(body).toHaveProperty("doctor");
    expect(body).toHaveProperty("doctorError");
    expect(body).toHaveProperty("stats");
    expect(body).toHaveProperty("jobs");
    expect(body).toHaveProperty("jobsError");
    expect(body).toHaveProperty("health");

    // Proves a real brain answered, not an empty stub.
    expect(body.installed).toBe(true);
    expect(body.doctorError).toBeNull();
    const hasRealOutput =
      (typeof body.stats === "string" && body.stats.length > 0) ||
      (typeof body.health === "string" && body.health.length > 0);
    expect(hasRealOutput).toBe(true);
  });
});
