"use client";

import { useCallback, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOnboardingState } from "@/components/onboarding/use-onboarding-state";
import { StepGateway } from "@/components/onboarding/step-gateway";
import { StepModel } from "@/components/onboarding/step-model";
import { StepChannel } from "@/components/onboarding/step-channel";
import { StepChat } from "@/components/onboarding/step-chat";
import { ONBOARDING_STEP_IDS, type OnboardingStepId } from "@/components/onboarding/types";

/** chat-view reads this to show its post-onboarding welcome. */
const POST_ONBOARDING_KEY = "mc-post-onboarding";

const STEP_LABELS: Record<OnboardingStepId, string> = {
  gateway: "Gateway",
  model: "Model",
  channel: "Telegram",
  chat: "First chat",
};

type Props = { onComplete: () => void };

/**
 * Guided, terminal-free onboarding:
 *   1. Detect the gateway (live status, one-click start if stopped)
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
  const activeStep: OnboardingStepId | null = chosenStep ?? (loaded ? state?.currentStep ?? "gateway" : null);

  const finishWizard = useCallback(() => {
    try {
      localStorage.setItem(POST_ONBOARDING_KEY, "1");
    } catch {
      // ignore storage failures in private mode
    }
    onComplete();
  }, [onComplete]);

  const advance = useCallback(
    async (from: OnboardingStepId, status: "done" | "skipped", meta?: Record<string, unknown>) => {
      const idx = ONBOARDING_STEP_IDS.indexOf(from);
      const next = ONBOARDING_STEP_IDS[idx + 1] ?? null;
      const now = new Date().toISOString();

      void patch({
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
        finishWizard();
      }
    },
    [patch, finishWizard],
  );

  if (!loaded || activeStep === null) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/60 dark:bg-black/70 backdrop-blur-sm">
        <div className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/40 [animation-delay:0ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/40 [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/40 [animation-delay:300ms]" />
        </div>
      </div>
    );
  }

  const activeIdx = ONBOARDING_STEP_IDS.indexOf(activeStep);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/60 dark:bg-black/70 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-[480px] overflow-hidden rounded-2xl border border-stone-200 dark:border-[#23282e] bg-white dark:bg-[#171a1d] shadow-2xl shadow-black/30">
        {/* Step rail */}
        <div className="px-8 pt-7 pb-5">
          <div className="flex items-center gap-0">
            {ONBOARDING_STEP_IDS.map((id, i) => {
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
                          ? "bg-emerald-500 text-white ring-emerald-500"
                          : active
                            ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 ring-stone-900 dark:ring-stone-100"
                            : "bg-transparent text-stone-400 dark:text-stone-600 ring-stone-200 dark:ring-[#2e343b]",
                      )}
                    >
                      {done && !active ? <Check className="h-3.5 w-3.5" /> : i + 1}
                    </div>
                    <span
                      className={cn(
                        "text-[10px] font-medium uppercase tracking-wide transition-colors duration-300",
                        active
                          ? "text-stone-900 dark:text-[#f5f7fa]"
                          : done
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-stone-400 dark:text-stone-600",
                      )}
                    >
                      {STEP_LABELS[id]}
                    </span>
                  </button>
                  {i < ONBOARDING_STEP_IDS.length - 1 && (
                    <div className="relative mx-2 mb-4 flex-1">
                      <div className="h-px w-full bg-stone-200 dark:bg-[#23282e]" />
                      <div
                        className="absolute inset-y-0 left-0 h-px bg-emerald-500 transition-all duration-500"
                        style={{ width: i < activeIdx ? "100%" : "0%" }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="h-px bg-stone-100 dark:bg-[#23282e]" />

        <div className="max-h-[min(72vh,560px)] overflow-y-auto overscroll-contain px-8 py-7">
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
