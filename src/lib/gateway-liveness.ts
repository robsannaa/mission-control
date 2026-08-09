/**
 * Gateway liveness probe.
 *
 * OpenClaw documents `GET /health` as the endpoint for exactly this: it answers
 * instantly, needs no auth, creates no session, and returns
 * `{"ok":true,"status":"live"}`.
 *
 * Probing the gateway root instead reports a healthy gateway as offline or
 * degraded whenever `/` is not a plain 200 — the Control UI can be disabled,
 * served behind a reverse proxy, or gated by auth. `/health` is also cheap
 * enough to poll, unlike `openclaw health --json`, which loads every plugin.
 */

const PROBE_TIMEOUT_MS = 3_000;

/** True when the gateway answers its health endpoint as live. */
export async function probeGatewayLiveness(
  gatewayUrl: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const base = gatewayUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { ok?: unknown } | null;
      // Treat a 200 without a parsable body as live: some proxies rewrite it.
      return body?.ok !== false;
    }
    // A 404 means this build predates /health; fall back to the root probe so
    // older gateways are not reported offline.
    if (res.status === 404) {
      const root = await fetch(base, { signal: AbortSignal.timeout(timeoutMs) });
      return root.ok;
    }
    return false;
  } catch {
    return false;
  }
}
