/**
 * The structured half of the Doctor: `openclaw doctor --lint --json`.
 *
 * This is the only doctor surface that is both read-only and machine-readable.
 *
 * - `--all` is NOT passed. On OpenClaw 2026.6.9+ it is not a recognized flag —
 *   the opt-in/opt-out check split it used to control is gone, and `--lint`
 *   now always runs the full inventory (verified: checksSkipped: 0). Passing
 *   `--all` anyway makes the CLI exit 2 before it lints anything, which is
 *   strictly worse than omitting it. If a future CLI reintroduces a check
 *   subset by default, re-add it then.
 * - `--severity-min info` — the default threshold is `warning`, which silently
 *   discards every info finding. A page that claims to show everything cannot
 *   run with a filter it did not choose.
 *
 * Exit codes: 0 = nothing at/above the threshold, 1 = findings exist, 2 = the
 * command failed before it could lint. **Exit 1 is the normal case.**
 *
 * `findings[]` is flat, not grouped: one check can emit several rows, and
 * `core/doctor/security` emits four that are one logical problem. Grouping by
 * `checkId` happens here so nothing downstream has to know that.
 */

import { runOpenClaw, extractJson, invocationOf } from "./doctor-exec";
import type { DoctorSourceRun } from "./doctor-types";

/** Verbatim shape from `dist/health-*.d.ts` — required fields first. */
export type HealthFinding = {
  checkId: string;
  severity: "info" | "warning" | "error";
  message: string;
  source?: string;
  path?: string;
  line?: number;
  column?: number;
  ocPath?: string;
  target?: string;
  requirement?: string;
  fixHint?: string;
};

export type LintEnvelope = {
  ok: boolean;
  checksRun: number;
  checksSkipped: number;
  findings: HealthFinding[];
};

/** One check's worth of rows, reassembled into the logical finding it is. */
export type LintGroup = {
  checkId: string;
  /** Highest severity among the rows. */
  severity: "info" | "warning" | "error";
  rows: HealthFinding[];
  /** Distinct `path` values across the rows. */
  paths: string[];
  /** Distinct `target` values across the rows. */
  targets: string[];
  /** First non-empty `fixHint`. The CLI repeats it across rows of one check. */
  fixHint: string | null;
};

export type LintResult = {
  run: DoctorSourceRun;
  envelope: LintEnvelope | null;
  groups: LintGroup[];
};

export const LINT_ARGS = ["doctor", "--lint", "--severity-min", "info", "--json"];

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const;

function isFinding(value: unknown): value is HealthFinding {
  if (!value || typeof value !== "object") return false;
  const f = value as Record<string, unknown>;
  return (
    typeof f.checkId === "string" &&
    typeof f.message === "string" &&
    (f.severity === "info" || f.severity === "warning" || f.severity === "error")
  );
}

/** Group flat rows by `checkId`, preserving CLI order within each group. */
export function groupFindings(findings: readonly HealthFinding[]): LintGroup[] {
  const byCheck = new Map<string, LintGroup>();

  for (const row of findings) {
    let group = byCheck.get(row.checkId);
    if (!group) {
      group = {
        checkId: row.checkId,
        severity: row.severity,
        rows: [],
        paths: [],
        targets: [],
        fixHint: null,
      };
      byCheck.set(row.checkId, group);
    }
    group.rows.push(row);
    if (SEVERITY_RANK[row.severity] < SEVERITY_RANK[group.severity]) {
      group.severity = row.severity;
    }
    if (row.path && !group.paths.includes(row.path)) group.paths.push(row.path);
    if (row.target && !group.targets.includes(row.target)) group.targets.push(row.target);
    if (!group.fixHint && row.fixHint) group.fixHint = row.fixHint;
  }

  return [...byCheck.values()].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
}

/**
 * Run the lint pass. Read-only: safe to call on a timer, safe to call while the
 * user is watching, safe on someone else's machine.
 */
export async function runLint(
  timeoutMs = 60_000,
  onChunk?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<LintResult> {
  const result = await runOpenClaw(LINT_ARGS, timeoutMs, onChunk);
  const ts = Date.now();
  const invocation = invocationOf(LINT_ARGS);

  const base: DoctorSourceRun = {
    ran: true,
    ok: false,
    ts,
    durationMs: result.durationMs,
    error: null,
    invocation,
  };

  if (result.spawnError) {
    return {
      run: { ...base, error: `Could not start the OpenClaw CLI: ${result.spawnError}` },
      envelope: null,
      groups: [],
    };
  }
  if (result.timedOut) {
    return {
      run: { ...base, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` },
      envelope: null,
      groups: [],
    };
  }

  const parsed = extractJson<Partial<LintEnvelope>>(result.stdout);
  if (!parsed || !Array.isArray(parsed.findings)) {
    // Exit 2 means doctor itself failed; anything else here means it produced
    // output we do not understand. Both are "we could not check", not "clean".
    const detail = (result.stderr || result.stdout).trim().slice(0, 400);
    return {
      run: {
        ...base,
        error:
          result.code === 2
            ? `The health check could not run.${detail ? ` ${detail}` : ""}`
            : `The health check produced output we could not read.${detail ? ` ${detail}` : ""}`,
      },
      envelope: null,
      groups: [],
    };
  }

  const findings = parsed.findings.filter(isFinding);
  const envelope: LintEnvelope = {
    ok: parsed.ok === true,
    checksRun: typeof parsed.checksRun === "number" ? parsed.checksRun : findings.length,
    checksSkipped: typeof parsed.checksSkipped === "number" ? parsed.checksSkipped : 0,
    findings,
  };

  return { run: { ...base, ok: true }, envelope, groups: groupFindings(findings) };
}
