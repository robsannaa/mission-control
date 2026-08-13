import { expect, test } from "@playwright/test";
import {
  AWARENESS_PROTOCOL_VERSION,
  buildInteractionIdempotencyKey,
  hasAwarenessProtocol,
  injectAwarenessProtocol,
  injectCronPayloadAwareness,
  normalizeQuestion,
  questionsAreSimilar,
  parseAwarenessOutcome,
  validateQuestion,
} from "../src/lib/awareness/protocol";
import { buildResumePrompt } from "../src/lib/awareness/engine";

test.describe("awareness protocol", () => {
  test("injects stable guidance into a prompt", () => {
    const result = injectAwarenessProtocol("Check my inbox.");
    expect(result).toContain("Check my inbox.");
    expect(result).toContain(AWARENESS_PROTOCOL_VERSION);
    expect(result.toLowerCase()).toContain("do not assume a particular memory provider");
    expect(result).toContain("NEEDS_INPUT:");
  });

  test("does not inject the protocol twice", () => {
    const once = injectAwarenessProtocol("Check my inbox.");
    const twice = injectAwarenessProtocol(once);
    expect(twice).toBe(once);
    expect(twice.match(/Mission Control awareness protocol/g)).toHaveLength(1);
  });

  test("recognizes an existing versioned protocol", () => {
    expect(hasAwarenessProtocol("[Mission Control awareness protocol: mc-awareness-v9]")).toBe(true);
    expect(hasAwarenessProtocol("ordinary prompt")).toBe(false);
  });

  test("agent-turn cron receives awareness", () => {
    const result = injectCronPayloadAwareness({ kind: "agentTurn", message: "Review email", model: "x" });
    expect(result.message).toContain("Review email");
    expect(result.message).toContain(AWARENESS_PROTOCOL_VERSION);
    expect(result.model).toBe("x");
  });

  test("system-event cron is not treated as a model prompt", () => {
    const payload = { kind: "systemEvent", text: "Wake up" };
    expect(injectCronPayloadAwareness(payload)).toEqual(payload);
  });

  test("command cron is not treated as a model prompt", () => {
    const payload = { kind: "command", message: "echo ok" };
    expect(injectCronPayloadAwareness(payload)).toEqual(payload);
  });

  test("parses a trailing clarification marker", () => {
    expect(parseAwarenessOutcome("I paused the write.\nNEEDS_INPUT: Who is Alex?")).toEqual({
      kind: "needs-input",
      question: "Who is Alex?",
    });
  });

  test("uses the last valid clarification marker", () => {
    expect(parseAwarenessOutcome("NEEDS_INPUT: Old?\nSome context\nNEEDS_INPUT: New?")).toEqual({
      kind: "needs-input",
      question: "New?",
    });
  });

  test("does not classify prose mentioning the marker", () => {
    expect(parseAwarenessOutcome("Use `NEEDS_INPUT:` if blocked, but I finished.")).toEqual({ kind: "complete" });
  });

  test("requires the marker to be the final control line", () => {
    expect(parseAwarenessOutcome("NEEDS_INPUT: Who is Alex?\nThen I continued anyway.")).toEqual({ kind: "complete" });
  });

  test("normalizes equivalent questions", () => {
    expect(normalizeQuestion("  Who   is ALEX? ")).toBe("who is alex?");
  });

  test("recognizes a model rephrasing of the same blocking question", () => {
    expect(questionsAreSimilar(
      "Which Alex sent this — your accountant or the supplier contact — or can you share the sender's email/domain so I can tell?",
      "The email doesn't specify a last name, email address, or company signature — is this payment request from Alex the accountant or Alex the supplier contact?",
    )).toBe(true);
  });

  test("does not merge materially different questions from one workflow", () => {
    expect(questionsAreSimilar(
      "Which Alex sent this payment request?",
      "Which bank account should receive the approved payment?",
    )).toBe(false);
  });

  test("idempotency includes workflow run identity", () => {
    const first = buildInteractionIdempotencyKey(
      { kind: "cron", id: "mail", runId: "one" },
      "Who is Alex?",
    );
    const same = buildInteractionIdempotencyKey(
      { kind: "cron", id: "mail", runId: "one" },
      " who  is alex? ",
    );
    const nextRun = buildInteractionIdempotencyKey(
      { kind: "cron", id: "mail", runId: "two" },
      "Who is Alex?",
    );
    expect(same).toBe(first);
    expect(nextRun).not.toBe(first);
  });

  test("resume prompts carry the durable interaction id for completion correlation", () => {
    const prompt = buildResumePrompt(
      "Which supplier?",
      "The first one",
      "2ddee72c-55c7-47cb-8507-e284a3a2e18a",
    );
    expect(prompt).toContain("[Mission Control interaction: 2ddee72c-55c7-47cb-8507-e284a3a2e18a]");
  });
});

test.describe("question validation", () => {
  test("accepts a concise question", () => {
    expect(validateQuestion({ title: "Email needs context", question: "Who is Alex?" })).toEqual([]);
  });

  test("requires title and question", () => {
    expect(validateQuestion({ title: " ", question: " " })).toEqual([
      "title is required",
      "question is required",
    ]);
  });

  test("bounds persisted content", () => {
    const errors = validateQuestion({ title: "t".repeat(241), question: "q".repeat(2001) });
    expect(errors).toContain("title must be 240 characters or fewer");
    expect(errors).toContain("question must be 2000 characters or fewer");
  });

  test("rejects incomplete choices", () => {
    expect(validateQuestion({
      title: "Choose",
      question: "Which?",
      choices: [{ id: "one", label: "", value: "1" }],
    })).toContain("every choice requires id, label, and value");
  });

  test("rejects duplicate choice ids", () => {
    expect(validateQuestion({
      title: "Choose",
      question: "Which?",
      choices: [
        { id: "one", label: "One", value: "1" },
        { id: "one", label: "Another", value: "2" },
      ],
    })).toContain("duplicate choice id: one");
  });
});
