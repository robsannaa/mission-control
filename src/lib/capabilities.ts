/**
 * Pure capability matrix — zero I/O, client-safe (imports nothing
 * server-runtime-only and nothing from a Node builtin module) so the same
 * key set can be read in the browser once plan 03-02 wires up
 * `useCapabilities()`.
 *
 * Six capability keys, each backed by a real UI or API surface that exists
 * in this repo today (no-placeholders rule; sandbox/nodes keys are Phase 9,
 * D-01 of 03-CONTEXT.md):
 *
 *   - appleCalendar        GET /api/integrations/apple/events, src/lib/apple-calendar.ts
 *   - calendarWorkspace    /calendar page, GET+POST /api/calendar, Calendar nav row,
 *                          Calendar quick action, and the localhost-bound Google OAuth
 *                          path in src/lib/google-calendar.ts (reachable only through
 *                          calendar-sync.ts <- /api/calendar)
 *   - tailscaleNetworking  /tailscale page, GET/POST /api/tailscale, Settings ->
 *                          Tailscale row, Infrastructure hub Tailscale entry
 *   - hostInfrastructure   Logs + Backup nav rows, Settings Infrastructure group
 *                          (Terminal/Config/Browser/Audio), dashboard "Access &
 *                          pairing" card, OpenClaw + Mission Control update banners,
 *                          browser-relay extension mode, MCP self-hosted connectors
 *   - localGatewayControl  Onboarding "gateway" step, local gateway bootstrap in
 *                          onboard/bootstrap.ts, CLI-transport diagnostic banner
 *   - localModelAuth       Onboarding model step: subscription paste-token auth and
 *                          local provider (Ollama / LM Studio) chooser
 *
 * Five of the six keys share one input (`!hosted`) today. They stay
 * separate keys, never collapsed into one boolean, because their *reasons*
 * differ and will diverge (a self-hosted Linux box with no Tailscale
 * installed, a hosted image that later gains a managed OAuth callback).
 *
 * `hosted` is a separate deployment fact exposed alongside the matrix, used
 * ONLY for copy/branding (page title, hosted-only support card, hosted-worded
 * onboarding copy). No feature gate may read it directly — feature gates
 * read a capability key so they fail closed.
 */

export const CAPABILITY_KEYS = [
  "appleCalendar",
  "calendarWorkspace",
  "tailscaleNetworking",
  "hostInfrastructure",
  "localGatewayControl",
  "localModelAuth",
] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

export type CapabilityMatrix = Record<CapabilityKey, boolean>;

export interface CapabilityInputs {
  platform: string;
  hosted: boolean;
  icalBuddyAvailable: boolean;
}

export interface CapabilitySnapshot {
  capabilities: CapabilityMatrix;
  hosted: boolean;
}

/**
 * Fail-closed constant — every key `false`. This is the value the React
 * context default resolves to (plan 03-02) so any component rendered
 * outside/before the provider reads absent by construction. Never mutate
 * this object; `computeCapabilities()` always returns a fresh one.
 */
export const NO_CAPABILITIES: CapabilityMatrix = {
  appleCalendar: false,
  calendarWorkspace: false,
  tailscaleNetworking: false,
  hostInfrastructure: false,
  localGatewayControl: false,
  localModelAuth: false,
};

/**
 * Fixed refusal copy (D-02 / UI-SPEC Copywriting Contract) — the single
 * source of this string. No error code, no jargon, no retry affordance.
 */
export const UNAVAILABLE_MESSAGE = "This isn't available on your setup.";

/**
 * Compute the capability matrix from already-resolved primitives. Pure,
 * never throws, and never treats a missing/undefined input as truthy —
 * every comparison is `=== true` / `=== "darwin"`, not a truthiness check,
 * so a malformed or absent input resolves every key to `false`, never
 * `true` (fail-closed, T-03-03).
 */
export function computeCapabilities(input: CapabilityInputs): CapabilityMatrix {
  const hosted = input?.hosted === true;
  const platform = input?.platform;
  const icalBuddyAvailable = input?.icalBuddyAvailable === true;
  const notHosted = !hosted;

  return {
    appleCalendar: notHosted && platform === "darwin" && icalBuddyAvailable,
    calendarWorkspace: notHosted,
    tailscaleNetworking: notHosted,
    hostInfrastructure: notHosted,
    localGatewayControl: notHosted,
    localModelAuth: notHosted,
  };
}
