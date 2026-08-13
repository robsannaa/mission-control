"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOnboardingState } from "@/components/onboarding/use-onboarding-state";
import { StepGateway } from "@/components/onboarding/step-gateway";
import { StepModel } from "@/components/onboarding/step-model";
import { StepChannel } from "@/components/onboarding/step-channel";
import { StepChat } from "@/components/onboarding/step-chat";
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from "@/components/onboarding/types";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { OnboardingWelcome } from "@/components/onboarding/welcome";

const isHosted =
  process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true" ||
  process.env.AGENTBAY_HOSTED === "true";

const STEP_LABELS: Record<OnboardingStepId, string> = {
  gateway: "Gateway",
  model: "Model",
  channel: "Telegram",
  chat: "First chat",
};

// A hosted container guarantees a running, healthy gateway — showing a step
// that just confirms that is noise, not reassurance. Auto-passed, not hidden
// from progress: it still counts as "done" in the rail.
const VISIBLE_STEP_IDS: OnboardingStepId[] = isHosted
  ? ONBOARDING_STEP_IDS.filter((id) => id !== "gateway")
  : [...ONBOARDING_STEP_IDS];

type Props = { onComplete: () => void };

/**
 * Guided, terminal-free onboarding:
 *   1. Detect the gateway (live status, one-click start if stopped) — skipped
 *      on hosted deployments, where the container guarantees it
 *   2. Authenticate a model provider (paste a key, live-verified)
 *   3. Connect Telegram (token paste → QR → first inbound message)
 *   4. First chat (streaming reply — the wow moment)
 *
 * Every step is skippable, safe to re-run, and progress persists server-side
 * (/api/onboarding/state) so the wizard resumes where you left off.
 */
export function OnboardingWizard({ onComplete }: Props) {
  const { state, loaded, patch } = useOnboardingState();
  // null until the user navigates — before that, resume from persisted progress
  const [chosenStep, setChosenStep] = useState<OnboardingStepId | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const activeStep: OnboardingStepId | null = chosenStep ?? (loaded ? state?.currentStep ?? "gateway" : null);
  const autoSkippedGateway = useRef(false);

  const advance = useCallback(
    async (from: OnboardingStepId, status: "done" | "skipped", meta?: Record<string, unknown>) => {
      const idx = ONBOARDING_STEP_IDS.indexOf(from);
      const next = ONBOARDING_STEP_IDS[idx + 1] ?? null;
      const now = new Date().toISOString();

      // Awaited (not fire-and-forget): the gate re-checks completedAt the
      // moment onComplete() fires, so it must already be durably persisted —
      // racing it is what used to make the wizard flash back open.
      await patch({
        ...(next ? { currentStep: next } : { completedAt: now }),
        steps: {
          [from]: {
            status,
            completedAt: status === "done" ? now : null,
            ...(meta ? { meta } : {}),
          },
        },
      });

      if (next) {
        setChosenStep(next);
      } else {
        onComplete();
      }
    },
    [patch, onComplete],
  );

  // Hosted: the container already guarantees a running gateway, so the step
  // that only confirms that is auto-passed rather than shown. Fires once,
  // after the welcome screen, the moment the gateway step would render.
  useEffect(() => {
    if (!isHosted || !loaded || autoSkippedGateway.current) return;
    if (!welcomeDismissed && !state?.startedAt) return;
    if (activeStep !== "gateway") return;
    autoSkippedGateway.current = true;
    queueMicrotask(() => {
      void advance("gateway", "done", { auto: true, reason: "hosted" });
    });
  }, [loaded, welcomeDismissed, state?.startedAt, activeStep, advance]);

  if (!loaded || activeStep === null) {
    return <ScreenLoadingState className="bg-muted" />;
  }

  if (!welcomeDismissed && !state?.startedAt) {
    return (
      <OnboardingWelcome
        onStart={() => {
          setWelcomeDismissed(true);
          void patch({ startedAt: new Date().toISOString() });
        }}
      />
    );
  }

  // Past the welcome screen: the auto-skip effect above is about to advance
  // past "gateway" on hosted deployments — a brief spinner beats flashing the
  // gateway step it's already skipping.
  if (isHosted && activeStep === "gateway") {
    return <ScreenLoadingState className="bg-muted" />;
  }

  const activeIdx = VISIBLE_STEP_IDS.indexOf(activeStep);

  return (
    // Mobile (<640px): a truly full-screen native-app surface — no floating
    // card, no dimmed backdrop peeking around the edges. sm+: a polished
    // centered panel over a dimmed backdrop, matching welcome.tsx's feel.
    <div className="onboarding-light fixed inset-0 z-50 flex flex-col bg-white text-[#111111] sm:items-center sm:justify-center sm:bg-[#f3f3f2] sm:p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-[560px] sm:flex-none sm:rounded-3xl sm:border sm:border-black/10 sm:shadow-[0_24px_60px_rgba(0,0,0,0.14)]">
        {/* Step rail */}
        <div className="px-5 pt-6 pb-4 sm:px-8 sm:pt-7 sm:pb-5">
          <div className="flex items-center gap-0">
            {VISIBLE_STEP_IDS.map((id, i) => {
              const persisted = state?.steps[id]?.status;
              const done = persisted === "done" || (persisted !== "skipped" && i < activeIdx);
              const active = id === activeStep;
              return (
                <div key={id} className="flex flex-1 items-center last:flex-none">
                  <button
                    type="button"
                    onClick={() => {
                      // Visited steps are revisitable — every step is safe to re-run
                      if (i <= activeIdx || done) setChosenStep(id);
                    }}
                    className="flex flex-col items-center gap-1.5"
                  >
                    <div
                      className={cn(
                        "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ring-1 transition-all duration-300",
                        done && !active
                          ? "bg-[#111111] text-white ring-black/15"
                          : active
                            ? "bg-primary text-primary-foreground ring-border-strong"
                            : "bg-transparent text-fg-subtle ring-border",
                      )}
                    >
                      {done && !active ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </div>
                    <span
                      className={cn(
                        "text-[10px] font-medium uppercase tracking-wide transition-colors duration-300",
                        active
                          ? "text-foreground"
                          : done
                            ? "text-black/60"
                            : "text-fg-subtle",
                      )}
                    >
                      {STEP_LABELS[id]}
                    </span>
                  </button>
                  {i < VISIBLE_STEP_IDS.length - 1 && (
                    <div className="relative mx-2 mb-4 flex-1">
                      <div className="h-px w-full bg-secondary" />
                      <div
                        className="absolute inset-y-0 left-0 h-px bg-[#111111] transition-all duration-500"
                        style={{ width: i < activeIdx ? "100%" : "0%" }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="h-px bg-black/10" />

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-6 sm:max-h-[min(72vh,560px)] sm:flex-none sm:px-8 sm:py-7">
          {activeStep === "gateway" && (
            <StepGateway
              onDone={(meta) => void advance("gateway", "done", meta)}
              onSkip={() => void advance("gateway", "skipped")}
            />
          )}
          {activeStep === "model" && (
            <StepModel
              onDone={(meta) => void advance("model", "done", meta)}
              onSkip={() => void advance("model", "skipped")}
            />
          )}
          {activeStep === "channel" && (
            <StepChannel
              onDone={(meta) => void advance("channel", "done", meta)}
              onSkip={() => void advance("channel", "skipped")}
            />
          )}
          {activeStep === "chat" && (
            <StepChat
              onDone={(meta) => void advance("chat", "done", meta)}
              onSkip={() => void advance("chat", "skipped")}
            />
          )}
        </div>
      </div>
    </div>
  );
}
