/**
 * Cross-route live proof of the canonical error envelope (REL-03 success
 * criterion 3, `.planning/phases/02-server-contract-hardening/02-13-PLAN.md`).
 *
 * `docs/API-CONTRACT.md` documents one error shape —
 * `{ ok: false, error: string, details?: unknown }` — for every route in
 * `src/app/api/**`. `scripts/check-api-contract.mjs` (wired into
 * `npm run check:contract`, `npm run test:premerge`, and CI as of this plan)
 * proves that shape statically, by scanning source text. This file is the
 * live counterpart: it sends a real malformed request to one representative
 * route from every input category the migration recipe distinguishes, and
 * asserts the actual HTTP response — against the running dev instance
 * (`~/instances/dev`, gateway :18789, Mission Control :3100) — carries the
 * envelope, not just the source code that produces it.
 *
 * Sampled routes, one per input category, each named with the plan that
 * migrated it onto `withRoute`/`withPassthroughRoute`:
 *
 *   1. JSON-body route      — POST /api/auth/login            (02-05-PLAN.md)
 *   2. Query-parameter route — GET  /api/logs                  (02-11-PLAN.md)
 *   3. No-input route        — POST /api/cron                  (02-09-PLAN.md)
 *   4. Dynamic-segment route — GET  /api/integrations/google/accounts/[id] (02-06-PLAN.md)
 *   5. Streaming route       — POST /api/chat/stream            (02-02-PLAN.md)
 *
 * None of these requests reaches a real gateway side effect: every one is
 * rejected at the schema-validation boundary inside `resolveInputs()`
 * (`src/lib/api-route.ts`), before any handler body — and therefore before
 * any `gatewayCall`, any provider request, or (for chat/stream) any real LLM
 * completion — ever runs. That's also why `POST /api/chat/stream` is safe to
 * exercise for real here even though `e2e/streaming-integrity.spec.ts`
 * explicitly skips a *valid* request to the same route (real cost,
 * non-deterministic output): this test only ever reaches the pre-gateway 400
 * branch, the same branch `src/app/api/chat/stream/route.test.ts` pins in
 * the CI-safe unit lane.
 *
 * A red test here means a route left the documented envelope at the HTTP
 * boundary even though `check:contract`'s source-text scan didn't catch it
 * (or the two disagree) — inspect the route source and
 * `docs/API-CONTRACT.md`, don't loosen these assertions.
 */
import { test, expect } from "@playwright/test";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

/** Shape every error response in this codebase must have (docs/API-CONTRACT.md §1). */
function assertCanonicalEnvelope(body: unknown): asserts body is {
  ok: false;
  error: string;
  details?: unknown;
} {
  expect(body).toHaveProperty("ok");
  expect((body as { ok: unknown }).ok).toBe(false);
  expect(body).toHaveProperty("error");
  expect(typeof (body as { error: unknown }).error).toBe("string");
  expect(((body as { error: string }).error).length).toBeGreaterThan(0);
  const hasDetails = Object.prototype.hasOwnProperty.call(body, "details");
  if (hasDetails) {
    const details = (body as { details: unknown }).details;
    expect(details).not.toBeNull();
    expect(typeof details).toBe("object");
    expect(Array.isArray(details)).toBe(false);
  }
}

/**
 * A response body must never carry a stack trace or an internal upstream
 * RPC/method name — closes T-02-01/T-02-02 at the integration level
 * (`.planning/phases/02-server-contract-hardening/02-13-PLAN.md` threat
 * register, T-02-62). Checked against the raw response text, not just the
 * parsed JSON, so an unparsed/partial body would still be caught.
 */
function assertNoLeakedInternals(raw: string, routeLabel: string) {
  expect(raw, `${routeLabel}: response looks like it contains a stack trace`).not.toMatch(
    /at\s+[\w.$<>]+\s+\(.*:\d+:\d+\)/,
  );
  expect(raw, `${routeLabel}: response body should not read "at .../node_modules/"`).not.toContain(
    "node_modules",
  );
  // Internal gateway RPC method names never belong in a client-facing body —
  // any dotted "namespace.verb" gateway RPC id (e.g. cron.add, sessions.list).
  expect(raw, `${routeLabel}: response body should not name a raw gateway RPC method`).not.toMatch(
    /\b(cron|sessions|chat|config|gateway|mcp)\.(add|list|update|remove|run|history|patch|get)\b/,
  );
}

/* ── 1. JSON-body route — POST /api/auth/login (02-05) ──────────────────── */

test.describe("POST /api/auth/login — malformed JSON-body request @live", () => {
  test("an empty token is rejected with the canonical envelope and a JSON content type", async ({
    request,
  }) => {
    const res = await request.post(`${LIVE_BASE}/api/auth/login`, {
      data: { token: "" },
    });
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"]).toContain("application/json");

    const raw = await res.text();
    assertNoLeakedInternals(raw, "POST /api/auth/login");
    const body = JSON.parse(raw);
    assertCanonicalEnvelope(body);
    expect(body.details).toBeDefined();
  });
});

/* ── 2. Query-parameter route — GET /api/logs (02-11) ────────────────────── */

test.describe("GET /api/logs — malformed query-parameter request @live", () => {
  test("a non-integer limit is rejected with the canonical envelope", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/logs?limit=not-a-number`);
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"]).toContain("application/json");

    const raw = await res.text();
    assertNoLeakedInternals(raw, "GET /api/logs");
    const body = JSON.parse(raw);
    assertCanonicalEnvelope(body);
    expect(body.details).toBeDefined();
  });
});

/* ── 3. No-input route — POST /api/cron (02-09) ──────────────────────────── */

test.describe("POST /api/cron — no input at all, forced into a schema failure @live", () => {
  test("a completely empty body is rejected with the canonical envelope", async ({ request }) => {
    const res = await request.post(`${LIVE_BASE}/api/cron`, {
      data: {},
    });
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"]).toContain("application/json");

    const raw = await res.text();
    assertNoLeakedInternals(raw, "POST /api/cron");
    const body = JSON.parse(raw);
    assertCanonicalEnvelope(body);
    // cronPostSchema is a discriminatedUnion("action", ...) — an entirely
    // empty body fails on the missing discriminator itself.
    expect(body.details).toBeDefined();
  });
});

/* ── 4. Dynamic-segment route — GET /api/integrations/google/accounts/[id] (02-06) ── */

test.describe("GET /api/integrations/google/accounts/[id] — malformed dynamic segment @live", () => {
  test("an id outside GOOGLE_ACCOUNT_ID_PATTERN is rejected before any account lookup", async ({
    request,
  }) => {
    const res = await request.get(
      `${LIVE_BASE}/api/integrations/google/accounts/${encodeURIComponent("bad id")}`,
    );
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"]).toContain("application/json");

    const raw = await res.text();
    assertNoLeakedInternals(raw, "GET /api/integrations/google/accounts/[id]");
    const body = JSON.parse(raw);
    assertCanonicalEnvelope(body);
    expect(body.details).toBeDefined();
  });
});

/* ── 5. Streaming route — POST /api/chat/stream (02-02) ──────────────────── */

test.describe("POST /api/chat/stream — malformed pre-stream request @live", () => {
  test("a non-array messages field is rejected before the stream opens, never as event-stream", async ({
    request,
  }) => {
    const res = await request.post(`${LIVE_BASE}/api/chat/stream`, {
      data: { messages: "not-an-array" },
    });
    expect(res.status()).toBe(400);
    expect(res.headers()["content-type"]).toContain("application/json");
    expect(res.headers()["content-type"]).not.toContain("text/event-stream");

    const raw = await res.text();
    assertNoLeakedInternals(raw, "POST /api/chat/stream");
    const body = JSON.parse(raw);
    assertCanonicalEnvelope(body);
    expect(body.details).toBeDefined();
  });
});
