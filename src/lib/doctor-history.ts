/**
 * Persistent run history — the Doctor page's time dimension.
 *
 * Storage: `$OPENCLAW_HOME/ui/doctor-history.json`, atomic write, 50-run ring,
 * raw transcript capped. That design was sound and is kept.
 *
 * ## Why the schema version is 2
 *
 * Version 1 rows were produced by the regex classifier: nine "issues" per run,
 * six of them fragments of wrapped sentences, none of them the machine's actual
 * problems. Diffing a v2 run against those would manufacture a fake regression
 * on the first load ("8 issues resolved!") purely because the parser changed.
 * So v1 rows are discarded on read rather than migrated — there is nothing in
 * them worth carrying forward, and `discardedLegacyRuns` records that it
 * happened so the UI can say "history starts here" instead of "you were
 * healthy before".
 *
 * ## What a run record holds now
 *
 * The full snapshot, not a summary. That is what makes regressions answerable
 * at the level a person asks them: not "warnings went from 3 to 4" but "this
 * exact finding is new since yesterday, and that one you fixed has come back".
 */

import { join } from "path";
import { readFile, writeFile, rename, mkdir, unlink } from "fs/promises";
import { randomUUID } from "crypto";
import { getOpenClawHome } from "@/lib/paths";
import type { DoctorSnapshot, DoctorTrendPoint } from "./doctor-types";

const MAX_RUNS = 50;
const MAX_RAW_OUTPUT_BYTES = 50 * 1024;
export const HISTORY_VERSION = 2;

export type DoctorRunRecord = {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** What the user asked for: `lint`, `full`, `deep`, or a fix id. */
  mode: string;
  /** Process exit code when a single command backed the run, else null. */
  exitCode: number | null;
  summary: { errors: number; warnings: number; infos: number; total: number };
  score: number | null;
  /** The complete snapshot, so history can diff findings and not just counts. */
  snapshot: DoctorSnapshot;
  /** Raw CLI transcript, redacted and truncated. Empty for RPC-only runs. */
  rawOutput: string;
};

type HistoryFile = {
  version: typeof HISTORY_VERSION;
  /** Count of v1 rows dropped on upgrade, so the UI can explain the gap. */
  discardedLegacyRuns: number;
  runs: DoctorRunRecord[];
};

function historyPath(): string {
  return join(getOpenClawHome(), "ui", "doctor-history.json");
}

async function loadHistory(): Promise<HistoryFile> {
  try {
    const raw = await readFile(historyPath(), "utf-8");
    const data = JSON.parse(raw) as Partial<HistoryFile> & { version?: number; runs?: unknown[] };
    if (data.version === HISTORY_VERSION && Array.isArray(data.runs)) {
      return {
        version: HISTORY_VERSION,
        discardedLegacyRuns: data.discardedLegacyRuns ?? 0,
        runs: data.runs as DoctorRunRecord[],
      };
    }
    // Older schema: drop the rows, remember how many, keep going.
    return {
      version: HISTORY_VERSION,
      discardedLegacyRuns: Array.isArray(data.runs) ? data.runs.length : 0,
      runs: [],
    };
  } catch {
    return { version: HISTORY_VERSION, discardedLegacyRuns: 0, runs: [] };
  }
}

async function writeHistory(history: HistoryFile): Promise<void> {
  await mkdir(join(getOpenClawHome(), "ui"), { recursive: true });
  const path = historyPath();
  const tmp = `${path}.tmp.${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmp, JSON.stringify(history), "utf-8");
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function saveDoctorRun(run: DoctorRunRecord): Promise<void> {
  const record: DoctorRunRecord = {
    ...run,
    rawOutput:
      run.rawOutput.length > MAX_RAW_OUTPUT_BYTES
        ? `${run.rawOutput.slice(0, MAX_RAW_OUTPUT_BYTES)}\n… (truncated)`
        : run.rawOutput,
  };
  const history = await loadHistory();
  history.runs.unshift(record);
  if (history.runs.length > MAX_RUNS) history.runs = history.runs.slice(0, MAX_RUNS);
  await writeHistory(history);
}

export async function listDoctorRuns(
  limit = 20,
  offset = 0,
): Promise<{ runs: DoctorRunRecord[]; total: number; discardedLegacyRuns: number }> {
  const history = await loadHistory();
  return {
    runs: history.runs.slice(offset, offset + limit),
    total: history.runs.length,
    discardedLegacyRuns: history.discardedLegacyRuns,
  };
}

export async function deleteDoctorRun(id: string): Promise<boolean> {
  const history = await loadHistory();
  const before = history.runs.length;
  history.runs = history.runs.filter((r) => r.id !== id);
  if (history.runs.length === before) return false;
  await writeHistory(history);
  return true;
}

/** The most recent completed run, or null. Used to serve a cached snapshot. */
export async function getLatestRun(): Promise<DoctorRunRecord | null> {
  const history = await loadHistory();
  return history.runs[0] ?? null;
}

export async function getLastRunTimestamp(): Promise<number | null> {
  return (await getLatestRun())?.completedAt ?? null;
}

export type DoctorDiff = {
  /** Findings present now that were absent in the comparison run. */
  newFindings: { id: string; title: string; severity: string }[];
  /** Findings present then and gone now. */
  resolvedFindings: { id: string; title: string; severity: string }[];
  /** Findings that were resolved at some point and have come back. */
  regressions: { id: string; title: string; severity: string; lastSeenAt: number }[];
  scoreDelta: number | null;
  comparedTo: { id: string; completedAt: number } | null;
  /**
   * Sources that ran in one snapshot but not the other, so their findings were
   * excluded from the comparison. The UI should say so rather than implying the
   * unchecked areas were clean.
   */
  notComparable: string[];
};

const SOURCE_LABELS: Record<string, string> = {
  lint: "the read-only checks",
  legacy: "the full check",
  "security-audit": "the security audit",
  "secrets-audit": "the credential audit",
  runtime: "live gateway status",
};

/** Which provenance entry backs a finding of this source. */
function sourceRan(snapshot: DoctorSnapshot, source: string): boolean {
  const p = snapshot.provenance;
  switch (source) {
    case "lint":
      return p.lint.ran && p.lint.ok;
    case "legacy":
      return p.legacy.ran && p.legacy.ok;
    case "security-audit":
      return p.securityAudit.ran && p.securityAudit.ok;
    case "secrets-audit":
      return p.secretsAudit.ran && p.secretsAudit.ok;
    case "runtime":
      return p.runtime.ran && p.runtime.ok;
    default:
      return false;
  }
}

/**
 * Compare a snapshot against the previous run, and flag genuine regressions.
 *
 * A regression is stronger than "new": it is a finding that appeared, went away
 * in a later run, and has returned. That distinction is what makes the claim
 * "this started after the last update" defensible rather than decorative, so it
 * is computed from the full history rather than the immediately previous run.
 *
 * ## Coverage-aware comparison
 *
 * Findings are only compared across runs where **the source that produces them
 * ran in both**. Without that rule, a `quick` run followed by a `deep` one
 * reports every legacy finding as brand new and — worse — as a *regression*,
 * because the quick run in between never looked. The first version of this
 * function did exactly that: it claimed the unsupported Node had regressed,
 * when the truth was that one run had not checked for it. A time dimension that
 * manufactures history is worse than none.
 */
export async function diffAgainstHistory(snapshot: DoctorSnapshot): Promise<DoctorDiff> {
  const history = await loadHistory();
  // Skip the run that *is* this snapshot: `collectSnapshotShared` persists
  // before the caller asks for a diff, and comparing a run against itself would
  // report every machine as unchanged forever.
  const older = history.runs.filter((r) => r.snapshot?.ts !== snapshot.ts);
  const previous = older[0] ?? null;

  const comparable = (source: string, other: DoctorSnapshot | undefined) =>
    Boolean(other) && sourceRan(snapshot, source) && sourceRan(other!, source);

  const notComparable = new Set<string>();
  const sourcesPresent = new Set([
    ...snapshot.findings.map((f) => f.source),
    ...(previous?.snapshot.findings ?? []).map((f) => f.source),
  ]);
  for (const source of sourcesPresent) {
    if (!comparable(source, previous?.snapshot)) {
      notComparable.add(SOURCE_LABELS[source] ?? source);
    }
  }

  const nowIds = new Map(snapshot.findings.map((f) => [f.id, f]));
  const thenIds = new Map((previous?.snapshot.findings ?? []).map((f) => [f.id, f]));

  const newFindings = [...nowIds.values()]
    .filter((f) => comparable(f.source, previous?.snapshot) && !thenIds.has(f.id))
    .map((f) => ({ id: f.id, title: f.title, severity: f.severity }));

  const resolvedFindings = [...thenIds.values()]
    .filter((f) => comparable(f.source, previous?.snapshot) && !nowIds.has(f.id))
    .map((f) => ({ id: f.id, title: f.title, severity: f.severity }));

  // Walk backwards through runs that actually checked this finding's source.
  // A run that skipped the source is not evidence of absence, so it is stepped
  // over rather than counted as a clean result.
  const regressions: DoctorDiff["regressions"] = [];
  for (const candidate of newFindings) {
    const source = nowIds.get(candidate.id)?.source;
    if (!source) continue;
    let sawClean = false;
    for (const run of older) {
      if (!run.snapshot || !sourceRan(run.snapshot, source)) continue;
      if (!run.snapshot.findings.some((f) => f.id === candidate.id)) {
        sawClean = true;
        continue;
      }
      if (sawClean) {
        regressions.push({ ...candidate, lastSeenAt: run.completedAt });
        break;
      }
      // Present in the most recent run that checked, with no clean run
      // between: this is continuous, not a regression.
      break;
    }
  }

  return {
    newFindings,
    resolvedFindings,
    regressions,
    scoreDelta:
      snapshot.health.score != null && previous?.score != null
        ? snapshot.health.score - previous.score
        : null,
    comparedTo: previous ? { id: previous.id, completedAt: previous.completedAt } : null,
    notComparable: [...notComparable],
  };
}

/** Compact series for a sparkline, oldest first. */
export async function getTrend(limit = 30): Promise<DoctorTrendPoint[]> {
  const history = await loadHistory();
  return history.runs
    .slice(0, limit)
    .map((run) => ({
      ts: run.completedAt,
      score: run.score,
      errors: run.summary.errors,
      warnings: run.summary.warnings,
      infos: run.summary.infos,
      // Carried so the chart can refuse to connect runs of different depth.
      mode: run.mode,
    }))
    .reverse();
}

export function createRunId(): string {
  return randomUUID();
}
