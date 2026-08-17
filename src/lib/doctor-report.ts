/**
 * Post-save health verification for the config editor.
 *
 * The user's standing rule is "always run `openclaw doctor` after editing
 * config", so a config write is only really finished once a health check has
 * confirmed the gateway still likes the file. This module is that check,
 * normalised into one small shape the UI can render without knowing anything
 * about doctor's output formats.
 *
 * ## Where the data comes from (probed against OpenClaw v2026.7.1-2)
 *
 * `openclaw doctor --lint --json` is a real machine-readable surface — no
 * regex-on-human-text needed. It is read-only (no prompts, no repair, no
 * config/state rewrites, per docs/cli/doctor.md) and emits:
 *
 *   {"ok":false,"checksRun":24,"checksSkipped":27,"findings":[
 *     {"checkId":"core/doctor/security","severity":"warning",
 *      "message":"...","path":"...","fixHint":"..."}]}
 *
 * Exit codes are `0` = no findings at/above the severity threshold, `1` = at
 * least one finding, `2` = the command failed before it could lint. So a
 * non-zero exit is *not* an error — only exit 2 (or unparseable stdout) is.
 *
 * There is no `--fast` / `--quick` flag on this build, and as of OpenClaw
 * 2026.6.9+ there is no `--all` either — the opt-in check split it used to
 * toggle is gone, and `--lint` always runs the full inventory now (verified:
 * checksSkipped: 0). Passing `--all` makes the CLI exit 2 before it lints
 * anything, so it is not sent. `fast` is kept as a parameter name for callers,
 * but no longer changes which checks run — only kept in case a future CLI
 * reintroduces a subset.
 *
 * ## Fallback ladder
 *
 *   1. `json` — `doctor --lint --json` parsed. The normal path.
 *   2. `text` — doctor ran but stdout was not JSON: reuse the human-text
 *      classifier in `doctor-checks.ts` rather than inventing a second one.
 *   3. `rpc`  — doctor could not run at all, or blew the time budget: fall
 *      back to the gateway `health` RPC (~20ms) so the user still gets a
 *      partial answer instead of a spinner. `partial` is set in that case.
 *
 * Nothing here throws: a health check that explodes must still report, because
 * "we could not verify your change" is itself the answer the user needs.
 */

import { spawn } from "child_process";
import { getOpenClawBin } from "./paths";
import { classifyDoctorOutput } from "./doctor-checks";

export type DoctorCheckStatus = "ok" | "warn" | "fail";

export type DoctorCheck = {
  /** Stable doctor check id (e.g. `core/doctor/security`) when one exists. */
  id?: string;
  /** Plain-English label safe to show to a non-technical user. */
  name: string;
  status: DoctorCheckStatus;
  /** One or more problem statements, newline-joined, with fix hints appended. */
  message?: string;
};

export type DoctorReportSource = "json" | "text" | "rpc";

/** A finding deliberately kept out of `checks`. Never silently dropped. */
export type DoctorFilteredNotice = {
  id: string;
  checkId: string;
  severity: string;
  message: string;
  /** Why this was demoted out of the actionable list. */
  reason: string;
};

export type DoctorReport = {
  /** True when no check has status `fail`. Warnings do not clear `ok`. */
  ok: boolean;
  ranAt: number;
  source: DoctorReportSource;
  checks: DoctorCheck[];
  /** Always derived from `checks`, so the counts and the list cannot disagree. */
  summary: { ok: number; warn: number; fail: number };
  raw?: string;
  /** Wall-clock cost of the run, for the "checked 2s ago" affordance. */
  durationMs: number;
  /** True when this is a degraded answer (RPC-only) rather than a full lint. */
  partial: boolean;
  /** True when the doctor subprocess blew its budget and was killed. */
  timedOut: boolean;
  /** Which check set ran: `true` = default lint set, `false` = `--all`. */
  fast: boolean;
  /** Cosmetic notices removed from `checks`, kept visible for transparency. */
  filtered: DoctorFilteredNotice[];
};

export type DoctorReportOptions = {
  /** `true` (default) = default lint set. `false` = `--all`, the full inventory. */
  fast?: boolean;
  /** Budget for the doctor subprocess. Defaults to {@link DOCTOR_TIMEOUT_MS}. */
  timeoutMs?: number;
};

/**
 * Budget for the `doctor --lint` subprocess.
 *
 * The check is interactive — it runs while the user is looking at a "Saved"
 * banner — so it may not hang. 10s covers a warm run (~4s) with room for a
 * cold plugin-loader start; past that the subprocess is killed and the far
 * cheaper `health` RPC answers instead, keeping the worst case near ~13s.
 */
export const DOCTOR_TIMEOUT_MS = 10_000;

/** Budget for the degraded `health` RPC fallback. */
const RPC_TIMEOUT_MS = 3_000;

/** `raw` is for a details/disclosure pane, not a log sink. */
const MAX_RAW_CHARS = 8_000;

/* ── Noise filtering ───────────────────────────────────────────────────── */

/**
 * Findings that are cosmetic residue rather than something the user did (or
 * can do) anything about from the config editor.
 *
 * The motivating case: this gateway emits "Left plugin install index in place
 * because shared SQLite state has conflicting plugin install metadata for:
 * codex" on nearly every CLI call, and surfaces the same residue through
 * `core/doctor/legacy-state`. Showing that next to "your config was saved"
 * teaches the user to ignore the health check, which is the one outcome worth
 * avoiding.
 *
 * Two safety rails:
 *   - matching is on the *message*, not the check id alone, so a genuine
 *     legacy-state problem still lands in `checks`;
 *   - `error` severity is never filtered, no matter what it matches.
 */
const NOISE_RULES: { id: string; reason: string; test: (checkId: string, message: string) => boolean }[] = [
  {
    id: "plugin-install-index",
    reason:
      "Known cosmetic residue: the plugin install index could not be folded into shared SQLite state. It does not affect the gateway or your config.",
    test: (_checkId, message) =>
      /plugin install index/i.test(message) ||
      /conflicting plugin install metadata/i.test(message),
  },
  {
    id: "plugin-version-drift",
    reason:
      "A bundled runtime plugin is older than the OpenClaw build. Cosmetic until that plugin is used; unrelated to config edits.",
    test: (checkId, message) =>
      checkId === "core/doctor/configured-plugin-installs" &&
      /older than this OpenClaw version/i.test(message),
  },
];

function matchNoise(checkId: string, severity: string, message: string) {
  if (severity === "error") return null;
  for (const rule of NOISE_RULES) {
    if (rule.test(checkId, message)) return rule;
  }
  return null;
}

/* ── Naming ────────────────────────────────────────────────────────────── */

const CHECK_NAMES: Record<string, string> = {
  "core/doctor/security": "Secrets stored in plain text",
  "core/doctor/legacy-state": "Legacy state migration",
  "core/doctor/gateway-config": "Gateway configuration",
  "core/doctor/configured-plugin-installs": "Runtime plugin versions",
  "core/doctor/skills-readiness": "Skills readiness",
  "core/doctor/session-locks": "Session locks",
};

/**
 * Turn `core/doctor/gateway-config` into "Gateway config" when the id is not
 * in the table above, so an unknown or plugin-registered check still reads as
 * a sentence rather than a slug.
 */
export function friendlyCheckName(checkId: string): string {
  const known = CHECK_NAMES[checkId];
  if (known) return known;
  const tail = checkId.split("/").filter(Boolean).pop() ?? checkId;
  const words = tail.replace(/[-_]+/g, " ").trim();
  if (!words) return checkId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A `doctor --lint` finding printed as prose rather than JSON:
 *   `  [warning] core/doctor/gateway-config gateway.mode is unset.`
 * The check id is optional — some findings are emitted as bare prose:
 *   `  [warning] Left plugin install index in place because …`
 */
const LINT_TEXT_LINE_RE = /^\s*\[(error|fatal|warning|warn|info|notice)\]\s+(.*\S)\s*$/i;

/** `    fix: Run \`openclaw configure\` …` — remediation for the finding above. */
const LINT_TEXT_FIX_RE = /^\s*fix:\s*(.*\S)\s*$/i;

/**
 * A check id is a slash-delimited slug (`core/doctor/gateway-config`). Requiring
 * the slash keeps a capitalised first word of prose ("Left plugin install
 * index …") from being mistaken for one.
 */
const LINT_CHECK_ID_RE = /^[a-z][\w.-]*(?:\/[\w.-]+)+$/;

/**
 * Parse `doctor --lint` prose into the same envelope the `--json` path yields,
 * so both surfaces share one grouping, noise-filter and fix-hint code path.
 */
function parseLintText(text: string): DoctorLintPayload {
  const findings: DoctorLintFinding[] = [];

  for (const line of text.split(/\r?\n/)) {
    const fix = line.match(LINT_TEXT_FIX_RE);
    if (fix && findings.length > 0) {
      findings[findings.length - 1].fixHint = fix[1];
      continue;
    }

    const match = line.match(LINT_TEXT_LINE_RE);
    if (!match) continue;

    const [, severity, rest] = match;
    const [firstWord, ...tail] = rest.split(/\s+/);
    const hasCheckId = LINT_CHECK_ID_RE.test(firstWord) && tail.length > 0;

    findings.push({
      checkId: hasCheckId ? firstWord : "core/doctor/unknown",
      severity: severity.toLowerCase(),
      message: hasCheckId ? tail.join(" ") : rest,
    });
  }

  return { checksRun: findings.length, findings };
}

function severityToStatus(severity: string): DoctorCheckStatus {
  const normalized = severity.toLowerCase();
  if (normalized === "error" || normalized === "fatal") return "fail";
  if (normalized === "warning" || normalized === "warn") return "warn";
  return "ok";
}

const STATUS_RANK: Record<DoctorCheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

function summarize(checks: DoctorCheck[]): { ok: number; warn: number; fail: number } {
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) summary[check.status] += 1;
  return summary;
}

/** Worst status first, so the UI never buries a failure under passes. */
function sortChecks(checks: DoctorCheck[]): DoctorCheck[] {
  return [...checks].sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
}

function truncateRaw(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.length > MAX_RAW_CHARS
    ? `${trimmed.slice(0, MAX_RAW_CHARS)}\n… (truncated)`
    : trimmed;
}

/* ── `doctor --lint --json` parsing ────────────────────────────────────── */

export type DoctorLintFinding = {
  checkId?: string;
  severity?: string;
  message?: string;
  path?: string;
  target?: string;
  fixHint?: string;
};

export type DoctorLintPayload = {
  ok?: boolean;
  checksRun?: number;
  checksSkipped?: number;
  findings?: DoctorLintFinding[];
};

/**
 * Pull the lint envelope out of doctor's stdout.
 *
 * `doctor --lint --json` prints only JSON on this build, but the CLI is happy
 * to prepend banner boxes ("Doctor notices …") on other code paths, so scan
 * line-by-line for the first line that parses as an object with `findings`,
 * then fall back to the first balanced `{…}` span. Returns null when there is
 * no envelope, which is the signal to drop to the text classifier.
 */
export function parseDoctorLintJson(stdout: string): DoctorLintPayload | null {
  const looksLikeEnvelope = (value: unknown): value is DoctorLintPayload =>
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ("findings" in value || "checksRun" in value);

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (looksLikeEnvelope(parsed)) return parsed;
    } catch {
      // Not this line — keep scanning.
    }
  }

  const start = stdout.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i += 1) {
    const char = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(stdout.slice(start, i + 1));
          if (looksLikeEnvelope(parsed)) return parsed;
        } catch {
          // Malformed — give up rather than guess.
        }
        return null;
      }
    }
  }
  return null;
}

/**
 * Collapse doctor findings into one check per `checkId`.
 *
 * Doctor emits one finding per *line* of prose — the security check alone
 * produces four, of which three are explanation and remediation. Grouped, that
 * reads as a single problem with a paragraph attached, which is what it is.
 * The group takes the worst severity in it, and `fixHint`s are appended once
 * each so the user is told what to do without four copies of the same advice.
 */
export function normalizeLintPayload(payload: DoctorLintPayload): {
  checks: DoctorCheck[];
  filtered: DoctorFilteredNotice[];
} {
  const filtered: DoctorFilteredNotice[] = [];
  const groups = new Map<
    string,
    { status: DoctorCheckStatus; messages: string[]; hints: string[] }
  >();

  for (const finding of payload.findings ?? []) {
    const checkId = typeof finding?.checkId === "string" && finding.checkId ? finding.checkId : "core/doctor/unknown";
    const severity = typeof finding?.severity === "string" ? finding.severity : "warning";
    const message = typeof finding?.message === "string" ? finding.message.trim() : "";
    if (!message) continue;

    const noise = matchNoise(checkId, severity, message);
    if (noise) {
      filtered.push({ id: noise.id, checkId, severity, message, reason: noise.reason });
      continue;
    }

    const status = severityToStatus(severity);
    const group = groups.get(checkId) ?? { status: "ok" as DoctorCheckStatus, messages: [], hints: [] };
    if (STATUS_RANK[status] > STATUS_RANK[group.status]) group.status = status;
    if (!group.messages.includes(message)) group.messages.push(message);
    const hint = typeof finding?.fixHint === "string" ? finding.fixHint.trim() : "";
    if (hint && !group.hints.includes(hint)) group.hints.push(hint);
    groups.set(checkId, group);
  }

  const checks: DoctorCheck[] = [];
  for (const [checkId, group] of groups) {
    const body = group.messages.join("\n");
    const hints = group.hints.map((hint) => `Fix: ${hint}`).join("\n");
    checks.push({
      id: checkId,
      name: friendlyCheckName(checkId),
      status: group.status,
      message: hints ? `${body}\n${hints}` : body,
    });
  }

  // Always report that the run happened. Without this a clean install returns
  // an empty list, which reads like "nothing ran" rather than "nothing wrong" —
  // and it is the only place the run/skip counts survive into the UI.
  const run = typeof payload.checksRun === "number" ? payload.checksRun : 0;
  const skipped = typeof payload.checksSkipped === "number" ? payload.checksSkipped : 0;
  const problems = checks.length;
  checks.push({
    id: "mission-control/doctor/completed",
    name:
      problems === 0
        ? "All health checks passed"
        : `Health check finished — ${problems === 1 ? "1 item needs" : `${problems} items need`} attention`,
    status: "ok",
    message: `Ran ${run} check${run === 1 ? "" : "s"}${skipped ? `, skipped ${skipped} optional check${skipped === 1 ? "" : "s"}` : ""}.`,
  });

  return { checks: sortChecks(checks), filtered };
}

/**
 * Last-resort parse of doctor's *human* output, via the existing classifier in
 * `doctor-checks.ts`. Its `DoctorIssue.title`/`detail` are already written for
 * non-technical readers, so they map straight onto a check.
 */
export function normalizeDoctorText(text: string): {
  checks: DoctorCheck[];
  filtered: DoctorFilteredNotice[];
} {
  const filtered: DoctorFilteredNotice[] = [];
  const checks: DoctorCheck[] = [];
  const seen = new Set<string>();

  for (const issue of classifyDoctorOutput(text.split(/\r?\n/))) {
    const noise = matchNoise(issue.checkId, issue.severity, issue.rawText);
    if (noise) {
      filtered.push({
        id: noise.id,
        checkId: issue.checkId,
        severity: issue.severity,
        message: issue.rawText,
        reason: noise.reason,
      });
      continue;
    }
    const key = `${issue.checkId}:${issue.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push({
      id: issue.checkId === "unknown" ? undefined : issue.checkId,
      name: issue.title,
      status: severityToStatus(issue.severity),
      message: issue.detail,
    });
  }

  /*
   * `classifyDoctorOutput` parses the *legacy* box-drawing pass. This function
   * is also reached with `doctor --lint` prose — plain `[severity] check-id
   * message` lines — which the box parser returns [] for. Reading that empty
   * result as "healthy" is exactly the false all-clear this module exists to
   * prevent, so parse those lines and route them through the same grouping and
   * noise filtering the JSON path uses.
   */
  if (checks.length === 0) {
    const payload = parseLintText(text);
    if ((payload.findings?.length ?? 0) > 0) {
      const lint = normalizeLintPayload(payload);
      return { checks: lint.checks, filtered: [...filtered, ...lint.filtered] };
    }
  }

  if (checks.length === 0) {
    /*
     * Only a positive completion marker justifies an all-clear. Silence from a
     * parser that did not recognise its input means "we could not read this",
     * and saying so is strictly better than inventing a clean bill of health.
     */
    const completed = /doctor complete|no (?:problems|issues) found|checks? passed/i.test(text);
    checks.push(
      completed
        ? {
            id: "mission-control/doctor/completed",
            name: "All health checks passed",
            status: "ok",
            message: "Doctor reported no problems.",
          }
        : {
            id: "mission-control/doctor/unreadable",
            name: "Health check output could not be read",
            status: "warn",
            message:
              "Doctor ran but Mission Control could not interpret its output, so this is not a clean bill of health. The raw output is shown below.",
          },
    );
  }

  return { checks: sortChecks(checks), filtered };
}

/* ── Subprocess ────────────────────────────────────────────────────────── */

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError: string | null;
};

function runDoctorLint(bin: string, args: string[], timeoutMs: number): Promise<SpawnResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const finish = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, {
        // NO_COLOR keeps ANSI out of `raw`; the insecure-ws opt-in matches
        // /api/doctor/run so a loopback gateway is reachable either way.
        env: { ...process.env, NO_COLOR: "1", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: "", timedOut: false, spawnError: String(err) });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      // SIGTERM can be swallowed by a busy plugin loader — do not wait forever.
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 1_000);
      finish({ code: null, stdout, stderr, timedOut: true, spawnError: null });
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      finish({ code: null, stdout, stderr, timedOut, spawnError: String(err) });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

/* ── Gateway `health` RPC fallback ─────────────────────────────────────── */

type GatewayHealthPayload = {
  ok?: boolean;
  eventLoop?: { degraded?: boolean; reasons?: string[] };
  plugins?: { loaded?: string[]; errors?: unknown[] };
  configReload?: { hotReloadStatus?: string };
};

/**
 * Degraded answer built from the gateway `health` RPC (verified live: returns
 * `{ ok, eventLoop, plugins, configReload, channels, … }`). Cheap enough to run
 * inside whatever budget is left after doctor gave up.
 */
async function buildRpcChecks(): Promise<DoctorCheck[] | null> {
  let payload: GatewayHealthPayload;
  try {
    const { gatewayCall } = await import("./openclaw");
    payload = await gatewayCall<GatewayHealthPayload>("health", {}, RPC_TIMEOUT_MS);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;

  const checks: DoctorCheck[] = [
    {
      id: "gateway/health",
      name: payload.ok === false ? "Gateway reports a problem" : "Gateway is responding",
      status: payload.ok === false ? "fail" : "ok",
      message:
        payload.ok === false
          ? "The gateway answered but reported itself unhealthy."
          : "The gateway answered a health check, so your saved config loaded.",
    },
  ];

  const pluginErrors = Array.isArray(payload.plugins?.errors) ? payload.plugins.errors : [];
  if (pluginErrors.length > 0) {
    checks.push({
      id: "gateway/health/plugins",
      name: "Some plugins failed to load",
      status: "fail",
      message: pluginErrors.map((err) => (typeof err === "string" ? err : JSON.stringify(err))).join("\n"),
    });
  }

  if (payload.eventLoop?.degraded) {
    const reasons = Array.isArray(payload.eventLoop.reasons) ? payload.eventLoop.reasons : [];
    checks.push({
      id: "gateway/health/event-loop",
      name: "Gateway is running slowly",
      status: "warn",
      message: reasons.length ? reasons.join("\n") : "The gateway event loop is degraded.",
    });
  }

  const hotReload = payload.configReload?.hotReloadStatus;
  if (typeof hotReload === "string" && hotReload !== "active") {
    checks.push({
      id: "gateway/health/config-reload",
      name: "Config hot-reload is not active",
      status: "warn",
      message: `Config hot-reload reports "${hotReload}". A gateway restart may be needed for changes to take effect.`,
    });
  }

  return checks;
}

/* ── Entry point ───────────────────────────────────────────────────────── */

function finalize(
  partialReport: Omit<DoctorReport, "ok" | "summary" | "durationMs" | "ranAt"> & { checks: DoctorCheck[] },
  startedAt: number,
): DoctorReport {
  const checks = sortChecks(partialReport.checks);
  const summary = summarize(checks);
  return {
    ...partialReport,
    checks,
    summary,
    ok: summary.fail === 0,
    ranAt: startedAt,
    durationMs: Date.now() - startedAt,
  };
}

/**
 * Run a health check and return a normalised report. Never throws, never hangs.
 *
 * `ok` means "no check failed" — warnings (the common case on a real machine:
 * plaintext secrets, legacy residue) do not turn the banner red, because a
 * config save that produced only pre-existing warnings did not break anything.
 */
export async function runDoctorReport(options: DoctorReportOptions = {}): Promise<DoctorReport> {
  const fast = options.fast !== false;
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? DOCTOR_TIMEOUT_MS);
  const startedAt = Date.now();

  const base = { source: "json" as DoctorReportSource, partial: false, timedOut: false, fast, filtered: [] as DoctorFilteredNotice[] };

  let bin: string;
  try {
    bin = await getOpenClawBin();
  } catch {
    bin = "openclaw";
  }

  const args = ["doctor", "--lint", "--json", "--non-interactive"];

  let result: SpawnResult;
  try {
    result = await runDoctorLint(bin, args, timeoutMs);
  } catch (err) {
    result = { code: null, stdout: "", stderr: "", timedOut: false, spawnError: String(err) };
  }

  const combined = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`;

  // 1. The structured surface.
  if (!result.timedOut && !result.spawnError) {
    const payload = parseDoctorLintJson(result.stdout);
    if (payload) {
      const { checks, filtered } = normalizeLintPayload(payload);
      return finalize({ ...base, source: "json", checks, filtered, raw: truncateRaw(combined) }, startedAt);
    }
  }

  // 2. Doctor ran but did not speak JSON — classify the prose.
  if (!result.timedOut && !result.spawnError && combined.trim()) {
    const { checks, filtered } = normalizeDoctorText(combined);
    // Exit 2 means doctor failed before linting: say so instead of implying the
    // absence of findings is a clean bill of health.
    if (result.code !== 0 && result.code !== 1) {
      checks.unshift({
        id: "mission-control/doctor/exit",
        name: "Health check could not complete",
        status: "fail",
        message: `\`openclaw ${args.join(" ")}\` exited with code ${result.code ?? "unknown"}. The details below are unparsed doctor output.`,
      });
    }
    return finalize({ ...base, source: "text", checks, filtered, raw: truncateRaw(combined) }, startedAt);
  }

  // 3. Doctor timed out or could not start — degrade to the gateway RPC.
  const rpcChecks = await buildRpcChecks();
  if (rpcChecks) {
    rpcChecks.unshift({
      id: "mission-control/doctor/partial",
      name: result.timedOut ? "Full health check took too long" : "Full health check could not run",
      status: "warn",
      message: result.timedOut
        ? `\`openclaw doctor --lint\` did not finish within ${Math.round(timeoutMs / 1000)}s, so only the quick gateway health check ran. Run it again for the full report.`
        : "The openclaw command could not be started, so only the quick gateway health check ran.",
    });
    return finalize(
      { ...base, source: "rpc", partial: true, timedOut: result.timedOut, checks: rpcChecks, raw: truncateRaw(combined) },
      startedAt,
    );
  }

  // 4. Nothing answered. Report the failure rather than an empty success.
  return finalize(
    {
      ...base,
      source: "rpc",
      partial: true,
      timedOut: result.timedOut,
      checks: [
        {
          id: "mission-control/doctor/unavailable",
          name: "Could not verify your change",
          status: "fail",
          message: result.timedOut
            ? `The health check did not finish within ${Math.round(timeoutMs / 1000)}s and the gateway did not answer either. Your change may still have been saved — reload to confirm.`
            : `The health check could not be run${result.spawnError ? ` (${result.spawnError})` : ""} and the gateway did not answer. Your change may still have been saved — reload to confirm.`,
        },
      ],
      raw: truncateRaw(combined),
    },
    startedAt,
  );
}
