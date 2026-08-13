import { expect, test } from "@playwright/test";
import {
  groupTasks,
  isCancellable,
  runtimeLabel,
  statusBucket,
  taskTitle,
  type NativeTask,
} from "../src/lib/tasks-native-types";

function task(partial: Partial<NativeTask>): NativeTask {
  return { taskId: "t-" + Math.abs(Math.random()).toString(36).slice(2, 8), runtime: "cron", status: "done", ...partial };
}

test.describe("tasks-native status classification", () => {
  test("statusBucket maps common statuses", () => {
    expect(statusBucket("running")).toBe("running");
    expect(statusBucket("in-progress")).toBe("running");
    expect(statusBucket("queued")).toBe("queued");
    expect(statusBucket("waiting")).toBe("waiting");
    expect(statusBucket("blocked")).toBe("waiting");
    expect(statusBucket("failed")).toBe("failed");
    expect(statusBucket("lost")).toBe("failed");
    expect(statusBucket("cancelled")).toBe("cancelled");
    expect(statusBucket("completed")).toBe("done");
    expect(statusBucket("delivered")).toBe("done");
  });

  test("isCancellable only for active work", () => {
    expect(isCancellable("running")).toBe(true);
    expect(isCancellable("queued")).toBe(true);
    expect(isCancellable("waiting")).toBe(true);
    expect(isCancellable("done")).toBe(false);
    expect(isCancellable("failed")).toBe(false);
  });
});

test.describe("tasks-native grouping", () => {
  test("groups are ordered running→waiting→queued→failed→done→cancelled", () => {
    const tasks = [
      task({ status: "done" }),
      task({ status: "running" }),
      task({ status: "failed" }),
      task({ status: "waiting" }),
    ];
    const groups = groupTasks(tasks);
    expect(groups.map((g) => g.bucket)).toEqual(["running", "waiting", "failed", "done"]);
  });

  test("within a bucket, most recent activity first", () => {
    const groups = groupTasks([
      task({ status: "running", lastEventAt: 100 }),
      task({ status: "running", lastEventAt: 300 }),
      task({ status: "running", lastEventAt: 200 }),
    ]);
    const times = groups[0]!.tasks.map((t) => t.lastEventAt);
    expect(times).toEqual([300, 200, 100]);
  });
});

test.describe("tasks-native display", () => {
  test("taskTitle prefers label, then task text, then id", () => {
    expect(taskTitle(task({ label: "gmail-crawl" }))).toBe("gmail-crawl");
    expect(taskTitle(task({ label: "", task: "Do the thing\nmore" }))).toBe("Do the thing");
    expect(taskTitle(task({ label: "", task: "", taskId: "abcdef123456" }))).toBe("abcdef12");
  });

  test("runtimeLabel is human", () => {
    expect(runtimeLabel("cron")).toBe("Cron");
    expect(runtimeLabel("subagent")).toBe("Subagent");
    expect(runtimeLabel("acp")).toBe("ACP");
  });
});
