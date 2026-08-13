import { expect, test } from "@playwright/test";
import {
  PROTOCOL,
  cronIdentityOf,
  cronRuntimeIdentityOf,
  finalAssistantText,
  finalEventText,
  interactionIdOf,
  questionOf,
  textOf,
} from "../openclaw-plugin/mission-control-awareness/dist/protocol.js";

test.describe("OpenClaw awareness bridge", () => {
  test("exports the same versioned, provider-neutral contract", () => {
    expect(PROTOCOL).toContain("mc-awareness-v1");
    expect(PROTOCOL).toContain("do not assume a particular memory provider");
  });

  test("reads OpenClaw string and content-block message shapes", () => {
    expect(textOf("plain")).toBe("plain");
    expect(textOf([{ type: "text", text: "first" }, { content: "second" }])).toBe("first\nsecond");
  });

  test("uses only the final assistant message", () => {
    expect(finalAssistantText([
      { role: "assistant", content: "old" },
      { role: "user", content: "new prompt" },
      { role: "assistant", content: [{ type: "text", text: "final" }] },
    ])).toBe("final");
  });

  test("returns no text when there is no assistant response", () => {
    expect(finalAssistantText([{ role: "user", content: "hello" }])).toBe("");
  });

  test("prefers OpenClaw's finalized assistant message for cron capture", () => {
    expect(finalEventText({
      lastAssistantMessage: "Paused.\nNEEDS_INPUT: Which Alex?",
      messages: [{ role: "assistant", content: "stale partial" }],
    })).toBe("Paused.\nNEEDS_INPUT: Which Alex?");
  });

  test("falls back to the last llm_output assistant text", () => {
    expect(finalEventText({
      assistantTexts: ["intermediate", "Paused.\nNEEDS_INPUT: Which Alex?"],
    })).toBe("Paused.\nNEEDS_INPUT: Which Alex?");
  });

  test("extracts one trailing clarification question", () => {
    expect(questionOf("Paused before writing memory.\nNEEDS_INPUT: Who is Alex?")).toBe("Who is Alex?");
  });

  test("derives cron identity from OpenClaw's canonical session key", () => {
    expect(cronIdentityOf("agent:main:cron:c715e1e7-c962-4c59-a1d1-e7bd79aefa31")).toEqual({
      agentId: "main",
      jobId: "c715e1e7-c962-4c59-a1d1-e7bd79aefa31",
    });
    expect(cronIdentityOf("agent:main:cron:c715e1e7-c962-4c59-a1d1-e7bd79aefa31:run:a4449872-e1f1-4331-a716-309d62a36717")).toEqual({
      agentId: "main",
      jobId: "c715e1e7-c962-4c59-a1d1-e7bd79aefa31",
    });
  });

  test("derives cron identity from the exact llm hook context shape", () => {
    expect(cronRuntimeIdentityOf(
      {
        assistantTexts: ["Paused.\nNEEDS_INPUT: Who is Alex?"],
        runId: "a4449872-e1f1-4331-a716-309d62a36717",
        sessionId: "runtime-session",
      },
      {
        agentId: "main",
        sessionKey: "agent:main:cron:c715e1e7-c962-4c59-a1d1-e7bd79aefa31:run:a4449872-e1f1-4331-a716-309d62a36717",
        trigger: "cron",
      },
    )).toEqual({
      agentId: "main",
      jobId: "c715e1e7-c962-4c59-a1d1-e7bd79aefa31",
      sessionKey: "agent:main:cron:c715e1e7-c962-4c59-a1d1-e7bd79aefa31:run:a4449872-e1f1-4331-a716-309d62a36717",
    });
  });

  test("ignores a non-cron event candidate and uses the cron context", () => {
    expect(cronRuntimeIdentityOf(
      { sessionKey: "agent:main:telegram:direct:123" },
      { sessionKey: "agent:main:cron:mail-sweep:run:run-1" },
    )).toEqual({
      agentId: "main",
      jobId: "mail-sweep",
      sessionKey: "agent:main:cron:mail-sweep:run:run-1",
    });
  });

  test("does not mistake ordinary conversations for cron runs", () => {
    expect(cronIdentityOf("agent:main:telegram:direct:1386366527")).toBeNull();
    expect(cronIdentityOf("agent:main:cron:")).toBeNull();
    expect(cronIdentityOf("agent:main:cron:job:unexpected:suffix")).toBeNull();
  });

  test("does not treat an embedded marker as a control frame", () => {
    expect(questionOf("NEEDS_INPUT: Who is Alex?\nThen I continued anyway.")).toBeNull();
  });

  test("rejects an empty clarification marker", () => {
    expect(questionOf("Paused.\nNEEDS_INPUT:   ")).toBeNull();
  });

  test("correlates a resumed turn with its durable interaction", () => {
    expect(interactionIdOf([
      { role: "user", content: "ordinary prompt" },
      { role: "user", content: "[Mission Control clarification response]\n\n[Mission Control interaction: 2ddee72c-55c7-47cb-8507-e284a3a2e18a]" },
    ])).toBe("2ddee72c-55c7-47cb-8507-e284a3a2e18a");
  });

  test("ignores malformed interaction correlation markers", () => {
    expect(interactionIdOf([{ role: "user", content: "[Mission Control interaction: nope]" }])).toBeNull();
  });
});
