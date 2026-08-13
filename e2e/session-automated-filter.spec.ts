import { expect, test } from "@playwright/test";
import { isAutomatedSessionTitle, classifySessionKind, sessionKindOf } from "../src/lib/session-kinds";

test.describe("automated session detection", () => {
  test("flags Mission Control's programmatic runs", () => {
    expect(isAutomatedSessionTitle("TASK: read-only knowledge extraction. You are being called…")).toBe(true);
    expect(isAutomatedSessionTitle("You are being called programmatically by Mission Control")).toBe(true);
    expect(isAutomatedSessionTitle("@memory/dreaming/rem/2026-08-13")).toBe(true);
    expect(isAutomatedSessionTitle("memory extraction")).toBe(true);
  });

  test("flags OpenClaw self-test / capability probes", () => {
    expect(isAutomatedSessionTitle("Say A-OK")).toBe(true);
    expect(isAutomatedSessionTitle("Reply exactly: TEXTOK")).toBe(true);
    expect(isAutomatedSessionTitle("Reply with exactly: TEXTOK")).toBe(true);
    expect(isAutomatedSessionTitle("Reply with the single word: pong")).toBe(true);
    expect(isAutomatedSessionTitle("What is the secret word in the attached file?")).toBe(true);
    expect(isAutomatedSessionTitle("Remember the codeword ZEBRA")).toBe(true);
    expect(isAutomatedSessionTitle("Colour? One word.")).toBe(true);
    expect(isAutomatedSessionTitle("What colour fills this image?")).toBe(true);
    expect(isAutomatedSessionTitle('(Re your check-in: "Hey — how did it go?") its monday')).toBe(true);
  });

  test("leaves real user conversations alone", () => {
    expect(isAutomatedSessionTitle("iPhone")).toBe(false);
    expect(isAutomatedSessionTitle("@DREAMS.md what this file has?")).toBe(false);
    expect(isAutomatedSessionTitle("What can you do?")).toBe(false);
    expect(isAutomatedSessionTitle("its on monday, not today")).toBe(false); // a real nudge reply
    expect(isAutomatedSessionTitle("Can you reply to this email for me?")).toBe(false);
    expect(isAutomatedSessionTitle("")).toBe(false);
    expect(isAutomatedSessionTitle(undefined)).toBe(false);
  });

  test("kind classifier still only treats openresponses/main as chat", () => {
    expect(classifySessionKind(sessionKindOf({ key: "agent:main:openresponses:x" })).isChat).toBe(true);
    expect(classifySessionKind(sessionKindOf({ key: "agent:main:cron:x" })).isChat).toBe(false);
    expect(classifySessionKind(sessionKindOf({ key: "agent:main:subagent:x" })).isChat).toBe(false);
  });
});
