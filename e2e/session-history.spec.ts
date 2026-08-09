import { test, expect } from "@playwright/test";
import {
  CHAT_SESSION_KINDS,
  INSPECTABLE_SESSION_KINDS,
  classifySessionKind,
  sessionAgentIdOf,
  sessionKindOf,
  sessionTitleOf,
} from "../src/lib/session-kinds";

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3100";

/* ── Pure classification (no gateway, no server — safe for CI) ───────────── */

test.describe("session kind classification", () => {
  test("prefers the gateway-provided kind over key parsing", () => {
    expect(sessionKindOf({ kind: "cron", key: "agent:main:openresponses:x" })).toBe("cron");
  });

  test("falls back to key parsing when kind is absent", () => {
    expect(sessionKindOf({ key: "agent:main:openresponses:abc" })).toBe("openresponses");
    expect(sessionKindOf({ key: "malformed" })).toBe("");
  });

  test("only real dashboard chats are offered as chats", () => {
    expect(classifySessionKind("openresponses").isChat).toBe(true);
    expect(classifySessionKind("main").isChat).toBe(true);
    for (const kind of ["cron", "subagent", "mission-control", "telegram"]) {
      expect(classifySessionKind(kind).isChat).toBe(false);
    }
  });

  test("channel transcripts are never inspectable from the dashboard", () => {
    // The bug this guards: a chat session picker that lists
    // agent:main:telegram:<chatId> and renders a private DM in the dashboard.
    for (const kind of ["telegram", "whatsapp", "discord", "signal", "slack"]) {
      expect(classifySessionKind(kind).isInspectable).toBe(false);
      expect(INSPECTABLE_SESSION_KINDS.has(kind)).toBe(false);
    }
  });

  test("operational sessions are inspectable but not chats", () => {
    for (const kind of ["cron", "subagent", "mission-control"]) {
      expect(classifySessionKind(kind).isInspectable).toBe(true);
      expect(CHAT_SESSION_KINDS.has(kind)).toBe(false);
    }
  });

  test("unknown kinds fail closed", () => {
    const info = classifySessionKind("some-future-channel");
    expect(info.isChat).toBe(false);
    expect(info.isInspectable).toBe(false);
  });

  test("titles prefer gateway labels over invented ones", () => {
    expect(sessionTitleOf({ label: "versami-mail-sweep", kind: "cron" })).toBe("versami-mail-sweep");
    expect(sessionTitleOf({ displayName: "Gmail crawl", kind: "cron" })).toBe("Gmail crawl");
    expect(sessionTitleOf({ kind: "cron" })).toBe("Scheduled job");
    expect(sessionTitleOf({ label: "   ", kind: "openresponses" })).toBe("Chat");
  });

  test("extracts the agent id from a session key", () => {
    expect(sessionAgentIdOf({ key: "agent:main:openresponses:x" })).toBe("main");
    expect(sessionAgentIdOf({ key: "notagent:main:x" })).toBeNull();
    expect(sessionAgentIdOf({})).toBeNull();
  });
});

/* ── Route behaviour (needs the app + a live gateway) ────────────────────── */

test.describe("chat history API @live", () => {
  test("rejects a missing or malformed sessionKey", async ({ request }) => {
    const missing = await request.get(`${BASE}/api/chat/history`);
    expect(missing.status()).toBe(400);

    const malformed = await request.get(
      `${BASE}/api/chat/history?sessionKey=${encodeURIComponent("has spaces/../..")}`,
    );
    expect(malformed.status()).toBe(400);
  });

  test("returns 404 for a session the gateway does not know", async ({ request }) => {
    const res = await request.get(
      `${BASE}/api/chat/history?sessionKey=agent:main:openresponses:00000000-0000-0000-0000-000000000000`,
    );
    expect(res.status()).toBe(404);
  });

  test("refuses channel transcripts and loads real chats", async ({ request }) => {
    const listRes = await request.get(`${BASE}/api/sessions`);
    test.skip(!listRes.ok(), "gateway unavailable");
    const body = await listRes.json();
    const sessions: Array<{ key?: string; kind?: string }> = body.sessions ?? body.items ?? [];
    test.skip(sessions.length === 0, "no sessions on this gateway");

    const channel = sessions.find((s) => !classifySessionKind(sessionKindOf(s)).isInspectable);
    if (channel?.key) {
      const res = await request.get(
        `${BASE}/api/chat/history?sessionKey=${encodeURIComponent(channel.key)}`,
      );
      expect(res.status()).toBe(403);
      const json = await res.json();
      expect(JSON.stringify(json)).not.toContain("content");
    }

    const chat = sessions.find((s) => classifySessionKind(sessionKindOf(s)).isChat);
    if (chat?.key) {
      const res = await request.get(
        `${BASE}/api/chat/history?sessionKey=${encodeURIComponent(chat.key)}&limit=5`,
      );
      expect(res.ok()).toBeTruthy();
      const json = await res.json();
      expect(json.sessionKey).toBe(chat.key);
      expect(Array.isArray(json.messages)).toBeTruthy();
      expect(json.messages.length).toBeLessThanOrEqual(5);
      expect(json.limit).toBe(5);
    }
  });

  test("clamps an absurd limit instead of trusting it", async ({ request }) => {
    const listRes = await request.get(`${BASE}/api/sessions`);
    test.skip(!listRes.ok(), "gateway unavailable");
    const body = await listRes.json();
    const sessions: Array<{ key?: string; kind?: string }> = body.sessions ?? body.items ?? [];
    const chat = sessions.find((s) => classifySessionKind(sessionKindOf(s)).isChat);
    test.skip(!chat?.key, "no chat session available");

    const res = await request.get(
      `${BASE}/api/chat/history?sessionKey=${encodeURIComponent(chat!.key!)}&limit=99999`,
    );
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).limit).toBeLessThanOrEqual(500);
  });
});
