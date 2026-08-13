import { expect, test } from "@playwright/test";
import { isAutomatedSessionTitle, classifySessionKind, sessionKindOf } from "../src/lib/session-kinds";

test.describe("automated session detection", () => {
  test("flags Mission Control's programmatic runs", () => {
    expect(isAutomatedSessionTitle("TASK: read-only knowledge extraction. You are being called…")).toBe(true);
    expect(isAutomatedSessionTitle("You are being called programmatically by Mission Control")).toBe(true);
    expect(isAutomatedSessionTitle("@memory/dreaming/rem/2026-08-13")).toBe(true);
    expect(isAutomatedSessionTitle("memory extraction")).toBe(true);
  });

  test("leaves real user conversations alone", () => {
    expect(isAutomatedSessionTitle("How did the interview go?")).toBe(false);
    expect(isAutomatedSessionTitle("iPhone")).toBe(false);
    expect(isAutomatedSessionTitle("@DREAMS.md what this file has?")).toBe(false);
    expect(isAutomatedSessionTitle("")).toBe(false);
    expect(isAutomatedSessionTitle(undefined)).toBe(false);
  });

  test("kind classifier still only treats openresponses/main as chat", () => {
    expect(classifySessionKind(sessionKindOf({ key: "agent:main:openresponses:x" })).isChat).toBe(true);
    expect(classifySessionKind(sessionKindOf({ key: "agent:main:cron:x" })).isChat).toBe(false);
    expect(classifySessionKind(sessionKindOf({ key: "agent:main:subagent:x" })).isChat).toBe(false);
  });
});
