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

/* ── Style tokens (semantic design tokens; see src/app/globals.css) ── */

export const inputClass =
  "w-full rounded-lg px-3 py-2.5 text-sm bg-card border border-input text-foreground placeholder:text-fg-subtle dark:placeholder:text-fg-placeholder focus:outline-none focus:ring-2 focus:ring-border-strong/40 dark:focus:ring-border-strong/30 focus:border-border-strong dark:focus:border-border-strong disabled:opacity-50 transition-all duration-200";

export const labelClass =
  "block text-xs font-medium uppercase tracking-wide text-fg-subtle";

export const primaryBtnClass =
  "flex items-center gap-1.5 rounded-full px-5 py-2.5 text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/88 disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200 shadow-sm";

export const secondaryBtnClass =
  "rounded-full px-3 py-2 text-xs font-medium text-fg-secondary ring-1 ring-border hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200";

export const cardClass =
  "rounded-xl border border-border bg-card p-5";
