/**
 * CI-safe unit tests for the onboarding wizard's pure logic — no gateway, no
 * server, no browser. Covers the three P0 fixes that are pure functions:
 *
 *   1. Gate decision (setup-gate.tsx): whether the wizard reappears once
 *      onboarding is settled (completedAt/dismissedAt) — the "skip loop" fix.
 *   2. Error-frame detection (error-frame.ts): distinguishing a genuine
 *      assistant reply from a gateway/agent error inside the wizard's chat
 *      stream — the "chat step celebrates on error" fix.
 *   3. Provider probe URL selection (provider-auth.ts): OpenRouter's probe
 *      now hits an authenticated endpoint instead of a public catalog that
 *      accepts any key — the "OpenRouter validation is fake" fix.
 */

import { test, expect } from "@playwright/test";
import {
  shouldShowOnboardingWizard,
  shouldShowFinishSetupPointer,
  type OnboardGateStatus,
  type OnboardGateProgress,
} from "../src/components/setup-gate";
import {
  ONBOARD_ERROR_MARKER,
  splitOnboardChatFrame,
  buildOnboardErrorFrame,
  friendlyOnboardChatError,
} from "../src/components/onboarding/error-frame";
import { getProviderProbeUrl } from "../src/lib/provider-auth";

/* ── 1. Gate decision — completedAt / dismissedAt (the skip-loop fix) ──── */

test.describe("setup-gate: shouldShowOnboardingWizard", () => {
  const needsSetup: OnboardGateStatus = { hasModel: false, hasApiKey: false };
  const fullyConfigured: OnboardGateStatus = { hasModel: true, hasApiKey: true };
  const fresh: OnboardGateProgress = { completedAt: null, dismissedAt: null };
  const completed: OnboardGateProgress = { completedAt: "2026-01-01T00:00:00Z", dismissedAt: null };
  const dismissed: OnboardGateProgress = { completedAt: null, dismissedAt: "2026-01-01T00:00:00Z" };

  test("shows the wizard when credentials are missing and nothing is settled", () => {
    expect(shouldShowOnboardingWizard(needsSetup, fresh, false)).toBe(true);
  });

  test("does NOT show the wizard again once completed, even with credentials still missing", () => {
    // This is the exact skip-loop bug: the user finished the wizard (having
    // skipped the model step, say) and it used to reappear on the next poll.
    expect(shouldShowOnboardingWizard(needsSetup, completed, false)).toBe(false);
  });

  test("does NOT show the wizard again once explicitly dismissed", () => {
    expect(shouldShowOnboardingWizard(needsSetup, dismissed, false)).toBe(false);
  });

  test("never shows the wizard once credentials are actually present, settled or not", () => {
    expect(shouldShowOnboardingWizard(fullyConfigured, fresh, false)).toBe(false);
    expect(shouldShowOnboardingWizard(fullyConfigured, completed, false)).toBe(false);
  });

  test("forceShow always wins — Settings' 'Run setup again' reopens regardless of gate state", () => {
    expect(shouldShowOnboardingWizard(fullyConfigured, completed, true)).toBe(true);
    expect(shouldShowOnboardingWizard(null, null, true)).toBe(true);
  });

  test("no status yet (still loading) never shows the wizard", () => {
    expect(shouldShowOnboardingWizard(null, fresh, false)).toBe(false);
  });
});

test.describe("setup-gate: shouldShowFinishSetupPointer", () => {
  const needsSetup: OnboardGateStatus = { hasModel: false, hasApiKey: false };
  const fullyConfigured: OnboardGateStatus = { hasModel: true, hasApiKey: true };
  const fresh: OnboardGateProgress = { completedAt: null, dismissedAt: null };
  const completed: OnboardGateProgress = { completedAt: "2026-01-01T00:00:00Z", dismissedAt: null };

  test("shows the pointer exactly when setup is incomplete but settled", () => {
    expect(shouldShowFinishSetupPointer(needsSetup, completed, false)).toBe(true);
  });

  test("does not show the pointer while the wizard itself would be showing", () => {
    expect(shouldShowFinishSetupPointer(needsSetup, fresh, false)).toBe(false);
  });

  test("does not show the pointer once fully configured", () => {
    expect(shouldShowFinishSetupPointer(fullyConfigured, completed, false)).toBe(false);
  });

  test("does not show the pointer while forceShow reopened the wizard", () => {
    expect(shouldShowFinishSetupPointer(needsSetup, completed, true)).toBe(false);
  });

  test("gate decision and pointer are mutually exclusive for every combination", () => {
    const statuses = [needsSetup, fullyConfigured, null];
    const progresses = [
      fresh,
      completed,
      { completedAt: null, dismissedAt: "x" } as OnboardGateProgress,
      null,
    ];
    for (const status of statuses) {
      for (const progress of progresses) {
        for (const forceShow of [true, false]) {
          const showsWizard = shouldShowOnboardingWizard(status, progress, forceShow);
          const showsPointer = shouldShowFinishSetupPointer(status, progress, forceShow);
          expect(showsWizard && showsPointer).toBe(false);
        }
      }
    }
  });
});

/* ── 2. Error-frame detection (the chat-celebrates-on-error fix) ───────── */

test.describe("error-frame: splitOnboardChatFrame", () => {
  test("plain assistant text with no marker is a genuine reply", () => {
    const { content, error } = splitOnboardChatFrame("Hello! I'm your agent.");
    expect(content).toBe("Hello! I'm your agent.");
    expect(error).toBeNull();
  });

  test("a marker with a message after it is an error, not content", () => {
    const raw = `Some partial text${ONBOARD_ERROR_MARKER}Your model isn't connected yet.`;
    const { content, error } = splitOnboardChatFrame(raw);
    expect(content).toBe("Some partial text");
    expect(error).toBe("Your model isn't connected yet.");
  });

  test("a marker with no content before it is still an honest failure, not an empty celebration", () => {
    const raw = `${ONBOARD_ERROR_MARKER}The agent hit a problem answering. Try again in a moment.`;
    const { content, error } = splitOnboardChatFrame(raw);
    expect(content).toBe("");
    expect(error).toBe("The agent hit a problem answering. Try again in a moment.");
  });

  test("a marker with no trailing message falls back to a message, never a blank error", () => {
    const { error } = splitOnboardChatFrame(ONBOARD_ERROR_MARKER);
    expect(error).toBeTruthy();
    expect(typeof error).toBe("string");
  });

  test("round-trips through buildOnboardErrorFrame", () => {
    const frame = buildOnboardErrorFrame("Custom failure message.");
    const { content, error } = splitOnboardChatFrame(`streamed so far${frame}`);
    expect(content).toBe("streamed so far");
    expect(error).toBe("Custom failure message.");
  });
});

test.describe("error-frame: friendlyOnboardChatError", () => {
  test("maps a 401/403 status to the model-reconnect message", () => {
    expect(friendlyOnboardChatError("anything", 401)).toContain("Model step");
    expect(friendlyOnboardChatError("anything", 403)).toContain("Model step");
  });

  test("maps the real gateway 'no API key found' failure to the model-reconnect message", () => {
    // Verified live: a fresh gateway with no credentials fails a chat turn
    // with exactly this shape (raw path + CLI command included) — the
    // friendly translation must catch it and never leak the raw text.
    const raw =
      'No API key found for provider "openai". Auth store: /Users/x/.openclaw/agents/main/agent/openclaw-agent.sqlite. Configure auth for this agent (openclaw agents add <id>).';
    const message = friendlyOnboardChatError(raw);
    expect(message).toContain("Model step");
    expect(message).not.toContain("openclaw-agent.sqlite");
    expect(message).not.toContain("openclaw agents add");
  });

  test("maps an unreachable gateway to the gateway-step message", () => {
    expect(friendlyOnboardChatError("ECONNREFUSED", undefined)).toContain("Gateway step");
    expect(friendlyOnboardChatError("anything", 404)).toContain("Gateway step");
  });

  test("an empty detail still produces a non-empty, plain message", () => {
    const message = friendlyOnboardChatError("");
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("undefined");
  });

  test("never echoes raw provider error bodies back verbatim", () => {
    const raw = '{"error":{"message":"some obscure upstream failure","code":500}}';
    const message = friendlyOnboardChatError(raw);
    expect(message).not.toContain("{");
    expect(message).not.toContain("upstream failure");
  });
});

/* ── 3. Provider probe URL selection (the fake OpenRouter validation fix) ── */

test.describe("provider-auth: getProviderProbeUrl", () => {
  test("openrouter probes the authenticated /key endpoint, not the public /models catalog", () => {
    // /api/v1/models returns 200 for ANY Authorization header including
    // garbage (verified live) — it never actually checks the key. /api/v1/key
    // is OpenRouter's authenticated "who am I" endpoint and 401s on a bad
    // key (also verified live, see the audit report).
    const url = getProviderProbeUrl("openrouter");
    expect(url).toBe("https://openrouter.ai/api/v1/key");
    expect(url).not.toContain("/models");
  });

  test("anthropic and openai probe real, key-checking endpoints", () => {
    expect(getProviderProbeUrl("anthropic")).toBe("https://api.anthropic.com/v1/messages");
    expect(getProviderProbeUrl("openai")).toBe("https://api.openai.com/v1/models");
  });

  test("case-insensitive and trims whitespace, matching how the UI sends provider ids", () => {
    expect(getProviderProbeUrl(" OpenRouter ")).toBe("https://openrouter.ai/api/v1/key");
  });

  test("unknown providers have no probe (validateProviderToken must reject, never silently pass)", () => {
    expect(getProviderProbeUrl("not-a-real-provider")).toBeNull();
    expect(getProviderProbeUrl("")).toBeNull();
  });
});
