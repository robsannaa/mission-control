/**
 * The honest health signal.
 *
 * ## What was wrong
 *
 * The previous implementation computed `100 − 20·errors − 5·warnings` over a
 * set that was **always empty**: it read `health.checks`, `status.service`,
 * `status.gateway.port` and `status.rpc`, none of which exist on this gateway.
 * So it reported 100/healthy/1 check on a machine with an unsupported Node,
 * a fragile service definition, three plaintext credentials, 128 orphan files
 * and a pending restart. A score that cannot go down is not a score.
 *
 * ## The rules here
 *
 * 1. **No run, no number.** If nothing has completed, the state is
 *    `never-checked` and the score is `null`. Not 100. Not "unknown, showing
 *    100". Null, and the UI must render the words.
 * 2. **Only what was actually checked counts.** Lint does not implement every
 *    registered check — `state-integrity`, `gateway-daemon`, `disk-space`,
 *    `session-transcripts`, `skills-readiness`, `memory-search`,
 *    `command-owner` and `legacy-cron-store` return `[]` from lint while the
 *    legacy pass finds real problems in several. If lint ran alone, those
 *    families are reported as *unverified*, and the caveat says so.
 * 3. **Every deduction is itemised.** The number is auditable: the UI can show
 *    exactly which finding cost which points, so nobody has to trust it.
 * 4. **Age is part of the answer.** A run from four hours ago is reported as
 *    stale rather than presented as current.
 */

import type {
  DoctorCoverage,
  DoctorFinding,
  DoctorHealth,
  DoctorProvenance,
} from "./doctor-types";

/** Beyond this, a cached run is described as stale rather than current. */
export const STALE_AFTER_MS = 15 * 60_000;

/** Check families lint registers but does not implement — verified empirically. */
export const LINT_BLIND_SPOTS: { id: string; label: string; reason: string }[] = [
  {
    id: "core/doctor/state-integrity",
    label: "Conversation storage",
    reason: "Only the full check reports missing transcripts and leftover files.",
  },
  {
    id: "core/doctor/gateway-daemon",
    label: "Background service setup",
    reason: "Only the full check inspects how the service starts OpenClaw.",
  },
  {
    id: "core/doctor/disk-space",
    label: "Disk space",
    reason: "Measured live from the gateway instead.",
  },
  {
    id: "core/doctor/session-transcripts",
    label: "Conversation transcripts",
    reason: "Only the full check compares the list against the files on disk.",
  },
  {
    id: "core/doctor/skills-readiness",
    label: "Skills",
    reason: "Only the full check reports which skills are usable.",
  },
  {
    id: "core/doctor/memory-search",
    label: "Memory search",
    reason: "Not covered by the quick read-only check.",
  },
  {
    id: "core/doctor/command-owner",
    label: "Command ownership",
    reason: "Not covered by the quick read-only check.",
  },
  {
    id: "core/doctor/legacy-cron-store",
    label: "Scheduled jobs",
    reason: "Only the full check inspects how scheduled jobs are stored.",
  },
];

/** Registered check count reported by `doctor --lint --all` on 2026.7.x. */
export const REGISTERED_CHECK_COUNT = 51;

export type ScoreInputs = {
  findings: readonly DoctorFinding[];
  prevention: readonly DoctorFinding[];
  provenance: DoctorProvenance;
  runtime: {
    pluginErrors: number;
    eventLoopDegraded: boolean;
    queuedSystemEvents: number;
    taskAuditErrors: number;
    taskAuditWarnings: number;
    diskFreeRatio: number | null;
  };
  checksRun: number | null;
  checksSkipped: number | null;
  /** True when the legacy (full) pass contributed to this snapshot. */
  legacyRan: boolean;
};

/**
 * Weights. Deliberately blunt and readable rather than tuned: the point is that
 * a machine with real problems cannot score 100, not that 84 is meaningfully
 * different from 86.
 *
 * Warnings taper. Ten unrelated warnings is a system that needs attention, not
 * a system in crisis, and a flat 7 points each drove this machine to 28/100 —
 * "critical" — with no errors at all. The first few carry full weight; the rest
 * carry less, so the number keeps moving without pretending a long advisory
 * list is an emergency.
 */
const WEIGHTS = {
  error: 22,
  /** Full weight for this many warnings, then `warningTail` each. */
  warningFull: 7,
  warningFullCount: 3,
  warningTail: 3,
  info: 0,
  preventionError: 15,
  preventionWarning: 5,
} as const;

export function computeCoverage(inputs: ScoreInputs): DoctorCoverage {
  // `checksRun` counts *doctor* checks, so only doctor-sourced findings may be
  // measured against it. Counting security-audit rows and live gateway signals
  // in the same fraction produced "12 of 51 checks reported something" when
  // three doctor checks had fired — a denominator that does not match its
  // numerator is exactly the kind of confident nonsense this page is replacing.
  const isDoctorCheck = (id: string) => id.startsWith("core/doctor/");
  const doctorChecks = new Set(
    inputs.findings.filter((f) => isDoctorCheck(f.checkId)).map((f) => f.checkId),
  ).size;
  const otherSources = inputs.findings.filter((f) => !isDoctorCheck(f.checkId)).length;
  const reporting = new Set(inputs.findings.map((f) => f.checkId)).size;
  const unverified = inputs.legacyRan ? [] : LINT_BLIND_SPOTS;

  const parts: string[] = [];
  if (inputs.checksRun != null) {
    parts.push(
      `${doctorChecks} of ${inputs.checksRun} health check${inputs.checksRun === 1 ? "" : "s"} reported something`,
    );
  } else {
    parts.push(`${doctorChecks} health checks reported something`);
  }
  if (otherSources > 0) {
    parts.push(
      `${otherSources} further finding${otherSources === 1 ? "" : "s"} came from the security audit and live status`,
    );
  }
  if (unverified.length) {
    parts.push(
      `${unverified.length} area${unverified.length === 1 ? " is" : "s are"} not covered by the quick check`,
    );
  }

  return {
    checksRegistered: REGISTERED_CHECK_COUNT,
    checksRun: inputs.checksRun,
    checksSkipped: inputs.checksSkipped,
    checksReporting: reporting,
    unverifiedFamilies: unverified,
    statement: `${parts.join("; ")}.`,
  };
}

export function computeHealth(inputs: ScoreInputs, now = Date.now()): DoctorHealth {
  const { provenance } = inputs;
  const sourceRuns = [
    provenance.lint,
    provenance.legacy,
    provenance.securityAudit,
    provenance.secretsAudit,
  ];
  const anyRan = sourceRuns.some((s) => s.ran && s.ok);

  // Nothing completed: the only honest answer is that we have not looked.
  if (!anyRan) {
    const attempted = sourceRuns.some((s) => s.ran);
    const errors = sourceRuns.map((s) => s.error).filter(Boolean) as string[];
    return {
      state: provenance.runtime.ran && !provenance.runtime.ok
        ? "gateway-unreachable"
        : attempted
          ? "run-failed"
          : "never-checked",
      score: null,
      grade: "unknown",
      checkedAt: null,
      ageMs: null,
      deductions: [],
      caveats: attempted
        ? errors.length
          ? errors
          : ["The health check did not complete, so nothing here has been verified."]
        : ["This system has never been checked."],
    };
  }

  const deductions: { reason: string; points: number }[] = [];
  let errorCount = 0;
  let warningIndex = 0;

  for (const f of inputs.findings) {
    if (f.informational) continue;
    // A consequence of another finding must not be charged twice — fixing the
    // cause clears it. This is the whole point of tracking causality.
    if (f.causedBy) continue;

    if (f.severity === "error") {
      errorCount++;
      deductions.push({ reason: f.title, points: WEIGHTS.error });
    } else if (f.severity === "warning") {
      const points =
        warningIndex < WEIGHTS.warningFullCount ? WEIGHTS.warningFull : WEIGHTS.warningTail;
      warningIndex++;
      deductions.push({ reason: f.title, points });
    }
  }

  for (const f of inputs.prevention) {
    if (f.severity === "error") errorCount++;
    const points =
      f.severity === "error"
        ? WEIGHTS.preventionError
        : f.severity === "warning"
          ? WEIGHTS.preventionWarning
          : 0;
    if (points > 0) deductions.push({ reason: f.title, points });
  }

  // Live gateway signals — pending restarts, failed add-ons, a degraded event
  // loop, unfinished background jobs — deliberately contribute *nothing extra*
  // here. Each already produced a finding above, and charging the same problem
  // twice would make the itemised deduction list, which the user can read,
  // show two lines for one problem. `inputs.runtime` is kept because it is what
  // decides whether those findings exist at all.
  void inputs.runtime;

  const total = deductions.reduce((sum, d) => sum + d.points, 0);
  const score = Math.max(0, Math.min(100, 100 - total));

  const checkedAt = Math.max(
    ...sourceRuns.filter((s) => s.ran && s.ok && s.ts).map((s) => s.ts as number),
  );
  const ageMs = now - checkedAt;

  const caveats: string[] = [];
  if (!inputs.legacyRan) {
    caveats.push(
      "Only the quick read-only check ran. Conversation storage, the background service setup and scheduled jobs were not inspected — problems there would not appear here.",
    );
  }
  if (!provenance.securityAudit.ok) {
    caveats.push("The security audit did not run, so security findings are incomplete.");
  }
  if (!provenance.runtime.ok) {
    caveats.push("The gateway did not answer, so live status is missing from this result.");
  }
  for (const s of sourceRuns) {
    if (s.ran && !s.ok && s.error) caveats.push(s.error);
  }

  // Grade is not the score alone. A pile of advisory warnings is a system that
  // needs attention; "critical" is reserved for something actually broken, so
  // it requires at least one error-severity finding. Getting this wrong in the
  // other direction is what the old implementation did — it could never leave
  // "healthy" — but crying critical over advice is the same failure mirrored.
  const grade: DoctorHealth["grade"] =
    errorCount > 0 ? (score < 70 ? "critical" : "attention") : score >= 90 ? "healthy" : "attention";

  return {
    state: ageMs > STALE_AFTER_MS ? "stale" : "checked",
    score,
    grade,
    checkedAt,
    ageMs,
    deductions: deductions.sort((a, b) => b.points - a.points),
    caveats,
  };
}
