/**
 * Every repair the Doctor page can perform, and exactly what each one costs.
 *
 * ## Why a catalog rather than a mode string
 *
 * The old surface exposed five *modes* (`scan`, `repair`, `repair-force`,
 * `deep`, `generate-token`) and let the UI decide what was safe. That put the
 * safety decision in the wrong layer: a stray `POST {mode:"repair-force"}` would
 * overwrite the owner's launchd definition, and nothing on the server said no.
 * Here, safety is a property of the fix, the API enforces it, and the UI is free
 * to render it however it likes.
 *
 * ## The uncomfortable truth about `doctor --fix`
 *
 * There is no per-check repair. `--only` exists for `--lint` and is *rejected*
 * for `--fix`. So several distinct findings share one command, and pressing
 * "fix" on any of them runs all of them. Pretending otherwise would be a lie the
 * user discovers afterwards, so `alsoResolves` is part of the fix contract and
 * the preview lists every finding the command will touch.
 *
 * ## Previews
 *
 * Three kinds, and the difference is stated rather than blurred:
 *   - `dry-run`     — the command itself supports `--dry-run` and we ran it. The
 *                     numbers are the real numbers.
 *   - `preflight`   — a gateway RPC that reports whether the action is safe
 *                     right now (`gateway.restart.preflight`).
 *   - `impact-list` — no dry run exists; we list the findings this command
 *                     claims to fix, from their own `fixHint`, plus the side
 *                     effects we know it has. Honest, but not a simulation.
 */

import type { DoctorFixSafety } from "./doctor-types";

export type FixPreviewKind = "dry-run" | "preflight" | "impact-list" | "none";

export type FixPlan = {
  id: string;
  label: string;
  safety: DoctorFixSafety;
  /** Present tense, plain language, no jargon. */
  whatItDoes: string;
  /** Consequences the user would not guess. Rendered as a list, verbatim. */
  sideEffects: string[];
  requiresRestart: boolean;
  previewKind: FixPreviewKind;
  /** Argv passed to `openclaw`. Empty when the fix is guidance only. */
  argv: string[];
  /** Argv for the dry run, when `previewKind === "dry-run"`. */
  previewArgv: string[] | null;
  /** Gateway RPC for `previewKind === "preflight"`. */
  preflightRpc: string | null;
  /**
   * How we prove it worked, rather than trusting the exit code.
   * `lint` re-runs the read-only lint pass and checks the finding is gone —
   * doctor does the same thing internally (it re-runs `detect()` scoped to the
   * repaired findings), which is what makes "verified fixed" distinguishable
   * from "claimed fixed".
   */
  verify: "lint" | "sessions-cleanup" | "none";
  timeoutMs: number;
  /** Findings this command also resolves, by finding id. */
  alsoResolves: string[];
};

export const FIX_PLANS: Record<string, FixPlan> = {
  "sessions-prune-missing": {
    id: "sessions-prune-missing",
    label: "Remove conversations whose files are gone",
    safety: "safe",
    whatItDoes:
      "Removes the list entries for conversations whose transcript files no longer exist on disk. Nothing readable is deleted — these entries already point at nothing.",
    sideEffects: [
      "The affected conversations disappear from your history list. Their content was already unrecoverable.",
      "Conversations with intact transcripts are untouched.",
    ],
    requiresRestart: false,
    previewKind: "dry-run",
    argv: ["sessions", "cleanup", "--enforce", "--fix-missing", "--json"],
    previewArgv: ["sessions", "cleanup", "--dry-run", "--fix-missing", "--json"],
    preflightRpc: null,
    verify: "sessions-cleanup",
    timeoutMs: 60_000,
    alsoResolves: [],
  },

  "doctor-fix": {
    id: "doctor-fix",
    label: "Apply OpenClaw's recommended repairs",
    safety: "caution",
    whatItDoes:
      "Runs OpenClaw's own repair pass: it reinstalls add-ons whose version has drifted, moves settings out of files newer versions no longer read, and archives leftover conversation files by renaming them rather than deleting them.",
    sideEffects: [
      "Your settings file is backed up first (openclaw.json.bak, keeping the last five).",
      "Settings OpenClaw does not recognise are removed from the file. If you hand-edited it with keys from a newer or older version, those keys are dropped.",
      "It does not touch the background service definition — that needs a separate, riskier step.",
      "Repairs OpenClaw has already declined (see the notice on the finding) stay declined.",
    ],
    requiresRestart: true,
    previewKind: "impact-list",
    argv: ["doctor", "--fix"],
    previewArgv: null,
    preflightRpc: null,
    verify: "lint",
    timeoutMs: 180_000,
    alsoResolves: [],
  },

  "disable-insecure-auth": {
    id: "disable-insecure-auth",
    label: "Turn off the relaxed sign-in setting",
    safety: "caution",
    whatItDoes:
      "Sets gateway.controlUi.allowInsecureAuth back to off, so the built-in web interface stops accepting the relaxed sign-in path it was left on for debugging.",
    sideEffects: [
      "If you reach the built-in Control UI over plain http from another machine, you will need to switch to https or a local connection first — otherwise sign-in stops working.",
      "Mission Control itself is unaffected; it authenticates with the gateway token.",
      "Takes effect after the gateway restarts.",
    ],
    requiresRestart: true,
    previewKind: "dry-run",
    argv: ["config", "set", "gateway.controlUi.allowInsecureAuth", "false", "--json"],
    previewArgv: [
      "config",
      "set",
      "gateway.controlUi.allowInsecureAuth",
      "false",
      "--dry-run",
      "--json",
    ],
    preflightRpc: null,
    verify: "none",
    timeoutMs: 90_000,
    alsoResolves: [],
  },

  "gateway-restart": {
    id: "gateway-restart",
    label: "Restart the background service",
    safety: "caution",
    whatItDoes:
      "Stops and starts the OpenClaw background service so pending settings changes take effect.",
    sideEffects: [
      "Anything the assistant is running right now is interrupted.",
      "Connected chat channels reconnect; messages sent during the restart may be delayed.",
      "The preview below reports whether anything is currently in flight.",
    ],
    requiresRestart: false,
    previewKind: "preflight",
    argv: ["gateway", "restart"],
    previewArgv: null,
    preflightRpc: "gateway.restart.preflight",
    verify: "none",
    timeoutMs: 120_000,
    alsoResolves: [],
  },

  "gateway-service-reinstall": {
    id: "gateway-service-reinstall",
    label: "Rewrite the background service definition",
    safety: "destructive",
    whatItDoes:
      "Regenerates the operating system service entry that starts OpenClaw at login, pointing it at the Node version currently in use.",
    sideEffects: [
      "Any hand-edits you made to the service file are overwritten and cannot be recovered.",
      "The service is stopped and restarted.",
      "Do this only after installing a supported Node version — otherwise it re-records the same problem.",
    ],
    requiresRestart: false,
    previewKind: "none",
    argv: ["gateway", "install", "--force"],
    previewArgv: null,
    preflightRpc: null,
    verify: "none",
    timeoutMs: 180_000,
    alsoResolves: [],
  },

  "doctor-fix-force": {
    id: "doctor-fix-force",
    label: "Apply aggressive repairs",
    safety: "destructive",
    whatItDoes:
      "Everything the recommended repair does, and additionally overwrites the operating system service definition that starts OpenClaw.",
    sideEffects: [
      "Hand-edited service configuration is overwritten and cannot be recovered.",
      "Settings OpenClaw does not recognise are removed from your settings file.",
      "The background service is restarted.",
    ],
    requiresRestart: true,
    previewKind: "none",
    argv: ["doctor", "--fix", "--force"],
    previewArgv: null,
    preflightRpc: null,
    verify: "lint",
    timeoutMs: 300_000,
    alsoResolves: [],
  },

  "generate-gateway-token": {
    id: "generate-gateway-token",
    label: "Create a new gateway token",
    safety: "destructive",
    whatItDoes:
      "Replaces the shared secret that every client uses to talk to the gateway with a freshly generated one.",
    sideEffects: [
      "Mission Control loses its own connection until it picks up the new token — this page will stop loading data.",
      "Every paired device, phone, and script using the old token stops working until you give it the new one.",
      "There is no undo. The previous token is not recoverable from the interface.",
    ],
    requiresRestart: true,
    previewKind: "none",
    argv: ["doctor", "--generate-gateway-token", "--non-interactive"],
    previewArgv: null,
    preflightRpc: null,
    verify: "none",
    timeoutMs: 90_000,
    alsoResolves: [],
  },
};

export function getFixPlan(id: string): FixPlan | null {
  return Object.prototype.hasOwnProperty.call(FIX_PLANS, id) ? FIX_PLANS[id] : null;
}

/** Human-readable command, for the advanced disclosure and the report. */
export function fixCommand(plan: FixPlan): string {
  return plan.argv.length ? `openclaw ${plan.argv.join(" ")}` : "(guided steps only)";
}
