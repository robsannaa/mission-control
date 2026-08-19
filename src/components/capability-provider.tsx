"use client";

import { CapabilityContext } from "@/hooks/use-capabilities";
import type { CapabilitySnapshot } from "@/lib/capabilities";

/**
 * Feeds the server-computed capability snapshot into `CapabilityContext`.
 * No fetch, no state, no effect — the value arrives as a prop from
 * `layout.tsx` (an async Server Component that awaits
 * `getCapabilitySnapshot()`), so there is no client-side unresolved window
 * on first paint (UI-SPEC E4). Mirrors the minimal `"use client"`
 * wrapper-in-layout shape of `theme-provider.tsx`.
 */
export function CapabilityProvider({
  snapshot,
  children,
}: {
  snapshot: CapabilitySnapshot;
  children: React.ReactNode;
}) {
  return (
    <CapabilityContext.Provider value={snapshot}>
      {children}
    </CapabilityContext.Provider>
  );
}
