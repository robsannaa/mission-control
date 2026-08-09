"use client";

import {
  Bot,
  Cable,
  Check,
  LayoutDashboard,
  MessageSquare,
  Radio,
  Sparkles,
} from "lucide-react";

const FEATURES = [
  {
    icon: Cable,
    text: "Connect your local OpenClaw gateway in seconds",
  },
  {
    icon: Sparkles,
    text: "Choose a model and connect your preferred channel",
  },
  {
    icon: LayoutDashboard,
    text: "Chat, automate, and manage everything from one place",
  },
] as const;

function ProductVisual() {
  return (
    <div
      className="relative h-[300px] overflow-hidden bg-[#111111] sm:h-[400px] lg:h-[480px]"
      style={{
        backgroundImage:
          "radial-gradient(circle at 1px 1px, rgba(255,255,255,0.085) 1px, transparent 0)",
        backgroundSize: "18px 18px",
      }}
      aria-hidden="true"
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.07),transparent_48%)]" />

      <svg
        className="absolute inset-0 h-full w-full"
        viewBox="0 0 920 430"
        fill="none"
        preserveAspectRatio="none"
      >
        <path d="M245 166 C330 166 318 215 380 215" stroke="#3b82f6" strokeWidth="2" />
        <path d="M540 215 C610 215 600 142 686 142" stroke="#22c55e" strokeWidth="2" />
        <path d="M540 248 C625 248 620 300 710 300" stroke="#a855f7" strokeWidth="2" />
        <circle cx="245" cy="166" r="5" fill="#3b82f6" />
        <circle cx="380" cy="215" r="5" fill="#3b82f6" />
        <circle cx="540" cy="215" r="5" fill="#22c55e" />
        <circle cx="686" cy="142" r="5" fill="#22c55e" />
        <circle cx="540" cy="248" r="5" fill="#a855f7" />
        <circle cx="710" cy="300" r="5" fill="#a855f7" />
      </svg>

      <div className="absolute left-[6%] top-[22%] w-[25%] min-w-44 rounded-2xl border border-white/10 bg-[#1b1b1b] p-3 shadow-2xl sm:p-4">
        <div className="mb-3 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[11px] font-medium text-white/65">
            <Bot className="h-3.5 w-3.5" /> Agent
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-emerald-400/10 px-2 py-1 text-[10px] font-medium text-emerald-300">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> Online
          </span>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/25 p-3">
          <p className="text-xs font-semibold text-white">main</p>
          <p className="mt-1 text-[10px] text-white/45">claude-sonnet-5</p>
        </div>
      </div>

      <div className="absolute left-1/2 top-[13%] w-[30%] min-w-52 -translate-x-1/2 rounded-2xl border border-white/15 bg-[#202020] p-3 shadow-[0_22px_60px_rgba(0,0,0,0.55)] sm:p-4">
        <div className="mb-4 flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-white text-sm">🦞</div>
          <div>
            <p className="text-xs font-semibold text-white">Mission Control</p>
            <p className="text-[10px] text-white/45">Your agent workspace</p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl border border-white/10 bg-black/25 p-2.5">
            <p className="text-[9px] uppercase tracking-wider text-white/35">Status</p>
            <p className="mt-1 text-xs font-semibold text-white">Connected</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/25 p-2.5">
            <p className="text-[9px] uppercase tracking-wider text-white/35">Tasks</p>
            <p className="mt-1 text-xs font-semibold text-white">Ready</p>
          </div>
        </div>
        <div className="mt-2 flex items-center justify-between rounded-xl border border-white/10 bg-black/25 px-3 py-2.5">
          <span className="text-[10px] text-white/50">Gateway healthy</span>
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        </div>
      </div>

      <div className="absolute right-[6%] top-[18%] w-[25%] min-w-44 rounded-2xl border border-white/10 bg-[#1b1b1b] p-3 shadow-2xl sm:p-4">
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium text-white/65">
          <MessageSquare className="h-3.5 w-3.5" /> First conversation
        </div>
        <div className="space-y-2">
          <div className="ml-auto w-4/5 rounded-xl rounded-br-sm bg-white px-3 py-2 text-[10px] text-black">
            What can you help me with?
          </div>
          <div className="w-5/6 rounded-xl rounded-bl-sm bg-white/10 px-3 py-2 text-[10px] leading-relaxed text-white/75">
            Tasks, research, schedules, and more.
          </div>
        </div>
      </div>

      <div className="absolute bottom-[9%] right-[9%] hidden w-[21%] min-w-40 rounded-2xl border border-white/10 bg-[#1b1b1b] p-3 shadow-2xl sm:block">
        <div className="flex items-center gap-2 text-[11px] font-medium text-white/65">
          <Radio className="h-3.5 w-3.5 text-violet-400" /> Channels
        </div>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-black/25 px-3 py-2 text-[10px] text-white/55">
          Telegram <span className="text-emerald-400">Connected</span>
        </div>
      </div>

      <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-black/35 px-3 py-1.5 text-[10px] font-medium text-white/40 backdrop-blur-sm">
        Private · local · under your control
      </div>
    </div>
  );
}

export function OnboardingWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#f3f3f2] px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-[1024px] overflow-hidden rounded-[32px] border border-black/10 bg-white text-[#111111] shadow-[0_28px_70px_rgba(0,0,0,0.16)] sm:rounded-[44px]">
        <ProductVisual />

        <div className="px-6 pb-6 pt-8 sm:px-14 sm:pb-10 sm:pt-12">
          <h1 className="text-2xl font-semibold tracking-[-0.03em] sm:text-[34px] sm:leading-tight">
            Meet Mission Control
          </h1>

          <div className="mt-7 space-y-5 sm:mt-10 sm:space-y-7">
            {FEATURES.map(({ icon: Icon, text }) => (
              <div key={text} className="flex items-center gap-4 sm:gap-5">
                <Icon className="h-6 w-6 shrink-0 stroke-[1.8] sm:h-7 sm:w-7" />
                <p className="text-base font-medium leading-snug sm:text-[22px]">{text}</p>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={onStart}
            className="mt-9 flex h-14 w-full items-center justify-center rounded-2xl bg-[#111111] px-6 text-base font-medium text-white transition-transform hover:scale-[1.005] hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black focus-visible:ring-offset-2 active:scale-[0.995] sm:mt-12 sm:h-20 sm:text-[22px]"
          >
            Get started
          </button>
        </div>
      </div>
    </div>
  );
}
