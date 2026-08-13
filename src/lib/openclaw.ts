/**
 * Primary OpenClaw client — all server-side code should import from here.
 *
 * Routes every call through the unified OpenClawClient which selects the
 * best transport automatically (HTTP to Gateway when available, CLI
 * subprocess as fallback). Works on Mac and Linux.
 *
 * Internal modules (transports, openclaw-cli.ts) should NOT be imported
 * directly from API routes or lib helpers.
 */

import { getClient, getTransportMode, type TransportMode } from "./openclaw-client";
import type { RunCliResult } from "./openclaw-cli";
import { toPairingRequiredError } from "./gateway-errors";

export type { RunCliResult } from "./openclaw-cli";
export { parseJsonFromCliOutput } from "./openclaw-cli";
export { getClient } from "./openclaw-client";

/**
 * Budget for a CLI *write* to the config.
 *
 * `openclaw config set` is not a cheap file edit: the subprocess initialises the
 * full plugin loader and runs doctor checks first, so on a cold cache — a large
 * plugin set, slow disk, or the first call after an update rebuilds it — it can
 * take far longer than a read. The default 15s produced the worst possible
 * outcome, aborting mid-write and reporting "This operation was aborted" for a
 * change that may already have landed (#82). Prefer waiting to that ambiguity.
 */
export const CONFIG_WRITE_TIMEOUT_MS = 60_000;

export async function runCli(
  args: string[],
  timeout = 15000,
  stdin?: string,
): Promise<string> {
  const client = await getClient();
  return client.run(args, timeout, stdin);
}

export async function runCliJson<T>(
  args: string[],
  timeout = 15000,
): Promise<T> {
  const client = await getClient();
  return client.runJson<T>(args, timeout);
}

export async function runCliCaptureBoth(
  args: string[],
  timeout = 15000,
): Promise<RunCliResult> {
  const client = await getClient();
  return client.runCapture(args, timeout);
}

export async function gatewayCall<T>(
  method: string,
  params?: Record<string, unknown>,
  timeout = 15000,
): Promise<T> {
  const client = await getClient();
  try {
    return await client.gatewayRpc<T>(method, params, timeout);
  } catch (err) {
    // A pairing/scope refusal is an actionable approval moment, not a generic
    // failure: rethrow it typed so routes can answer 428 and the UI can offer
    // the approve flow instead of rendering an empty page.
    throw toPairingRequiredError(err) ?? err;
  }
}

export async function resolveTransport(): Promise<TransportMode> {
  const client = await getClient();
  return client.resolveTransport();
}

export function configuredTransport(): TransportMode {
  return getTransportMode();
}

/**
 * Execute an argv array on the Mission Control host without ever serialising
 * it into a shell command. This is intentionally separate from the transport
 * abstraction: catalog Git/Skills.sh references are user input, while the
 * HTTP exec bridge currently accepts only a command string.
 */
export async function runLocalCliCapture(
  args: string[],
  timeout = 15_000,
): Promise<RunCliResult> {
  const { runCliCaptureBoth } = await import("./openclaw-cli");
  return runCliCaptureBoth(args, timeout);
}
