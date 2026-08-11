/**
 * Turn a Skills-inventory load failure into something a person can act on.
 *
 * Issue #73: on an old OpenClaw, the Skills page always read "Degraded". The
 * cause was version-specific — Mission Control used to shell out to
 * `openclaw skills list --json`, and that CLI prints nothing when stdout is not
 * a TTY (a subprocess never has one), so the parse failed with a bare
 * "empty output". v0.9.0 reads the inventory over the `skills.status` gateway
 * RPC instead (no subprocess, no TTY), which fixes it outright.
 *
 * The RPC → CLI → filesystem fallback chain can still bottom out on a gateway so
 * old it predates `skills.status` *and* has the TTY-gated CLI. When it does, the
 * route used to surface the raw parser error. This maps the known failure shapes
 * to plain language so the page explains what happened and what to do, instead
 * of showing an opaque status word.
 *
 * Pure function — no gateway, no IO — so it unit-tests under the CI project.
 */
export function describeSkillsFailure(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)) || "";
  const lower = raw.toLowerCase();

  // The TTY-gated CLI signature: `skills list --json` returned nothing, so the
  // JSON parser threw "empty output". This only reaches here when the RPC was
  // also unavailable — i.e. the gateway is too old to report skills to a
  // headless dashboard. Point at the real fix: update OpenClaw.
  if (/empty output|no output|returned nothing/.test(lower)) {
    return "Couldn't read your skills. This usually means OpenClaw is out of date — its command-line tool doesn't report skills to a background dashboard. Update OpenClaw to the latest version, then reload this page.";
  }

  // Gateway unreachable — the RPC couldn't connect at all.
  if (/econnrefused|connection refused|fetch failed|not responding|unreachable|timed out|timeout|etimedout/.test(lower)) {
    return "Can't reach OpenClaw right now. Make sure it's running, then reload this page.";
  }

  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return cleaned ? `Couldn't load skills: ${cleaned}` : "Couldn't load skills. Please reload the page.";
}
