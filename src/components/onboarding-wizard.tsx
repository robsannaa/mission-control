"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MeshGradient, type MeshVariant } from "@/components/ui/mesh-gradient";
import { BrandMark } from "@/components/ui/brand-mark";
import { StepHeroVisual } from "@/components/onboarding/step-hero-visual";
import { useOnboardingState } from "@/components/onboarding/use-onboarding-state";
import { StepGateway } from "@/components/onboarding/step-gateway";
import { StepModel } from "@/components/onboarding/step-model";
import { StepChannel } from "@/components/onboarding/step-channel";
import { StepChat } from "@/components/onboarding/step-chat";
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from "@/components/onboarding/types";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { OnboardingWelcome } from "@/components/onboarding/welcome";
import { useCapability } from "@/hooks/use-capabilities";

const STEP_LABELS: Record<OnboardingStepId, string> = {
  gateway: "Gateway",
  model: "Model",
  channel: "Telegram",
  chat: "First chat",
};

// The aurora gradient (the welcome's) reads best — use it across the whole flow
// so every screen shares the same signature colour field.
const HERO_VARIANT: Record<OnboardingStepId, MeshVariant> = {
  gateway: "aurora",
  model: "aurora",
  channel: "aurora",
  chat: "aurora",
};

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
  const localGatewayControl = useCapability("localGatewayControl");
  // null until the user navigates — before that, resume from persisted progress
  const [chosenStep, setChosenStep] = useState<OnboardingStepId | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const activeStep: OnboardingStepId | null = chosenStep ?? (loaded ? state?.currentStep ?? "gateway" : null);
  const autoSkippedGateway = useRef(false);

  // A hosted container guarantees a running, healthy gateway — showing a step
  // that just confirms that is noise, not reassurance. Auto-passed, not hidden
  // from progress: it still counts as "done" in the rail. Computed per render
  // from the capability so the step list never freezes at import time.
  const VISIBLE_STEP_IDS: OnboardingStepId[] = useMemo(
    () =>
      localGatewayControl
        ? [...ONBOARDING_STEP_IDS]
        : ONBOARDING_STEP_IDS.filter((id) => id !== "gateway"),
    [localGatewayControl],
  );

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
    if (localGatewayControl || !loaded || autoSkippedGateway.current) return;
    if (!welcomeDismissed && !state?.startedAt) return;
    if (activeStep !== "gateway") return;
    autoSkippedGateway.current = true;
    queueMicrotask(() => {
      void advance("gateway", "done", { auto: true, reason: "hosted" });
    });
  }, [loaded, welcomeDismissed, state?.startedAt, activeStep, advance, localGatewayControl]);

  if (!loaded || activeStep === null) {
    return <ScreenLoadingState className="onboarding-light bg-[#f3f3f2]" />;
  }

  // Always greet with the welcome screen on load (until dismissed this session),
  // so a reload replays onboarding from the very start — not mid-flow.
  if (!welcomeDismissed) {
    return (
      <OnboardingWelcome
        onStart={() => {
          setWelcomeDismissed(true);
          void patch({ startedAt: new Date().toISOString() });
        }}
      />
    );
  }

  // On hosted, "gateway" isn't a visible step — instead of flashing a spinner
  // while the auto-skip effect advances state, render the first visible step
  // straight away, so the transition just slides. `visibleStep` is always a
  // real, shown step.
  const visibleStep = VISIBLE_STEP_IDS.includes(activeStep) ? activeStep : VISIBLE_STEP_IDS[0];
  const activeIdx = VISIBLE_STEP_IDS.indexOf(visibleStep);

  return (
    // Mobile (<640px): a truly full-screen native-app surface — no floating
    // card, no dimmed backdrop peeking around the edges. sm+: a polished
    // centered panel over a dimmed backdrop, matching welcome.tsx's feel.
    <div className="onboarding-light fixed inset-0 z-50 flex flex-col bg-white text-[#111111] sm:items-center sm:justify-center sm:bg-[#f3f3f2] sm:p-4">
      {/* Fixed card size — hero + body sum to the SAME height on every step, so
          the gradient hero keeps identical proportions throughout the flow. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white sm:h-[660px] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-[560px] sm:flex-none sm:rounded-3xl sm:border sm:border-black/10 sm:shadow-[0_24px_60px_rgba(0,0,0,0.14)]">
        {/* Gradient hero — the ElevenLabs shape: a mesh band up top carrying
            the mark + progress, step content below. Each step gets its own
            variant. Dots stay revisitable, like the old numbered rail. */}
        <MeshGradient variant={HERO_VARIANT[visibleStep]} className="h-[240px] shrink-0">
          <div className="flex h-full flex-col justify-between p-5 sm:px-8 sm:py-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-white/95 text-[#0a0a0a] shadow-[0_4px_14px_rgba(0,0,0,0.28)]">
                  <BrandMark className="h-[18px] w-[18px]" />
                </div>
                <span className="text-[13px] font-semibold text-white">Set up Mission Control</span>
              </div>
              <span className="rounded-full bg-black/25 px-2.5 py-1 font-mono text-[11px] font-medium text-white/80 backdrop-blur-sm">
                Step {activeIdx + 1} of {VISIBLE_STEP_IDS.length}
              </span>
            </div>

            <div className="flex flex-1 items-center justify-center">
              <StepHeroVisual step={visibleStep} />
            </div>

            <div className="flex items-center gap-1.5">
              {VISIBLE_STEP_IDS.map((id, i) => {
                const persisted = state?.steps[id]?.status;
                const done = persisted === "done" || (persisted !== "skipped" && i < activeIdx);
                const reachable = i <= activeIdx || done;
                return (
                  <button
                    key={id}
                    type="button"
                    aria-label={STEP_LABELS[id]}
                    onClick={() => {
                      // Visited steps are revisitable — every step is safe to re-run
                      if (reachable) setChosenStep(id);
                    }}
                    disabled={!reachable}
                    className={cn(
                      "h-1.5 flex-1 rounded-full transition-all duration-500",
                      i <= activeIdx ? "bg-white" : "bg-white/30",
                      reachable ? "cursor-pointer" : "cursor-default",
                    )}
                  />
                );
              })}
            </div>
          </div>
        </MeshGradient>

        {/* Fixed content height — the card is ONE size for every step and every
            provider choice. Taller content scrolls inside this frame; it never
            resizes the card. */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-6 sm:px-8 sm:pt-7">
          {visibleStep === "gateway" && (
            <StepGateway
              onDone={(meta) => void advance("gateway", "done", meta)}
              onSkip={() => void advance("gateway", "skipped")}
            />
          )}
          {visibleStep === "model" && (
            <StepModel
              onDone={(meta) => void advance("model", "done", meta)}
              onSkip={() => void advance("model", "skipped")}
            />
          )}
          {visibleStep === "channel" && (
            <StepChannel
              onDone={(meta) => void advance("channel", "done", meta)}
              onSkip={() => void advance("channel", "skipped")}
            />
          )}
          {visibleStep === "chat" && (
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
