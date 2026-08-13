import { expect, test } from "@playwright/test";
import { interactionReplyMessages } from "../src/lib/interaction-chat";
import type { InteractionRequest, InteractionStatus } from "../src/lib/awareness/types";

function interaction(status: InteractionStatus, answer: string | null): InteractionRequest {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: "local",
    userId: "owner",
    agentId: "main",
    kind: "clarification",
    status,
    title: "Scheduled work needs your input",
    question: "Which Alex sent this?",
    context: null,
    reason: null,
    source: { kind: "cron", id: "cron-1", label: "Scheduled task" },
    choices: [],
    answer,
    answeredAt: 100,
    expiresAt: null,
    idempotencyKey: "cron-1:run-1",
    createdAt: 50,
    updatedAt: 110,
    version: 2,
    metadata: {},
  };
}

function text(row: ReturnType<typeof interactionReplyMessages>[number]): string {
  const part = row.parts[0];
  return part.type === "text" ? part.text : "";
}

test.describe("clarification chat chronology", () => {
  test("an unanswered question adds no unrelated transcript messages", () => {
    expect(interactionReplyMessages(interaction("open", null))).toEqual([]);
  });

  test("the durable answer is followed by the resume acknowledgement", () => {
    const rows = interactionReplyMessages(interaction("resuming", "This was just a test"));

    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(text(rows[0])).toBe("This was just a test");
    expect(text(rows[1])).toBe(
      "Thanks — I have the clarification. I’m continuing Scheduled task now.",
    );
    expect(rows[0].id).toBe(
      "interaction-11111111-1111-4111-8111-111111111111-user",
    );
  });

  test("a refresh can reconstruct the completed clarification thread", () => {
    const rows = interactionReplyMessages(interaction("completed", "Alex is the accountant"));

    expect(text(rows[0])).toBe("Alex is the accountant");
    expect(text(rows[1])).toBe(
      "Thanks — I have the clarification. Scheduled task has finished.",
    );
  });
});
