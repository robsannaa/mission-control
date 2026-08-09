"use client";

import { useCallback, useEffect, useState } from "react";
import type { OnboardingState, OnboardingStepId, OnboardingStepState } from "./types";

type StatePatch = {
  currentStep?: OnboardingStepId;
  startedAt?: string | null;
  completedAt?: string | null;
  steps?: Partial<Record<OnboardingStepId, Partial<OnboardingStepState>>>;
};

/**
 * Server-persisted wizard progress (survives reloads, browsers, devices).
 * Reads on mount; every mutation round-trips through /api/onboarding/state so
 * the stored copy is the single source of truth.
 */
export function useOnboardingState() {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/onboarding/state", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.ok && data.state) setState(data.state);
      })
      .catch(() => {
        // Offline start — the wizard still works, progress just won't resume
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const patch = useCallback(async (p: StatePatch): Promise<OnboardingState | null> => {
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: p }),
      });
      const data = await res.json();
      if (data?.ok && data.state) {
        setState(data.state);
        return data.state;
      }
    } catch {
      // Persistence is best-effort; local UI state still advances
    }
    return null;
  }, []);

  return { state, loaded, patch };
}
