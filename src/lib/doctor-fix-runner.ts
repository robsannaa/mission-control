/**
 * Preview and apply a single repair, and prove afterwards whether it worked.
 *
 * ## Verified fixed vs claimed fixed
 *
 * OpenClaw's own repair loop returns `status: "repaired" | "skipped" | "failed"`
 * and then **re-runs detection scoped to the repaired findings**, warning if a
 * finding survived its own fix. That distinction is worth surfacing rather than
 * hiding behind a green tick, so every apply here ends with an independent
 * re-check:
 *
 *   - `verified-fixed`     — the finding is gone from a fresh read-only check.
 *   - `applied-unverified` — the command succeeded, but this fix has no
 *                            automatic way to confirm the result.
 *   - `still-present`      — the command reported success and the problem is
 *                            still there. The most useful outcome to know, and
 *                            the one a naive implementation reports as success.
 *   - `failed`             — the command itself failed.
 *
 * ## Safety
 *
 * `safety !== "safe"` requires `confirm: true` on the request. This is enforced
 * here rather than in the UI: the destructive operations touch the owner's real
 * machine (rewriting launchd definitions, rotating the gateway token that this
 * very page authenticates with), and a stray call must not be able to trigger
 * one.
 */

import { runOpenClaw, extractJson, invocationOf } from "./doctor-exec";
import { gatewayCall } from "./openclaw";
import { getFixPlan, type FixPlan } from "./doctor-fix-catalog";
import { runLint } from "./doctor-lint";
import { redact } from "./doctor-redact";
import { peekSnapshot, invalidateSnapshot } from "./doctor-snapshot";
import type { DoctorFinding } from "./doctor-types";

export type FixPreview = {
  fixId: string;
  label: string;
  safety: FixPlan["safety"];
  kind: FixPlan["previewKind"];
  /** True when the numbers below come from an actual dry run of the command. */
  simulated: boolean;
  /** Plain-language lines describing what will change. Render as a list. */
  changes: string[];
  sideEffects: string[];
  requiresConfirmation: boolean;
  requiresRestart: boolean;
  /** Findings this command will act on, by id and title. */
  affects: { id: string; title: string }[];
  /** Reason the action is currently inadvisable, if any. */
  blockers: string[];
  command: string;
  /** Raw dry-run/preflight payload, for the advanced disclosure. */
  raw: unknown;
  error: string | null;
};

type SessionsCleanupPayload = {
  beforeCount?: number;
  afterCount?: number;
  missing?: number;
  repaired?: number;
  pruned?: number;
  capped?: number;
  dmScopeRetired?: number;
  wouldMutate?: boolean;
  unreferencedArtifacts?: { scannedFiles?: number; removedFiles?: number; freedBytes?: number };
};

type ConfigSetPayload = {
  ok?: boolean;
  operations?: number;
  configPath?: string;
  changed?: boolean;
  dryRun?: boolean;
  checks?: { schema?: boolean; resolvability?: boolean; resolvabilityComplete?: boolean };
};

/**
 * The raw payload is surfaced to the UI behind an advanced disclosure, so it
 * gets the same scrubbing as anything else that leaves the server — dry-run
 * output carries absolute paths, and nothing guarantees a future field will not
 * carry a value.
 */
function redactPayload(payload: unknown): unknown {
  try {
    return JSON.parse(redact(JSON.stringify(payload)));
  } catch {
    return null;
  }
}

type RestartPreflightPayload = {
  safe?: boolean;
  counts?: Record<string, number>;
  blockers?: { kind?: string; message?: string }[];
  summary?: string;
};

async function affectedFindings(fixId: string): Promise<{ id: string; title: string }[]> {
  const snapshot = await peekSnapshot();
  if (!snapshot) return [];
  return snapshot.findings
    .filter((f: DoctorFinding) => f.fix?.id === fixId)
    .map((f) => ({ id: f.id, title: f.title }));
}

async function blockedReasons(fixId: string): Promise<string[]> {
  const snapshot = await peekSnapshot();
  if (!snapshot) return [];
  const reasons = new Set<string>();
  for (const f of snapshot.findings) {
    if (f.fix?.id === fixId && f.fix.blocked) reasons.add(f.fix.blocked.reason);
  }
  return [...reasons];
}

export async function previewFix(fixId: string): Promise<FixPreview | null> {
  const plan = getFixPlan(fixId);
  if (!plan) return null;

  const base: FixPreview = {
    fixId: plan.id,
    label: plan.label,
    safety: plan.safety,
    kind: plan.previewKind,
    simulated: false,
    changes: [],
    sideEffects: plan.sideEffects,
    requiresConfirmation: plan.safety !== "safe",
    requiresRestart: plan.requiresRestart,
    affects: await affectedFindings(plan.id),
    blockers: await blockedReasons(plan.id),
    command: plan.argv.length ? `openclaw ${plan.argv.join(" ")}` : "",
    raw: null,
    error: null,
  };

  if (plan.previewKind === "dry-run" && plan.previewArgv) {
    const [result] = await Promise.all([
      runOpenClaw(plan.previewArgv, 60_000),
      readCurrentFlags(),
    ]);
    const payload = extractJson<SessionsCleanupPayload & ConfigSetPayload>(result.stdout);
    if (!payload) {
      return {
        ...base,
        error: `The preview could not run: ${redact((result.stderr || result.stdout).trim().slice(0, 300))}`,
      };
    }
    return {
      ...base,
      simulated: true,
      raw: redactPayload(payload),
      changes: describeDryRun(plan.id, payload),
    };
  }

  if (plan.previewKind === "preflight" && plan.preflightRpc) {
    const payload = await gatewayCall<RestartPreflightPayload>(plan.preflightRpc, {}, 8000).catch(
      () => null,
    );
    if (!payload) {
      return { ...base, error: "The gateway did not answer, so we cannot tell whether this is safe right now." };
    }
    const blockers = (payload.blockers ?? []).map((b) => redact(b.message ?? b.kind ?? "busy"));
    return {
      ...base,
      simulated: true,
      raw: payload,
      changes: payload.safe
        ? ["Nothing is running right now, so a restart interrupts nothing."]
        : [
            `${payload.counts?.totalActive ?? blockers.length} thing(s) are in progress and would be interrupted.`,
          ],
      blockers: [...base.blockers, ...blockers],
    };
  }

  if (plan.previewKind === "impact-list") {
    return {
      ...base,
      changes: base.affects.length
        ? base.affects.map((a) => `Attempts to resolve: ${a.title}`)
        : ["No current finding claims this command will fix it."],
    };
  }

  return base;
}

function describeDryRun(
  fixId: string,
  payload: SessionsCleanupPayload & ConfigSetPayload,
): string[] {
  if (fixId === "sessions-prune-missing") {
    const lines: string[] = [];
    if (typeof payload.missing === "number") {
      lines.push(
        `${payload.missing} conversation entr${payload.missing === 1 ? "y" : "ies"} whose transcript file is gone will be removed.`,
      );
    }
    if (typeof payload.beforeCount === "number" && typeof payload.afterCount === "number") {
      lines.push(
        `Your conversation list goes from ${payload.beforeCount} to ${payload.afterCount} entries.`,
      );
    }
    const artifacts = payload.unreferencedArtifacts;
    if (artifacts?.scannedFiles) {
      lines.push(
        `${artifacts.scannedFiles} stored files were checked; ${artifacts.removedFiles ?? 0} will be removed.`,
      );
    }
    if (payload.wouldMutate === false) lines.push("Nothing would change — there is nothing to clean up.");
    return lines;
  }

  if (fixId === "disable-insecure-auth") {
    if (payload.changed === false) return ["This setting is already off. Nothing would change."];
    // `config set --dry-run --json` reports that the operation is valid, not
    // what the old value was. Stating a before/after from assumed defaults
    // would be inventing the interesting half of the sentence, so the current
    // value is read from the settings file — a real second source — and the
    // schema result is reported as what it actually is.
    const lines = [
      `gateway.controlUi.allowInsecureAuth will be set to false${
        currentInsecureAuth === undefined
          ? ""
          : ` (currently ${JSON.stringify(currentInsecureAuth)})`
      }.`,
    ];
    if (payload.checks?.schema) {
      lines.push("OpenClaw checked the change against its settings schema and accepted it.");
    }
    if (typeof payload.operations === "number") {
      lines.push(`${payload.operations} setting will be written.`);
    }
    return lines;
  }

  return [JSON.stringify(payload)];
}

/**
 * Current value of the one config flag a fix targets, read straight from
 * openclaw.json. Cached per call chain rather than per process, because the
 * point is to reflect the file as it is right now.
 */
let currentInsecureAuth: unknown;

async function readCurrentFlags(): Promise<void> {
  try {
    const { readConfigFile } = await import("./paths");
    const config = (await readConfigFile()) as {
      gateway?: { controlUi?: { allowInsecureAuth?: unknown } };
    };
    currentInsecureAuth = config?.gateway?.controlUi?.allowInsecureAuth;
  } catch {
    currentInsecureAuth = undefined;
  }
}

export type FixOutcome = {
  fixId: string;
  status: "verified-fixed" | "applied-unverified" | "still-present" | "failed" | "refused";
  exitCode: number | null;
  durationMs: number;
  /** Plain-language result line. */
  message: string;
  /** What the verification pass observed, when one ran. */
  verification: { ran: boolean; method: string; detail: string } | null;
  requiresRestart: boolean;
  raw: { stdout: string; stderr: string };
};

export type ApplyOptions = {
  confirm?: boolean;
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  onStage?: (stage: string, label: string) => void;
};

/** One repair at a time, process-wide. Two concurrent `doctor --fix` runs race. */
let fixInFlight = false;

export function isFixInFlight(): boolean {
  return fixInFlight;
}

export async function applyFix(fixId: string, options: ApplyOptions = {}): Promise<FixOutcome> {
  const plan = getFixPlan(fixId);
  if (!plan) {
    return {
      fixId,
      status: "refused",
      exitCode: null,
      durationMs: 0,
      message: `There is no repair called "${fixId}".`,
      verification: null,
      requiresRestart: false,
      raw: { stdout: "", stderr: "" },
    };
  }

  if (plan.safety !== "safe" && options.confirm !== true) {
    return {
      fixId,
      status: "refused",
      exitCode: null,
      durationMs: 0,
      message:
        plan.safety === "destructive"
          ? "This repair overwrites things that cannot be recovered, so it will not run without explicit confirmation."
          : "This repair changes real settings, so it will not run without explicit confirmation.",
      verification: null,
      requiresRestart: plan.requiresRestart,
      raw: { stdout: "", stderr: "" },
    };
  }

  if (!plan.argv.length) {
    return {
      fixId,
      status: "refused",
      exitCode: null,
      durationMs: 0,
      message: "This problem is fixed by following the steps, not by running a command.",
      verification: null,
      requiresRestart: plan.requiresRestart,
      raw: { stdout: "", stderr: "" },
    };
  }

  if (fixInFlight) {
    return {
      fixId,
      status: "refused",
      exitCode: null,
      durationMs: 0,
      message: "Another repair is already running. Wait for it to finish.",
      verification: null,
      requiresRestart: plan.requiresRestart,
      raw: { stdout: "", stderr: "" },
    };
  }

  fixInFlight = true;
  const startedAt = Date.now();
  try {
    options.onStage?.("apply", `Running ${invocationOf(plan.argv)}`);
    const result = await runOpenClaw(plan.argv, plan.timeoutMs, options.onOutput);
    const failed = result.spawnError != null || result.timedOut || (result.code ?? 1) > 1;

    // The snapshot is stale the moment anything changes.
    invalidateSnapshot();

    if (failed) {
      return {
        fixId,
        status: "failed",
        exitCode: result.code,
        durationMs: Date.now() - startedAt,
        message: result.timedOut
          ? "The repair took too long and was stopped. Nothing is guaranteed to have changed."
          : `The repair did not complete: ${redact((result.stderr || result.stdout).trim().slice(0, 300))}`,
        verification: null,
        requiresRestart: plan.requiresRestart,
        raw: { stdout: redact(result.stdout), stderr: redact(result.stderr) },
      };
    }

    options.onStage?.("verify", "Checking whether the problem is actually gone");
    const verification = await verifyFix(plan);

    return {
      fixId,
      status: verification.status,
      exitCode: result.code,
      durationMs: Date.now() - startedAt,
      message: verification.message,
      verification: verification.detail,
      requiresRestart: plan.requiresRestart,
      raw: { stdout: redact(result.stdout), stderr: redact(result.stderr) },
    };
  } finally {
    fixInFlight = false;
  }
}

async function verifyFix(plan: FixPlan): Promise<{
  status: FixOutcome["status"];
  message: string;
  detail: FixOutcome["verification"];
}> {
  if (plan.verify === "lint") {
    const lint = await runLint(90_000);
    if (!lint.run.ok) {
      return {
        status: "applied-unverified",
        message:
          "The repair ran, but the follow-up check could not complete, so we cannot confirm the problem is gone.",
        detail: { ran: true, method: "read-only health check", detail: lint.run.error ?? "unknown" },
      };
    }
    const affected = await affectedFindings(plan.id);

    /*
     * A lint re-run can only speak about findings lint itself produced. Ones
     * sourced from the legacy pass or the security audit carry a different id
     * prefix, so they can never appear in `stillPresent` — and reading that
     * silence as proof of repair is how a fix claims "confirmed gone" for a
     * problem it never looked at. Say what was verified and what was not.
     */
    const verifiable = affected.filter((a) => a.id.startsWith("lint:"));
    const unverifiable = affected.filter((a) => !a.id.startsWith("lint:"));

    const stillPresent = verifiable.filter((a) =>
      lint.groups.some((g) => `lint:${g.checkId}` === a.id),
    );
    if (stillPresent.length) {
      return {
        status: "still-present",
        message: `The repair ran and reported success, but ${stillPresent.length} of the problems it was meant to fix are still there.`,
        detail: {
          ran: true,
          method: "read-only health check",
          detail: stillPresent.map((s) => s.title).join("; "),
        },
      };
    }

    if (unverifiable.length) {
      return {
        status: "applied-unverified",
        message:
          verifiable.length > 0
            ? `The repair ran and the problems the quick check covers are gone, but it cannot confirm ${unverifiable.length === 1 ? "one other problem" : `${unverifiable.length} other problems`} this repair was meant to fix. Run a full check to be sure.`
            : `The repair ran, but the quick check does not cover ${unverifiable.length === 1 ? "the problem" : "the problems"} it was meant to fix, so we cannot confirm it worked. Run a full check to be sure.`,
        detail: {
          ran: true,
          method: "read-only health check",
          detail: `not covered by the quick check: ${unverifiable.map((u) => u.title).join("; ")}`,
        },
      };
    }

    return {
      status: "verified-fixed",
      message: "The repair ran and a fresh check confirms the problem is gone.",
      detail: {
        ran: true,
        method: "read-only health check",
        detail: `${lint.groups.length} check(s) still reporting something`,
      },
    };
  }

  if (plan.verify === "sessions-cleanup" && plan.previewArgv) {
    const result = await runOpenClaw(plan.previewArgv, 60_000);
    const payload = extractJson<SessionsCleanupPayload>(result.stdout);
    if (!payload) {
      return {
        status: "applied-unverified",
        message: "The repair ran, but the follow-up check could not be read.",
        detail: { ran: true, method: "cleanup dry run", detail: "unreadable output" },
      };
    }
    if ((payload.missing ?? 0) > 0) {
      return {
        status: "still-present",
        message: `The repair ran, but ${payload.missing} entries with missing files remain.`,
        detail: { ran: true, method: "cleanup dry run", detail: `missing: ${payload.missing}` },
      };
    }
    return {
      status: "verified-fixed",
      message: "The repair ran and a fresh check confirms nothing is left to clean up.",
      detail: {
        ran: true,
        method: "cleanup dry run",
        detail: `missing: 0, list now ${payload.beforeCount ?? "?"} entries`,
      },
    };
  }

  return {
    status: "applied-unverified",
    message:
      "The repair ran successfully. There is no automatic way to confirm the result for this one.",
    detail: null,
  };
}
