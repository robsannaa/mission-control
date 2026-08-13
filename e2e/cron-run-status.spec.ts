import { expect, test } from "@playwright/test";
import {
  cronRunFailed,
  cronRunOutput,
  selectTriggeredCronRun,
} from "../src/lib/cron-run-status";
import { formatCronDiagnosticLine } from "../src/lib/cron-live-log";

test.describe("cron live run selection", () => {
  test("never completes a new request from the previous run", () => {
    const requestedAt = 20_000;
    const selected = selectTriggeredCronRun(
      [{ runAtMs: 18_000, ts: 19_000, status: "ok" }],
      requestedAt,
      18_000,
    );
    expect(selected).toBeNull();
  });

  test("prefers the manual run when a scheduled run overlaps", () => {
    const selected = selectTriggeredCronRun(
      [
        { runAtMs: 21_000, runId: "scheduled:job:1", status: "ok" },
        { runAtMs: 20_500, runId: "manual:job:2", status: "ok" },
      ],
      20_000,
      18_000,
    );
    expect(selected?.runId).toBe("manual:job:2");
  });

  test("uses the transcript first and the run summary as a fallback", () => {
    const run = { status: "ok", summary: "Completed summary" };
    expect(cronRunOutput(run, "Live transcript")).toBe("Live transcript");
    expect(cronRunOutput(run, "")).toBe("Completed summary");
  });

  test("recognizes both status and error based failures", () => {
    expect(cronRunFailed({ status: "failed" })).toBe(true);
    expect(cronRunFailed({ status: "ok", error: "boom" })).toBe(true);
    expect(cronRunFailed({ status: "ok" })).toBe(false);
  });
});

test("formats real cron progress without dumping diagnostic metadata", () => {
  const row = JSON.stringify({
    time: "2026-08-12T12:04:55.503+02:00",
    message:
      'long-running session: state=processing reason=queued_behind_active_work lastProgress=model_call:started cronJobId=job-1 lastAssistant="Checking the next message." recovery=none',
  });
  const output = formatCronDiagnosticLine(row, "job-1", 0);
  expect(output).toContain("processing · model call started");
  expect(output).toContain("Checking the next message.");
  expect(output).not.toContain("cronJobId");
});
