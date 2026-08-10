/**
 * Dropping a card into In Progress starts a run.
 *
 * This is the board's central promise — In Progress means an agent is working
 * RIGHT NOW — and it is also the rule with the highest cost of being wrong:
 * firing when it should not spends the user's tokens and runs a real agent on
 * their machine, while not firing leaves a card claiming to be running when
 * nothing is.
 *
 * `shouldDispatchOnMove` is pure precisely so it can be pinned here rather than
 * living implicitly inside a drag handler.
 */

import { test, expect } from "@playwright/test";
import {
  shouldDispatchOnMove,
  type Column,
  type DispatchStatus,
} from "../src/components/tasks/types";

const COLUMNS: Column[] = [
  { id: "backlog", title: "Backlog" },
  { id: "in-progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
] as Column[];

const move = (fromColumnId: string, toColumnId: string, status?: DispatchStatus) =>
  shouldDispatchOnMove({ columns: COLUMNS, fromColumnId, toColumnId, status });

test.describe("a drop into In Progress starts the work", () => {
  test("from Backlog, an idle card runs", () => {
    expect(move("backlog", "in-progress")).toBe(true);
  });

  test("from Done, dragging back to In Progress re-runs it", () => {
    expect(move("done", "in-progress", "completed")).toBe(true);
  });

  test("from Review, a card the user has finished with runs again", () => {
    expect(move("review", "in-progress", "cancelled")).toBe(true);
  });

  test("a failed card can be retried by dragging it back", () => {
    expect(move("backlog", "in-progress", "failed")).toBe(true);
  });
});

test.describe("it never starts work the user did not ask for", () => {
  test("moving to Backlog, Review or Done starts nothing", () => {
    for (const target of ["backlog", "review", "done"]) {
      expect(move("in-progress", target)).toBe(false);
      expect(move("backlog", target)).toBe(false);
    }
  });

  test("reordering inside In Progress does not fire a second run", () => {
    expect(move("in-progress", "in-progress")).toBe(false);
  });

  test("a card that is already running is never dispatched again", () => {
    // The caller offers to stop it instead; a second dispatch would start a
    // concurrent turn on the same session.
    for (const status of ["dispatching", "running"] as DispatchStatus[]) {
      expect(move("backlog", "in-progress", status)).toBe(false);
    }
  });

  test("a card waiting on the user is not restarted behind their back", () => {
    // `asking` means the agent stopped for an answer, `needs-review` means we
    // could not tell. Re-running either would discard the question unanswered.
    for (const status of ["asking", "needs-review"] as DispatchStatus[]) {
      expect(move("review", "in-progress", status)).toBe(false);
    }
  });

  test("a no-op move starts nothing, whatever the column", () => {
    for (const id of ["backlog", "in-progress", "review", "done"]) {
      expect(move(id, id)).toBe(false);
    }
  });
});

test.describe("the rule follows the user's own column names", () => {
  const CUSTOM: Column[] = [
    { id: "col-1", title: "Ideas" },
    { id: "col-2", title: "Doing" },
    { id: "col-3", title: "WIP" },
    { id: "col-4", title: "Shipped" },
  ] as Column[];

  const customMove = (fromColumnId: string, toColumnId: string) =>
    shouldDispatchOnMove({ columns: CUSTOM, fromColumnId, toColumnId });

  test('a column titled "Doing" counts as In Progress', () => {
    expect(customMove("col-1", "col-2")).toBe(true);
  });

  test('so does "WIP"', () => {
    expect(customMove("col-1", "col-3")).toBe(true);
  });

  test("but moving between two in-progress-ish columns does not re-run", () => {
    expect(customMove("col-2", "col-3")).toBe(false);
  });

  test("a column with no in-progress meaning never starts anything", () => {
    expect(customMove("col-2", "col-4")).toBe(false);
    expect(customMove("col-1", "col-4")).toBe(false);
  });

  test("an unknown column id is not treated as In Progress", () => {
    expect(customMove("col-1", "does-not-exist")).toBe(false);
  });
});

/* ── @live — the same rule against a real board and a real agent ────────── */

const BASE = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3100";

/**
 * Proves the wiring, not just the rule: that the drop handler reaches the
 * dispatch call, that a real agent runs, and that the card settles by itself.
 *
 * Uses a card whose entire job is to say one word, so a live run costs a
 * sentence and touches nothing. The card is removed afterwards either way.
 */
test.describe("@live dropping a card into In Progress runs it", () => {
  test("a real agent runs and the card settles on its own", async ({ page, request }) => {
    test.setTimeout(120_000);

    const before = await (await request.get(`${BASE}/api/tasks`)).json();
    const id = Math.max(0, ...before.tasks.map((t: { id: number }) => t.id)) + 1;

    await request.put(`${BASE}/api/tasks`, {
      data: {
        ...before,
        tasks: [
          ...before.tasks,
          {
            id,
            title: "Reply with the single word PELICAN",
            description:
              "Reply with the single word PELICAN and nothing else. Do not use any tools.",
            column: "backlog",
            priority: "low",
          },
        ],
      },
    });

    try {
      await page.addInitScript(() => localStorage.setItem("mc-dashboard-tour-done-v1", "1"));
      await page.goto(`${BASE}/tasks`, { waitUntil: "domcontentloaded" });
      await page.locator(`[data-task-id="${id}"]`).waitFor({ timeout: 30_000 });

      // Native HTML5 drag — the handler reads dataTransfer, so synthesise one.
      const dropped = await page.evaluate((taskId) => {
        const source = document.querySelector(`[data-task-id="${taskId}"]`);
        const target = document.querySelector('[data-column-id="in-progress"]');
        if (!source || !target) return false;
        const dt = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
        dt.setData("text/plain", String(taskId));
        target.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: dt }));
        target.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: dt }));
        return true;
      }, id);
      expect(dropped).toBe(true);

      const settled = ["completed", "failed", "cancelled", "asking", "needs-review"];
      let card: Record<string, unknown> | undefined;

      for (let i = 0; i < 120; i++) {
        await page.waitForTimeout(500);
        const board = await (await request.get(`${BASE}/api/tasks`)).json();
        card = board.tasks.find((t: { id: number }) => t.id === id);
        const status = card?.dispatchStatus as string | undefined;
        if (status && settled.includes(status)) break;
      }

      /*
       * Assert on the engine's own transition log, not on catching the card
       * mid-flight. A one-word reply can finish between two polls, and a test
       * this important must not depend on winning that race.
       */
      const transitions = (card?.dispatchTransitions ?? []) as { to?: string }[];
      const states = transitions.map((t) => t.to);
      expect(states).toContain("dispatching");

      // A real session, not a simulated one.
      expect(String(card?.dispatchSessionKey ?? "")).toContain(`task-${id}`);
      expect(card?.dispatchStatus).toBe("completed");
      // And the card moved itself out of In Progress when the work finished.
      expect(card?.column).not.toBe("in-progress");
    } finally {
      const now = await (await request.get(`${BASE}/api/tasks`)).json();
      await request.put(`${BASE}/api/tasks`, {
        data: { ...now, tasks: now.tasks.filter((t: { id: number }) => t.id !== id) },
      });
    }
  });
});
