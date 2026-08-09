/**
 * Auto-enable the gateway's OpenResponses endpoint, which streaming chat needs.
 *
 * `gateway.http.endpoints.responses.enabled` is off by default, and enabling it
 * requires a config patch plus a gateway restart. This kicks that off in the
 * background from the health poll so a user who opens chat does not have to
 * discover the setting, and lets the chat routes wait on the in-flight attempt
 * rather than racing it.
 *
 * Attempts are rate-limited by a cooldown and never retried in a tight loop:
 * each one restarts the gateway, so a failing patch would otherwise become a
 * restart loop (#20).
 *
 * This lives in `lib` rather than beside the health route because Next.js 16
 * rejects a route module that exports anything other than route handlers and
 * its known config fields — importing these from `api/gateway/route.ts` failed
 * the production build with "'waitForResponsesEndpoint' is not a valid Route
 * export field".
 */

import { gatewayCall } from "./openclaw";
import { gatewayConfigPatch } from "./gateway-config";

let _ensured = false;
let _lastAttempt = 0;
const RETRY_COOLDOWN_MS = 5 * 60_000;

/** Resolves when the current setup attempt completes, successfully or not. */
let _setupPromise: Promise<void> | null = null;

/** Start the setup attempt unless one already succeeded or ran recently. */
export function triggerResponsesEndpointSetup(): void {
  if (_ensured) return;
  if (Date.now() - _lastAttempt < RETRY_COOLDOWN_MS) return;
  _lastAttempt = Date.now();

  // Fire-and-forget: the health check must not block on this.
  _setupPromise = (async () => {
    try {
      const cfg = await gatewayCall<{
        hash?: string;
        parsed?: Record<string, unknown>;
        config?: Record<string, unknown>;
      }>("config.get", undefined, 8000);

      // `parsed` is the current shape; `config` covers older gateways.
      const root = cfg?.parsed ?? cfg?.config ?? {};
      const gw = (root as Record<string, unknown>)?.gateway as Record<string, unknown> | undefined;
      const http = gw?.http as Record<string, unknown> | undefined;
      const endpoints = http?.endpoints as Record<string, unknown> | undefined;
      const responses = endpoints?.responses as Record<string, unknown> | undefined;
      if (responses?.enabled === true) {
        _ensured = true;
        return;
      }

      await gatewayConfigPatch(
        {
          raw: JSON.stringify({
            gateway: { http: { endpoints: { responses: { enabled: true } } } },
          }),
          baseHash: String(cfg?.hash || ""),
          restartDelayMs: 3000,
        },
        10000,
      );
      _ensured = true;
    } catch {
      // Non-fatal: streaming falls back to non-streaming. Deliberately does not
      // clear `_ensured` — the cooldown is what schedules the next attempt.
    } finally {
      _setupPromise = null;
    }
  })();
}

/**
 * Wait for an in-flight setup attempt, so a message sent before the health poll
 * has finished does not race the restart.
 */
export async function waitForResponsesEndpoint(): Promise<void> {
  if (_setupPromise) await _setupPromise;
}
