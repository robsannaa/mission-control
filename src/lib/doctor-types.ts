/**
 * Shared vocabulary for the Doctor server surface.
 *
 * Everything the Doctor page renders comes from one of five real sources, and
 * every finding records which one it came from and how certain that source is.
 * The distinction matters: `openclaw doctor --lint --json` hands us a typed
 * `HealthFinding`, while the legacy human pass has to be parsed out of
 * box-drawing text. Both are useful. Only one of them is certain, and the UI is
 * entitled to know which is which.
 */

export type DoctorSeverity = "error" | "warning" | "info";

/**
 * How much we trust the finding's *existence and shape* (not its importance).
 *
 * - `structured` — came out of a machine-readable envelope (`--lint --json`,
 *   `security audit --json`, `secrets audit --json`, a gateway RPC result).
 * - `parsed`     — recovered from human-readable CLI output by an anchored
 *   section parser. The section header and a curated signature both matched, so
 *   the finding is real, but the wording is not a contract and could drift.
 * - `derived`    — we computed it ourselves from structured inputs (e.g. a
 *   token expiring in under three days). Real data, our judgement.
 */
export type DoctorConfidence = "structured" | "parsed" | "derived";

export type DoctorSourceKind =
  | "lint"
  | "legacy"
  | "security-audit"
  | "secrets-audit"
  | "runtime";

/**
 * How dangerous it is to press the button.
 *
 * - `safe`        — reversible or additive, touches nothing the user configured
 *                   by hand. May be offered as one click.
 * - `caution`     — rewrites real state (config, plugin installs, service
 *                   restarts). Requires `confirm: true` on the API call.
 * - `destructive` — overwrites hand-written service definitions, rotates
 *                   credentials, or breaks live clients. Requires
 *                   `confirm: true` AND is never presented as one click.
 */
export type DoctorFixSafety = "safe" | "caution" | "destructive";

/** A step in a walkthrough for problems that have no button. */
export type DoctorGuideStep = {
  title: string;
  detail: string;
  /** Shown only behind an "advanced" disclosure; a guide must read without it. */
  command?: string;
  /** How the user knows the step worked. */
  verify?: string;
  /** True when this step is something Mission Control can do for the user. */
  fixId?: string;
};

/**
 * A repair Mission Control can actually perform, described in enough detail
 * that the user can read what will happen before anything happens.
 */
export type DoctorFix = {
  /** Stable id; pass to `POST /api/doctor/fix`. */
  id: string;
  label: string;
  safety: DoctorFixSafety;
  /** Plain language, present tense: exactly what pressing this changes. */
  whatItDoes: string;
  /** Consequences the user would not otherwise guess. Rendered as a list. */
  sideEffects: string[];
  requiresRestart: boolean;
  /** True for anything not `safe`. The API rejects the call without `confirm`. */
  requiresConfirmation: boolean;
  /** True when `GET /api/doctor/fix?fixId=…` returns a real dry run. */
  previewAvailable: boolean;
  /**
   * Set when the CLI has already told us it declined this repair. Parsed from
   * the `Doctor notices` block (`Left … in place because …`). A blocked fix
   * must not be offered as a button.
   */
  blocked: { reason: string } | null;
  /** The literal command, for the advanced disclosure. Never the only wording. */
  command: string;
  /** Other finding ids this same command also resolves. */
  alsoResolves: string[];
};

export type DoctorFinding = {
  /** Stable across runs, so history can diff. */
  id: string;
  /** The doctor check id when one exists (`core/doctor/security`), else our own. */
  checkId: string;
  source: DoctorSourceKind;
  confidence: DoctorConfidence;
  severity: DoctorSeverity;
  /** Grouping key for the UI — a check family, not an invented category. */
  family: string;
  /** What is wrong, in plain language. */
  title: string;
  /** Why it matters to me. */
  explanation: string;
  /** What happens if I do nothing. Empty for purely informational rows. */
  impact: string;
  /** Verbatim machine output backing the claim, redacted. Never invented. */
  evidence: string[];
  /** Filesystem or config paths involved, redacted. */
  paths: string[];
  /**
   * Id of the finding that *causes* this one. Fixing the cause resolves the
   * chain, so the UI can collapse consequences under their root.
   */
  causedBy: string | null;
  /** Ids of findings this one causes. Inverse of `causedBy`. */
  causes: string[];
  /** True when nothing is wrong and there is nothing to do. */
  informational: boolean;
  fix: DoctorFix | null;
  /** Multi-step walkthrough when there is no single button. */
  guide: DoctorGuideStep[];
  docs: string | null;
  /** Source ids merged into this finding (e.g. lint + secrets audit agreeing). */
  mergedFrom: string[];
};

/** Whether one of the five sources ran, and what it cost. */
export type DoctorSourceRun = {
  ran: boolean;
  ok: boolean;
  ts: number | null;
  durationMs: number | null;
  /** Present when `ran` is true but `ok` is false. */
  error: string | null;
  /** The literal command or RPC, for the report. */
  invocation: string;
};

export type DoctorProvenance = {
  lint: DoctorSourceRun;
  legacy: DoctorSourceRun;
  securityAudit: DoctorSourceRun;
  secretsAudit: DoctorSourceRun;
  runtime: DoctorSourceRun;
};

/**
 * Coverage, stated honestly.
 *
 * `checksRegistered` is what the CLI reports it ran. `checksReporting` is how
 * many of them produced findings. `unverifiedFamilies` are check families that
 * lint returns `[]` for while the legacy pass demonstrably finds real problems
 * — lint silence there means "not checked", never "healthy".
 */
export type DoctorCoverage = {
  checksRegistered: number | null;
  checksRun: number | null;
  checksSkipped: number | null;
  checksReporting: number;
  /** Families structured output does not cover. Present even on a clean run. */
  unverifiedFamilies: { id: string; label: string; reason: string }[];
  /** One-line summary the UI can print verbatim. */
  statement: string;
};

export type DoctorHealthState =
  | "never-checked"
  | "checked"
  | "stale"
  | "gateway-unreachable"
  | "run-failed";

export type DoctorHealth = {
  state: DoctorHealthState;
  /**
   * 0–100, or `null`. Null whenever no real run backs it. A null score must be
   * rendered as "Never checked", never as 100.
   */
  score: number | null;
  grade: "healthy" | "attention" | "critical" | "unknown";
  /** When the run that produced this finished. */
  checkedAt: number | null;
  ageMs: number | null;
  /** Itemised deductions, so the number is auditable rather than magic. */
  deductions: { reason: string; points: number }[];
  /** Honest qualifications: which families were not verified, and why. */
  caveats: string[];
};

/** A single point on the trend line, small enough to keep 50 of. */
export type DoctorTrendPoint = {
  ts: number;
  score: number | null;
  errors: number;
  warnings: number;
  infos: number;
  /**
   * Which check set produced this score. Scores from different modes are NOT
   * comparable — a quick run skips the whole legacy pass, so it scores higher
   * than a deep run on an unchanged machine. Consumers must not draw a trend
   * line across a mode change.
   */
  mode: string;
};

export type DoctorSnapshot = {
  /** Snapshot schema version. Bump when the finding shape changes. */
  version: 2;
  /** When this snapshot object was assembled (may be a cache hit). */
  ts: number;
  /** True when served from cache rather than a fresh run. */
  cached: boolean;
  health: DoctorHealth;
  provenance: DoctorProvenance;
  coverage: DoctorCoverage;
  summary: { errors: number; warnings: number; infos: number; total: number };
  findings: DoctorFinding[];
  /** Rollups that are healthy and therefore not findings. Calm, quiet numbers. */
  vitals: DoctorVital[];
  /** Warnings about things that have not broken yet. */
  prevention: DoctorFinding[];
  gateway: {
    reachable: boolean;
    port: number;
    runtimeVersion: string | null;
    cliVersion: string | null;
    nodeVersion: string | null;
    uptimeMs: number | null;
  };
};

/** A healthy measured number worth showing without dressing it as a problem. */
export type DoctorVital = {
  id: string;
  label: string;
  value: string;
  /** Optional secondary detail, e.g. "318 GB free of 494 GB". */
  detail?: string;
  status: "ok" | "unknown";
  source: DoctorSourceKind;
};
