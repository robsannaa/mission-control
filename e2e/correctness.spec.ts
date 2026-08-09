/**
 * Wrong-data regression suite: catalogs must derive from the gateway, defaults
 * must be resolved (never the literal "main" guess), and gateway failures must
 * surface instead of masquerading as "not configured".
 *
 * All checks are read-only against the live dev server (default
 * http://127.0.0.1:3100, override with MC_BASE_URL) and assume the local
 * OpenClaw gateway is running with Telegram configured — which is the fixed
 * state of this machine.
 */

import { test, expect } from "@playwright/test";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

test.describe("channels are gateway-derived @live", () => {
  test("GET /api/channels reports telegram as configured, not from a hardcoded list", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/channels`);
    expect(res.ok()).toBe(true);
    const data = await res.json();

    // A live gateway must never be reported as offline.
    expect(data.gatewayOffline).toBe(false);

    const channels: Array<Record<string, unknown>> = data.channels;
    expect(Array.isArray(channels)).toBe(true);

    // Telegram is configured+running on this machine — the row must reflect
    // the gateway's channels.status, not a static default.
    const telegram = channels.find((c) => c.channel === "telegram");
    expect(telegram).toBeTruthy();
    expect(telegram!.configured).toBe(true);
    expect(telegram!.connected).toBe(true);
    expect(Array.isArray(telegram!.statuses)).toBe(true);
    expect((telegram!.statuses as unknown[]).length).toBeGreaterThan(0);

    // The setup catalog covers the five channels the README promises; none of
    // them may be hidden even when unconfigured.
    for (const id of ["telegram", "discord", "whatsapp", "signal", "slack"]) {
      const row = channels.find((c) => c.channel === id);
      expect(row, `channel ${id} missing from /api/channels`).toBeTruthy();
      expect(["token", "qr", "cli", "auto"]).toContain(row!.setupType);
    }
  });
});

test.describe("models surface real providers @live", () => {
  test("GET /api/models returns the gateway's live catalog and auth state", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/models`);
    expect(res.ok()).toBe(true);
    const data = await res.json();

    expect(data.gatewayOffline).toBe(false);

    // Live model catalog (models.list) — provider-prefixed keys, real context
    // windows (the config fallback reports contextWindow 0 for everything).
    const models: Array<Record<string, unknown>> = data.models;
    expect(Array.isArray(models)).toBe(true);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(typeof m.key).toBe("string");
      expect((m.key as string).includes("/")).toBe(true);
    }
    expect(models.some((m) => (m.contextWindow as number) > 0)).toBe(true);

    // Live auth state (models.authStatus). Anthropic is authenticated on this
    // machine (agents.defaults.model.primary is an anthropic model).
    const authProviders: Array<Record<string, unknown>> = data.authProviders;
    expect(Array.isArray(authProviders)).toBe(true);
    expect(authProviders.length).toBeGreaterThan(0);
    const anthropic = authProviders.find((p) => p.provider === "anthropic");
    expect(anthropic).toBeTruthy();
    expect(anthropic!.authenticated).toBe(true);
  });
});

test.describe("gateway version info @live", () => {
  test("GET /api/gateway includes version + supported-range verdict", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/gateway`);
    expect(res.ok()).toBe(true);
    const data = await res.json();

    expect(data.version).toBeTruthy();
    const version = data.version as {
      gateway: string | null;
      supportedRange: string;
      supported: boolean | null;
    };
    expect(typeof version.supportedRange).toBe("string");
    expect(version.supportedRange.length).toBeGreaterThan(0);

    if (data.status === "online") {
      // A healthy gateway reports its calver runtime version, and the verdict
      // must be a real boolean, not silently unknown.
      expect(version.gateway).toMatch(/^\d{4}\.\d+/);
      expect(typeof version.supported).toBe("boolean");
    }
  });
});

test.describe("chat stream resolves the default agent @live", () => {
  test("POST /api/chat/stream with no agentId uses the gateway's default agent", async ({ request }) => {
    // Ask the app which agent is the default (resolved from agents.list).
    const agentsRes = await request.get(`${LIVE_BASE}/api/agents`);
    expect(agentsRes.ok()).toBe(true);
    const agentsData = await agentsRes.json();
    const agents: Array<{ id: string; isDefault?: boolean }> = agentsData.agents ?? [];
    expect(agents.length).toBeGreaterThan(0);
    const defaultAgent = agents.find((a) => a.isDefault) ?? agents[0];

    // Empty input fails fast with 400 — but only AFTER the agent id has been
    // resolved, and the route reports what it resolved in a header. The route
    // must resolve the gateway's default, not assume the literal "main".
    const res = await request.post(`${LIVE_BASE}/api/chat/stream`, {
      data: { messages: [] },
    });
    expect(res.status()).toBe(400);
    const resolved = res.headers()["x-openclaw-agent-id"];
    expect(resolved).toBe(defaultAgent.id);
  });

  test("POST /api/chat/stream honors an explicit agentId", async ({ request }) => {
    const res = await request.post(`${LIVE_BASE}/api/chat/stream`, {
      data: { agentId: "some-explicit-agent", messages: [] },
    });
    expect(res.status()).toBe(400);
    expect(res.headers()["x-openclaw-agent-id"]).toBe("some-explicit-agent");
  });
});
