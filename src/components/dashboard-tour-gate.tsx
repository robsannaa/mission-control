"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

const TOUR_DONE_KEY = "mc-dashboard-tour-done-v1";
const MIN_DESKTOP_WIDTH = 1024;

const DashboardTour = dynamic(
  () => import("@/components/dashboard-tour").then((m) => m.DashboardTour),
  { ssr: false },
);

/**
 * Lightweight gate that prevents loading the full tour bundle unless the user
 * is eligible to see it — and unless onboarding is settled.
 *
 * The tour used to fire the instant the wizard closed (onboarding progress
 * was never consulted), so a user who had just finished — or skipped —
 * setup got no breathing room before a second guided overlay started. This
 * waits for the wizard's own completedAt/dismissedAt before offering itself.
 * A machine that was already fully configured (the wizard never had to run,
 * so startedAt stays null) is unaffected — the tour still offers right away.
 */
export function DashboardTourGate() {
  const [eligibleByStorage] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      if (localStorage.getItem(TOUR_DONE_KEY) === "1") return false;
    } catch {
      // ignore storage failures
    }
    return window.innerWidth >= MIN_DESKTOP_WIDTH;
  });
  const [blockedByOnboarding, setBlockedByOnboarding] = useState(true);

  useEffect(() => {
    if (!eligibleByStorage) return;
    let cancelled = false;
    fetch("/api/onboarding/state", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const state = data?.state;
        const inProgress = Boolean(state?.startedAt) && !state?.completedAt && !state?.dismissedAt;
        setBlockedByOnboarding(inProgress);
      })
      .catch(() => {
        // Offline / unreadable — err toward not interrupting with the tour.
      });
    return () => {
      cancelled = true;
    };
  }, [eligibleByStorage]);

  if (!eligibleByStorage || blockedByOnboarding) return null;
  return <DashboardTour />;
}
