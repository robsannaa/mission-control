/**
 * Per-path config schema intelligence — GET /api/config/lookup.
 *
 * Two halves:
 *
 * 1. `@live` request specs against the running Mission Control app and the
 *    real OpenClaw gateway. They assert the *shape* of the answer, never the
 *    exact copy: OpenClaw owns the field titles and may reword them, but the
 *    contract (reloadKind ∈ restart|hot|none, enum flattening, null for an
 *    unknown path, the multi-path map, the 25-path cap) is ours to keep.
 *
 * 2. Pure unit tests for `@/lib/config-schema-validate` — normalization and
 *    the client-side validator. No gateway, no server: they run in the CI
 *    project. This is the validation the config editor's "Changes are
 *    validated before saving" copy has been promising all along.
 *
 * Observed against OpenClaw v2026.7.1-2 while writing this spec:
 *   gateway.port              → reloadKind "restart", type integer, exclusiveMinimum 0
 *   gateway.auth.mode         → reloadKind "restart", anyOf of 4 consts → enum
 *   agents.defaults.model     → reloadKind "hot",     anyOf string|object (open, no enum)
 *   tools.media.audio.enabled → reloadKind "none",    type boolean
 *   this.path.does.not.exist  → INVALID_REQUEST "config schema path not found"
 */

import { test, expect } from "@playwright/test";
import {
  degradedConfigLookup,
  normalizeConfigSchemaLookup,
  reloadKindFromMatrix,
  validateConfigValue,
  type NormalizedConfigLookup,
} from "../src/lib/config-schema-validate";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

const RELOAD_KINDS = ["restart", "hot", "none"];

type SingleResponse = {
  path?: string;
  lookup?: NormalizedConfigLookup | null;
  reason?: string;
};

type MultiResponse = {
  results?: Record<string, NormalizedConfigLookup | null>;
  reasons?: Record<string, string>;
  reason?: string;
};

/** Every lookup, degraded or not, must carry these. */
function expectLookupShape(lookup: NormalizedConfigLookup, requestedPath: string) {
  expect(typeof lookup.path).toBe("string");
  expect(lookup.requestedPath).toBe(requestedPath);
  expect(RELOAD_KINDS).toContain(lookup.reloadKind);
  expect(["gateway", "matrix"]).toContain(lookup.reloadKindSource);
  // Tri-state: a real boolean or an explicit null. Never undefined, never a guess.
  for (const field of ["required", "deprecated", "readOnly"] as const) {
    expect([true, false, null]).toContain(lookup[field]);
  }
  expect(Array.isArray(lookup.children)).toBe(true);
  expect(typeof lookup.hasChildren).toBe("boolean");
}

/* ── 1. Live lookups for real config paths ─────────────────────────────── */

test.describe("GET /api/config/lookup — real paths @live", () => {
  test("gateway.port carries an integer type, bounds and a restart warning @live", async ({
    request,
  }) => {
    const res = await request.get(`${LIVE_BASE}/api/config/lookup?path=gateway.port`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SingleResponse;

    expect(body.path).toBe("gateway.port");
    const lookup = body.lookup;
    expect(lookup, `no lookup returned: ${body.reason ?? ""}`).toBeTruthy();
    if (!lookup) return;

    expectLookupShape(lookup, "gateway.port");
    expect(lookup.degraded).toBeFalsy();
    // gateway.* is the documented restart row; the gateway agrees.
    expect(lookup.reloadKind).toBe("restart");
    expect(lookup.reloadKindSource).toBe("gateway");
    expect(lookup.type).toBe("integer");
    expect(typeof lookup.title).toBe("string");
    expect(typeof lookup.description).toBe("string");
    // A port must be positive — the schema says exclusiveMinimum, not minimum,
    // and the difference decides whether port 0 is accepted.
    const hasLowerBound =
      typeof lookup.exclusiveMinimum === "number" || typeof lookup.minimum === "number";
    expect(hasLowerBound).toBe(true);
  });

  test("gateway.auth.mode flattens its const branches into an enum @live", async ({
    request,
  }) => {
    const res = await request.get(`${LIVE_BASE}/api/config/lookup?path=gateway.auth.mode`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SingleResponse;
    const lookup = body.lookup;
    expect(lookup, `no lookup returned: ${body.reason ?? ""}`).toBeTruthy();
    if (!lookup) return;

    expectLookupShape(lookup, "gateway.auth.mode");
    expect(lookup.reloadKind).toBe("restart");
    expect(Array.isArray(lookup.enum)).toBe(true);
    // The schema states these as four anyOf `const` branches, not an `enum`.
    // Normalization is what makes a dropdown possible.
    expect(lookup.enum).toContain("token");
    expect(lookup.enum).toContain("none");
    expect(lookup.type).toBe("string");

    // The validator must agree with the enum it was handed.
    expect(validateConfigValue(lookup, "token")).toEqual({ ok: true });
    const bad = validateConfigValue(lookup, "definitely-not-a-mode");
    expect(bad.ok).toBe(false);
  });

  test("agents.defaults.model stays an open union (no fake enum) @live", async ({
    request,
  }) => {
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?path=agents.defaults.model`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SingleResponse;
    const lookup = body.lookup;
    expect(lookup, `no lookup returned: ${body.reason ?? ""}`).toBeTruthy();
    if (!lookup) return;

    expectLookupShape(lookup, "agents.defaults.model");
    // Model is not a gateway.* path, so it hot-applies.
    expect(lookup.reloadKind).not.toBe("restart");
    // string | { primary, fallbacks } — one open branch, so no enum at all.
    expect(lookup.enum).toBeUndefined();
    expect(lookup.types).toEqual(expect.arrayContaining(["string"]));
    // A plain model id must validate against the union.
    expect(validateConfigValue(lookup, "anthropic/claude-opus-4")).toEqual({ ok: true });
  });

  test("tools.media.audio.enabled is a boolean that needs no reload @live", async ({
    request,
  }) => {
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?path=tools.media.audio.enabled`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SingleResponse;
    const lookup = body.lookup;
    expect(lookup, `no lookup returned: ${body.reason ?? ""}`).toBeTruthy();
    if (!lookup) return;

    expectLookupShape(lookup, "tools.media.audio.enabled");
    expect(lookup.type).toBe("boolean");
    expect(lookup.reloadKind).not.toBe("restart");
    expect(validateConfigValue(lookup, true)).toEqual({ ok: true });
    expect(validateConfigValue(lookup, "yes").ok).toBe(false);
  });

  test("an unknown path answers null with a reason, not a fake node @live", async ({
    request,
  }) => {
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?path=this.path.does.not.exist`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SingleResponse;
    expect(body.path).toBe("this.path.does.not.exist");
    expect(body.lookup).toBeNull();
    expect(typeof body.reason).toBe("string");
    expect(body.reason?.length).toBeGreaterThan(0);
  });

  test("array-index and root paths resolve @live", async ({ request }) => {
    const root = await request.get(`${LIVE_BASE}/api/config/lookup?path=.`);
    expect(root.status()).toBe(200);
    const rootBody = (await root.json()) as SingleResponse;
    expect(rootBody.lookup, `no root lookup: ${rootBody.reason ?? ""}`).toBeTruthy();
    // The root lists every top-level section — this is what lets the editor
    // offer sections that do not exist on disk yet.
    expect((rootBody.lookup?.children.length ?? 0)).toBeGreaterThan(5);

    const indexed = await request.get(
      `${LIVE_BASE}/api/config/lookup?path=${encodeURIComponent("agents.list[0].model")}`,
    );
    expect(indexed.status()).toBe(200);
    const indexedBody = (await indexed.json()) as SingleResponse;
    expect(indexedBody.lookup).toBeTruthy();
    // The gateway normalizes bracket indexes to dotted segments.
    expect(indexedBody.lookup?.path).toBe("agents.list.0.model");
    expect(indexedBody.lookup?.requestedPath).toBe("agents.list[0].model");
  });
});

/* ── 2. Multi-path form and request limits ─────────────────────────────── */

test.describe("GET /api/config/lookup — batching and limits @live", () => {
  test("?paths= returns a keyed map @live", async ({ request }) => {
    const paths = [
      "gateway.port",
      "agents.defaults.model",
      "tools.media.audio.enabled",
      "this.path.does.not.exist",
    ];
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?paths=${encodeURIComponent(paths.join(","))}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as MultiResponse;
    expect(body.results).toBeTruthy();
    const results = body.results ?? {};
    for (const path of paths) {
      expect(Object.prototype.hasOwnProperty.call(results, path)).toBe(true);
    }
    expect(results["gateway.port"]).toBeTruthy();
    // The unknown path is null inside the same map — a partial answer, clearly
    // marked, instead of failing the whole batch.
    expect(results["this.path.does.not.exist"]).toBeNull();
    expect(body.reasons?.["this.path.does.not.exist"]).toBeTruthy();
  });

  test("?paths= with a single value still uses the map form @live", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config/lookup?paths=gateway.port`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as MultiResponse;
    expect(body.results).toBeTruthy();
    expect(Object.keys(body.results ?? {})).toEqual(["gateway.port"]);
  });

  test("repeated ?path= params batch too @live", async ({ request }) => {
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?path=gateway.port&path=gateway.auth.mode`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as MultiResponse;
    expect(Object.keys(body.results ?? {}).sort()).toEqual([
      "gateway.auth.mode",
      "gateway.port",
    ]);
  });

  test("over the 25-path cap is a 400 that names the cap @live", async ({ request }) => {
    const paths = Array.from({ length: 26 }, (_, i) => `gateway.p${i}`);
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?paths=${encodeURIComponent(paths.join(","))}`,
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string; max?: number };
    expect(body.max).toBe(25);
    expect(body.error).toContain("25");
  });

  test("exactly 25 paths is accepted @live", async ({ request }) => {
    const paths = Array.from({ length: 25 }, (_, i) =>
      i === 0 ? "gateway.port" : `gateway.unknown${i}`,
    );
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?paths=${encodeURIComponent(paths.join(","))}`,
    );
    expect(res.status()).toBe(200);
    const body = (await res.json()) as MultiResponse;
    expect(Object.keys(body.results ?? {}).length).toBe(25);
  });

  test("no path at all is a 400 with usage @live", async ({ request }) => {
    const res = await request.get(`${LIVE_BASE}/api/config/lookup`);
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("path");
  });

  test("an unusable path is rejected without hitting the gateway @live", async ({
    request,
  }) => {
    const deep = Array.from({ length: 40 }, () => "a").join(".");
    const res = await request.get(`${LIVE_BASE}/api/config/lookup?path=${deep}`);
    expect(res.status()).toBe(200);
    const body = (await res.json()) as SingleResponse;
    expect(body.lookup).toBeNull();
    expect(body.reason).toBeTruthy();
  });
});

/* ── 3. Reload matrix fallback (pure) ──────────────────────────────────── */

test.describe("reloadKindFromMatrix", () => {
  test("mirrors the documented reload table", () => {
    // Gateway server row — restart.
    expect(reloadKindFromMatrix("gateway")).toBe("restart");
    expect(reloadKindFromMatrix("gateway.port")).toBe("restart");
    expect(reloadKindFromMatrix("gateway.auth.mode")).toBe("restart");
    // Infrastructure row — restart.
    expect(reloadKindFromMatrix("discovery")).toBe("restart");
    expect(reloadKindFromMatrix("browser.headless")).toBe("restart");
    expect(reloadKindFromMatrix("plugins.load")).toBe("restart");
    expect(reloadKindFromMatrix("plugins.installs.foo")).toBe("restart");
    // Documented exceptions under gateway.*.
    expect(reloadKindFromMatrix("gateway.reload.mode")).toBe("hot");
    expect(reloadKindFromMatrix("gateway.remote")).toBe("hot");
    // Everything else hot-applies.
    expect(reloadKindFromMatrix("agents.defaults.model")).toBe("hot");
    expect(reloadKindFromMatrix("tools.media.audio.enabled")).toBe("hot");
    expect(reloadKindFromMatrix("plugins.entries.canvas.enabled")).toBe("hot");
    // Bracket syntax normalizes before matching.
    expect(reloadKindFromMatrix("agents.list[0].model")).toBe("hot");
  });

  test("a degraded lookup carries the matrix answer and nothing else", () => {
    const lookup = degradedConfigLookup("gateway.port");
    expect(lookup.degraded).toBe(true);
    expect(lookup.reloadKind).toBe("restart");
    expect(lookup.reloadKindSource).toBe("matrix");
    expect(lookup.required).toBeNull();
    expect(lookup.type).toBeUndefined();
    // A degraded lookup must never block a save on constraints it does not know.
    expect(validateConfigValue(lookup, "anything at all")).toEqual({ ok: true });
  });
});

/* ── 4. Normalization (pure) ───────────────────────────────────────────── */

test.describe("normalizeConfigSchemaLookup", () => {
  test("flattens anyOf const branches into an enum and a single type", () => {
    const lookup = normalizeConfigSchemaLookup(
      {
        path: "gateway.auth.mode",
        reloadKind: "restart",
        schema: {
          title: "Gateway Auth Mode",
          description: "…",
          anyOf: [
            { type: "string", const: "none" },
            { type: "string", const: "token" },
            { type: "string", const: "password" },
          ],
        },
        children: [],
      },
      { requestedPath: "gateway.auth.mode", required: false },
    );
    expect(lookup?.enum).toEqual(["none", "token", "password"]);
    expect(lookup?.type).toBe("string");
    expect(lookup?.reloadKindSource).toBe("gateway");
    expect(lookup?.required).toBe(false);
    // Schema title/description double as the editor's label/help.
    expect(lookup?.label).toBe("Gateway Auth Mode");
  });

  test("leaves an open union without an enum", () => {
    const lookup = normalizeConfigSchemaLookup(
      {
        path: "agents.defaults.model",
        reloadKind: "hot",
        schema: {
          anyOf: [{ type: "string" }, { type: "object", properties: { primary: {} } }],
        },
        children: [],
      },
      { requestedPath: "agents.defaults.model" },
    );
    expect(lookup?.enum).toBeUndefined();
    expect(lookup?.types).toEqual(["string", "object"]);
    expect(lookup?.type).toBeUndefined();
    expect(lookup?.required).toBeNull();
  });

  test("falls back to the reload matrix when the gateway omits reloadKind", () => {
    const lookup = normalizeConfigSchemaLookup(
      { path: "gateway.port", schema: { type: "integer" }, children: [] },
      { requestedPath: "gateway.port" },
    );
    expect(lookup?.reloadKind).toBe("restart");
    expect(lookup?.reloadKindSource).toBe("matrix");
  });

  test("keeps hint metadata and child summaries", () => {
    const lookup = normalizeConfigSchemaLookup(
      {
        path: "gateway",
        reloadKind: "restart",
        schema: { type: "object" },
        hint: { label: "Gateway", group: "Gateway", order: 30, tags: ["advanced"] },
        hintPath: "gateway",
        children: [
          {
            key: "port",
            path: "gateway.port",
            type: "integer",
            required: true,
            hasChildren: false,
            reloadKind: "restart",
            hint: { label: "Gateway Port" },
          },
          { key: "bogus" },
        ],
      },
      { requestedPath: "gateway" },
    );
    expect(lookup?.label).toBe("Gateway");
    expect(lookup?.group).toBe("Gateway");
    expect(lookup?.order).toBe(30);
    expect(lookup?.hasChildren).toBe(true);
    // The malformed child is dropped, not propagated as a broken row.
    expect(lookup?.children.length).toBe(1);
    expect(lookup?.children[0]).toMatchObject({
      key: "port",
      path: "gateway.port",
      type: "integer",
      required: true,
      reloadKind: "restart",
      label: "Gateway Port",
    });
  });

  test("returns null for a payload that is not an object", () => {
    expect(normalizeConfigSchemaLookup(null, { requestedPath: "x" })).toBeNull();
    expect(normalizeConfigSchemaLookup(undefined, { requestedPath: "x" })).toBeNull();
  });
});

/* ── 5. The validator (pure) ───────────────────────────────────────────── */

/** Minimal normalized lookup with the fields under test. */
function makeLookup(overrides: Partial<NormalizedConfigLookup> = {}): NormalizedConfigLookup {
  return {
    path: "some.field",
    requestedPath: "some.field",
    reloadKind: "hot",
    reloadKindSource: "gateway",
    required: null,
    deprecated: null,
    readOnly: null,
    writeOnly: null,
    hasChildren: false,
    children: [],
    schema: {},
    ...overrides,
  };
}

test.describe("validateConfigValue", () => {
  test("passes when nothing is known", () => {
    expect(validateConfigValue(null, "whatever")).toEqual({ ok: true });
    expect(validateConfigValue(undefined, 42)).toEqual({ ok: true });
    expect(validateConfigValue(makeLookup(), { anything: true })).toEqual({ ok: true });
  });

  test("required rejects blank values and accepts real ones", () => {
    const lookup = makeLookup({ required: true, type: "string", title: "Token" });
    expect(validateConfigValue(lookup, "abc")).toEqual({ ok: true });
    for (const blank of [undefined, null, "", "   "]) {
      const result = validateConfigValue(lookup, blank);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("Token");
    }
  });

  test("a blank value on an optional field is a legitimate clear", () => {
    const lookup = makeLookup({ required: false, type: "string" });
    expect(validateConfigValue(lookup, "")).toEqual({ ok: true });
    expect(validateConfigValue(lookup, null)).toEqual({ ok: true });
  });

  test("false and 0 are values, not blanks", () => {
    expect(validateConfigValue(makeLookup({ required: true, type: "boolean" }), false)).toEqual(
      { ok: true },
    );
    expect(validateConfigValue(makeLookup({ required: true, type: "integer" }), 0)).toEqual({
      ok: true,
    });
  });

  test("readOnly refuses any write", () => {
    const result = validateConfigValue(makeLookup({ readOnly: true, title: "Version" }), "1.0");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("read-only");
  });

  test("type: string", () => {
    const lookup = makeLookup({ type: "string", types: ["string"] });
    expect(validateConfigValue(lookup, "hello")).toEqual({ ok: true });
    expect(validateConfigValue(lookup, 5).ok).toBe(false);
    expect(validateConfigValue(lookup, true).ok).toBe(false);
  });

  test("type: integer rejects decimals, number accepts them", () => {
    const integer = makeLookup({ type: "integer", types: ["integer"] });
    expect(validateConfigValue(integer, 18789)).toEqual({ ok: true });
    expect(validateConfigValue(integer, 18789.5).ok).toBe(false);
    expect(validateConfigValue(integer, "18789").ok).toBe(false);

    const number = makeLookup({ type: "number", types: ["number"] });
    expect(validateConfigValue(number, 1.5)).toEqual({ ok: true });
    expect(validateConfigValue(number, Number.NaN).ok).toBe(false);
  });

  test("type: boolean / array / object", () => {
    expect(
      validateConfigValue(makeLookup({ type: "boolean", types: ["boolean"] }), true),
    ).toEqual({ ok: true });
    expect(
      validateConfigValue(makeLookup({ type: "boolean", types: ["boolean"] }), "true").ok,
    ).toBe(false);
    expect(validateConfigValue(makeLookup({ type: "array", types: ["array"] }), [1])).toEqual({
      ok: true,
    });
    expect(
      validateConfigValue(makeLookup({ type: "array", types: ["array"] }), { a: 1 }).ok,
    ).toBe(false);
    expect(
      validateConfigValue(makeLookup({ type: "object", types: ["object"] }), { a: 1 }),
    ).toEqual({ ok: true });
    expect(validateConfigValue(makeLookup({ type: "object", types: ["object"] }), [1]).ok).toBe(
      false,
    );
  });

  test("a union type accepts any of its branches", () => {
    const lookup = makeLookup({ types: ["string", "object"] });
    expect(validateConfigValue(lookup, "openai/gpt-5")).toEqual({ ok: true });
    expect(validateConfigValue(lookup, { primary: "openai/gpt-5" })).toEqual({ ok: true });
    expect(validateConfigValue(lookup, 7).ok).toBe(false);
  });

  test("enum", () => {
    const lookup = makeLookup({
      type: "string",
      types: ["string"],
      enum: ["none", "token", "password"],
      title: "Auth Mode",
    });
    expect(validateConfigValue(lookup, "token")).toEqual({ ok: true });
    const result = validateConfigValue(lookup, "tokn");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Auth Mode");
      expect(result.message).toContain("token");
    }
  });

  test("pattern", () => {
    const lookup = makeLookup({ type: "string", types: ["string"], pattern: "^[a-z0-9-]+$" });
    expect(validateConfigValue(lookup, "my-agent")).toEqual({ ok: true });
    expect(validateConfigValue(lookup, "My Agent").ok).toBe(false);
  });

  test("an unusable pattern never blocks the user", () => {
    const lookup = makeLookup({ type: "string", types: ["string"], pattern: "([" });
    expect(validateConfigValue(lookup, "anything")).toEqual({ ok: true });
  });

  test("minLength / maxLength", () => {
    const lookup = makeLookup({
      type: "string",
      types: ["string"],
      minLength: 3,
      maxLength: 6,
    });
    expect(validateConfigValue(lookup, "abcd")).toEqual({ ok: true });
    expect(validateConfigValue(lookup, "ab").ok).toBe(false);
    expect(validateConfigValue(lookup, "abcdefg").ok).toBe(false);
  });

  test("minimum / maximum", () => {
    const lookup = makeLookup({ type: "integer", types: ["integer"], minimum: 1, maximum: 10 });
    expect(validateConfigValue(lookup, 1)).toEqual({ ok: true });
    expect(validateConfigValue(lookup, 10)).toEqual({ ok: true });
    expect(validateConfigValue(lookup, 0).ok).toBe(false);
    expect(validateConfigValue(lookup, 11).ok).toBe(false);
  });

  test("exclusiveMinimum / exclusiveMaximum — the real gateway.port bound", () => {
    const lookup = makeLookup({
      type: "integer",
      types: ["integer"],
      exclusiveMinimum: 0,
      exclusiveMaximum: 65536,
      title: "Gateway Port",
    });
    expect(validateConfigValue(lookup, 18789)).toEqual({ ok: true });
    // A plain `minimum: 0` would have let this through.
    expect(validateConfigValue(lookup, 0).ok).toBe(false);
    expect(validateConfigValue(lookup, 65536).ok).toBe(false);
  });

  test("multipleOf", () => {
    const lookup = makeLookup({ type: "integer", types: ["integer"], multipleOf: 100 });
    expect(validateConfigValue(lookup, 2000)).toEqual({ ok: true });
    expect(validateConfigValue(lookup, 2050).ok).toBe(false);
  });

  test("minItems / maxItems / uniqueItems", () => {
    const lookup = makeLookup({
      type: "array",
      types: ["array"],
      minItems: 1,
      maxItems: 2,
      uniqueItems: true,
    });
    expect(validateConfigValue(lookup, ["a"])).toEqual({ ok: true });
    expect(validateConfigValue(lookup, []).ok).toBe(false);
    expect(validateConfigValue(lookup, ["a", "b", "c"]).ok).toBe(false);
    expect(validateConfigValue(lookup, ["a", "a"]).ok).toBe(false);
  });

  test("every failure message is human-readable, not a schema dump", () => {
    const lookup = makeLookup({
      type: "integer",
      types: ["integer"],
      minimum: 1,
      title: "Gateway Port",
    });
    const result = validateConfigValue(lookup, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe("Gateway Port must be 1 or more.");
    }
  });
});
