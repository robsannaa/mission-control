"use client";

import { createContext, useContext } from "react";
import { NO_CAPABILITIES, type CapabilityKey, type CapabilitySnapshot } from "@/lib/capabilities";

/**
 * Client-side read side of the capability matrix (plan 03-02). The root
 * layout resolves the snapshot server-side (`getCapabilitySnapshot()`) and
 * feeds it into `CapabilityProvider` — this context never fetches on its
 * own.
 *
 * The default value IS `NO_CAPABILITIES` (every key `false`), not `null`
 * and not `undefined` — mirroring `ConfigLookupContext`'s `EMPTY_API`
 * fail-closed default in `use-config-lookup.ts`. Any consumer rendered
 * outside/before `CapabilityProvider` reads every capability as absent by
 * construction, with no null-check needed at any call site (UI-SPEC
 * Capability-Gating Interaction Contract §2).
 *
 * `hosted` on the snapshot is for copy and branding only (page title,
 * hosted-worded onboarding text). No feature gate may read it directly —
 * every feature gate reads a capability key through `useCapability()` /
 * `useCapabilities()` so it fails closed (D-07).
 */
export const CapabilityContext = createContext<CapabilitySnapshot>({
  capabilities: NO_CAPABILITIES,
  hosted: false,
});

/** Read the full capability snapshot from anywhere under `CapabilityProvider`. */
export function useCapabilities(): CapabilitySnapshot {
  return useContext(CapabilityContext);
}

/** Read a single capability key — the common case at a feature-gate call site. */
export function useCapability(key: CapabilityKey): boolean {
  const { capabilities } = useCapabilities();
  return capabilities[key];
}
