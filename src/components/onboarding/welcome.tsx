"use client";

import { useEffect, useRef, useState } from "react";
import { Cable, Check, LayoutDashboard, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { MeshGradient } from "@/components/ui/mesh-gradient";
import { BrandMark } from "@/components/ui/brand-mark";
import { primaryBtnClass } from "./types";

const FEATURES = [
  { icon: Cable, text: "Set up your private agent in seconds" },
  { icon: Sparkles, text: "Choose a model and connect your preferred channel" },
  { icon: LayoutDashboard, text: "Chat, automate, and manage everything from one place" },
] as const;

const QUESTION = "What can you help me with?";
const ANSWER = "Tasks, research, schedules, and more.";

// Cycle timing (ms).
const THINK_AT = 850;
const ANSWER_AT = 2050;
const TYPE_MS = 42;
const HOLD_MS = 2800;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return reduced;
}

type Phase = "user" | "thinking" | "answer" | "hold";

function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 py-0.5" aria-label="Agent is typing">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-[#a59f97]"
          style={{ animation: "bounce-dot 1.2s ease-in-out infinite", animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

/**
 * A looping "live" chat demo: the user message sends, the agent thinks, then
 * streams its reply character by character — the ElevenLabs move of spending the
 * whole motion budget on a product demo. Falls back to the finished exchange
 * under prefers-reduced-motion.
 */
function AnimatedChat() {
  const reduced = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [phase, setPhase] = useState<Phase>("user");
  const [typed, setTyped] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const typing = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (reduced) return; // static exchange rendered below — no timers, no setState
    const clearAll = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      if (typing.current) clearInterval(typing.current);
    };
    const run = () => {
      clearAll();
      setPhase("user");
      setTyped(0);
      timers.current.push(setTimeout(() => setPhase("thinking"), THINK_AT));
      timers.current.push(
        setTimeout(() => {
          setPhase("answer");
          let i = 0;
          typing.current = setInterval(() => {
            i += 1;
            setTyped(i);
            if (i >= ANSWER.length && typing.current) clearInterval(typing.current);
          }, TYPE_MS);
        }, ANSWER_AT),
      );
      const doneAt = ANSWER_AT + ANSWER.length * TYPE_MS + 250;
      timers.current.push(setTimeout(() => setPhase("hold"), doneAt));
      timers.current.push(setTimeout(() => setCycle((c) => c + 1), doneAt + HOLD_MS));
    };
    run();
    return clearAll;
  }, [reduced, cycle]);

  const showAnswer = reduced || phase === "answer" || phase === "hold";
  const typedCount = reduced ? ANSWER.length : typed;

  return (
    <div className="mt-2 min-h-[92px] space-y-1.5">
      <div
        key={`q-${cycle}`}
        className="ml-auto w-4/5 rounded-xl rounded-br-sm bg-[#0a0a0a] px-3 py-2 text-[11px] text-white animate-in fade-in slide-in-from-bottom-1 duration-300"
      >
        {QUESTION}
      </div>
      {!reduced && phase === "thinking" && (
        <div className="w-fit rounded-xl rounded-bl-sm bg-[#f5f3f1] px-3 py-2 animate-in fade-in duration-200">
          <TypingDots />
        </div>
      )}
      {showAnswer && (
        <div className="w-5/6 rounded-xl rounded-bl-sm bg-[#f5f3f1] px-3 py-2 text-[11px] leading-relaxed text-[#44403b] animate-in fade-in duration-200">
          {ANSWER.slice(0, typedCount)}
          {!reduced && phase === "answer" && typed < ANSWER.length && (
            <span
              className="ml-px inline-block h-3 w-px translate-y-0.5 bg-[#44403b] align-middle"
              style={{ animation: "caret-blink 1s steps(1) infinite" }}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A live-looking Mission Control preview, framed inside the grainy gradient and
 * bleeding off the bottom — the ElevenLabs "product-in-a-gradient-well" hero.
 * Monochrome by design; all colour lives in the gradient behind it.
 */
function ProductPreview() {
  return (
    <div className="absolute inset-x-0 bottom-0 flex justify-center px-8">
      <div className="w-full max-w-[380px] translate-y-5 rounded-t-2xl border border-black/5 bg-white/95 p-4 shadow-[0_-2px_30px_rgba(0,0,0,0.18)] backdrop-blur-sm">
        <div className="mb-3 flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0a0a0a] text-white">
            <BrandMark className="h-[15px] w-[15px]" />
          </div>
          <span className="text-[13px] font-semibold text-[#0a0a0a]">Mission Control</span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-[#f5f3f1] px-2 py-1 text-[10px] font-medium text-[#59544f]">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Online
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-[#f5f3f1] p-2.5">
            <p className="text-[9px] tracking-wide text-[#a59f97]">Status</p>
            <p className="mt-0.5 flex items-center gap-1 text-xs font-semibold text-[#0a0a0a]">
              <Check className="h-3 w-3 text-emerald-500" /> Connected
            </p>
          </div>
          <div className="rounded-xl bg-[#f5f3f1] p-2.5">
            <p className="text-[9px] tracking-wide text-[#a59f97]">Agent</p>
            <p className="mt-0.5 text-xs font-semibold text-[#0a0a0a]">Ready</p>
          </div>
        </div>
        <AnimatedChat />
      </div>
    </div>
  );
}

/**
 * Welcome — the first surface of onboarding, in the ElevenLabs shape: a grainy
 * mesh gradient hero framing a live product demo, product value + CTA below.
 */
export function OnboardingWelcome({ onStart }: { onStart: () => void }) {
  return (
    // Same frame as every wizard step: fixed 640px card, 240px hero, body fills
    // the rest with the CTA pinned to the bottom.
    <div className="onboarding-light fixed inset-0 z-50 flex flex-col bg-white text-[#111111] sm:items-center sm:justify-center sm:bg-[#f3f3f2] sm:p-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white sm:h-[660px] sm:max-h-[calc(100vh-2rem)] sm:w-full sm:max-w-[560px] sm:flex-none sm:rounded-3xl sm:border sm:border-black/10 sm:shadow-[0_24px_60px_rgba(0,0,0,0.14)]">
        <MeshGradient variant="aurora" className="relative h-[240px] shrink-0">
          <ProductPreview />
        </MeshGradient>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-7 pb-7 pt-7 sm:px-9 sm:pt-8 sm:pb-9">
          <h1 className="text-[22px] font-medium tracking-[-0.02em]">Meet Mission Control</h1>

          <div className="mt-6 space-y-4">
            {FEATURES.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-3.5">
                <Icon className="h-[18px] w-[18px] shrink-0 stroke-[1.6] text-[#44403b]" />
                <p className="text-[15px] font-normal leading-snug text-[#292524]">{text}</p>
              </div>
            ))}
          </div>

          <button type="button" onClick={onStart} className={cn(primaryBtnClass, "mt-auto")}>
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}
