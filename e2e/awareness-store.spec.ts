import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  answerInteraction,
  createInteraction,
  getInteraction,
  listInteractions,
  resetInteractionStoreForTests,
  transitionInteraction,
} from "../src/lib/awareness/store";

let directory = "";

test.describe.serial("durable interaction store", () => {
  test.beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mc-awareness-test-"));
    process.env.MISSION_CONTROL_INTERACTION_DB = join(directory, "interactions.db");
    resetInteractionStoreForTests();
  });

  test.afterAll(async () => {
    delete process.env.MISSION_CONTROL_INTERACTION_DB;
    resetInteractionStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  test("creates an open interaction with provider-neutral source metadata", async () => {
    const item = await createInteraction({
      title: "Email needs context",
      question: "Who is Alex?",
      context: "An invoice arrived from Alex.",
      reason: "Identity changes how the invoice is filed.",
      source: { kind: "email", id: "mail-1", runId: "run-1", sessionKey: "agent:main:cron:mail" },
      idempotencyKey: "mail-1:run-1:alex",
      choices: [{ id: "accountant", label: "Accountant", value: "Alex is my accountant" }],
    });
    expect(item.status).toBe("open");
    expect(item.tenantId).toBe("local");
    expect(item.source.kind).toBe("email");
    expect(item.choices[0].label).toBe("Accountant");
  });

  test("same idempotency key returns the original interaction", async () => {
    const input = {
      title: "Duplicate",
      question: "Should I continue?",
      source: { kind: "cron" as const, id: "job-1", runId: "run-1" },
      idempotencyKey: "same-run",
    };
    const first = await createInteraction(input);
    const second = await createInteraction({ ...input, question: "Changed text must not duplicate" });
    expect(second.id).toBe(first.id);
    expect(second.question).toBe("Should I continue?");
  });

  test("coalesces repeated runs while the source still has an active question", async () => {
    const first = await createInteraction({
      title: "Run one", question: "Who is Alex?",
      source: { kind: "cron", id: "mail", runId: "one" }, idempotencyKey: "mail:one",
    });
    const second = await createInteraction({
      title: "Run two", question: "Who is Alex?",
      source: { kind: "cron", id: "mail", runId: "two" }, idempotencyKey: "mail:two",
    });
    expect(second.id).toBe(first.id);
    expect(second.source.runId).toBe("one");

    await transitionInteraction({ id: first.id, status: "skipped" });
    const afterResolution = await createInteraction({
      title: "Run three", question: "Who is Alex?",
      source: { kind: "cron", id: "mail", runId: "three" }, idempotencyKey: "mail:three",
    });
    expect(afterResolution.id).not.toBe(first.id);
  });

  test("does not reopen a recently answered source question under new wording", async () => {
    const first = await createInteraction({
      title: "Payment check",
      question: "Which Alex sent this — your accountant or the supplier contact?",
      source: { kind: "cron", id: "payment-mail", runId: "one" },
      idempotencyKey: "payment-mail:one",
    });
    await answerInteraction({ id: first.id, answer: "This was only a test" });
    await transitionInteraction({ id: first.id, status: "completed" });

    const repeated = await createInteraction({
      title: "Payment check",
      question: "The payment email is from Alex; is that the accountant or the supplier contact?",
      source: { kind: "cron", id: "payment-mail", runId: "two" },
      idempotencyKey: "payment-mail:two",
    });
    expect(repeated.id).toBe(first.id);
    expect(repeated.status).toBe("completed");

    const different = await createInteraction({
      title: "Payment destination",
      question: "Which bank account should receive this payment?",
      source: { kind: "cron", id: "payment-mail", runId: "three" },
      idempotencyKey: "payment-mail:three",
    });
    expect(different.id).not.toBe(first.id);
    expect(different.status).toBe("open");
  });

  test("lists active interactions newest first", async () => {
    const items = await listInteractions({ status: "active", limit: 100 });
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items.every((item) => item.status === "open" || item.status === "resuming")).toBe(true);
    expect(items[0].createdAt).toBeGreaterThanOrEqual(items[1].createdAt);
  });

  test("filters by source kind", async () => {
    const items = await listInteractions({ status: "all", sourceKind: "email" });
    expect(items).toHaveLength(1);
    expect(items[0].source.id).toBe("mail-1");
  });

  test("accepts the first answer", async () => {
    const item = await createInteraction({
      title: "Answer once", question: "Which client?",
      source: { kind: "task", id: "42" }, idempotencyKey: "answer-once",
    });
    const result = await answerInteraction({ id: item.id, answer: "Acme", channel: "telegram" });
    expect(result.accepted).toBe(true);
    expect(result.interaction.status).toBe("answered");
    expect(result.interaction.answer).toBe("Acme");
  });

  test("rejects duplicate answers and preserves the canonical answer", async () => {
    const item = (await listInteractions({ status: "all" })).find((value) => value.idempotencyKey === "answer-once");
    expect(item).toBeTruthy();
    const result = await answerInteraction({ id: item!.id, answer: "Other", channel: "discord" });
    expect(result.accepted).toBe(false);
    expect(result.interaction.answer).toBe("Acme");
  });

  test("concurrent answers produce exactly one winner", async () => {
    const item = await createInteraction({
      title: "Race", question: "Red or blue?",
      source: { kind: "integration", id: "race" }, idempotencyKey: "answer-race",
    });
    const results = await Promise.all([
      answerInteraction({ id: item.id, answer: "Red", channel: "telegram" }),
      answerInteraction({ id: item.id, answer: "Blue", channel: "mission-control" }),
    ]);
    expect(results.filter((result) => result.accepted)).toHaveLength(1);
    const stored = await getInteraction(item.id);
    expect(["Red", "Blue"]).toContain(stored?.answer);
  });

  test("supports skip from open state", async () => {
    const item = await createInteraction({
      title: "Optional", question: "Add a note?",
      source: { kind: "task", id: "optional" }, idempotencyKey: "skip-me",
    });
    expect((await transitionInteraction({ id: item.id, status: "skipped" })).status).toBe("skipped");
  });

  test("invalid transitions fail closed", async () => {
    const item = (await listInteractions({ status: "all" })).find((value) => value.idempotencyKey === "skip-me");
    await expect(transitionInteraction({ id: item!.id, status: "resuming" })).rejects.toThrow(/Cannot transition/);
  });

  test("persists state across store reinitialization", async () => {
    const before = await listInteractions({ status: "all", limit: 200 });
    resetInteractionStoreForTests();
    const after = await listInteractions({ status: "all", limit: 200 });
    expect(after.map((item) => item.id).sort()).toEqual(before.map((item) => item.id).sort());
  });

  test("tenant scoping hides another tenant's interaction", async () => {
    const foreign = await createInteraction({
      tenantId: "tenant-b", userId: "user-b", title: "Private", question: "Private?",
      source: { kind: "system", id: "private" }, idempotencyKey: "private",
    });
    expect(await getInteraction(foreign.id, "local")).toBeNull();
    expect((await listInteractions({ tenantId: "local", status: "all" })).some((item) => item.id === foreign.id)).toBe(false);
  });

  test("validates before writing", async () => {
    await expect(createInteraction({
      title: "", question: "", source: { kind: "task", id: "bad" }, idempotencyKey: "bad",
    })).rejects.toThrow(/title is required; question is required/);
  });

  test("does not allow an empty answer", async () => {
    const item = (await listInteractions({ status: "active" }))[0];
    await expect(answerInteraction({ id: item.id, answer: "   " })).rejects.toThrow("answer is required");
  });

  test("missing interaction is reported", async () => {
    await expect(answerInteraction({ id: "missing", answer: "answer" })).rejects.toThrow("Interaction not found");
  });
});
