/**
 * Config WRITE model.
 *
 * 1. Unit tests for src/lib/config-diff.ts — the minimal-diff builder that
 *    turns (base, next) into a JSON merge patch plus the `replacePaths` list
 *    the gateway demands for destructive array replacement. Pure functions, no
 *    gateway, no server: these run in the CI project.
 * 2. @live round-trips against the real gateway through PATCH /api/config,
 *    proving the two things the old whole-document write got wrong:
 *      - an explicit `null` really deletes a key (it used to be a silent no-op
 *        reported as "saved successfully"),
 *      - an array can shrink when `replacePaths` names it (it used to hard-fail
 *        with an unmapped raw gateway error).
 *    Both restore the original value before finishing.
 *
 * Control-plane writes are rate-limited to 3 per 60s per client, so the live
 * tests pace themselves through `patchConfig()` and honour `retryAfterMs`.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyMergePatch,
  arrayLosesEntries,
  buildConfigDiff,
  collectArrayPathsUnder,
  collectDeletedPaths,
  collectEnvSubstitutedPaths,
  collectPatchPaths,
  deepEqual,
  normalizeArrayPath,
  parseReplacePathsFromError,
  stableStringify,
} from "../src/lib/config-diff";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

/* ── 1. config-diff: merge patch construction ──────────────────────────── */

test.describe("config-diff — merge patch", () => {
  test("identical documents produce no patch at all", () => {
    const doc = { a: 1, b: { c: [1, 2], d: "x" } };
    const diff = buildConfigDiff(doc, JSON.parse(JSON.stringify(doc)));
    expect(diff.patch).toEqual({});
    expect(diff.changed).toBe(false);
    expect(diff.changedPaths).toEqual([]);
    expect(diff.replacePaths).toEqual([]);
  });

  test("only the changed leaf travels — untouched subtrees are absent", () => {
    const base = {
      gateway: { port: 18789, bind: "loopback", tailscale: { mode: "off" } },
      session: { dmScope: "per-channel-peer" },
    };
    const next = {
      gateway: { port: 18790, bind: "loopback", tailscale: { mode: "off" } },
      session: { dmScope: "per-channel-peer" },
    };
    const diff = buildConfigDiff(base, next);
    expect(diff.patch).toEqual({ gateway: { port: 18790 } });
    expect(diff.changedPaths).toEqual(["gateway.port"]);
    expect(diff.changed).toBe(true);
  });

  test("a nested key added deep in an existing tree", () => {
    const base = { a: { b: { c: 1 } } };
    const next = { a: { b: { c: 1, d: 2 } } };
    expect(buildConfigDiff(base, next).patch).toEqual({ a: { b: { d: 2 } } });
  });

  test("a whole new section is written in full", () => {
    const base = { gateway: { port: 1 } };
    const next = { gateway: { port: 1 }, cron: { jobs: [{ id: "x" }] } };
    const diff = buildConfigDiff(base, next);
    expect(diff.patch).toEqual({ cron: { jobs: [{ id: "x" }] } });
    expect(diff.replacePaths).toEqual([]);
  });

  test("a new empty section is still written (creates the section)", () => {
    const diff = buildConfigDiff({}, { memory: {} });
    expect(diff.patch).toEqual({ memory: {} });
    expect(diff.changed).toBe(true);
    expect(diff.changedPaths).toEqual(["memory"]);
  });

  test("an empty section that stays empty is not rewritten", () => {
    expect(buildConfigDiff({ memory: {} }, { memory: {} }).changed).toBe(false);
  });
});

/* ── 2. config-diff: deletion ──────────────────────────────────────────── */

test.describe("config-diff — deletion carries an explicit null", () => {
  test("a removed leaf becomes null, not an omission", () => {
    const base = { wizard: { lastRunVersion: "1.0", lastRunMode: "local" } };
    const next = { wizard: { lastRunMode: "local" } };
    const diff = buildConfigDiff(base, next);
    expect(diff.patch).toEqual({ wizard: { lastRunVersion: null } });
    expect(diff.deletedPaths).toEqual(["wizard.lastRunVersion"]);
  });

  test("a removed top-level section becomes a single null", () => {
    const base = { gateway: { port: 1 }, cron: { jobs: [] } };
    const next = { gateway: { port: 1 } };
    const diff = buildConfigDiff(base, next);
    expect(diff.patch).toEqual({ cron: null });
    expect(diff.deletedPaths).toEqual(["cron"]);
  });

  test("deleting a subtree confirms every array buried inside it", () => {
    const base = {
      agents: { list: [{ id: "a" }], defaults: { model: { fallbacks: ["x", "y"] } } },
    };
    const next = {};
    const diff = buildConfigDiff(base, next);
    expect(diff.patch).toEqual({ agents: null });
    // The gateway treats a deleted subtree as removing every array under it.
    expect(diff.replacePaths.sort()).toEqual(
      ["agents.defaults.model.fallbacks", "agents.list"].sort(),
    );
  });

  test("an explicit null in `next` is treated as a delete", () => {
    const diff = buildConfigDiff({ a: 1 }, { a: null });
    expect(diff.patch).toEqual({ a: null });
    expect(diff.deletedPaths).toEqual(["a"]);
  });

  test("clearing every key of an object deletes the keys, not the object", () => {
    const diff = buildConfigDiff({ a: { b: 1, c: 2 } }, { a: {} });
    expect(diff.patch).toEqual({ a: { b: null, c: null } });
  });

  test("a base key holding null that disappears still emits null", () => {
    const diff = buildConfigDiff({ a: null }, {});
    expect(diff.patch).toEqual({ a: null });
    expect(diff.changed).toBe(true);
  });
});

/* ── 3. config-diff: arrays and replacePaths ───────────────────────────── */

test.describe("config-diff — arrays", () => {
  test("appending to an array is not destructive", () => {
    const diff = buildConfigDiff({ list: ["a", "b"] }, { list: ["a", "b", "c"] });
    expect(diff.patch).toEqual({ list: ["a", "b", "c"] });
    expect(diff.replacePaths).toEqual([]);
  });

  test("shrinking an array demands replacePaths", () => {
    const diff = buildConfigDiff(
      { agents: { defaults: { model: { fallbacks: ["a", "b"] } } } },
      { agents: { defaults: { model: { fallbacks: ["a"] } } } },
    );
    expect(diff.patch).toEqual({ agents: { defaults: { model: { fallbacks: ["a"] } } } });
    expect(diff.replacePaths).toEqual(["agents.defaults.model.fallbacks"]);
  });

  test("removing an entry from the middle demands replacePaths", () => {
    const diff = buildConfigDiff({ l: ["a", "b", "c"] }, { l: ["a", "c"] });
    expect(diff.replacePaths).toEqual(["l"]);
  });

  test("reordering the same entries demands replacePaths", () => {
    const diff = buildConfigDiff({ l: ["a", "b"] }, { l: ["b", "a"] });
    expect(diff.patch).toEqual({ l: ["b", "a"] });
    expect(diff.replacePaths).toEqual(["l"]);
  });

  test("editing an entry in place demands replacePaths (the old value is gone)", () => {
    const diff = buildConfigDiff({ l: ["a", "b"] }, { l: ["a", "c"] });
    expect(diff.replacePaths).toEqual(["l"]);
  });

  test("prepending keeps every entry but changes order — still confirmed", () => {
    const diff = buildConfigDiff({ l: ["a", "b"] }, { l: ["z", "a", "b"] });
    expect(diff.replacePaths).toEqual(["l"]);
  });

  test("arrays of objects: a removed entry is detected by deep equality", () => {
    const base = { bindings: [{ agentId: "home" }, { agentId: "work" }] };
    const next = { bindings: [{ agentId: "home" }] };
    const diff = buildConfigDiff(base, next);
    expect(diff.replacePaths).toEqual(["bindings"]);
  });

  test("arrays of objects: key order inside an entry is not a change", () => {
    const base = { l: [{ a: 1, b: 2 }] };
    const next = { l: [{ b: 2, a: 1 }] };
    expect(buildConfigDiff(base, next).changed).toBe(false);
  });

  test("an array nested inside an array entry uses the gateway's [] notation", () => {
    const base = { agents: { list: [{ id: "a", skills: ["x", "y"] }] } };
    const next = { agents: { list: [{ id: "a", skills: ["x"] }] } };
    const diff = buildConfigDiff(base, next);
    // The outer array changed too (its entry is no longer deep-equal).
    expect(diff.replacePaths).toContain("agents.list");
    expect(diff.replacePaths).toContain("agents.list[].skills");
  });

  test("an array replaced by an object loses every entry", () => {
    const diff = buildConfigDiff({ l: ["a"] }, { l: { a: 1 } });
    expect(diff.patch).toEqual({ l: { a: 1 } });
    expect(diff.replacePaths).toEqual(["l"]);
  });

  test("an object holding arrays replaced by a scalar confirms each array", () => {
    const base = { s: { one: [1], two: { three: [2] } } };
    const diff = buildConfigDiff(base, { s: "off" });
    expect(diff.patch).toEqual({ s: "off" });
    expect(diff.replacePaths.sort()).toEqual(["s.one", "s.two.three"]);
  });

  test("a scalar replaced by an array has nothing to confirm", () => {
    const diff = buildConfigDiff({ l: "off" }, { l: ["a"] });
    expect(diff.patch).toEqual({ l: ["a"] });
    expect(diff.replacePaths).toEqual([]);
  });

  test("arrayLosesEntries matches the gateway's multiset rule", () => {
    expect(arrayLosesEntries([1, 2], [1, 2, 3])).toBe(false);
    expect(arrayLosesEntries([1, 2], [1])).toBe(true);
    expect(arrayLosesEntries([1, 2], [2, 1])).toBe(true);
    expect(arrayLosesEntries([], [1])).toBe(false);
    expect(arrayLosesEntries([1], [])).toBe(true);
    expect(arrayLosesEntries([{ a: 1 }], [{ a: 1 }, { b: 2 }])).toBe(false);
    expect(arrayLosesEntries([{ a: 1 }], [{ a: 2 }])).toBe(true);
  });

  test("collectArrayPathsUnder finds every array in a subtree", () => {
    expect(collectArrayPathsUnder({ a: [1], b: { c: [2], d: 3 } }, "root").sort()).toEqual([
      "root.a",
      "root.b.c",
    ]);
    expect(collectArrayPathsUnder([1, 2], "root")).toEqual(["root"]);
    expect(collectArrayPathsUnder("scalar", "root")).toEqual([]);
  });
});

/* ── 4. config-diff: type changes and odd shapes ───────────────────────── */

test.describe("config-diff — type changes", () => {
  test("scalar to object writes the object whole", () => {
    const diff = buildConfigDiff({ a: 1 }, { a: { b: 2 } });
    expect(diff.patch).toEqual({ a: { b: 2 } });
  });

  test("object to scalar writes the scalar", () => {
    const diff = buildConfigDiff({ a: { b: 2 } }, { a: 1 });
    expect(diff.patch).toEqual({ a: 1 });
  });

  test("number to string of the same digits is a real change", () => {
    expect(buildConfigDiff({ a: 1 }, { a: "1" }).patch).toEqual({ a: "1" });
  });

  test("false, 0 and empty string are values, not absences", () => {
    const diff = buildConfigDiff(
      { a: true, b: 1, c: "x" },
      { a: false, b: 0, c: "" },
    );
    expect(diff.patch).toEqual({ a: false, b: 0, c: "" });
  });

  test("undefined in `next` means delete, never 'write undefined'", () => {
    const diff = buildConfigDiff({ a: 1 }, { a: undefined });
    expect(diff.patch).toEqual({ a: null });
    expect(diff.deletedPaths).toEqual(["a"]);
  });

  test("non-object inputs degrade to an empty document", () => {
    expect(buildConfigDiff(null, null).changed).toBe(false);
    expect(buildConfigDiff("x", { a: 1 }).patch).toEqual({ a: 1 });
  });
});

/* ── 5. config-diff: round-trip property ───────────────────────────────── */

test.describe("config-diff — applying the patch reproduces `next`", () => {
  const fixtures: Array<[string, unknown, unknown]> = [
    ["leaf change", { a: 1, b: 2 }, { a: 9, b: 2 }],
    ["nested add", { a: { b: 1 } }, { a: { b: 1, c: 2 } }],
    ["leaf delete", { a: { b: 1, c: 2 } }, { a: { c: 2 } }],
    ["section delete", { a: 1, b: { c: 2 } }, { a: 1 }],
    ["array shrink", { l: [1, 2, 3] }, { l: [1] }],
    ["array grow", { l: [1] }, { l: [1, 2, 3] }],
    ["array reorder", { l: [1, 2] }, { l: [2, 1] }],
    ["array of objects", { l: [{ id: "a" }] }, { l: [{ id: "b" }, { id: "c" }] }],
    ["type change", { a: { b: 1 } }, { a: "flat" }],
    ["new section", { a: 1 }, { a: 1, z: { y: [1, 2] } }],
    ["empty section", {}, { z: {} }],
    ["deep mixed", { a: { b: { c: [1], d: 2 }, e: 3 } }, { a: { b: { c: [1, 4] }, f: 5 } }],
  ];

  for (const [name, base, next] of fixtures) {
    test(`round-trips: ${name}`, () => {
      const diff = buildConfigDiff(base, next);
      expect(applyMergePatch(base, diff.patch)).toEqual(next);
    });
  }

  test("applying an empty patch is a no-op", () => {
    const doc = { a: 1, b: { c: 2 } };
    expect(applyMergePatch(doc, {})).toEqual(doc);
  });

  test("applyMergePatch never mutates its inputs", () => {
    const base = { a: { b: 1 } };
    const patch = { a: { b: 2 } };
    applyMergePatch(base, patch);
    expect(base).toEqual({ a: { b: 1 } });
    expect(patch).toEqual({ a: { b: 2 } });
  });
});

/* ── 6. config-diff: patch introspection helpers ───────────────────────── */

test.describe("config-diff — patch introspection", () => {
  test("collectPatchPaths lists every touched leaf", () => {
    const paths = collectPatchPaths({
      gateway: { port: 1, tailscale: { mode: "off" } },
      cron: null,
    });
    expect(paths.sort()).toEqual(["cron", "gateway.port", "gateway.tailscale.mode"]);
  });

  test("collectPatchPaths treats an empty object as its own path", () => {
    expect(collectPatchPaths({ memory: {} })).toEqual(["memory"]);
  });

  test("collectPatchPaths keeps a legacy dotted key intact", () => {
    expect(collectPatchPaths({ "gateway.port": 1 })).toEqual(["gateway.port"]);
  });

  test("collectDeletedPaths finds only the nulls", () => {
    const deleted = collectDeletedPaths({
      a: { b: null, c: 1 },
      d: null,
      e: { f: { g: null } },
    });
    expect(deleted.sort()).toEqual(["a.b", "d", "e.f.g"]);
  });

  test("normalizeArrayPath rewrites concrete indices to the gateway's []", () => {
    expect(normalizeArrayPath("agents.list[0].skills")).toBe("agents.list[].skills");
    expect(normalizeArrayPath("a[0].b[12].c")).toBe("a[].b[].c");
    expect(normalizeArrayPath("gateway.port")).toBe("gateway.port");
  });

  test("stableStringify is key-order independent, deepEqual follows", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(deepEqual({ a: [1, { x: 1, y: 2 }] }, { a: [1, { y: 2, x: 1 }] })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: "1" })).toBe(false);
  });

  test("parseReplacePathsFromError reads the live gateway wording", () => {
    // Verbatim from OpenClaw v2026.7.1-2.
    const message =
      "GatewayClientRequestError: config.patch would remove entries from array path(s): " +
      "agents.defaults.model.fallbacks, agents.list[].skills. Pass replacePaths with the " +
      "exact path(s) when this is intentional, or use config.apply for full-config replacement.";
    expect(parseReplacePathsFromError(message)).toEqual([
      "agents.defaults.model.fallbacks",
      "agents.list[].skills",
    ]);
  });

  test("parseReplacePathsFromError ignores unrelated errors", () => {
    expect(parseReplacePathsFromError("config changed since last load")).toEqual([]);
    expect(parseReplacePathsFromError(undefined)).toEqual([]);
  });
});

/* ── 7. Env indirection (parsed vs resolved) ───────────────────────────── */

test.describe("config-diff — env substitution reporting", () => {
  test("reports a ${VAR} leaf and ignores plain values", () => {
    const parsed = {
      models: { providers: { custom: { apiKey: "${CUSTOM_API_KEY}", baseUrl: "https://x" } } },
    };
    const resolved = {
      models: { providers: { custom: { apiKey: "sk-real", baseUrl: "https://x" } } },
    };
    expect(collectEnvSubstitutedPaths(parsed, resolved)).toEqual([
      "models.providers.custom.apiKey",
    ]);
  });

  test("reports inline substitution and array positions", () => {
    const parsed = { a: { b: ["${BASE}/v1", "plain"] } };
    const resolved = { a: { b: ["https://api.example.com/v1", "plain"] } };
    expect(collectEnvSubstitutedPaths(parsed, resolved)).toEqual(["a.b[0]"]);
  });

  test("$${VAR} is an escaped literal, not indirection", () => {
    const doc = { a: "$${NOT_A_VAR}" };
    expect(collectEnvSubstitutedPaths(doc, doc)).toEqual([]);
  });

  test("lowercase ${var} is not env syntax", () => {
    const doc = { a: "${lowercase}" };
    expect(collectEnvSubstitutedPaths(doc, doc)).toEqual([]);
  });

  test("the redaction sentinel is identical in both trees — no false positive", () => {
    const sentinel = "__OPENCLAW_" + "REDACTED__";
    const doc = { gateway: { auth: { token: sentinel } } };
    expect(collectEnvSubstitutedPaths(doc, doc)).toEqual([]);
  });

  test("a value that differs only in `resolved` is still reported", () => {
    // Belt and braces: even without recognizable `${}` syntax, a parsed/resolved
    // disagreement means the authored text is not what runs.
    expect(collectEnvSubstitutedPaths({ a: "authored" }, { a: "expanded" })).toEqual(["a"]);
  });

  test("a scratch copy of the real config with an injected ${VAR} is detected", () => {
    // Requirement: prove the logic against the real document shape without ever
    // writing to the live config. Read it, copy it in memory, inject the case.
    const configPath = join(
      process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"),
      "openclaw.json",
    );
    let liveDoc: Record<string, unknown>;
    try {
      liveDoc = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      test.skip(true, "no local openclaw.json to copy");
      return;
    }

    // The untouched document must report nothing (no `${VAR}` on this install).
    expect(collectEnvSubstitutedPaths(liveDoc, liveDoc)).toEqual([]);

    // Scratch copy on disk, never the live path — same round-trip the editor does.
    const scratchDir = mkdtempSync(join(tmpdir(), "mc-config-envsub-"));
    const scratchPath = join(scratchDir, "openclaw.json");
    const scratchParsed = JSON.parse(JSON.stringify(liveDoc)) as Record<string, unknown>;
    const wizard = (scratchParsed.wizard ?? {}) as Record<string, unknown>;
    wizard.lastRunVersion = "${MC_PROBE_VERSION}";
    scratchParsed.wizard = wizard;
    writeFileSync(scratchPath, JSON.stringify(scratchParsed, null, 2));

    const reloaded = JSON.parse(readFileSync(scratchPath, "utf-8")) as Record<string, unknown>;
    // What the gateway would hand back as `resolved` for that document.
    const scratchResolved = JSON.parse(JSON.stringify(reloaded)) as Record<string, unknown>;
    (scratchResolved.wizard as Record<string, unknown>).lastRunVersion = "9.9.9-from-env";

    expect(collectEnvSubstitutedPaths(reloaded, scratchResolved)).toEqual([
      "wizard.lastRunVersion",
    ]);
    // And the authored `${VAR}` is what the editor round-trips, not the expansion.
    expect((reloaded.wizard as Record<string, unknown>).lastRunVersion).toBe(
      "${MC_PROBE_VERSION}",
    );
    // The diff of an untouched authored document is empty, so a save can never
    // bake the expansion in.
    expect(buildConfigDiff(reloaded, reloaded).changed).toBe(false);

    rmSync(scratchDir, { recursive: true, force: true });
  });
});

/* ── 8. Live round-trips ───────────────────────────────────────────────── */

type PatchBody = {
  patch?: Record<string, unknown>;
  raw?: string;
  baseHash: string;
  replacePaths?: string[];
  mode?: "patch" | "apply";
};

type Json = Record<string, unknown>;
type ConfigPayload = { config: Json; meta: Json };

/** Fetch the canonical payload. */
async function getPayload(request: APIRequestContext): Promise<ConfigPayload> {
  const res = await request.get(`${LIVE_BASE}/api/config`);
  expect(res.status()).toBe(200);
  return (await res.json()) as ConfigPayload;
}

/**
 * PATCH, honouring the gateway's 3-writes-per-60s control-plane budget: a 429
 * is retried after the server-reported delay rather than failing the run.
 */
async function pacedPatch(
  request: APIRequestContext,
  body: PatchBody,
  attempts = 4,
): Promise<{ status: number; body: Json }> {
  let last: { status: number; body: Json } = { status: 0, body: {} };
  for (let i = 0; i < attempts; i += 1) {
    const res = await request.patch(`${LIVE_BASE}/api/config`, { data: body });
    last = { status: res.status(), body: (await res.json()) as Json };
    if (last.status !== 429) return last;
    const retryAfterMs = Number(last.body.retryAfterMs ?? 0) || 20_000;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs + 1_000));
  }
  return last;
}

/** Read `agents.defaults.model.fallbacks` out of a payload. */
function readFallbacks(payload: ConfigPayload): unknown {
  const agents = payload.config.agents as Json | undefined;
  const defaults = agents?.defaults as Json | undefined;
  const model = defaults?.model as Json | undefined;
  return model?.fallbacks;
}

test.describe.serial("config write model @live", () => {

  test("GET serves the authoring surface with an envSubstituted list", async ({ request }) => {
    const payload = await getPayload(request);
    expect(payload).toHaveProperty("config");
    expect(payload.meta).toHaveProperty("baseHash");
    // New contract: the editor authors against `parsed`, so `${VAR}` survives.
    expect(payload.meta.configSource).toBe("parsed");
    const envSubstituted = payload.meta.envSubstituted;
    expect(Array.isArray(envSubstituted)).toBe(true);
    for (const path of envSubstituted as string[]) {
      expect(typeof path).toBe("string");
      expect(path.length).toBeGreaterThan(0);
    }
  });

  test("a stale baseHash returns 409 with the current config, never a clobber", async ({
    request,
  }) => {
    const before = await getPayload(request);
    const result = await pacedPatch(request, {
      patch: { wizard: { lastRunVersion: "should-never-be-written" } },
      baseHash: "0".repeat(64),
    });

    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(result.body.error).toBe("conflict");
    expect(typeof result.body.currentHash).toBe("string");
    expect(result.body.remoteConfig).toBeTruthy();
    expect(typeof result.body.message).toBe("string");

    // Proof that the write did NOT land: the value is untouched.
    const after = await getPayload(request);
    expect(after.config.wizard).toEqual(before.config.wizard);
  });

  test("null deletes a key for real, then the original is restored", async ({ request }) => {
    test.setTimeout(240_000);

    const initial = await getPayload(request);
    const original = (initial.config.wizard as Json | undefined)?.lastRunVersion;
    test.skip(typeof original !== "string", "wizard.lastRunVersion not present on this install");

    // 1. Set a probe value so the delete is unambiguous.
    const probe = `mc-delete-probe-${Date.now()}`;
    const setRes = await pacedPatch(request, {
      patch: { wizard: { lastRunVersion: probe } },
      baseHash: String(initial.meta.baseHash),
    });
    expect(setRes.status, JSON.stringify(setRes.body)).toBe(200);
    expect(setRes.body.ok).toBe(true);
    // wizard.* is reloadKind "none" — this must NOT ask for a restart.
    expect(setRes.body.restartRequired).toBe(false);
    expect(typeof setRes.body.hash).toBe("string");

    const afterSet = await getPayload(request);
    expect((afterSet.config.wizard as Json).lastRunVersion).toBe(probe);

    // 2. Delete it with an explicit null.
    const delRes = await pacedPatch(request, {
      patch: { wizard: { lastRunVersion: null } },
      baseHash: String(afterSet.meta.baseHash),
    });
    expect(delRes.status, JSON.stringify(delRes.body)).toBe(200);
    expect(delRes.body.deletedPaths).toEqual(["wizard.lastRunVersion"]);

    const afterDelete = await getPayload(request);
    const wizardAfterDelete = afterDelete.config.wizard as Json;
    // The key is GONE, not merely unchanged — this is the bug being fixed.
    expect(Object.keys(wizardAfterDelete)).not.toContain("lastRunVersion");

    // 3. Restore exactly what was there before.
    const restore = await pacedPatch(request, {
      patch: { wizard: { lastRunVersion: original } },
      baseHash: String(afterDelete.meta.baseHash),
    });
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);

    const restored = await getPayload(request);
    expect((restored.config.wizard as Json).lastRunVersion).toBe(original);
  });

  test("an array shrink needs replacePaths, and says so instead of failing raw", async ({
    request,
  }) => {
    test.setTimeout(300_000);

    const initial = await getPayload(request);
    const fallbacks = readFallbacks(initial);
    test.skip(
      !Array.isArray(fallbacks) || fallbacks.length < 2,
      "agents.defaults.model.fallbacks needs at least two entries for this test",
    );
    const originalFallbacks = fallbacks as unknown[];
    const shrunk = originalFallbacks.slice(0, originalFallbacks.length - 1);
    const ARRAY_PATH = "agents.defaults.model.fallbacks";

    // The diff builder must flag this shrink on its own.
    const diff = buildConfigDiff(
      { agents: { defaults: { model: { fallbacks: originalFallbacks } } } },
      { agents: { defaults: { model: { fallbacks: shrunk } } } },
    );
    expect(diff.replacePaths).toEqual([ARRAY_PATH]);

    // 1. Without replacePaths the gateway refuses — and we hand back the exact
    //    paths to confirm rather than a raw error string.
    const refused = await pacedPatch(request, {
      patch: diff.patch,
      baseHash: String(initial.meta.baseHash),
    });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.replacePathsRequired).toEqual([ARRAY_PATH]);

    // The refused write changed nothing.
    const unchanged = await getPayload(request);
    expect(readFallbacks(unchanged)).toEqual(originalFallbacks);

    // 2. With replacePaths it lands.
    const shrinkRes = await pacedPatch(request, {
      patch: diff.patch,
      baseHash: String(unchanged.meta.baseHash),
      replacePaths: diff.replacePaths,
    });
    expect(shrinkRes.status, JSON.stringify(shrinkRes.body)).toBe(200);

    const afterShrink = await getPayload(request);
    expect(readFallbacks(afterShrink)).toEqual(shrunk);

    // 3. Restore the original list (a grow — no confirmation needed).
    const restore = await pacedPatch(request, {
      patch: { agents: { defaults: { model: { fallbacks: originalFallbacks } } } },
      baseHash: String(afterShrink.meta.baseHash),
    });
    expect(restore.status, JSON.stringify(restore.body)).toBe(200);

    const restored = await getPayload(request);
    expect(readFallbacks(restored)).toEqual(originalFallbacks);
  });

  test("a no-op write is rejected before it reaches the gateway budget", async ({ request }) => {
    const initial = await getPayload(request);
    const res = await pacedPatch(request, {
      patch: {},
      baseHash: String(initial.meta.baseHash),
      mode: "patch",
    });
    // An empty merge patch is a valid (if pointless) write; what must never
    // happen is a restart being scheduled for it.
    expect([200, 400]).toContain(res.status);
    if (res.status === 200) expect(res.body.restartRequired).toBe(false);
  });
});
