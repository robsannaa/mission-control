/**
 * Vitest jsdom pin for the pure helpers in `cron-view.tsx` — the fragile,
 * 3,300-line monolithic cron view. Per D-03 (01-CONTEXT.md), the only
 * source change that made these importable is the mechanical addition of
 * the `export` keyword to ten pure helpers — no logic change, no
 * reformatting, no test-hook attributes added to the view.
 *
 * These are pinning tests: they encode current behavior exactly as it is
 * today. A failure here means behavior moved — someone must decide whether
 * that was intended, not "fix the test to make it pass again."
 *
 * Pins in this file:
 *   - fmtDuration, fmtAgo, fmtDate, fmtFullDate — the four time formatters
 *   - cronToHuman, scheduleDisplay, scheduleOptionLabel — cron-expression
 *     to plain-language translation (the chain a Plan 05 e2e spec also pins
 *     at the rendered end)
 *   - normalizeDeliveryMode, isValidWebhookUrl — delivery config validation
 *   - buildFailureGuide — the plain-language failure explanations shown to
 *     a non-technical user when a cron job fails; this is the highest
 *     user-visible-consequence helper in this file
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fmtDuration,
  fmtAgo,
  fmtDate,
  fmtFullDate,
  cronToHuman,
  scheduleDisplay,
  scheduleOptionLabel,
  normalizeDeliveryMode,
  isValidWebhookUrl,
  buildFailureGuide,
} from "@/components/cron-view";

/* ── fmtDuration ──────────────────────────────────── */

describe("cron-view: fmtDuration", () => {
  test("falsy input (undefined, 0) reads em-dash", () => {
    expect(fmtDuration(undefined)).toBe("—");
    expect(fmtDuration(0)).toBe("—");
  });

  test("under 1000ms: raw millisecond count with ms suffix", () => {
    expect(fmtDuration(1)).toBe("1ms");
    expect(fmtDuration(999)).toBe("999ms");
  });

  test("1s to under 60s: whole seconds, no decimal (toFixed(0))", () => {
    expect(fmtDuration(1000)).toBe("1s");
    expect(fmtDuration(1499)).toBe("1s");
    expect(fmtDuration(1500)).toBe("2s");
    expect(fmtDuration(59999)).toBe("60s");
  });

  test("60s and over: minutes with one decimal place", () => {
    expect(fmtDuration(60000)).toBe("1.0m");
    expect(fmtDuration(90000)).toBe("1.5m");
    expect(fmtDuration(916)).toBe("916ms");
  });
});

/* ── fmtAgo ───────────────────────────────────────── */

describe("cron-view: fmtAgo", () => {
  const NOW = new Date("2026-08-18T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("falsy input (undefined, 0) reads em-dash", () => {
    expect(fmtAgo(undefined)).toBe("—");
    expect(fmtAgo(0)).toBe("—");
  });

  test("past: seconds bucket", () => {
    expect(fmtAgo(NOW - 30_000)).toBe("30s ago");
  });

  test("past: minutes bucket", () => {
    expect(fmtAgo(NOW - 5 * 60_000)).toBe("5m ago");
  });

  test("past: hours bucket", () => {
    expect(fmtAgo(NOW - 3 * 3_600_000)).toBe("3h ago");
  });

  test("past: days bucket", () => {
    expect(fmtAgo(NOW - 2 * 86_400_000)).toBe("2d ago");
  });

  test("future: seconds bucket", () => {
    expect(fmtAgo(NOW + 30_000)).toBe("in 30s");
  });

  test("future: minutes bucket", () => {
    expect(fmtAgo(NOW + 5 * 60_000)).toBe("in 5m");
  });

  test("future: hours bucket", () => {
    expect(fmtAgo(NOW + 3 * 3_600_000)).toBe("in 3h");
  });

  test("future: days bucket", () => {
    expect(fmtAgo(NOW + 2 * 86_400_000)).toBe("in 2d");
  });
});

/* ── fmtDate / fmtFullDate ────────────────────────── */
//
// Locale-formatted output is timezone-dependent on the machine running the
// suite. We pin the stable, format-driven parts of the string (12-hour AM/PM
// suffix vs. zero-padded 24-hour clock) rather than the full rendered
// string, per the plan's guidance.

describe("cron-view: fmtDate", () => {
  const EPOCH = new Date("2026-03-15T14:30:00.000Z").getTime();

  test("falsy input reads em-dash", () => {
    expect(fmtDate(undefined, "24h")).toBe("—");
  });

  test("24h preference: no AM/PM suffix", () => {
    const out = fmtDate(EPOCH, "24h");
    expect(out).not.toMatch(/\b(AM|PM)\b/);
  });

  test("12h preference: has AM/PM suffix", () => {
    const out = fmtDate(EPOCH, "12h");
    expect(out).toMatch(/\b(AM|PM)\b/);
  });
});

describe("cron-view: fmtFullDate", () => {
  const EPOCH = new Date("2026-03-15T14:30:00.000Z").getTime();

  test("falsy input reads em-dash", () => {
    expect(fmtFullDate(undefined, "24h")).toBe("—");
  });

  test("24h preference: no AM/PM suffix, includes weekday and year", () => {
    const out = fmtFullDate(EPOCH, "24h");
    expect(out).not.toMatch(/\b(AM|PM)\b/);
    expect(out).toContain("2026");
  });

  test("12h preference: has AM/PM suffix, includes weekday and year", () => {
    const out = fmtFullDate(EPOCH, "12h");
    expect(out).toMatch(/\b(AM|PM)\b/);
    expect(out).toContain("2026");
  });
});

/* ── cronToHuman ──────────────────────────────────── */

describe("cron-view: cronToHuman", () => {
  test("every-N-minutes expression", () => {
    expect(cronToHuman("*/15 * * * *", "24h")).toBe("Every 15 minutes");
  });

  test("daily-at-time expression, 24h format", () => {
    expect(cronToHuman("30 8 * * *", "24h")).toBe("Daily at 08:30");
  });

  test("daily-at-time expression, 12h format", () => {
    expect(cronToHuman("30 8 * * *", "12h")).toBe("Daily at 8:30 AM");
  });

  test("weekday expression (specific day), 24h format", () => {
    expect(cronToHuman("0 9 * * 1", "24h")).toBe("Every Mon at 09:00");
  });

  test("weekday expression (specific day), 12h format", () => {
    expect(cronToHuman("0 9 * * 1", "12h")).toBe("Every Mon at 9:00 AM");
  });

  test("fewer than five fields: returns the input unchanged", () => {
    expect(cronToHuman("* * *", "24h")).toBe("* * *");
    expect(cronToHuman("", "24h")).toBe("");
  });

  test("both time-format preferences produce different clock renderings for the same expression", () => {
    const h24 = cronToHuman("0 18 * * *", "24h");
    const h12 = cronToHuman("0 18 * * *", "12h");
    expect(h24).toBe("Daily at 18:00");
    expect(h12).toBe("Daily at 6:00 PM");
    expect(h24).not.toBe(h12);
  });
});

/* ── scheduleDisplay ──────────────────────────────── */

describe("cron-view: scheduleDisplay", () => {
  test("kind 'every' under 60 minutes", () => {
    expect(scheduleDisplay({ kind: "every", everyMs: 30 * 60_000 }, "24h")).toBe("Every 30m");
  });

  test("kind 'every' over 60 minutes rounds to hours", () => {
    expect(scheduleDisplay({ kind: "every", everyMs: 6 * 3_600_000 }, "24h")).toBe("Every 6h");
  });

  test("kind 'cron' with tz appends the timezone", () => {
    expect(scheduleDisplay({ kind: "cron", expr: "0 8 * * *", tz: "America/New_York" }, "24h")).toBe(
      "Daily at 08:00 (America/New_York)"
    );
  });

  test("kind 'cron' without tz omits the timezone suffix", () => {
    expect(scheduleDisplay({ kind: "cron", expr: "0 8 * * *" }, "24h")).toBe("Daily at 08:00");
  });

  test("kind 'cron' where cronToHuman returns the expression unchanged", () => {
    expect(scheduleDisplay({ kind: "cron", expr: "1,2,3 * * * *" }, "24h")).toBe("1,2,3 * * * *");
  });

  test("unrecognized kind falls back to 'Unknown'", () => {
    expect(scheduleDisplay({ kind: "weird" }, "24h")).toBe("Unknown");
  });
});

/* ── scheduleOptionLabel ──────────────────────────── */

describe("cron-view: scheduleOptionLabel", () => {
  // Real entries from the module-private SCHEDULE_SIMPLE_OPTIONS table
  // (cron-view.tsx ~line 1302-1315), reconstructed as literals here since
  // the const itself is not exported and D-03 forbids exporting anything
  // beyond the ten named pure helpers.

  test("cron kind: cronToHuman's translation wins over the option's own label whenever it differs from the raw expr — this makes the id-keyed 24h labels below effectively unreachable for every cron entry in the real table", () => {
    // daily-8am: cronToHuman("0 8 * * *") = "Daily at 08:00" (!= raw expr),
    // so the function returns on the first branch — the id==="daily-8am"
    // check further down is never reached for this entry.
    expect(
      scheduleOptionLabel({ id: "daily-8am", label: "Every day at 8:00 AM", kind: "cron", expr: "0 8 * * *" }, "24h")
    ).toBe("Daily at 08:00");
    expect(
      scheduleOptionLabel({ id: "daily-6pm", label: "Every day at 6:00 PM", kind: "cron", expr: "0 18 * * *" }, "24h")
    ).toBe("Daily at 18:00");
    // monday-9am: cronToHuman produces "Every Mon at 09:00" (abbreviated
    // weekday), not the id branch's "Every Monday at 09:00" (full name).
    expect(
      scheduleOptionLabel({ id: "monday-9am", label: "Every Monday at 9:00 AM", kind: "cron", expr: "0 9 * * 1" }, "24h")
    ).toBe("Every Mon at 09:00");
    expect(
      scheduleOptionLabel({ id: "twice-day", label: "Twice a day (8am & 8pm)", kind: "cron", expr: "0 8,20 * * *" }, "24h")
    ).toBe("Twice a day (08:00 & 20:00)");
  });

  test("kind 'every' (no expr field): the cron short-circuit is skipped, id-keyed 24h override applies", () => {
    // every-hour has no id match in the hardcoded 24h list, so it falls
    // through to the option's own label.
    expect(
      scheduleOptionLabel({ id: "every-hour", label: "Every hour", kind: "every", interval: "1h" }, "24h")
    ).toBe("Every hour");
  });

  test("12h preference never applies the id-keyed 24h override, even for a matching id", () => {
    expect(
      scheduleOptionLabel({ id: "daily-8am", label: "Every day at 8:00 AM", kind: "every", interval: "1h" }, "12h")
    ).toBe("Every day at 8:00 AM");
  });

  test("id-keyed 24h override is reachable when the cron short-circuit is bypassed (kind !== 'cron') and the id matches one of the four hardcoded entries", () => {
    // Constructed to exercise the branch the real table's cron-kind entries
    // never reach: same id/label pairing the table uses for "daily-8am",
    // but with a non-"cron" kind so the first branch's `"expr" in opt` guard
    // is false and execution falls through to the id check.
    expect(
      scheduleOptionLabel({ id: "daily-8am", label: "fallback label", kind: "at" }, "24h")
    ).toBe("Every day at 08:00");
    expect(
      scheduleOptionLabel({ id: "monday-9am", label: "fallback label", kind: "at" }, "24h")
    ).toBe("Every Monday at 09:00");
  });

  test("non-cron, unrecognized id: returns the option's own label unchanged", () => {
    expect(scheduleOptionLabel({ id: "custom", label: "Custom schedule (advanced)", kind: "custom" }, "24h")).toBe(
      "Custom schedule (advanced)"
    );
  });
});

/* ── normalizeDeliveryMode ────────────────────────── */

describe("cron-view: normalizeDeliveryMode", () => {
  test("each accepted mode passes through", () => {
    expect(normalizeDeliveryMode("announce")).toBe("announce");
    expect(normalizeDeliveryMode("webhook")).toBe("webhook");
    expect(normalizeDeliveryMode("none")).toBe("none");
  });

  test("case and whitespace are normalized", () => {
    expect(normalizeDeliveryMode("  ANNOUNCE  ")).toBe("announce");
    expect(normalizeDeliveryMode("Webhook")).toBe("webhook");
  });

  test("null, undefined and garbage fall back to 'none'", () => {
    expect(normalizeDeliveryMode(null)).toBe("none");
    expect(normalizeDeliveryMode(undefined)).toBe("none");
    expect(normalizeDeliveryMode("carrier-pigeon")).toBe("none");
    expect(normalizeDeliveryMode("")).toBe("none");
  });
});

/* ── isValidWebhookUrl ────────────────────────────── */

describe("cron-view: isValidWebhookUrl", () => {
  test("http and https are accepted", () => {
    expect(isValidWebhookUrl("http://example.com/webhook")).toBe(true);
    expect(isValidWebhookUrl("https://example.com/webhook")).toBe(true);
  });

  test("other protocols are rejected", () => {
    expect(isValidWebhookUrl("ftp://example.com/webhook")).toBe(false);
    expect(isValidWebhookUrl("javascript:alert(1)")).toBe(false);
  });

  test("non-URL strings are rejected", () => {
    expect(isValidWebhookUrl("not a url")).toBe(false);
  });

  test("empty string is rejected", () => {
    expect(isValidWebhookUrl("")).toBe(false);
  });
});

/* ── buildFailureGuide ────────────────────────────── */
//
// One test per branch. Each asserts `headline` exactly and asserts the
// `steps` array's length and channel-hint presence — the plain-language
// promise this helper makes to a non-technical user reading a cron failure.

describe("cron-view: buildFailureGuide", () => {
  test("delivery target missing, with a channel set: channel-specific hint", () => {
    const guide = buildFailureGuide("Delivery target is missing", { mode: "announce", channel: "telegram" });
    expect(guide.headline).toBe("Delivery destination is missing");
    expect(guide.steps).toHaveLength(3);
    expect(guide.steps[1]).toBe("Set recipient in Delivery for the telegram channel.");
  });

  test("delivery target missing, no channel set: generic hint", () => {
    const guide = buildFailureGuide("delivery missing target", { mode: "none" });
    expect(guide.headline).toBe("Delivery destination is missing");
    expect(guide.steps).toHaveLength(3);
    expect(guide.steps[1]).toBe("Set a delivery channel and recipient in the Delivery section.");
  });

  test("provider authentication failure", () => {
    const guide = buildFailureGuide("401 Unauthorized: invalid API key", { mode: "none" });
    expect(guide.headline).toBe("Provider authentication failed");
    expect(guide.steps).toHaveLength(3);
  });

  test("model unavailable", () => {
    const guide = buildFailureGuide("model not found: gpt-nonexistent", { mode: "none" });
    expect(guide.headline).toBe("Selected model is unavailable");
    expect(guide.steps).toHaveLength(3);
  });

  test("timeout", () => {
    const guide = buildFailureGuide("Error: the run timed out after 300s", { mode: "none" });
    expect(guide.headline).toBe("The job timed out");
    expect(guide.steps).toHaveLength(3);
  });

  test("connection failure", () => {
    const guide = buildFailureGuide("connect ECONNREFUSED 127.0.0.1:11434", { mode: "none" });
    expect(guide.headline).toBe("Connection to a required service failed");
    expect(guide.steps).toHaveLength(3);
  });

  test("unrecognized error: generic fallback branch", () => {
    const guide = buildFailureGuide("Cannot find module '/some/path/run-dream.mjs'", { mode: "none" });
    expect(guide.headline).toBe("The run failed");
    expect(guide.steps).toHaveLength(3);
  });
});
