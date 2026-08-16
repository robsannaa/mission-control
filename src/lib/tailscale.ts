/**
 * Tailscale helpers — error class shared between the tailscale route and any
 * future caller that wants to detect "tailscale binary missing on this host".
 *
 * Defined here (not in route.ts) so route modules stay clean of non-handler
 * exports; Next.js' typed-routes system rejects extra exports on route files.
 */

/**
 * Thrown by `runTailscale` (and any caller) when the `tailscale` binary is not on
 * PATH. Distinguishes "feature unavailable on this host" from generic subprocess
 * failures, so route handlers can return 503 (Service Unavailable) instead of a
 * generic 500.
 *
 * Bug fix 2026-08-16: previously ENOENT bubbled up as "spawn tailscale ENOENT"
 * with status 500, hiding the real cause from the UI.
 */
export class TailscaleNotInstalledError extends Error {
  constructor() {
    super("tailscale CLI not installed on this host");
    this.name = "TailscaleNotInstalledError";
  }
}
