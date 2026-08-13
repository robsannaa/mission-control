import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createInteraction,
  findActiveInteractionsForSource,
  resetInteractionStoreForTests,
  transitionInteraction,
} from "../src/lib/awareness/store";

// The cron re-enable guard (`reEnableCronIfSettled`) decides whether a paused
// schedule may be re-enabled by asking `findActiveInteractionsForSource`: it may
// only re-enable once the source has NO unresolved question (H2), and it must do
// so on any terminal transition — including skip/cancel — so a job is never
// stranded disabled (H1). These tests exercise that decision at the data layer.
let directory = "";

test.describe.serial("cron re-enable settle guard", () => {
  const source = { kind: "cron" as const, id: "job-reenable" };

  test.beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "mc-reenable-"));
    process.env.MISSION_CONTROL_INTERACTION_DB = join(directory, "interactions.db");
    resetInteractionStoreForTests();
  });

  test.afterAll(async () => {
    delete process.env.MISSION_CONTROL_INTERACTION_DB;
    resetInteractionStoreForTests();
    await rm(directory, { recursive: true, force: true });
  });

  test("an unresolved cron question keeps its source active (schedule must stay paused)", async () => {
    const q = await createInteraction({
      title: "Need input",
      question: "Continue the mail sweep?",
      source: { ...source, runId: "run-1" },
      idempotencyKey: "job-reenable:run-1:q1",
    });
    const active = await findActiveInteractionsForSource(source);
    expect(active.map((i) => i.id)).toContain(q.id);
  });

  test("a different source's open question does not count toward this source", async () => {
    await createInteraction({
      title: "Other job",
      question: "Proceed?",
      source: { kind: "cron", id: "other-job", runId: "run-x" },
      idempotencyKey: "other-job:run-x:q",
    });
    const active = await findActiveInteractionsForSource(source);
    expect(active.every((i) => i.source.id === "job-reenable")).toBe(true);
    expect(active.length).toBeGreaterThan(0);
  });

  test("resolving the question settles the source (now safe to re-enable)", async () => {
    const before = await findActiveInteractionsForSource(source);
    expect(before.length).toBe(1);
    // Skip is a terminal transition reachable from `open` — the path H1 was
    // stranding by never re-enabling. After it, the source has no open question.
    await transitionInteraction({ id: before[0]!.id, status: "skipped" });
    const after = await findActiveInteractionsForSource(source);
    expect(after).toHaveLength(0);
  });
});
