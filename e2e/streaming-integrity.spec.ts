/**
 * Stream-integrity proof for Phase 2 Plan 2 (server-contract-hardening).
 *
 * The hard rule this plan enforces is that migrating a streaming route onto
 * `withPassthroughRoute` must never change what the route actually streams:
 * `withPassthroughRoute` validates the setup-phase body/query, then returns
 * whatever the handler returns exactly as constructed — no status read, no
 * body inspection (`src/lib/api-route.ts`). This file is the automated proof
 * that promise held, run against the real dev instance
 * (`~/instances/dev`, gateway :18789, Mission Control :3100).
 *
 * Two kinds of assertion:
 *   1. A pre-stream rejection (an unrecognized `doctor/run` mode) still
 *      returns the canonical `{ ok: false, error, details? }` envelope
 *      before any stream opens. (The equivalent chat/stream assertion lives
 *      in `src/app/api/chat/stream/route.test.ts` — the CI-safe unit lane —
 *      since it needs no gateway.)
 *   2. For every streaming route that can be exercised on the dev instance
 *      *without* a side effect (spending real LLM tokens, installing
 *      software, or mutating on-disk state), a valid request still returns
 *      `text/event-stream` and delivers a first frame before the assertion
 *      times out. Routes that cannot be driven safely are explicitly
 *      skipped with a reason — an honest skip beats a fake pass.
 *
 * Uses the global `fetch` (not the Playwright `request` fixture): several of
 * these routes stream indefinitely (`stats/stream`'s 5s tick,
 * `terminal`'s 15s heartbeat), so the test needs a real `ReadableStream`
 * reader it can cancel after the first frame arrives, not a fixture that
 * buffers the whole response body.
 */
import { test, expect } from "@playwright/test";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

/** Read up to the first non-empty chunk of a streaming Response, then cancel. */
async function readFirstStreamFrame(
  url: string,
  init: RequestInit,
  timeoutMs = 20_000,
): Promise<{ status: number; contentType: string | null; firstChunk: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const contentType = res.headers.get("content-type");
    if (!res.body) {
      return { status: res.status, contentType, firstChunk: "" };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let firstChunk = "";
    try {
      while (!firstChunk.trim()) {
        const { done, value } = await reader.read();
        if (done) break;
        firstChunk += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return { status: res.status, contentType, firstChunk };
  } finally {
    clearTimeout(timeout);
  }
}

/* ── 1. Pre-stream rejection stays the canonical envelope @live ────────── */

test.describe("POST /api/doctor/run — unknown mode rejected before streaming @live", () => {
  test("an unrecognized mode returns 400 with ok:false and the accepted modes under details", async ({ request }) => {
    const res = await request.post(`${LIVE_BASE}/api/doctor/run`, {
      data: { mode: "not-a-real-mode" },
    });
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["content-type"]).not.toContain("text/event-stream");

    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.details).toBeDefined();
    const expectedModes = (body.details as { expected?: unknown }).expected;
    expect(Array.isArray(expectedModes)).toBe(true);
    expect(expectedModes).toEqual(expect.arrayContaining(["quick", "full", "deep"]));
  });
});

/* ── 2. Streams still stream after the withPassthroughRoute migration ──── */

test.describe("streaming routes still stream after the withPassthroughRoute migration @live", () => {
  test("GET /api/stats/stream returns text/event-stream and delivers a first frame", async () => {
    const { status, contentType, firstChunk } = await readFirstStreamFrame(
      `${LIVE_BASE}/api/stats/stream`,
      { headers: { Accept: "text/event-stream" } },
    );
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(firstChunk).toContain("data:");
  });

  test("POST /api/doctor/run (mode: quick, read-only) returns text/event-stream and delivers a first frame", async () => {
    // "quick" is the read-only depth (docs/API-CONTRACT.md, doctor/run's own
    // doc comment) — safe to run for real, unlike "full"/"deep" which apply
    // OpenClaw's safe migrations to disk.
    const { status, contentType, firstChunk } = await readFirstStreamFrame(
      `${LIVE_BASE}/api/doctor/run`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ mode: "quick" }),
      },
    );
    expect(status).toBe(200);
    expect(contentType).toContain("text/event-stream");
    expect(firstChunk).toContain("data:");
    expect(firstChunk).toContain('"type":"start"');
  });

  test("GET /api/terminal (existing session) returns text/event-stream and delivers a first frame", async ({ request }) => {
    // Exercises the highest-value boundary in this plan's threat register
    // (T-02-06): a validated "create" control action opens a real PTY
    // session, the SSE GET streams its first status frame, then the session
    // is torn down via the validated "kill" action so no shell process is
    // left behind on the host running the suite.
    const createRes = await request.post(`${LIVE_BASE}/api/terminal`, {
      data: { action: "create", cols: 80, rows: 24 },
    });
    expect(createRes.ok()).toBe(true);
    const created = await createRes.json();
    const sessionId: string = created.session;
    expect(typeof sessionId).toBe("string");
    expect(sessionId.length).toBeGreaterThan(0);

    try {
      const { status, contentType, firstChunk } = await readFirstStreamFrame(
        `${LIVE_BASE}/api/terminal?action=stream&session=${encodeURIComponent(sessionId)}`,
        { headers: { Accept: "text/event-stream" } },
      );
      expect(status).toBe(200);
      expect(contentType).toContain("text/event-stream");
      expect(firstChunk).toContain("data:");
    } finally {
      const killRes = await request.post(`${LIVE_BASE}/api/terminal`, {
        data: { action: "kill", session: sessionId },
      });
      expect(killRes.ok()).toBe(true);
    }
  });

  test("POST /api/chat/stream — not exercised for real", async () => {
    test.skip(
      true,
      "A valid request reaches the gateway's real LLM completion endpoint — " +
        "real cost and non-deterministic output, same reason e2e/correctness.spec.ts " +
        "only exercises this route's pre-gateway 400 branch, never a real message.",
    );
  });

  test("POST /api/chat — not exercised for real", async () => {
    test.skip(
      true,
      "Same reason as /api/chat/stream: a valid request reaches the gateway's " +
        "real LLM completion endpoint. Also not an event-stream response by " +
        "design (text/plain, for the AI SDK's TextStreamChatTransport).",
    );
  });

  test("POST /api/onboarding/chat — not exercised for real", async () => {
    test.skip(
      true,
      "Same reason as /api/chat/stream: a valid request reaches the gateway's " +
        "real LLM completion endpoint. Also not an event-stream response by " +
        "design (text/plain, the wizard's typed-marker protocol — see " +
        "src/components/onboarding/error-frame.ts).",
    );
  });

  test("POST /api/doctor/fix — not exercised for real", async () => {
    test.skip(
      true,
      "Applying any repair — even the \"safe\" safety class — mutates files " +
        "on disk (docs/API-CONTRACT.md's own repair-safety model). Not safe " +
        "to auto-run against a real dev instance in this suite.",
    );
  });

  test("POST /api/skills/install — not exercised for real", async () => {
    test.skip(
      true,
      "A valid request installs real software on the host (Homebrew/uv/pip/" +
        "go, per the route's own doc comment). Not safe to auto-run.",
    );
  });
});
