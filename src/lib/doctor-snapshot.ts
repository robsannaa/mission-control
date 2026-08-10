/**
 * Assembles one honest picture of the system from every source that has one.
 *
 * ## Depths
 *
 * | depth   | sources                                              | read-only | cost  |
 * |---------|------------------------------------------------------|-----------|-------|
 * | `quick` | lint, security audit, secrets audit, gateway RPCs     | **yes**   | ~7s   |
 * | `full`  | quick + the legacy human pass                         | no ⚠️      | ~15s  |
 * | `deep`  | full, with the legacy pass in `--deep` mode           | no ⚠️      | ~15s  |
 *
 * `quick` is what a page load or a poll gets. `full` and `deep` include
 * `openclaw doctor --non-interactive`, which **applies safe migrations and
 * state moves** — it is a repair pass wearing a scan's clothes, and the API
 * never lets it be mistaken for one.
 *
 * One honest caveat on `quick`: `doctor --lint` really is read-only, but
 * `security audit` and `secrets audit` run the CLI's own startup state-migration
 * pass, which prints `[state-migrations] Legacy state migration notes:` to
 * stderr and *may* move legacy state. On this machine it declined the only
 * pending migration ("Left plugin install index in place because …"), and that
 * notice is harvested here as the blocked-repair marker. So `quick` is read-only
 * in intent and in every observed run, but it inherits whatever the CLI decides
 * to migrate at startup, and this comment exists so nobody later claims
 * otherwise on the strength of the word "quick".
 *
 * ## Caching
 *
 * A doctor run spawns a subprocess that takes seconds and real CPU. A polling
 * UI must not cause one per tick, so a completed snapshot is held in memory and
 * mirrored to the run history, and concurrent callers share a single in-flight
 * run rather than queuing subprocesses behind each other.
 */

import { runLint, type LintResult } from "./doctor-lint";
import { runOpenClaw, invocationOf } from "./doctor-exec";
import { extractJson } from "./doctor-exec";
import { parseLegacyDoctorOutput } from "./doctor-checks";
import {
  applyBlockedRepairs,
  buildLegacyFindings,
  buildLintFindings,
  buildSecurityFindings,
  mergeSecretsAudit,
  linkCauses,
  linkSharedFixes,
  type SecretsAuditEnvelope,
  type SecurityAuditEnvelope,
} from "./doctor-knowledge";
import { collectRuntimeSignals } from "./doctor-signals";
import { computeCoverage, computeHealth } from "./doctor-score";
import { redact } from "./doctor-redact";
import { getLatestRun, saveDoctorRun, createRunId } from "./doctor-history";
import type {
  DoctorFinding,
  DoctorSnapshot,
  DoctorSourceRun,
  DoctorVital,
} from "./doctor-types";

export type SnapshotDepth = "quick" | "full" | "deep";

export type ProgressEvent =
  | { type: "phase"; phase: string; label: string; index: number; total: number }
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "phase-done"; phase: string; ok: boolean; durationMs: number; detail?: string };

const SECURITY_ARGS = ["security", "audit", "--json"];
const SECRETS_ARGS = ["secrets", "audit", "--json"];
const LEGACY_ARGS = ["doctor", "--non-interactive", "--no-workspace-suggestions"];
const LEGACY_DEEP_ARGS = ["doctor", "--deep", "--non-interactive", "--no-workspace-suggestions"];

function notRun(invocation: string): DoctorSourceRun {
  return { ran: false, ok: false, ts: null, durationMs: null, error: null, invocation };
}

async function runJsonSource<T>(
  args: string[],
  timeoutMs: number,
  onChunk?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<{ run: DoctorSourceRun; payload: T | null }> {
  const result = await runOpenClaw(args, timeoutMs, onChunk);
  const run: DoctorSourceRun = {
    ran: true,
    ok: false,
    ts: Date.now(),
    durationMs: result.durationMs,
    error: null,
    invocation: invocationOf(args),
  };
  if (result.spawnError) return { run: { ...run, error: result.spawnError }, payload: null };
  if (result.timedOut) {
    return { run: { ...run, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` }, payload: null };
  }
  const payload = extractJson<T>(result.stdout);
  if (!payload) {
    return {
      run: { ...run, error: "The command produced output we could not read." },
      payload: null,
    };
  }
  return { run: { ...run, ok: true }, payload };
}

export type CollectOptions = {
  depth?: SnapshotDepth;
  onProgress?: (event: ProgressEvent) => void;
};

export type CollectResult = {
  snapshot: DoctorSnapshot;
  /** Redacted CLI transcript of everything that ran. */
  transcript: string;
  startedAt: number;
};

export async function collectSnapshot(options: CollectOptions = {}): Promise<CollectResult> {
  const depth = options.depth ?? "quick";
  const emit = options.onProgress ?? (() => {});
  const startedAt = Date.now();
  const transcriptParts: string[] = [];

  // Always accumulated, never optional: the transcript is not only for the
  // shareable report — blocked-repair notices are recovered from it, and a
  // caller that opted out of the report would otherwise silently lose them.
  const capture = () => (stream: "stdout" | "stderr", text: string) => {
    // Redact on the way OUT as well as at rest. The stored transcript is
    // scrubbed at the end, but these lines reach the browser live, and one of
    // the commands doctor can run prints a freshly generated gateway token.
    emit({ type: "output", stream, text: redact(text) });
    transcriptParts.push(text);
  };

  const phases: string[] = ["lint", "security", "secrets", "runtime"];
  if (depth !== "quick") phases.push("legacy");
  const total = phases.length;
  const phaseIndex = (name: string) => phases.indexOf(name) + 1;

  // ── 1. Structured lint (read-only) ────────────────────────────────────────
  emit({
    type: "phase",
    phase: "lint",
    label: "Running OpenClaw's read-only health checks",
    index: phaseIndex("lint"),
    total,
  });
  const lint: LintResult = await runLint(90_000, capture());
  emit({
    type: "phase-done",
    phase: "lint",
    ok: lint.run.ok,
    durationMs: lint.run.durationMs ?? 0,
    detail: lint.envelope
      ? `${lint.envelope.checksRun} checks, ${lint.groups.length} reporting`
      : (lint.run.error ?? undefined),
  });

  // ── 2 & 3. Audits (read-only, independent — run together) ─────────────────
  emit({
    type: "phase",
    phase: "security",
    label: "Checking security settings",
    index: phaseIndex("security"),
    total,
  });
  emit({
    type: "phase",
    phase: "secrets",
    label: "Checking where passwords and keys are stored",
    index: phaseIndex("secrets"),
    total,
  });
  const [security, secrets] = await Promise.all([
    runJsonSource<SecurityAuditEnvelope>(SECURITY_ARGS, 60_000, capture()),
    runJsonSource<SecretsAuditEnvelope>(SECRETS_ARGS, 60_000, capture()),
  ]);
  emit({
    type: "phase-done",
    phase: "security",
    ok: security.run.ok,
    durationMs: security.run.durationMs ?? 0,
    detail: security.payload?.summary
      ? `${security.payload.summary.critical ?? 0} critical, ${security.payload.summary.warn ?? 0} warnings`
      : (security.run.error ?? undefined),
  });
  emit({
    type: "phase-done",
    phase: "secrets",
    ok: secrets.run.ok,
    durationMs: secrets.run.durationMs ?? 0,
    detail: secrets.payload?.summary
      ? `${secrets.payload.summary.plaintextCount ?? 0} stored in plain text`
      : (secrets.run.error ?? undefined),
  });

  // ── 4. Live gateway signals ───────────────────────────────────────────────
  emit({
    type: "phase",
    phase: "runtime",
    label: "Reading live status from the background service",
    index: phaseIndex("runtime"),
    total,
  });
  const runtime = await collectRuntimeSignals();
  emit({
    type: "phase-done",
    phase: "runtime",
    ok: runtime.run.ok,
    durationMs: runtime.run.durationMs ?? 0,
    detail: runtime.reachable ? "gateway responded" : "gateway did not answer",
  });

  // ── 5. Legacy pass (mutating — only on explicit request) ──────────────────
  let legacyRun: DoctorSourceRun = notRun(invocationOf(LEGACY_ARGS));
  let legacyFindings: DoctorFinding[] = [];
  let legacyVitals: DoctorVital[] = [];

  if (depth !== "quick") {
    const args = depth === "deep" ? LEGACY_DEEP_ARGS : LEGACY_ARGS;
    emit({
      type: "phase",
      phase: "legacy",
      label: "Running the full check (this also applies OpenClaw's safe migrations)",
      index: phaseIndex("legacy"),
      total,
    });
    const result = await runOpenClaw(args, 180_000, capture());
    const parse = parseLegacyDoctorOutput(result.stdout + result.stderr);
    const built = buildLegacyFindings(parse);
    legacyFindings = built.findings;
    legacyVitals = built.vitals;
    legacyRun = {
      ran: true,
      // The legacy pass exits 0 even with findings; only a crash or an
      // unfinished transcript means it failed.
      ok: parse.complete || parse.items.length > 0,
      ts: Date.now(),
      durationMs: result.durationMs,
      error: result.spawnError ?? (result.timedOut ? "Timed out" : null),
      invocation: invocationOf(args),
    };
    emit({
      type: "phase-done",
      phase: "legacy",
      ok: legacyRun.ok,
      durationMs: result.durationMs,
      detail: `${built.findings.length} findings, ${built.uncurated} not yet explained in plain language`,
    });
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  let findings: DoctorFinding[] = [
    ...buildLintFindings(lint.groups),
    ...legacyFindings,
    ...buildSecurityFindings(security.payload),
    ...runtime.findings,
  ];
  findings = mergeSecretsAudit(findings, secrets.payload);

  // Blocked-repair notices are scanned across everything that ran, not only the
  // legacy pass. `security audit` prints them to stderr on every invocation, so
  // even the read-only check learns that OpenClaw has already declined to
  // migrate the plugin install index — and the fix button for that finding is
  // suppressed instead of running a command that reports success and changes
  // nothing.
  const blockedRepairs = parseLegacyDoctorOutput(transcriptParts.join("")).blockedRepairs;
  findings = applyBlockedRepairs(findings, blockedRepairs);
  findings = linkSharedFixes(linkCauses(findings));

  const provenance = {
    lint: lint.run,
    legacy: legacyRun,
    securityAudit: security.run,
    secretsAudit: secrets.run,
    runtime: runtime.run,
  };

  const scoreInputs = {
    findings,
    prevention: runtime.prevention,
    provenance,
    runtime: runtime.score,
    checksRun: lint.envelope?.checksRun ?? null,
    checksSkipped: lint.envelope?.checksSkipped ?? null,
    legacyRan: legacyRun.ran && legacyRun.ok,
  };

  const health = computeHealth(scoreInputs);
  const coverage = computeCoverage(scoreInputs);

  const summary = { errors: 0, warnings: 0, infos: 0, total: findings.length };
  for (const f of findings) {
    if (f.severity === "error") summary.errors++;
    else if (f.severity === "warning") summary.warnings++;
    else summary.infos++;
  }

  const severityRank = { error: 0, warning: 1, info: 2 } as const;
  findings.sort((a, b) => {
    // Consequences sort directly under their cause rather than by severity, so
    // the chain reads top-down.
    if (a.causedBy === b.id) return 1;
    if (b.causedBy === a.id) return -1;
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return Number(a.informational) - Number(b.informational);
  });

  const snapshot: DoctorSnapshot = {
    version: 2,
    ts: Date.now(),
    cached: false,
    health,
    provenance,
    coverage,
    summary,
    findings,
    vitals: [...legacyVitals, ...runtime.vitals],
    prevention: runtime.prevention,
    gateway: {
      reachable: runtime.reachable,
      port: runtime.gateway.port,
      runtimeVersion: runtime.gateway.runtimeVersion,
      cliVersion: null,
      nodeVersion: runtime.gateway.nodeVersion,
      uptimeMs: runtime.gateway.uptimeMs,
    },
  };

  return { snapshot, transcript: redact(transcriptParts.join("")), startedAt };
}

// ── Cache and single-flight ─────────────────────────────────────────────────

/** Newest snapshot held in this process. Survives page navigation, not restarts. */
let memoryCache: { snapshot: DoctorSnapshot; transcript: string } | null = null;
let inFlight: Promise<CollectResult> | null = null;

/** Default freshness for `GET /api/doctor/status`. */
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;

/**
 * Run a collection, deduplicating concurrent callers.
 *
 * Two tabs opening the Doctor page at once must produce one subprocess, not
 * two. Progress callbacks are attached to whichever call actually started the
 * run; a caller that joins an in-flight run gets the result without narration.
 */
export async function collectSnapshotShared(options: CollectOptions = {}): Promise<CollectResult> {
  if (inFlight) return inFlight;
  inFlight = collectSnapshot(options)
    .then(async (result) => {
      memoryCache = { snapshot: result.snapshot, transcript: result.transcript };
      await persistRun(result, options.depth ?? "quick").catch(() => {});
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export async function persistRun(result: CollectResult, mode: string): Promise<void> {
  await saveDoctorRun({
    id: createRunId(),
    startedAt: result.startedAt,
    completedAt: result.snapshot.ts,
    durationMs: result.snapshot.ts - result.startedAt,
    mode,
    exitCode: null,
    summary: result.snapshot.summary,
    score: result.snapshot.health.score,
    snapshot: result.snapshot,
    rawOutput: result.transcript,
  });
}

/**
 * Best available snapshot without necessarily running anything.
 *
 * Order: in-memory cache → the newest stored run → a fresh `quick` collection.
 * A cached snapshot is returned with `cached: true` and its true age, so the UI
 * can say "checked 2 minutes ago" rather than implying it just looked.
 */
export async function getSnapshot(
  options: { maxAgeMs?: number; force?: boolean } = {},
): Promise<DoctorSnapshot> {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  if (!options.force) {
    const cached = memoryCache?.snapshot;
    if (cached && Date.now() - cached.ts <= maxAgeMs) return withAge(cached);

    const stored = await getLatestRun().catch(() => null);
    if (stored?.snapshot && Date.now() - stored.completedAt <= maxAgeMs) {
      memoryCache = { snapshot: stored.snapshot, transcript: stored.rawOutput };
      return withAge(stored.snapshot);
    }
  }

  const fresh = await collectSnapshotShared({ depth: "quick" });
  return fresh.snapshot;
}

/** Newest snapshot we hold, without running anything at all. */
export async function peekSnapshot(): Promise<DoctorSnapshot | null> {
  if (memoryCache) return withAge(memoryCache.snapshot);
  const stored = await getLatestRun().catch(() => null);
  if (!stored?.snapshot) return null;
  memoryCache = { snapshot: stored.snapshot, transcript: stored.rawOutput };
  return withAge(stored.snapshot);
}

export function peekTranscript(): string {
  return memoryCache?.transcript ?? "";
}

/** Invalidate the cache — called after a fix, so the next read re-checks. */
export function invalidateSnapshot(): void {
  memoryCache = null;
}

/**
 * Adopt a snapshot produced elsewhere (the streaming run endpoint) as the
 * current one. Without this, a run the user just watched complete would not be
 * what the next `GET /status` returns, and the page would appear to forget.
 */
export function primeCache(result: CollectResult): void {
  memoryCache = { snapshot: result.snapshot, transcript: result.transcript };
}

/** Re-stamp age fields so a cached snapshot never claims to be current. */
function withAge(snapshot: DoctorSnapshot): DoctorSnapshot {
  const ageMs = snapshot.health.checkedAt ? Date.now() - snapshot.health.checkedAt : null;
  return {
    ...snapshot,
    cached: true,
    health: {
      ...snapshot.health,
      ageMs,
      state:
        snapshot.health.state === "checked" && ageMs != null && ageMs > 15 * 60_000
          ? "stale"
          : snapshot.health.state,
    },
  };
}
