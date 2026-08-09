/**
 * Config editor — the WRITE experience.
 *
 * The audit found the editor PATCHing the whole document, so a deletion was a
 * silent no-op reported as success; it never previewed a change, never
 * validated anything despite claiming to, clobbered concurrent editors on a
 * hash conflict, and restarted the gateway on every save. This spec covers the
 * client half of the fix:
 *
 *  1. The pure model behind the editor (src/components/config/config-changes.ts)
 *     — minimal save payload, real deletes, replacePaths, the diff-preview
 *     rows, restart planning, the auth-token-mint warning, conflict analysis,
 *     and the field search index. No gateway, no server: CI project.
 *  2. @live round-trips against a running Mission Control + gateway, proving
 *     the exact payload the editor sends is accepted, that a delete really
 *     deletes, that a stale hash answers 409 with the remote document, and
 *     that `restartRequired` is honest.
 *  3. @live @ui browser checks that the preview renders and that an invalid
 *     field blocks the save button. These run in the LIVE_UI project — the
 *     only one that needs a Chromium binary.
 *
 * Live writes are capped at 3 per 60s per client, so the live block paces
 * itself and honours `retryAfterMs`.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { applyMergePatch, buildConfigDiff } from "../src/lib/config-diff";
import { validateConfigValue } from "../src/lib/config-schema-validate";
import type { NormalizedConfigLookup } from "../src/lib/config-schema-validate";
import {
  analyzeConflict,
  buildFieldIndex,
  buildSaveBody,
  deleteAtPath,
  describeChanges,
  detectAuthTokenMint,
  getAtPath,
  isEnvSubstitutedPath,
  isSensitiveConfigPath,
  planRestart,
  searchFields,
  setAtPath,
} from "../src/components/config/config-changes";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

/** A lookup as the batching endpoint returns one, for validator tests. */
function lookup(partial: Partial<NormalizedConfigLookup>): NormalizedConfigLookup {
  return {
    path: partial.path ?? "gateway.port",
    requestedPath: partial.requestedPath ?? partial.path ?? "gateway.port",
    reloadKind: partial.reloadKind ?? null,
    reloadKindSource: partial.reloadKindSource ?? null,
    required: partial.required ?? null,
    deprecated: partial.deprecated ?? null,
    readOnly: partial.readOnly ?? null,
    writeOnly: partial.writeOnly ?? null,
    hasChildren: partial.hasChildren ?? false,
    children: partial.children ?? [],
    schema: partial.schema ?? null,
    ...partial,
  } as NormalizedConfigLookup;
}

const noLookups = () => undefined;

/* ── 1. Save payload: minimal, never the whole document ─────────────── */

test.describe("editor save payload", () => {
  const base = {
    gateway: { port: 18789, bind: "loopback", auth: { mode: "token", token: "abc" } },
    agents: { defaults: { model: { primary: "a", fallbacks: ["b", "c"] } } },
    wizard: { lastRunVersion: "2026.7.1-2", lastRunMode: "local" },
  };

  test("a one-field edit sends only that field", () => {
    const next = setAtPath(base, "gateway.port", 18790);
    const { body } = buildSaveBody(base, next, "HASH");
    expect(body.patch).toEqual({ gateway: { port: 18790 } });
    expect(body.baseHash).toBe("HASH");
    expect(body.replacePaths).toBeUndefined();
    // The old editor sent the entire document; nothing untouched may travel.
    expect(JSON.stringify(body.patch)).not.toContain("agents");
    expect(JSON.stringify(body.patch)).not.toContain("wizard");
  });

  test("removing a key sends an explicit null — this is what makes deletes real", () => {
    const next = deleteAtPath(base, "wizard.lastRunVersion");
    const { body, diff } = buildSaveBody(base, next, "HASH");
    expect(body.patch).toEqual({ wizard: { lastRunVersion: null } });
    expect(diff.deletedPaths).toEqual(["wizard.lastRunVersion"]);
    // A merge patch that simply omitted the key would be a no-op, which is
    // exactly the silent lie this replaces.
    expect(applyMergePatch(base, body.patch)).not.toHaveProperty(
      "wizard.lastRunVersion"
    );
  });

  test("removing a whole section sends one null", () => {
    const next = deleteAtPath(base, "wizard");
    const { body } = buildSaveBody(base, next, "HASH");
    expect(body.patch).toEqual({ wizard: null });
  });

  test("shrinking a list carries replacePaths", () => {
    const next = setAtPath(base, "agents.defaults.model", {
      primary: "a",
      fallbacks: ["b"],
    });
    const { body } = buildSaveBody(base, next, "HASH");
    expect(body.patch).toEqual({
      agents: { defaults: { model: { fallbacks: ["b"] } } },
    });
    expect(body.replacePaths).toEqual(["agents.defaults.model.fallbacks"]);
  });

  test("growing a list needs no confirmation", () => {
    const next = setAtPath(base, "agents.defaults.model", {
      primary: "a",
      fallbacks: ["b", "c", "d"],
    });
    expect(buildSaveBody(base, next, "H").body.replacePaths).toBeUndefined();
  });

  test("an operator-confirmed replacePath is merged in without duplicates", () => {
    const next = setAtPath(base, "agents.defaults.model", { primary: "a", fallbacks: [] });
    const { body } = buildSaveBody(base, next, "H", [
      "agents.defaults.model.fallbacks",
      "tools.list",
    ]);
    expect(body.replacePaths).toEqual([
      "agents.defaults.model.fallbacks",
      "tools.list",
    ]);
  });

  test("no edits means no payload at all", () => {
    const { body, diff } = buildSaveBody(base, JSON.parse(JSON.stringify(base)), "H");
    expect(diff.changed).toBe(false);
    expect(body.patch).toEqual({});
  });
});

/* ── 2. Path helpers ────────────────────────────────────────────────── */

test.describe("dotted path helpers", () => {
  test("setAtPath does not mutate the snapshot", () => {
    const base = { a: { b: 1 } };
    const next = setAtPath(base, "a.b", 2);
    expect(base.a.b).toBe(1);
    expect(next).toEqual({ a: { b: 2 } });
  });

  test("setAtPath creates intermediate objects", () => {
    expect(setAtPath({}, "cron.jobs.enabled", true)).toEqual({
      cron: { jobs: { enabled: true } },
    });
  });

  test("deleteAtPath really removes the key, it does not set undefined", () => {
    const next = deleteAtPath({ a: { b: 1, c: 2 } }, "a.b");
    expect("b" in (next.a as Record<string, unknown>)).toBe(false);
    expect(next).toEqual({ a: { c: 2 } });
  });

  test("deleting a missing path is a no-op that keeps identity", () => {
    const base = { a: { b: 1 } };
    expect(deleteAtPath(base, "a.zzz")).toBe(base);
    expect(deleteAtPath(base, "nope.deep")).toBe(base);
  });

  test("getAtPath returns undefined rather than throwing on a missing branch", () => {
    expect(getAtPath({ a: 1 }, "a.b.c")).toBeUndefined();
    expect(getAtPath({ a: { b: { c: 7 } } }, "a.b.c")).toBe(7);
  });
});

/* ── 3. Diff preview rows ───────────────────────────────────────────── */

test.describe("diff preview rows", () => {
  const base = {
    gateway: { port: 18789, bind: "loopback" },
    env: { OPENAI_API_KEY: "sk-real-secret-value" },
    wizard: { lastRunVersion: "1.0" },
  };

  test("classifies added / changed / removed and puts removals first", () => {
    let next = setAtPath(base, "gateway.port", 1234);
    next = setAtPath(next, "gateway.newKey", "hello");
    next = deleteAtPath(next, "wizard.lastRunVersion");
    const diff = buildConfigDiff(base, next);
    const rows = describeChanges(base, next, diff, {
      hints: {},
      envSubstituted: [],
      lookup: noLookups,
    });

    expect(rows.map((r) => `${r.kind} ${r.path}`)).toEqual([
      "removed wizard.lastRunVersion",
      "changed gateway.port",
      "added gateway.newKey",
    ]);
    const port = rows.find((r) => r.path === "gateway.port")!;
    expect(port.before).toBe(18789);
    expect(port.after).toBe(1234);
    const removed = rows[0];
    expect(removed.before).toBe("1.0");
    expect(removed.after).toBeUndefined();
  });

  test("secret paths are flagged so the preview masks them by default", () => {
    const next = setAtPath(base, "env.OPENAI_API_KEY", "sk-new-secret");
    const rows = describeChanges(base, next, buildConfigDiff(base, next), {
      hints: {},
      envSubstituted: [],
      lookup: noLookups,
    });
    expect(rows[0].sensitive).toBe(true);
    // …and a plain path is not over-masked.
    const other = setAtPath(base, "gateway.bind", "lan");
    const otherRows = describeChanges(base, other, buildConfigDiff(base, other), {
      hints: {},
      envSubstituted: [],
      lookup: noLookups,
    });
    expect(otherRows[0].sensitive).toBe(false);
  });

  test("reload kind and replacePaths reach the row", () => {
    const next = setAtPath(base, "gateway.port", 9);
    const rows = describeChanges(base, next, buildConfigDiff(base, next), {
      hints: {},
      envSubstituted: [],
      lookup: (path) =>
        path === "gateway.port"
          ? lookup({ path, reloadKind: "restart", reloadKindSource: "gateway" })
          : null,
    });
    expect(rows[0].reloadKind).toBe("restart");
    expect(rows[0].reloadKindInferred).toBe(false);
  });

  test("a shrinking list row is marked as removing entries", () => {
    const listBase = { agents: { list: [{ id: "a" }, { id: "b" }] } };
    const listNext = { agents: { list: [{ id: "a" }] } };
    const diff = buildConfigDiff(listBase, listNext);
    const rows = describeChanges(listBase, listNext, diff, {
      hints: {},
      envSubstituted: [],
      lookup: noLookups,
    });
    expect(diff.replacePaths).toContain("agents.list");
    expect(rows[0].replaceConfirm).toBe(true);
  });
});

/* ── 4. Restart planning ────────────────────────────────────────────── */

test.describe("restart planning", () => {
  const rowFor = (path: string, reloadKind: "restart" | "hot" | "none" | null, source?: "gateway" | "matrix") => {
    const base = { [path.split(".")[0]]: {} };
    const next = setAtPath(base, path, "x");
    return describeChanges(base, next, buildConfigDiff(base, next), {
      hints: {},
      envSubstituted: [],
      lookup: () => (reloadKind === null ? null : lookup({ path, reloadKind, reloadKindSource: source ?? "gateway" })),
    });
  };

  test("only reloadKind:restart forces a restart", () => {
    expect(planRestart(rowFor("gateway.port", "restart")).required).toBe(true);
    expect(planRestart(rowFor("channels.telegram.enabled", "hot")).required).toBe(false);
    expect(planRestart(rowFor("ui.theme", "none")).required).toBe(false);
  });

  test("an unlooked-up path is reported as unknown, never assumed safe", () => {
    const plan = planRestart(rowFor("cron.jobs", null));
    expect(plan.required).toBe(false);
    expect(plan.unknownPaths).toEqual(["cron.jobs"]);
  });

  test("a matrix-derived verdict is marked inferred so the UI can hedge", () => {
    const plan = planRestart(rowFor("gateway.bind", "restart", "matrix"));
    expect(plan.required).toBe(true);
    expect(plan.inferred).toBe(true);
  });
});

/* ── 5. The auth-token mint must never be invisible ─────────────────── */

test.describe("gateway.auth.mode token mint", () => {
  test("switching to token with no token warns", () => {
    const base = { gateway: { auth: { mode: "none" } } };
    const next = { gateway: { auth: { mode: "token" } } };
    expect(detectAuthTokenMint(base, next)).toBe(true);
  });

  test("switching to token while supplying one does not warn", () => {
    const base = { gateway: { auth: { mode: "none" } } };
    const next = { gateway: { auth: { mode: "token", token: "my-own-token" } } };
    expect(detectAuthTokenMint(base, next)).toBe(false);
  });

  test("already in token mode with a token is quiet", () => {
    const doc = { gateway: { auth: { mode: "token", token: "abc" } } };
    expect(detectAuthTokenMint(doc, doc)).toBe(false);
  });

  test("clearing the token while staying in token mode warns", () => {
    const base = { gateway: { auth: { mode: "token", token: "abc" } } };
    const next = { gateway: { auth: { mode: "token" } } };
    expect(detectAuthTokenMint(base, next)).toBe(true);
  });

  test("any other mode is quiet", () => {
    expect(
      detectAuthTokenMint(
        { gateway: { auth: { mode: "token", token: "x" } } },
        { gateway: { auth: { mode: "none" } } }
      )
    ).toBe(false);
  });
});

/* ── 6. Conflict analysis + rebase ──────────────────────────────────── */

test.describe("409 conflict handling", () => {
  const base = { gateway: { port: 1, bind: "loopback" }, session: { dmScope: "a" } };

  test("separates contested, theirs-only and mine-only paths", () => {
    const mine = { gateway: { port: 2, bind: "loopback" }, session: { dmScope: "a" } };
    const theirs = { gateway: { port: 3, bind: "lan" }, session: { dmScope: "a" } };
    const analysis = analyzeConflict(base, mine, theirs);
    expect(analysis.contested).toEqual(["gateway.port"]);
    expect(analysis.theirs).toEqual(["gateway.bind"]);
    expect(analysis.mine).toEqual([]);
    expect(analysis.overlaps).toBe(true);
  });

  test("non-overlapping edits are reported as safe to rebase", () => {
    const mine = { gateway: { port: 2, bind: "loopback" }, session: { dmScope: "a" } };
    const theirs = { gateway: { port: 1, bind: "lan" }, session: { dmScope: "a" } };
    const analysis = analyzeConflict(base, mine, theirs);
    expect(analysis.overlaps).toBe(false);
    expect(analysis.contested).toEqual([]);
    expect(analysis.mine).toEqual(["gateway.port"]);
    expect(analysis.theirs).toEqual(["gateway.bind"]);
  });

  test("rebase keeps their untouched edits and re-applies mine on top", () => {
    const mine = { gateway: { port: 2, bind: "loopback" }, session: { dmScope: "a" } };
    const theirs = { gateway: { port: 1, bind: "lan" }, session: { dmScope: "b" } };
    // Exactly what the dialog's "Re-apply mine on top" does.
    const rebased = applyMergePatch(theirs, buildConfigDiff(base, mine).patch);
    expect(rebased).toEqual({
      gateway: { port: 2, bind: "lan" },
      session: { dmScope: "b" },
    });
    // The retry is then a minimal diff against THEIR document, not against the
    // stale snapshot — so it cannot resurrect values they deleted.
    const retry = buildConfigDiff(theirs, rebased);
    expect(retry.patch).toEqual({ gateway: { port: 2 } });
  });

  test("a delete survives the rebase", () => {
    const mine = deleteAtPath(base, "session");
    const theirs = { gateway: { port: 1, bind: "lan" }, session: { dmScope: "a" } };
    const rebased = applyMergePatch(theirs, buildConfigDiff(base, mine).patch) as Record<
      string,
      unknown
    >;
    expect("session" in rebased).toBe(false);
  });
});

/* ── 7. Validation, using the same validator the fields use ─────────── */

test.describe("client-side validation gate", () => {
  const portLookup = lookup({
    path: "gateway.port",
    type: "integer",
    types: ["integer"],
    exclusiveMinimum: 0,
    title: "Gateway Port",
  });

  test("a bad port is rejected with end-user prose", () => {
    const result = validateConfigValue(portLookup, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("Gateway Port");
  });

  test("a string in an integer field is rejected", () => {
    expect(validateConfigValue(portLookup, "18789").ok).toBe(false);
  });

  test("a good value passes", () => {
    expect(validateConfigValue(portLookup, 18789)).toEqual({ ok: true });
  });

  test("an enum field only accepts its options", () => {
    const modeLookup = lookup({
      path: "gateway.auth.mode",
      types: ["string"],
      enum: ["none", "token", "password", "trusted-proxy"],
      title: "Gateway Auth Mode",
    });
    expect(validateConfigValue(modeLookup, "token")).toEqual({ ok: true });
    const bad = validateConfigValue(modeLookup, "tokn");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain("none, token, password, trusted-proxy");
  });

  test("deleting a required field is caught before the write leaves the browser", () => {
    const required = lookup({ path: "gateway.port", required: true, title: "Gateway Port" });
    const result = validateConfigValue(required, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("required");
  });

  test("an unknown or degraded path never invents a failure", () => {
    expect(validateConfigValue(null, "anything")).toEqual({ ok: true });
    expect(validateConfigValue(lookup({ degraded: true, required: true }), undefined)).toEqual({
      ok: true,
    });
  });

  test("the gate blocks exactly the changed paths that fail", () => {
    const base = { gateway: { port: 18789, bind: "loopback" } };
    const next = setAtPath(base, "gateway.port", -1);
    const diff = buildConfigDiff(base, next);
    const problems = diff.changedPaths
      .map((path) => ({
        path,
        check: validateConfigValue(path === "gateway.port" ? portLookup : null, getAtPath(next, path)),
      }))
      .filter((entry) => !entry.check.ok);
    expect(problems.map((p) => p.path)).toEqual(["gateway.port"]);
  });
});

/* ── 8. Env indirection + secret classification ─────────────────────── */

test.describe("env-substituted values", () => {
  const paths = ["env.OPENAI_API_KEY", "tools.media.models[0].command"];

  test("matches the exact path", () => {
    expect(isEnvSubstitutedPath(paths, "env.OPENAI_API_KEY")).toBe(true);
  });

  test("an indexed leaf marks its parent array field", () => {
    expect(isEnvSubstitutedPath(paths, "tools.media.models")).toBe(true);
  });

  test("unrelated paths are not marked", () => {
    expect(isEnvSubstitutedPath(paths, "gateway.port")).toBe(false);
    expect(isEnvSubstitutedPath([], "env.OPENAI_API_KEY")).toBe(false);
  });
});

test.describe("secret classification", () => {
  test("hint, section and key-name rules all mask", () => {
    expect(isSensitiveConfigPath({}, "env.ANYTHING")).toBe(true);
    expect(isSensitiveConfigPath({}, "gateway.auth.token")).toBe(true);
    expect(isSensitiveConfigPath({}, "channels.telegram.botToken")).toBe(true);
    expect(isSensitiveConfigPath({ "a.b": { sensitive: true } }, "a.b")).toBe(true);
    expect(isSensitiveConfigPath({}, "gateway.port")).toBe(false);
  });
});

/* ── 9. Search finds FIELDS, not just section cards ─────────────────── */

test.describe("field search", () => {
  const index = buildFieldIndex(
    { gateway: { port: 18789, auth: { mode: "token" } } },
    { cron: { properties: { jobs: {}, timezone: {} } } },
    { "gateway.port": { label: "Gateway Port" } }
  );

  test("indexes nested document fields, schema-only fields and hint paths", () => {
    const paths = index.map((e) => e.path);
    expect(paths).toContain("gateway.port");
    expect(paths).toContain("gateway.auth.mode");
    // cron does not exist on disk, but the schema declares it — findable anyway.
    expect(paths).toContain("cron.jobs");
  });

  test("a query finds the field and names its section for the jump", () => {
    const hits = searchFields(index, "port");
    expect(hits[0].path).toBe("gateway.port");
    expect(hits[0].section).toBe("gateway");
    expect(hits[0].label).toBe("Gateway Port");
  });

  test("a never-configured section's field is reachable from search", () => {
    expect(searchFields(index, "timezone")[0].path).toBe("cron.timezone");
  });

  test("an empty query returns nothing (the section list is unfiltered)", () => {
    expect(searchFields(index, "  ")).toEqual([]);
  });
});

/* ── 10. @live — the real gateway ───────────────────────────────────── */

type PatchResult = { status: number; body: Record<string, unknown> };

/** PATCH that waits out the control-plane 3-writes/60s budget. */
async function pacedPatch(
  request: APIRequestContext,
  body: Record<string, unknown>,
  attempt = 0
): Promise<PatchResult> {
  const res = await request.patch(`${LIVE_BASE}/api/config`, { data: body, timeout: 90_000 });
  const parsed = (await res.json()) as Record<string, unknown>;
  if (res.status() === 429 && attempt < 3) {
    const wait = typeof parsed.retryAfterMs === "number" ? parsed.retryAfterMs : 20_000;
    await new Promise((resolve) => setTimeout(resolve, Math.min(wait + 1500, 65_000)));
    return pacedPatch(request, body, attempt + 1);
  }
  return { status: res.status(), body: parsed };
}

async function readConfig(request: APIRequestContext) {
  const res = await request.get(`${LIVE_BASE}/api/config`, { timeout: 60_000 });
  expect(res.status()).toBe(200);
  return (await res.json()) as {
    config: Record<string, unknown>;
    meta: Record<string, unknown>;
  };
}

test.describe("@live config editor write path", () => {
  test("@live GET /api/config serves the authoring surface the editor needs", async ({
    request,
  }) => {
    const { config, meta } = await readConfig(request);
    expect(typeof config).toBe("object");
    expect(["parsed", "resolved", "disk"]).toContain(meta.configSource);
    expect(Array.isArray(meta.envSubstituted)).toBe(true);
    expect(typeof meta.baseHash).toBe("string");
    // A `parsed` surface is what keeps `${VAR}` from being baked into its
    // expansion on the first save.
    if (!meta.degraded) expect(meta.configSource).toBe("parsed");
  });

  test("@live per-path lookups drive the restart warning", async ({ request }) => {
    const res = await request.get(
      `${LIVE_BASE}/api/config/lookup?paths=gateway.port,gateway.auth.mode,session.dmScope`,
      { timeout: 60_000 }
    );
    expect(res.status()).toBe(200);
    const data = (await res.json()) as {
      results: Record<string, NormalizedConfigLookup | null>;
    };
    const port = data.results["gateway.port"];
    expect(port).not.toBeNull();
    expect(port!.reloadKind).toBe("restart");
    // …and that is exactly what planRestart turns into the preview warning.
    const base = { gateway: { port: 18789 } };
    const next = { gateway: { port: 18999 } };
    const rows = describeChanges(base, next, buildConfigDiff(base, next), {
      hints: {},
      envSubstituted: [],
      lookup: (p) => data.results[p] ?? null,
    });
    expect(planRestart(rows).required).toBe(true);
    expect(planRestart(rows).paths).toEqual(["gateway.port"]);
  });

  test("@live a minimal patch writes, a null really deletes, and the value is restored", async ({
    request,
  }) => {
    test.setTimeout(400_000);
    const SCRATCH = "wizard.lastRunVersion";

    const before = await readConfig(request);
    const original = getAtPath(before.config, SCRATCH);
    const originalWizard = before.config.wizard;
    test.skip(
      typeof original !== "string",
      "wizard.lastRunVersion is the designated scratch key and is not set here"
    );

    // 1. Edit it through the editor's own payload builder.
    const edited = setAtPath(before.config, SCRATCH, "mc-config-editor-spec");
    const write = buildSaveBody(before.config, edited, String(before.meta.baseHash));
    expect(write.body.patch).toEqual({ wizard: { lastRunVersion: "mc-config-editor-spec" } });

    const first = await pacedPatch(request, write.body as unknown as Record<string, unknown>);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(typeof first.body.hash).toBe("string");
    // Most fields hot-apply; the editor must not restart the gateway for this.
    expect(first.body.restartRequired).toBe(false);

    const afterWrite = await readConfig(request);
    expect(getAtPath(afterWrite.config, SCRATCH)).toBe("mc-config-editor-spec");

    // 2. Delete it — the flow that used to be a silent no-op.
    const deleted = deleteAtPath(afterWrite.config, SCRATCH);
    const del = buildSaveBody(afterWrite.config, deleted, String(afterWrite.meta.baseHash));
    expect(del.body.patch).toEqual({ wizard: { lastRunVersion: null } });

    const second = await pacedPatch(request, del.body as unknown as Record<string, unknown>);
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.deletedPaths).toEqual([SCRATCH]);

    const afterDelete = await readConfig(request);
    expect(getAtPath(afterDelete.config, SCRATCH)).toBeUndefined();

    // 3. Restore the original value and prove the section is byte-identical.
    const restored = setAtPath(afterDelete.config, SCRATCH, original as string);
    const restore = buildSaveBody(
      afterDelete.config,
      restored,
      String(afterDelete.meta.baseHash)
    );
    const third = await pacedPatch(request, restore.body as unknown as Record<string, unknown>);
    expect(third.status, JSON.stringify(third.body)).toBe(200);

    const final = await readConfig(request);
    expect(getAtPath(final.config, SCRATCH)).toBe(original);
    expect(final.config.wizard).toEqual(originalWizard);
  });

  test("@live a stale base hash answers 409 with the remote document, never a clobber", async ({
    request,
  }) => {
    test.setTimeout(200_000);
    const { config } = await readConfig(request);
    const result = await pacedPatch(request, {
      patch: { wizard: { lastRunVersion: "mc-conflict-spec-should-not-land" } },
      baseHash: "0".repeat(64),
    });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe("conflict");
    expect(typeof result.body.currentHash).toBe("string");
    expect(String(result.body.currentHash).length).toBeGreaterThan(0);
    expect(result.body.remoteConfig).toBeTruthy();

    // The write must not have happened.
    const after = await readConfig(request);
    expect(getAtPath(after.config, "wizard.lastRunVersion")).toBe(
      getAtPath(config, "wizard.lastRunVersion")
    );

    // And the dialog's analysis works on the real payload.
    const remote = result.body.remoteConfig as Record<string, unknown>;
    const mine = setAtPath(config, "wizard.lastRunVersion", "mine");
    const analysis = analyzeConflict(config, mine, remote);
    expect(Array.isArray(analysis.contested)).toBe(true);
  });

  test("@live the doctor endpoint answers the shape the post-save panel renders", async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const res = await request.post(`${LIVE_BASE}/api/config/doctor`, {
      data: { fast: true },
      timeout: 150_000,
    });
    expect(res.status()).toBe(200);
    const report = (await res.json()) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
      summary: { ok: number; warn: number; fail: number };
      ranAt: number;
      retryAfterMs: number;
    };
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.ok).toBe(report.summary.fail === 0);
    expect(typeof report.ranAt).toBe("number");
    expect(typeof report.retryAfterMs).toBe("number");
    for (const check of report.checks) {
      expect(["ok", "warn", "fail"]).toContain(check.status);
      expect(check.name.length).toBeGreaterThan(0);
    }
  });
});

/* ── 11. @live browser — the parts only a DOM can prove ─────────────── */

// @ui puts these in the LIVE_UI project: they are the only tests in the repo
// that drive a real browser, so they are the only ones needing a Chromium
// download (`npm run test:install`). See playwright.config.ts.
test.describe("@live @ui config editor UI", () => {
  test("@live the diff preview lists the exact change and Save is gated", async ({ page }) => {
    test.setTimeout(180_000);
    // A fresh browser profile triggers the first-run dashboard tour, whose
    // full-screen scrim swallows every click. Mark it done before the app boots.
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("mc-dashboard-tour-done-v1", "1");
      } catch {
        /* storage unavailable — the tour scrim is handled below */
      }
    });
    await page.goto(`${LIVE_BASE}/config`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Search settings")).toBeVisible({ timeout: 60_000 });

    // Jump to a known scalar field through the FIELD search (not just sections).
    await page.getByLabel("Search settings").fill("dmScope");
    const firstResult = page.getByTestId("field-search-result").first();
    await expect(firstResult).toBeVisible({ timeout: 30_000 });
    await firstResult.click();

    const field = page.locator('[data-config-path="session.dmScope"]');
    await expect(field).toBeVisible({ timeout: 30_000 });

    // Make a real edit through whatever control the schema produced: a text
    // input, a <select>, or (for a short enum) the option buttons. The option
    // buttons are the ones without an aria-label — the remove button has one —
    // and the selected option is the emerald-tinted one.
    await field.scrollIntoViewIfNeeded();
    const textInput = field.locator('input[type="text"], input[type="number"]');
    const select = field.locator("select");
    const unselectedOption = field.locator(
      'button:not([aria-label]):not([class*="emerald"])'
    );

    if ((await textInput.count()) > 0) {
      await textInput.first().fill("mc-config-editor-spec");
    } else if ((await select.count()) > 0) {
      const control = select.first();
      const current = await control.inputValue();
      const values = await control.locator("option").evaluateAll((nodes) =>
        nodes.map((n) => (n as HTMLOptionElement).value)
      );
      const other = values.find((v) => v && v !== current);
      if (other) await control.selectOption(other);
    } else {
      await unselectedOption.first().click();
    }

    await page.getByTestId("config-review-save").click();
    const rows = page.getByTestId("config-diff-row");
    await expect(rows).toHaveCount(1, { timeout: 20_000 });
    await expect(rows.first()).toHaveAttribute("data-change-path", "session.dmScope");
    await expect(rows.first()).toHaveAttribute("data-change-kind", "changed");

    // Back out — nothing is written unless the operator confirms.
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page.getByTestId("config-diff-row")).toHaveCount(0);
  });

  test("@live an invalid value blocks the save", async ({ page }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("mc-dashboard-tour-done-v1", "1");
      } catch {
        /* storage unavailable */
      }
    });
    await page.goto(`${LIVE_BASE}/config`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Search settings")).toBeVisible({ timeout: 60_000 });

    await page.getByLabel("Search settings").fill("gateway.port");
    const result = page.getByTestId("field-search-result").first();
    await expect(result).toBeVisible({ timeout: 30_000 });
    await result.click();

    const field = page.locator('[data-config-path="gateway.port"]');
    await expect(field).toBeVisible({ timeout: 30_000 });
    // The gateway's schema says exclusiveMinimum: 0, so 0 is a real violation.
    await field.locator('input[type="number"]').first().fill("0");

    await expect(field.getByTestId("field-error")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("config-review-save")).toBeDisabled();
    await expect(page.getByTestId("config-jump-to-error")).toBeVisible();
    // …and no preview opened, so nothing could have been written.
    await expect(page.getByTestId("config-diff-row")).toHaveCount(0);

    // The restart warning must be inline on the field: gateway.port is
    // reloadKind "restart" straight from config.schema.lookup.
    await expect(field.getByText("restarts gateway")).toBeVisible();
  });
});
