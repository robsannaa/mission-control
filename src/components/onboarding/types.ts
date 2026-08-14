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
  /** Set when the user explicitly dismisses the "finish setting up" pointer
   * without completing the wizard — stops it from reappearing. */
  dismissedAt: string | null;
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

// Focus ring per the design system: 1.5px #2B7FFF outline, offset 2px — the one
// allowed accent, used only for focus + caret.
const FOCUS_RING =
  "focus-visible:outline-none focus-visible:outline-[1.5px] focus-visible:outline-[#2B7FFF] focus-visible:outline-offset-2";

export const inputClass =
  `w-full rounded-xl px-3 py-2.5 text-sm bg-card border border-input text-foreground placeholder:text-fg-subtle dark:placeholder:text-fg-placeholder focus:outline-none ${FOCUS_RING} focus:border-border-strong dark:focus:border-border-strong disabled:opacity-50 transition-all duration-200`;

// Labels: sentence case, never uppercase (the design system measured zero
// uppercase anywhere).
export const labelClass = "block text-xs font-medium text-fg-subtle";

// The onboarding primary CTA is ALWAYS the same: full-width, bottom-aligned,
// rounded-xl, one height. Never a pill that changes width/shape between steps.
// Weight 400 — buttons are never bold in this system.
export const primaryBtnClass =
  `flex h-12 w-full items-center justify-center gap-1.5 rounded-xl px-6 text-[15px] font-normal bg-primary text-primary-foreground hover:bg-primary/90 ${FOCUS_RING} disabled:opacity-30 disabled:cursor-not-allowed transition-all duration-200`;

// "Skip for now" — a quiet centered text link that sits above the primary CTA.
export const skipBtnClass =
  `text-[13px] font-normal text-muted-foreground transition-colors hover:text-foreground ${FOCUS_RING} disabled:opacity-40 disabled:cursor-not-allowed`;

export const secondaryBtnClass =
  "rounded-full px-3 py-2 text-xs font-medium text-fg-secondary ring-1 ring-border hover:bg-accent hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200";

export const cardClass =
  "rounded-xl border border-border bg-card p-5";
