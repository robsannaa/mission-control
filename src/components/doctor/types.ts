/**
 * Client-side vocabulary for the Doctor page.
 *
 * The snapshot types are re-exported straight from the server's canonical
 * module — `@/lib/doctor-types` contains types only, so importing it costs the
 * client bundle nothing. The repair-flow types are *restated* here rather than
 * imported from `@/lib/doctor-fix-runner`, because that module pulls in child
 * process and filesystem code; the page must never reach for it, even through a
 * type-only edge.
 */

export type {
  DoctorConfidence,
  DoctorCoverage,
  DoctorFinding,
  DoctorFix,
  DoctorFixSafety,
  DoctorGuideStep,
  DoctorHealth,
  DoctorHealthState,
  DoctorProvenance,
  DoctorSeverity,
  DoctorSnapshot,
  DoctorSourceKind,
  DoctorSourceRun,
  DoctorTrendPoint,
  DoctorVital,
} from "@/lib/doctor-types";

import type { DoctorSnapshot, DoctorSeverity, DoctorTrendPoint } from "@/lib/doctor-types";

/** `GET /api/doctor/status` — snapshot plus the time dimension. */
export type DoctorStatusResponse = DoctorSnapshot & {
  diff: DoctorDiff | null;
  trend: DoctorTrendPoint[];
};

export type DoctorDiff = {
  newFindings: { id: string; title: string; severity: DoctorSeverity }[];
  resolvedFindings: { id: string; title: string; severity: DoctorSeverity }[];
  regressions: { id: string; title: string; severity: DoctorSeverity; lastSeenAt: number }[];
  scoreDelta: number | null;
  comparedTo: { id: string; completedAt: number } | null;
  /** Sources excluded from the comparison. Never render a diff without this. */
  notComparable: string[];
};

/* ── run ───────────────────────────────────────────────────────────────── */

export type RunMode = "quick" | "full" | "deep";

export type RunEvent =
  | { type: "start"; runId: string; mode: RunMode; readOnly: boolean; phases: number }
  | { type: "phase"; phase: string; label: string; index: number; total: number }
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "phase-done"; phase: string; ok: boolean; durationMs: number; detail?: string }
  | { type: "snapshot"; snapshot: DoctorSnapshot; diff: DoctorDiff | null }
  | { type: "done"; runId: string; durationMs: number }
  | { type: "error"; message: string };

/** One narrated step of a run, as the page tracks it. */
export type RunPhase = {
  phase: string;
  label: string;
  index: number;
  total: number;
  status: "running" | "ok" | "failed";
  durationMs: number | null;
  detail: string | null;
};

/* ── repair ────────────────────────────────────────────────────────────── */

export type FixPreviewKind = "dry-run" | "preflight" | "impact-list" | "none";

/** `GET /api/doctor/fix` — the whole catalog, for repairs a finding does not carry. */
export type FixPlanSummary = {
  id: string;
  label: string;
  safety: "safe" | "caution" | "destructive";
  whatItDoes: string;
  sideEffects: string[];
  requiresRestart: boolean;
  requiresConfirmation: boolean;
  previewKind: FixPreviewKind;
  command: string;
};

/**
 * The minimum a repair dialog needs. Both `DoctorFix` (attached to a finding)
 * and `FixPlanSummary` (from the catalog) satisfy it, so a guide step can open
 * the same dialog as a finding's own button.
 */
export type FixDescriptor = {
  id: string;
  label: string;
  safety: "safe" | "caution" | "destructive";
  whatItDoes: string;
  requiresRestart: boolean;
};

export type FixPreview = {
  fixId: string;
  label: string;
  safety: "safe" | "caution" | "destructive";
  kind: FixPreviewKind;
  /** True only when the numbers came from really running the dry run. */
  simulated: boolean;
  changes: string[];
  sideEffects: string[];
  requiresConfirmation: boolean;
  requiresRestart: boolean;
  affects: { id: string; title: string }[];
  blockers: string[];
  command: string;
  raw: unknown;
  error: string | null;
};

export type FixOutcomeStatus =
  | "verified-fixed"
  | "applied-unverified"
  | "still-present"
  | "failed"
  | "refused";

export type FixOutcome = {
  fixId: string;
  status: FixOutcomeStatus;
  exitCode: number | null;
  durationMs: number;
  message: string;
  verification: { ran: boolean; method: string; detail: string } | null;
  requiresRestart: boolean;
  raw: { stdout: string; stderr: string };
};

export type FixEvent =
  | {
      type: "start";
      fixId: string;
      label: string;
      safety: string;
      command: string;
      requiresRestart: boolean;
    }
  | { type: "stage"; stage: "apply" | "verify"; label: string }
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "outcome"; outcome: FixOutcome }
  | { type: "done" }
  | { type: "error"; message: string };

/* ── history ───────────────────────────────────────────────────────────── */

export type DoctorRunSummary = {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  mode: string;
  exitCode: number | null;
  summary: { errors: number; warnings: number; infos: number; total: number };
  score: number | null;
  findingCount: number;
  healthState: string | null;
  transcriptBytes: number;
};

export type DoctorHistoryResponse = {
  runs: DoctorRunSummary[];
  total: number;
  /** Pre-v2 records dropped on upgrade. "History starts here", not progress. */
  discardedLegacyRuns: number;
  trend: DoctorTrendPoint[];
};
