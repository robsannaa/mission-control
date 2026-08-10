"use client";

import { useSyncExternalStore } from "react";

/** The platform never changes while the page is open, so nothing to subscribe to. */
const noop = () => () => {};

function clientModifier(): string {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    navigator.platform ??
    "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘" : "Ctrl";
}

/**
 * The label for the "submit" modifier key on this machine.
 *
 * Read through `useSyncExternalStore` so the server renders `Ctrl` and the
 * client corrects it during hydration without a mismatch. The badge has to name
 * the modifier: the handlers bind Cmd/Ctrl+Enter, so showing a bare Enter glyph
 * promises a shortcut that does nothing.
 */
export function useSubmitModifier(): string {
  return useSyncExternalStore(noop, clientModifier, () => "Ctrl");
}
