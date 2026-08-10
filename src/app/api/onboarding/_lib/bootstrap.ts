/**
 * Fresh-machine bootstrap — shared by the wizard's model step and the
 * gateway step's "Start" action.
 *
 * On a machine with no `openclaw.json` yet, neither `config.patch` (nothing
 * to patch a running gateway into) nor `openclaw gateway start` (nothing
 * installed to start) has anywhere to land. The one command proven to work
 * from empty is `openclaw onboard --non-interactive`, which is exactly what
 * the legacy /api/onboard `save-and-restart` action already runs — this
 * module lets the wizard call the same bootstrap instead of only being
 * reachable through the old non-wizard endpoint.
 *
 * Verified in a sandboxed gateway (temp OPENCLAW_HOME, no prior config):
 * `openclaw onboard --non-interactive --accept-risk --mode local
 * --auth-choice skip --install-daemon --daemon-runtime node` creates a valid
 * config, installs and starts the local service, and the gateway comes up
 * healthy afterward.
 */

import { access } from "fs/promises";
import { join } from "path";
import { runCliCaptureBoth } from "@/lib/openclaw";
import { getOpenClawHome } from "@/lib/paths";

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function configFileExists(): Promise<boolean> {
  return fileExists(join(getOpenClawHome(), "openclaw.json"));
}

const isHosted =
  process.env.AGENTBAY_HOSTED === "true" || process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";

export type BootstrapResult = { ok: true } | { ok: false; error: string };

/**
 * Create a working config (and, outside hosted containers, install + start
 * the local gateway service) from nothing. Safe to call repeatedly — it's a
 * no-op once `openclaw.json` exists.
 */
export async function bootstrapFreshMachine(): Promise<BootstrapResult> {
  if (await configFileExists()) return { ok: true };

  const args = [
    "onboard",
    "--non-interactive",
    "--accept-risk",
    "--mode",
    "local",
    "--auth-choice",
    "skip",
    "--skip-channels",
    "--skip-skills",
    "--skip-search",
    "--skip-ui",
  ];
  // Hosted containers already guarantee a running gateway — installing a
  // second local service inside it would be redundant, not helpful.
  if (isHosted) {
    args.push("--skip-health");
  } else {
    args.push("--install-daemon", "--daemon-runtime", "node");
  }

  try {
    const result = await runCliCaptureBoth(args, 60_000);
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || "").trim();
      return { ok: false, error: detail || `Bootstrap failed: exit code ${result.code}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
