/**
 * Vitest jsdom pin for the six pure formatter helpers in `agents-view.tsx`
 * (`formatTokens`, `formatBytes`, `formatAgo`, `shortModel`, `channelIcon`,
 * `shortPath`) — the "component" project's proof that a 5,100-line
 * `"use client"` view module (whose module-level imports pull in
 * `@xyflow/react` and its CSS) can be imported under jsdom.
 *
 * Per D-03, the only source change that made this importable is adding the
 * `export` keyword to these six declarations — no logic change. This file
 * pins their current, actual behavior, not an idealized version.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatTokens,
  formatBytes,
  formatAgo,
  shortModel,
  channelIcon,
  shortPath,
} from "@/components/agents-view";

describe("agents-view: formatTokens", () => {
  test("values under 1000 print as-is", () => {
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
  });

  test("1K threshold: one decimal place, K suffix", () => {
    expect(formatTokens(1000)).toBe("1.0K");
    expect(formatTokens(1500)).toBe("1.5K");
    expect(formatTokens(999_999)).toBe("1000.0K");
  });

  test("1M threshold: two decimal places, M suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.00M");
    expect(formatTokens(2_500_000)).toBe("2.50M");
  });
});

describe("agents-view: formatBytes", () => {
  test("values under 1024 print as bytes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  test("KB threshold: one decimal place", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
  });

  test("MB threshold: one decimal place", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

describe("agents-view: formatAgo", () => {
  const NOW = new Date("2026-08-18T12:00:00.000Z").getTime();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("null (and falsy) input reads Never", () => {
    expect(formatAgo(null)).toBe("Never");
    expect(formatAgo(0)).toBe("Never");
  });

  test("under 60s reads Just now", () => {
    expect(formatAgo(NOW - 30_000)).toBe("Just now");
  });

  test("minutes bucket", () => {
    expect(formatAgo(NOW - 5 * 60_000)).toBe("5m ago");
  });

  test("hours bucket", () => {
    expect(formatAgo(NOW - 3 * 3_600_000)).toBe("3h ago");
  });

  test("days bucket", () => {
    expect(formatAgo(NOW - 2 * 86_400_000)).toBe("2d ago");
  });
});

describe("agents-view: shortModel", () => {
  test("returns the last path segment", () => {
    expect(shortModel("openrouter/moonshotai/kimi-k3")).toBe("kimi-k3");
  });

  test("no slash: returns the string as-is", () => {
    expect(shortModel("gpt-5")).toBe("gpt-5");
  });
});

describe("agents-view: channelIcon", () => {
  test("all seven switch arms, including the default", () => {
    expect(channelIcon("telegram")).toBe("✈️");
    expect(channelIcon("whatsapp")).toBe("💬");
    expect(channelIcon("email")).toBe("📧");
    expect(channelIcon("discord")).toBe("🎮");
    expect(channelIcon("slack")).toBe("💼");
    expect(channelIcon("web")).toBe("🌐");
    expect(channelIcon("some-unknown-channel")).toBe("📡");
  });
});

describe("agents-view: shortPath", () => {
  test("returns the last path segment", () => {
    expect(shortPath("/Users/clawbert/instances/dev/home/.openclaw/workspace")).toBe("workspace");
  });

  test("trailing slash: falls back to the second-to-last segment", () => {
    expect(shortPath("/foo/bar/")).toBe("bar");
  });

  test("no slash: returns the string as-is (final fallback)", () => {
    expect(shortPath("workspace")).toBe("workspace");
  });
});
