/** Shared types + style tokens for the onboarding wizard. */

export const ONBOARDING_STEP_IDS = ["gateway", "model", "channel", "chat"] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

export type OnboardingStepState = {
  status: "pending" | "done" | "skipped";
  completedAt?: string | null;
  meta?: Record<string, unknown>;
};

export type OnboardingState = {
  version: 1;
  startedAt: string | null;
  completedAt: string | null;
  currentStep: OnboardingStepId;
  steps: Record<OnboardingStepId, OnboardingStepState>;
  updatedAt: string;
};

export type DetectPayload = {
  installed: boolean;
  binPath: string | null;
  cliVersion: string | null;
  running: boolean;
  healthy: boolean;
  url: string;
  port: number;
  checkedAt: string;
};

export type ProviderCatalogEntry = {
  id: string;
  label: string;
  placeholder: string;
  keyUrl: string;
  envKey: string | null;
  authMethods: ("api-key" | "paste-token")[];
  oauthCommand: string | null;
  hint: string;
};

export type ChannelStatusPayload = {
  ok: boolean;
  channel: string;
  configured: boolean;
  running: boolean;
  connected: boolean;
  lastInboundAt: number | null;
  lastError: string | null;
  botUsername: string | null;
  botName: string | null;
  deepLink: string | null;
};

/* ── Style tokens (match the existing stone-palette wizard) ── */

export const inputClass =
  "w-full rounded-lg px-3 py-2.5 text-sm bg-white dark:bg-[#0d1014] border border-stone-200 dark:border-[#23282e] text-stone-900 dark:text-[#f5f7fa] placeholder:text-stone-300 dark:placeholder:text-[#3a424c] focus:outline-none focus:ring-2 focus:ring-stone-400/40 dark:focus:ring-stone-500/30 focus:border-stone-400 dark:focus:border-stone-500 disabled:opacity-50 transition-all duration-200";

export const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-stone-400 dark:text-[#5a6270]";

export const primaryBtnClass =
  "flex items-center gap-1.5 rounded-lg px-5 py-2.5 text-sm font-medium bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 shadow-sm";

export const secondaryBtnClass =
  "rounded-lg px-3 py-2 text-xs font-medium text-stone-500 dark:text-[#a8b0ba] ring-1 ring-stone-200 dark:ring-[#2c343d] hover:bg-stone-100 dark:hover:bg-[#1c2128] disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200";

export const cardClass =
  "rounded-xl border border-stone-200 dark:border-[#23282e] bg-stone-50 dark:bg-[#0d1014] p-4";
