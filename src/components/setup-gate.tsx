"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Sparkles, X } from "lucide-react";
import { OnboardingWizard } from "@/components/onboarding-wizard";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { useCapabilities } from "@/hooks/use-capabilities";

const AUTO_RETRY_SECONDS = 8;

/** Dispatched by the Settings hub's "Run setup again" row to reopen the wizard
 * regardless of gate state — see settings-view.tsx. */
export const RELAUNCH_ONBOARDING_EVENT = "mc-onboarding:relaunch";

export type OnboardGateStatus = { hasModel: boolean; hasApiKey: boolean };
export type OnboardGateProgress = { completedAt: string | null; dismissedAt: string | null };

/**
 * Pure gate decision, exported for unit testing without rendering React.
 *
 * Credentials missing is necessary but not sufficient to show the wizard: once
 * the wizard has been completed OR explicitly dismissed, showing it again on
 * every poll (because the user chose to skip the model step, say) is the
 * "skip loop" bug — the fix is to trust that a settled session means the user
 * has already made their choice, and to surface a quiet pointer instead.
 */
export function shouldShowOnboardingWizard(
  status: OnboardGateStatus | null,
  progress: OnboardGateProgress | null,
  forceShow: boolean,
): boolean {
  if (forceShow) return true;
  if (!status) return false;
  const needsSetup = !status.hasModel || !status.hasApiKey;
  if (!needsSetup) return false;
  const settled = Boolean(progress?.completedAt || progress?.dismissedAt);
  return !settled;
}

/** True when setup is incomplete but the user already finished/dismissed the wizard. */
export function shouldShowFinishSetupPointer(
  status: OnboardGateStatus | null,
  progress: OnboardGateProgress | null,
  forceShow: boolean,
): boolean {
  if (forceShow) return false;
  if (!status) return false;
  const needsSetup = !status.hasModel || !status.hasApiKey;
  return needsSetup && Boolean(progress?.completedAt || progress?.dismissedAt);
}

function FinishSetupPointer({
  onOpen,
  onDismiss,
}: {
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-40 flex items-center gap-2.5 rounded-full border border-border bg-card px-3.5 py-2.5 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      <button
        type="button"
        onClick={onOpen}
        className="text-xs font-medium text-foreground hover:opacity-80 transition-opacity"
      >
        Finish setting up
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-fg-subtle hover:text-foreground transition-colors"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function SetupGate({ children }: { children: React.ReactNode }) {
  // Both consumers below choose wording, not availability, so the raw
  // deployment fact is the correct source here — the fail-closed capability
  // rule does not apply to copy.
  const { hosted } = useCapabilities();
  const [status, setStatus] = useState<OnboardGateStatus | null>(null);
  const [progress, setProgress] = useState<OnboardGateProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retryIn, setRetryIn] = useState(AUTO_RETRY_SECONDS);
  const [forceShow, setForceShow] = useState(false);
  const dismissing = useRef(false);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [onboardRes, stateRes] = await Promise.all([
        fetch("/api/onboard", { cache: "no-store" }),
        fetch("/api/onboarding/state", { cache: "no-store" }),
      ]);
      if (!onboardRes.ok) throw new Error();
      const data = await onboardRes.json();
      setStatus({ hasModel: Boolean(data.hasModel), hasApiKey: Boolean(data.hasApiKey) });

      if (stateRes.ok) {
        const stateData = await stateRes.json();
        if (stateData?.ok && stateData.state) {
          setProgress({
            completedAt: stateData.state.completedAt ?? null,
            dismissedAt: stateData.state.dismissedAt ?? null,
          });
        }
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    if (!error || !hosted) return;
    setRetryIn(AUTO_RETRY_SECONDS);
    const countdown = setInterval(() => {
      setRetryIn((prev) => Math.max(prev - 1, 0));
    }, 1000);
    const retryTimer = setTimeout(() => {
      void fetchStatus();
    }, AUTO_RETRY_SECONDS * 1000);
    return () => {
      clearInterval(countdown);
      clearTimeout(retryTimer);
    };
  }, [error, fetchStatus, hosted]);

  // Settings' "Run setup again" reopens the wizard from anywhere in the app.
  useEffect(() => {
    const handler = () => setForceShow(true);
    window.addEventListener(RELAUNCH_ONBOARDING_EVENT, handler);
    return () => window.removeEventListener(RELAUNCH_ONBOARDING_EVENT, handler);
  }, []);

  const handleComplete = useCallback(() => {
    // The wizard already awaits its final state patch before calling this, so
    // completedAt is durably persisted by the time we get here — no guessing
    // grace period needed, just re-read the truth.
    setForceShow(false);
    void fetchStatus();
  }, [fetchStatus]);

  const dismissPointer = useCallback(async () => {
    if (dismissing.current) return;
    dismissing.current = true;
    try {
      const res = await fetch("/api/onboarding/state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patch: { dismissedAt: new Date().toISOString() } }),
      });
      const data = await res.json();
      if (data?.ok && data.state) {
        setProgress({
          completedAt: data.state.completedAt ?? null,
          dismissedAt: data.state.dismissedAt ?? null,
        });
      }
    } catch {
      // best-effort — the pointer just stays visible until it works
    } finally {
      dismissing.current = false;
    }
  }, []);

  if (loading && !status) {
    // Onboarding is forced-light; keep the gate's loading screen light too so a
    // dark-theme reload doesn't flash black before the light wizard paints.
    return <ScreenLoadingState className="onboarding-light bg-[#f3f3f2]" />;
  }

  if (error) {
    return (
      <div className="onboarding-light fixed inset-0 z-50 flex items-center justify-center bg-[#f3f3f2] px-4 text-foreground">
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          {hosted ? (
            <>
              <h2 className="text-sm font-semibold text-foreground">Your agent is starting up</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                This usually takes a moment. We&apos;ll retry automatically in {retryIn}s.
              </p>
              <a
                href="/help"
                className="text-xs font-medium text-primary underline underline-offset-4 hover:opacity-90"
              >
                Contact support
              </a>
            </>
          ) : (
            <>
              <h2 className="text-sm font-semibold text-foreground">Could not connect to OpenClaw</h2>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Make sure the OpenClaw gateway is running and try again.
              </p>
            </>
          )}
          <button
            type="button"
            onClick={fetchStatus}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (shouldShowOnboardingWizard(status, progress, forceShow)) {
    return <OnboardingWizard onComplete={handleComplete} />;
  }

  return (
    <>
      {children}
      {shouldShowFinishSetupPointer(status, progress, forceShow) && (
        <FinishSetupPointer onOpen={() => setForceShow(true)} onDismiss={dismissPointer} />
      )}
    </>
  );
}
