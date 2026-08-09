/**
 * Post-save config health check — POST /api/config/doctor.
 *
 * 1. Parser unit tests (no gateway, no server): the normalizer is fed real
 *    captured `openclaw doctor --lint --json` output from OpenClaw v2026.7.1-2
 *    and the documented human-text format, and must produce a report whose
 *    `summary` counts can never disagree with its `checks` list.
 * 2. @live: the endpoint against a throwaway `next dev` on :3193 and the real
 *    OpenClaw CLI — shape, summary/checks agreement, the cached rate-limit
 *    path, and the timeout fallback that degrades to the gateway `health` RPC
 *    instead of hanging.
 *
 * The live tests spawn their own server (src copied, node_modules/config
 * symlinked — same sandbox trick as auth.spec.ts) rather than using the shared
 * :3100 service, because this route is new and the shared service is a
 * production build that is not rebuilt on every edit. Set MC_DOCTOR_BASE_URL
 * to point them at an already-running server instead.
 */

import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseDoctorLintJson,
  normalizeLintPayload,
  normalizeDoctorText,
  friendlyCheckName,
  runDoctorReport,
  type DoctorCheck,
} from "../src/lib/doctor-report";

const PORT = 3193;
const OWN_BASE = `http://127.0.0.1:${PORT}`;
const EXTERNAL_BASE = process.env.MC_DOCTOR_BASE_URL || "";
const BASE = EXTERNAL_BASE || OWN_BASE;
const REPO_ROOT = path.resolve(__dirname, "..");
const STARTUP_TIMEOUT_MS = 180_000;

/** Rate-limit window in src/app/api/config/doctor/route.ts. */
const MIN_INTERVAL_MS = 10_000;

/* ── Fixtures: real output captured from OpenClaw v2026.7.1-2 ──────────── */

/**
 * Verbatim stdout of:
 *   openclaw doctor --lint --json --non-interactive
 * on the live machine (2026-08-09). Note the security check emits four
 * findings that are really one problem plus its explanation — that grouping is
 * exactly what the normalizer has to get right.
 */
const LINT_JSON_FIXTURE = `{"ok":false,"checksRun":24,"checksSkipped":27,"findings":[{"checkId":"core/doctor/legacy-state","severity":"warning","message":"Plugin install index: /Users/clawbert/.openclaw/plugins/installs.json → shared SQLite state","path":"/Users/clawbert/.openclaw","fixHint":"Run \`openclaw doctor --fix\` to migrate legacy state."},{"checkId":"core/doctor/security","severity":"warning","message":"WARNING: openclaw.json contains plaintext secret-bearing config fields."},{"checkId":"core/doctor/security","severity":"warning","message":"Paths: gateway.auth.token, messages.tts.providers.elevenlabs.apiKey, channels.telegram.botToken"},{"checkId":"core/doctor/security","severity":"warning","message":"Agents or workspace tools that can read config files may see these API keys/tokens."},{"checkId":"core/doctor/security","severity":"warning","message":"Migrate them to SecretRefs with openclaw secrets configure or openclaw secrets apply, then verify with openclaw secrets audit --check."}]}`;

/** Verbatim stdout of the same command with `--all` (51 checks, no skips). */
const LINT_JSON_ALL_FIXTURE = `{"ok":false,"checksRun":51,"checksSkipped":0,"findings":[{"checkId":"core/doctor/configured-plugin-installs","severity":"warning","message":"Configured runtime plugin codex is older than this OpenClaw version.","path":"/Users/clawbert/.openclaw/npm/projects/openclaw-codex-8902d781d4__openclaw-generation__g-49fd4dbfde2c5057/node_modules/@openclaw/codex","target":"codex","fixHint":"Run \`openclaw doctor --fix\` to refresh the configured runtime plugin."},{"checkId":"core/doctor/legacy-state","severity":"warning","message":"Plugin install index: /Users/clawbert/.openclaw/plugins/installs.json → shared SQLite state","path":"/Users/clawbert/.openclaw","fixHint":"Run \`openclaw doctor --fix\` to migrate legacy state."}]}`;

/** A clean machine: no findings at all. */
const LINT_JSON_CLEAN_FIXTURE = `{"ok":true,"checksRun":24,"checksSkipped":27,"findings":[]}`;

/**
 * The CLI happily prepends banner boxes to other commands' output (`gateway
 * call` does it on every invocation on this machine), so the parser has to
 * survive a preamble rather than assuming stdout starts with `{`.
 */
const LINT_JSON_WITH_BANNER_FIXTURE = `│
◇  Doctor notices ───────────────────────────────────────────────────────╮
│                                                                        │
│  - Left plugin install index in place because shared SQLite state has  │
│    conflicting plugin install metadata for: codex                      │
│                                                                        │
├────────────────────────────────────────────────────────────────────────╯
${LINT_JSON_CLEAN_FIXTURE}`;

/** Human lint output, per docs/cli/doctor.md, plus a line of the known noise. */
const LINT_TEXT_FIXTURE = [
  "doctor --lint: ran 6 check(s), 1 finding(s)",
  "  [warning] core/doctor/gateway-config gateway.mode - gateway.mode is unset; gateway start will be blocked.",
  "    fix: Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
  "  [warning] Left plugin install index in place because shared SQLite state has conflicting plugin install metadata for: codex",
].join("\n");

/* ── Shared invariant ──────────────────────────────────────────────────── */

type ReportLike = {
  ok: boolean;
  ranAt: number;
  source: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
};

/**
 * The whole point of the normalized report: a caller can trust the counts.
 * If these ever drift, the UI shows "2 problems" next to a list of one.
 */
function expectWellFormed(report: ReportLike) {
  expect(["json", "text", "rpc"]).toContain(report.source);
  expect(typeof report.ok).toBe("boolean");
  expect(report.ranAt).toBeGreaterThan(1_700_000_000_000);
  expect(Array.isArray(report.checks)).toBe(true);
  expect(report.checks.length).toBeGreaterThan(0);

  const counted = { ok: 0, warn: 0, fail: 0 };
  for (const check of report.checks) {
    expect(typeof check.name).toBe("string");
    expect(check.name.length).toBeGreaterThan(0);
    expect(["ok", "warn", "fail"]).toContain(check.status);
    if (check.id !== undefined) expect(typeof check.id).toBe("string");
    if (check.message !== undefined) expect(typeof check.message).toBe("string");
    counted[check.status] += 1;
  }
  expect(report.summary).toEqual(counted);
  expect(report.ok).toBe(report.summary.fail === 0);
}

/* ── 1. Parser unit tests ──────────────────────────────────────────────── */

test.describe("doctor-report parser", () => {
  test("parses the real --lint --json envelope", () => {
    const payload = parseDoctorLintJson(LINT_JSON_FIXTURE);
    expect(payload).not.toBeNull();
    expect(payload!.ok).toBe(false);
    expect(payload!.checksRun).toBe(24);
    expect(payload!.checksSkipped).toBe(27);
    expect(payload!.findings).toHaveLength(5);
  });

  test("parses an envelope hidden behind a CLI banner box", () => {
    const payload = parseDoctorLintJson(LINT_JSON_WITH_BANNER_FIXTURE);
    expect(payload).not.toBeNull();
    expect(payload!.checksRun).toBe(24);
    expect(payload!.findings).toEqual([]);
  });

  test("returns null for output with no envelope", () => {
    expect(parseDoctorLintJson("")).toBeNull();
    expect(parseDoctorLintJson("openclaw: command failed\n")).toBeNull();
    expect(parseDoctorLintJson('{"unrelated":true}')).toBeNull();
    expect(parseDoctorLintJson('{"findings": [ broken')).toBeNull();
  });

  test("groups the four security findings into one check and keeps the fix hint", () => {
    const { checks } = normalizeLintPayload(parseDoctorLintJson(LINT_JSON_FIXTURE)!);
    const security = checks.filter((c) => c.id === "core/doctor/security");
    expect(security).toHaveLength(1);
    expect(security[0].status).toBe("warn");
    expect(security[0].name).toBe("Secrets stored in plain text");
    // All four message lines survive, newline-joined.
    expect(security[0].message!.split("\n")).toHaveLength(4);
    expect(security[0].message).toContain("plaintext secret-bearing config fields");
    expect(security[0].message).toContain("channels.telegram.botToken");
  });

  test("filters the benign plugin-install-index notice out of checks but not out of sight", () => {
    const { checks, filtered } = normalizeLintPayload(parseDoctorLintJson(LINT_JSON_FIXTURE)!);
    expect(checks.some((c) => c.id === "core/doctor/legacy-state")).toBe(false);
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe("plugin-install-index");
    expect(filtered[0].checkId).toBe("core/doctor/legacy-state");
    expect(filtered[0].reason).toContain("cosmetic");
  });

  test("filters the stale-runtime-plugin notice from an --all run", () => {
    const { checks, filtered } = normalizeLintPayload(parseDoctorLintJson(LINT_JSON_ALL_FIXTURE)!);
    expect(filtered.map((f) => f.id).sort()).toEqual(["plugin-install-index", "plugin-version-drift"]);
    // Everything real was noise, so only the synthetic completion check is left.
    expect(checks).toHaveLength(1);
    expect(checks[0].id).toBe("mission-control/doctor/completed");
    expect(checks[0].name).toBe("All health checks passed");
  });

  test("never filters an error-severity finding, however it reads", () => {
    const { checks, filtered } = normalizeLintPayload({
      ok: false,
      checksRun: 24,
      checksSkipped: 27,
      findings: [
        {
          checkId: "core/doctor/legacy-state",
          severity: "error",
          message: "Plugin install index is corrupt and blocks startup.",
        },
      ],
    });
    expect(filtered).toEqual([]);
    const failing = checks.find((c) => c.status === "fail");
    expect(failing?.id).toBe("core/doctor/legacy-state");
  });

  test("a clean run still reports that something ran", () => {
    const { checks, filtered } = normalizeLintPayload(parseDoctorLintJson(LINT_JSON_CLEAN_FIXTURE)!);
    expect(filtered).toEqual([]);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe("ok");
    expect(checks[0].message).toBe("Ran 24 checks, skipped 27 optional checks.");
  });

  test("summary always agrees with checks, on every fixture", () => {
    for (const fixture of [LINT_JSON_FIXTURE, LINT_JSON_ALL_FIXTURE, LINT_JSON_CLEAN_FIXTURE]) {
      const { checks } = normalizeLintPayload(parseDoctorLintJson(fixture)!);
      const summary = checks.reduce(
        (acc, c) => ({ ...acc, [c.status]: acc[c.status] + 1 }),
        { ok: 0, warn: 0, fail: 0 } as { ok: number; warn: number; fail: number },
      );
      expectWellFormed({
        ok: summary.fail === 0,
        ranAt: Date.now(),
        source: "json",
        checks,
        summary,
      });
    }
  });

  test("worst status sorts first", () => {
    const { checks } = normalizeLintPayload({
      checksRun: 3,
      findings: [
        { checkId: "a/b/warn-check", severity: "warning", message: "a warning" },
        { checkId: "a/b/fail-check", severity: "error", message: "a failure" },
      ],
    });
    expect(checks.map((c) => c.status)).toEqual(["fail", "warn", "ok"]);
  });

  test("falls back to the human-text classifier, noise filter included", () => {
    const { checks, filtered } = normalizeDoctorText(LINT_TEXT_FIXTURE);
    expect(filtered.map((f) => f.id)).toEqual(["plugin-install-index"]);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.name.length > 0)).toBe(true);
    expect(checks.some((c) => /gateway\.mode/.test(c.message ?? ""))).toBe(true);
  });

  test("unknown check ids still read as a sentence", () => {
    expect(friendlyCheckName("core/doctor/security")).toBe("Secrets stored in plain text");
    expect(friendlyCheckName("plugin/acme/some-new-check")).toBe("Some new check");
    expect(friendlyCheckName("bare_id")).toBe("Bare id");
  });
});

/* ── 2. Live endpoint ──────────────────────────────────────────────────── */

let sandboxDir = "";
let server: ChildProcess | null = null;

function prepareSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-config-doctor-spec-"));
  const symlinked = [
    "node_modules",
    "public",
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "components.json",
    "next-env.d.ts",
    "instrumentation.ts",
  ];
  for (const entry of symlinked) {
    const target = path.join(REPO_ROOT, entry);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(dir, entry));
  }
  // src must be a real copy — Next's route discovery skips symlinked app dirs.
  fs.cpSync(path.join(REPO_ROOT, "src"), path.join(dir, "src"), { recursive: true });
  return dir;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function startServer() {
  sandboxDir = prepareSandbox();
  const nextBin = path.join(REPO_ROOT, "node_modules", ".bin", "next");
  server = spawn(nextBin, ["dev", "-H", "127.0.0.1", "-p", String(PORT), "--webpack"], {
    cwd: sandboxDir,
    env: process.env,
    stdio: "ignore",
    detached: true,
  });
  await waitFor(
    async () => {
      const res = await fetch(`${OWN_BASE}/api/auth/status`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    },
    STARTUP_TIMEOUT_MS,
    `next dev on :${PORT}`,
  );
}

async function stopServer() {
  const proc = server;
  server = null;
  if (proc?.pid) {
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      setTimeout(resolve, 10_000);
    });
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await exited;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  if (sandboxDir) {
    fs.rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    sandboxDir = "";
  }
}

type DoctorResponse = ReportLike & {
  cached: boolean;
  retryAfterMs: number;
  fast: boolean;
  partial: boolean;
  timedOut: boolean;
  durationMs: number;
  filtered: { id: string; checkId: string; message: string; reason: string }[];
  raw?: string;
};

async function postDoctor(body?: unknown): Promise<DoctorResponse> {
  const res = await fetch(`${BASE}/api/config/doctor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as DoctorResponse;
}

test.describe("POST /api/config/doctor @live", () => {
  test.beforeAll(async () => {
    // A hook inherits the 90s test timeout from playwright.config.ts, but a
    // cold `next dev --webpack` compile in a fresh sandbox routinely needs
    // longer than that. Give the hook the budget startServer() already waits.
    test.setTimeout(STARTUP_TIMEOUT_MS + 60_000);
    if (!EXTERNAL_BASE) await startServer();
  });

  test.afterAll(async () => {
    // stopServer() allows the child 10s to exit, then rm -rf's the sandbox.
    test.setTimeout(60_000);
    if (!EXTERNAL_BASE) await stopServer();
  });

  test("returns a well-formed report from the real machine", async () => {
    const report = await postDoctor({});
    expectWellFormed(report);

    // The structured source must be what actually answered — this endpoint
    // exists precisely so nobody regexes human text when JSON is available.
    expect(report.source).toBe("json");
    expect(report.partial).toBe(false);
    expect(report.timedOut).toBe(false);
    expect(report.fast).toBe(true);
    expect(report.cached).toBe(false);

    // Fast enough to sit behind a save button.
    expect(report.durationMs).toBeLessThan(15_000);

    // A completion check is always present, so an all-clear never renders as
    // an empty list.
    expect(report.checks.some((c) => c.id === "mission-control/doctor/completed")).toBe(true);

    // Filtered notices are reported, never silently dropped.
    expect(Array.isArray(report.filtered)).toBe(true);
    for (const notice of report.filtered) {
      expect(typeof notice.reason).toBe("string");
      expect(report.checks.some((c) => c.message?.includes(notice.message))).toBe(false);
    }

    // Raw doctor output is available for a details pane.
    expect(report.raw).toContain("checksRun");
  });

  test("a second call inside the rate-limit window returns the cached report", async () => {
    const first = await postDoctor({});
    const second = await postDoctor({});

    expectWellFormed(second);
    expect(second.cached).toBe(true);
    // Same run, byte for byte — not a second subprocess.
    expect(second.ranAt).toBe(first.ranAt);
    expect(second.durationMs).toBe(first.durationMs);
    expect(second.summary).toEqual(first.summary);
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(second.retryAfterMs).toBeLessThanOrEqual(MIN_INTERVAL_MS);
  });

  test("concurrent callers share one subprocess", async () => {
    // Let the previous test's window lapse so this really exercises
    // single-flight rather than the cache.
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS + 1_000));

    const results = await Promise.all([postDoctor({}), postDoctor({}), postDoctor({})]);
    for (const report of results) expectWellFormed(report);

    expect(new Set(results.map((r) => r.ranAt)).size).toBe(1);
    expect(results.filter((r) => !r.cached)).toHaveLength(1);
  });

  test("fast:false runs the full check inventory", async () => {
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS + 1_000));

    const report = await postDoctor({ fast: false });
    expectWellFormed(report);
    expect(report.cached).toBe(false);
    expect(report.fast).toBe(false);
    // `--all` skips nothing, so the completion check says so.
    const completed = report.checks.find((c) => c.id === "mission-control/doctor/completed");
    expect(completed?.message).not.toContain("skipped");
  });

  test("a missing body is not an error, and defaults to the fast check set", async () => {
    // The rate-limit window is global, so lapse it — otherwise the previous
    // test's `fast: false` report would legitimately be served back.
    await new Promise((resolve) => setTimeout(resolve, MIN_INTERVAL_MS + 1_000));

    const report = await postDoctor();
    expectWellFormed(report);
    expect(report.cached).toBe(false);
    expect(report.fast).toBe(true);
  });

  test("a starved budget degrades instead of hanging", async () => {
    // 1s is far below the ~4s a warm lint needs, so the subprocess is killed.
    const started = Date.now();
    const report = await runDoctorReport({ timeoutMs: 1_000 });
    const elapsed = Date.now() - started;

    expectWellFormed(report);
    expect(report.timedOut).toBe(true);
    expect(report.partial).toBe(true);
    expect(report.source).toBe("rpc");
    // Killed, plus the fallback — nowhere near a full lint.
    expect(elapsed).toBeLessThan(8_000);
    // Whatever happened, the user is told the check did not complete. Which of
    // the two degraded branches runs depends on whether the gateway answers:
    // under Playwright's loader the lazy `./openclaw` import can fail to
    // resolve, in which case this exercises the last-resort branch rather than
    // the RPC one. Both are verified live against the running app.
    expect(
      report.checks.some(
        (c) => c.id === "mission-control/doctor/partial" || c.id === "mission-control/doctor/unavailable",
      ),
    ).toBe(true);
    expect(report.ok).toBe(report.summary.fail === 0);
  });
});
