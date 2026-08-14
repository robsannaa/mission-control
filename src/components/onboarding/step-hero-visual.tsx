"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Cable, Loader2, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OnboardingStepId } from "./types";

/**
 * A polished, looping mini-mock inside each step's gradient hero — the same
 * register as the welcome's product preview, but dramatizing the exact action
 * of the step. Frosted white card on the mesh; colour stays in the gradient.
 * All fall back to a finished still frame under prefers-reduced-motion.
 */

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

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "w-[304px] rounded-2xl bg-white/95 p-4 shadow-[0_10px_30px_rgba(0,0,0,0.22)] backdrop-blur-sm",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── Model: paste an API key → verifying → verified → model detected ── */

const API_KEY = "sk-ant-api03-9f4a2c7be9";
type ModelPhase = "typing" | "verifying" | "verified" | "detected";

function ModelMock() {
  const reduced = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [phase, setPhase] = useState<ModelPhase>("typing");
  const [typed, setTyped] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const typing = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (reduced) return;
    const clear = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      if (typing.current) clearInterval(typing.current);
    };
    const run = () => {
      setPhase("typing");
      setTyped(0);
      let i = 0;
      typing.current = setInterval(() => {
        i += 1;
        setTyped(i);
        if (i >= API_KEY.length && typing.current) clearInterval(typing.current);
      }, 55);
      const typeDone = API_KEY.length * 55 + 250;
      timers.current.push(setTimeout(() => setPhase("verifying"), typeDone));
      timers.current.push(setTimeout(() => setPhase("verified"), typeDone + 1100));
      timers.current.push(setTimeout(() => setPhase("detected"), typeDone + 1650));
      timers.current.push(setTimeout(() => setCycle((c) => c + 1), typeDone + 1650 + 2400));
    };
    run();
    return clear;
  }, [reduced, cycle]);

  const done = reduced || phase === "verified" || phase === "detected";
  const shown = reduced ? API_KEY : API_KEY.slice(0, typed);
  const masked = shown.length <= 7 ? shown : shown.slice(0, 7) + "•".repeat(shown.length - 7);

  return (
    <Panel>
      <p className="mb-2 text-[10px] font-medium text-[#777169]">API key</p>
      <div
        className={cn(
          "flex items-center gap-2 rounded-lg border bg-white px-3 py-2.5 transition-colors duration-300",
          done ? "border-emerald-400/70" : "border-black/10",
        )}
      >
        <span className="flex-1 truncate font-mono text-[11px] text-[#0a0a0a]">
          {masked || "sk-…"}
        </span>
        {phase === "verifying" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#a59f97]" />}
        {done && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white animate-in zoom-in-50 duration-300">
            <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
          </span>
        )}
      </div>
      <div className="mt-2.5 h-[34px]">
        {(reduced || phase === "detected") && (
          <div className="flex items-center gap-2 rounded-lg bg-[#f5f3f1] px-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-300">
            <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#0a0a0a] text-white">
              <Sparkles className="h-3 w-3" />
            </span>
            <span className="text-[11px] font-medium text-[#0a0a0a]">Anthropic</span>
            <span className="ml-auto text-[10px] font-medium text-emerald-600">detected</span>
          </div>
        )}
      </div>
    </Panel>
  );
}

/* ── Channel: a Telegram message arrives → paired ── */

function ChannelMock() {
  const reduced = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [paired, setPaired] = useState(false);
  useEffect(() => {
    if (reduced) return;
    let t1: ReturnType<typeof setTimeout>;
    let t2: ReturnType<typeof setTimeout>;
    const run = () => {
      setPaired(false);
      t1 = setTimeout(() => setPaired(true), 1600);
      t2 = setTimeout(() => setCycle((c) => c + 1), 4200);
    };
    run();
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [reduced, cycle]);
  const shown = reduced || paired;
  return (
    <Panel>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[#229ED9] text-white">
          <Send className="h-3 w-3" />
        </span>
        <span className="text-[11px] font-medium text-[#0a0a0a]">Telegram</span>
        {shown && (
          <span className="ml-auto flex items-center gap-1 text-[10px] font-medium text-emerald-600 animate-in fade-in duration-300">
            <Check className="h-3 w-3" /> Paired
          </span>
        )}
      </div>
      <div
        key={cycle}
        className="w-4/5 rounded-xl rounded-bl-sm bg-[#f5f3f1] px-2.5 py-1.5 text-[11px] text-[#44403b] animate-in fade-in slide-in-from-left-1 duration-300"
      >
        /start — connect me to Mission Control
      </div>
    </Panel>
  );
}

/* ── Gateway: connecting → healthy ── */

function GatewayMock() {
  const reduced = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [healthy, setHealthy] = useState(false);
  useEffect(() => {
    if (reduced) return;
    let t1: ReturnType<typeof setTimeout>;
    let t2: ReturnType<typeof setTimeout>;
    const run = () => {
      setHealthy(false);
      t1 = setTimeout(() => setHealthy(true), 1400);
      t2 = setTimeout(() => setCycle((c) => c + 1), 3800);
    };
    run();
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [reduced, cycle]);
  const ok = reduced || healthy;
  return (
    <Panel className="flex items-center gap-3">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[#f5f3f1] text-[#0a0a0a]">
        <Cable className="h-4 w-4" />
      </span>
      <div className="flex-1">
        <p className="text-[11px] font-medium text-[#0a0a0a]">OpenClaw gateway</p>
        <p className="flex items-center gap-1 text-[10px] text-[#777169]">
          {ok ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Connected · healthy
            </>
          ) : (
            <>
              <Loader2 className="h-2.5 w-2.5 animate-spin" /> Connecting…
            </>
          )}
        </p>
      </div>
    </Panel>
  );
}

/* ── Chat: send → streamed reply ── */

const CHAT_ANSWER = "On it — checking your calendar now.";

function ChatMock() {
  const reduced = usePrefersReducedMotion();
  const [cycle, setCycle] = useState(0);
  const [phase, setPhase] = useState<"user" | "typing" | "answer">("user");
  const [typed, setTyped] = useState(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const typing = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    if (reduced) return;
    const clear = () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
      if (typing.current) clearInterval(typing.current);
    };
    const run = () => {
      setPhase("user");
      setTyped(0);
      timers.current.push(setTimeout(() => setPhase("typing"), 700));
      timers.current.push(
        setTimeout(() => {
          setPhase("answer");
          let i = 0;
          typing.current = setInterval(() => {
            i += 1;
            setTyped(i);
            if (i >= CHAT_ANSWER.length && typing.current) clearInterval(typing.current);
          }, 40);
        }, 1800),
      );
      timers.current.push(
        setTimeout(() => setCycle((c) => c + 1), 1800 + CHAT_ANSWER.length * 40 + 2200),
      );
    };
    run();
    return clear;
  }, [reduced, cycle]);
  return (
    <Panel className="space-y-1.5">
      <div
        key={`u${cycle}`}
        className="ml-auto w-4/5 rounded-xl rounded-br-sm bg-[#0a0a0a] px-2.5 py-1.5 text-[11px] text-white animate-in fade-in slide-in-from-bottom-1 duration-300"
      >
        What can you help me with?
      </div>
      {!reduced && phase === "typing" && (
        <div className="w-fit rounded-xl rounded-bl-sm bg-[#f5f3f1] px-2.5 py-2">
          <span className="flex gap-1">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-[#a59f97]"
                style={{ animation: "bounce-dot 1.2s ease-in-out infinite", animationDelay: `${i * 0.16}s` }}
              />
            ))}
          </span>
        </div>
      )}
      {(reduced || phase === "answer") && (
        <div className="w-5/6 rounded-xl rounded-bl-sm bg-[#f5f3f1] px-2.5 py-1.5 text-[11px] text-[#44403b]">
          {reduced ? CHAT_ANSWER : CHAT_ANSWER.slice(0, typed)}
        </div>
      )}
    </Panel>
  );
}

export function StepHeroVisual({ step }: { step: OnboardingStepId }) {
  const Mock =
    step === "model"
      ? ModelMock
      : step === "channel"
        ? ChannelMock
        : step === "chat"
          ? ChatMock
          : GatewayMock;
  return (
    <div aria-hidden="true">
      <Mock />
    </div>
  );
}
