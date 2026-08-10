/**
 * The Kanban dispatch engine's load-bearing honesty rules.
 *
 * A column on this board is a claim about what an agent is doing right now. The
 * pure functions below decide whether that claim is true, and each of these
 * tests pins a way the board could lie that was found in review:
 *
 *   - a mid-text mention of `DONE:` beating the real trailing `NEEDS_INPUT:`,
 *     landing a card in Done with its question unanswered;
 *   - a stale client replaying an old board over a live run, silently orphaning
 *     a working agent with nothing left on the board to stop or answer it.
 *
 * Pure unit tests: no gateway, no server, no agent runs.
 */

import { test, expect } from "@playwright/test";
import { classifyFinalText } from "../src/lib/task-markers";
import { mergeBoardWrite, type KanbanData, type KanbanTask } from "../src/lib/kanban-store";

/* ── the verdict that decides which column a card lands in ─────────────── */

test.describe("classifyFinalText", () => {
  test("a trailing NEEDS_INPUT: is a question", () => {
    const v = classifyFinalText("Looked at the repo.\nNEEDS_INPUT: Which report file did you mean?");
    expect(v.kind).toBe("question");
    expect(v.confidence).toBe("high");
    if (v.kind === "question") expect(v.question).toBe("Which report file did you mean?");
  });

  test("a trailing DONE: is a completion", () => {
    const v = classifyFinalText("17*23 = 391\nDONE: Computed the product.");
    expect(v.kind).toBe("done");
    if (v.kind === "done") expect(v.summary).toBe("Computed the product.");
  });

  test("the LAST marker wins, not the first one mentioned", () => {
    // The agent narrates the protocol it was given, then actually asks. Reading
    // the first match anywhere would file this under Done and bury the question.
    const v = classifyFinalText(
      [
        "You told me to end with `DONE: <one-line summary>` when finished.",
        "I cannot finish without knowing the target.",
        "NEEDS_INPUT: Which environment should I deploy to?",
      ].join("\n"),
    );
    expect(v.kind).toBe("question");
    if (v.kind === "question") expect(v.question).toBe("Which environment should I deploy to?");
  });

  test("no marker is admitted as unknown rather than guessed", () => {
    const v = classifyFinalText("I had a look and everything seems fine.");
    expect(v.kind).toBe("unknown");
    expect(v.confidence).toBe("low");
  });

  test("empty output is unknown, never done", () => {
    for (const input of ["", "   ", null, undefined]) {
      expect(classifyFinalText(input).kind).toBe("unknown");
    }
  });
});

/* ── the guard that stops a stale board clobbering a live run ──────────── */

const task = (over: Partial<KanbanTask> = {}): KanbanTask =>
  ({ id: 1, title: "A card", column: "backlog", ...over }) as KanbanTask;

const board = (tasks: KanbanTask[], rev = 3): KanbanData =>
  ({ columns: [{ id: "backlog", title: "Backlog" }], tasks, rev }) as unknown as KanbanData;

test.describe("mergeBoardWrite", () => {
  test("a card mid-run survives a client that never knew about it", () => {
    const current = board([task({ id: 1, dispatchStatus: "running" })]);
    const incoming = board([], 0); // stale client: card not in its copy

    const merged = mergeBoardWrite(incoming, current);
    expect(merged.tasks.map((t) => t.id)).toEqual([1]);
    expect(merged.tasks[0].dispatchStatus).toBe("running");
  });

  test("a card holding an unanswered question also survives", () => {
    const current = board([task({ id: 2, dispatchStatus: "asking" })]);
    const merged = mergeBoardWrite(board([], 0), current);
    expect(merged.tasks.map((t) => t.id)).toEqual([2]);
  });

  test("deleting an idle card is still a legitimate edit", () => {
    const current = board([task({ id: 3 })]);
    const merged = mergeBoardWrite(board([], 0), current);
    expect(merged.tasks).toEqual([]);
  });

  test("engine-owned run state is never overwritten by a client board", () => {
    const current = board([task({ id: 1, dispatchStatus: "running", dispatchRunId: "run-a" })]);
    // The client sends the same card back claiming it is idle.
    const incoming = board([task({ id: 1, title: "Renamed by the user" })]);

    const merged = mergeBoardWrite(incoming, current);
    // The user's own edit lands...
    expect(merged.tasks[0].title).toBe("Renamed by the user");
    // ...but the run state stays what the engine says it is.
    expect(merged.tasks[0].dispatchStatus).toBe("running");
    expect(merged.tasks[0].dispatchRunId).toBe("run-a");
  });

  test("the server's revision is kept, not the client's", () => {
    const merged = mergeBoardWrite(board([], 0), board([], 9));
    expect(merged.rev).toBe(9);
  });

  test("a new card is stamped, and older boards are backfilled", () => {
    const fresh = mergeBoardWrite(board([task({ id: 1 })]), board([]));
    expect(fresh.tasks[0].createdAt).toBeGreaterThan(0);
    expect(fresh.tasks[0].updatedAt).toBeGreaterThan(0);

    // A card that predates these fields keeps its identity but gains stamps.
    const backfilled = mergeBoardWrite(board([task({ id: 1 })]), board([task({ id: 1 })]));
    expect(backfilled.tasks[0].createdAt).toBeGreaterThan(0);
  });

  test("editing a card bumps updatedAt but never createdAt", () => {
    const current = board([task({ id: 1, title: "Before", createdAt: 1000, updatedAt: 1000 })]);
    const merged = mergeBoardWrite(board([task({ id: 1, title: "After" })]), current);

    expect(merged.tasks[0].createdAt).toBe(1000);
    expect(merged.tasks[0].updatedAt).toBeGreaterThan(1000);
  });

  test("run activity alone does not restamp updatedAt", () => {
    // Engine-owned fields change constantly while an agent works. If they
    // counted as edits, "last edited" would just mean "recently running".
    const current = board([
      task({ id: 1, title: "Same", createdAt: 1000, updatedAt: 1000, dispatchStatus: "running" }),
    ]);
    const merged = mergeBoardWrite(board([task({ id: 1, title: "Same" })]), current);

    expect(merged.tasks[0].updatedAt).toBe(1000);
  });
});
