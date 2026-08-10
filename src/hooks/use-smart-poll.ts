"use client";

import { useEffect, useRef, useCallback } from "react";

type UseSmartPollOptions = {
  /** Milliseconds between polls when tab is visible. Default 5000. */
  intervalMs?: number;
  /** When true, polling pauses (SSE/WS is providing data). */
  sseActive?: boolean;
  /** When false, polling is disabled entirely. Default true. */
  enabled?: boolean;
  /** Fire immediately on mount. Default true. */
  immediate?: boolean;
  /**
   * Floor for `intervalMs`. Defaults to 5s, which is right for background
   * dashboards. A surface that is actively watching one thing happen — a task
   * run streaming its steps — can lower it deliberately.
   */
  minIntervalMs?: number;
};

/**
 * Smart polling hook that:
 * - Pauses when the tab is hidden
 * - Pauses when an SSE/WS stream is active
 * - Re-polls immediately when tab becomes visible or window gains focus
 * - Deduplicates in-flight requests
 */
const MIN_POLL_INTERVAL_MS = 5000;

export function useSmartPoll(
  fn: () => void | Promise<void>,
  options: UseSmartPollOptions = {},
) {
  const {
    intervalMs: rawIntervalMs = 5000,
    sseActive = false,
    enabled = true,
    immediate = true,
    minIntervalMs = MIN_POLL_INTERVAL_MS,
  } = options;
  const intervalMs = Math.max(rawIntervalMs, minIntervalMs);

  const fnRef = useRef(fn);
  fnRef.current = fn;
  const sseRef = useRef(sseActive);
  sseRef.current = sseActive;
  // Read through a ref: `tick` is created once, so a closed-over `enabled`
  // would freeze at its first value and never start polling when it flips on.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inFlight = useRef(false);

  const tick = useCallback(async () => {
    if (inFlight.current) return;
    if (!enabledRef.current) return;
    if (document.visibilityState !== "visible") return;
    if (sseRef.current) return;
    inFlight.current = true;
    try {
      await fnRef.current();
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Fire immediately on mount only (not on intervalMs changes)
  useEffect(() => {
    if (!enabled) return;
    if (immediate) void tick();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // Set up interval + visibility/focus listeners (re-runs when intervalMs changes)
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => void tick(), intervalMs);

    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    const onFocus = () => void tick();

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, tick, intervalMs]);
}
