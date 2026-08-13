import { expect, test } from "@playwright/test";
import { groupRunsFromEvents, type AuditEvent } from "../src/lib/audit";

function evt(partial: Partial<AuditEvent> & Pick<AuditEvent, "eventId" | "sequence" | "occurredAt" | "kind" | "action" | "status">): AuditEvent {
  return partial as AuditEvent;
}

test.describe("groupRunsFromEvents", () => {
  test("pairs tool started/finished events into one call with duration", () => {
    const events: AuditEvent[] = [
      evt({
        eventId: "e1", sequence: 1, occurredAt: 1000,
        kind: "agent_run", action: "agent.run.started", status: "started",
        runId: "run-1", agentId: "main", sessionKey: "s1",
      }),
      evt({
        eventId: "e2", sequence: 2, occurredAt: 1200,
        kind: "tool_action", action: "tool.action.started", status: "started",
        runId: "run-1", toolCallId: "tc-1", toolName: "exec",
      }),
      evt({
        eventId: "e3", sequence: 3, occurredAt: 1500,
        kind: "tool_action", action: "tool.action.finished", status: "succeeded",
        runId: "run-1", toolCallId: "tc-1", toolName: "exec",
      }),
      evt({
        eventId: "e4", sequence: 4, occurredAt: 2000,
        kind: "agent_run", action: "agent.run.finished", status: "succeeded",
        runId: "run-1", agentId: "main", sessionKey: "s1",
      }),
    ];

    const runs = groupRunsFromEvents(events);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.runId).toBe("run-1");
    expect(run.startedAt).toBe(1000);
    expect(run.endedAt).toBe(2000);
    expect(run.status).toBe("succeeded");
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({
      toolCallId: "tc-1",
      toolName: "exec",
      startedAt: 1200,
      endedAt: 1500,
      status: "succeeded",
      durationMs: 300,
    });
  });

  test("orders runs newest-first", () => {
    const events: AuditEvent[] = [
      evt({ eventId: "a1", sequence: 1, occurredAt: 1000, kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-old" }),
      evt({ eventId: "a2", sequence: 2, occurredAt: 1500, kind: "agent_run", action: "agent.run.finished", status: "succeeded", runId: "run-old" }),
      evt({ eventId: "b1", sequence: 3, occurredAt: 5000, kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-new" }),
      evt({ eventId: "b2", sequence: 4, occurredAt: 5500, kind: "agent_run", action: "agent.run.finished", status: "succeeded", runId: "run-new" }),
    ];

    const runs = groupRunsFromEvents(events);
    expect(runs.map((r) => r.runId)).toEqual(["run-new", "run-old"]);
  });

  test("handles an unfinished (still 'started') run and tool call", () => {
    const events: AuditEvent[] = [
      evt({ eventId: "e1", sequence: 1, occurredAt: 1000, kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-live" }),
      evt({ eventId: "e2", sequence: 2, occurredAt: 1100, kind: "tool_action", action: "tool.action.started", status: "started", runId: "run-live", toolCallId: "tc-x", toolName: "read" }),
    ];

    const runs = groupRunsFromEvents(events);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe("started");
    expect(run.endedAt).toBeUndefined();
    expect(run.tools).toHaveLength(1);
    expect(run.tools[0]).toMatchObject({ toolCallId: "tc-x", status: "started" });
    expect(run.tools[0]!.endedAt).toBeUndefined();
    expect(run.tools[0]!.durationMs).toBeUndefined();
  });

  test("ignores malformed events", () => {
    const events = [
      evt({ eventId: "e1", sequence: 1, occurredAt: 1000, kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-1" }),
      // missing sequence / wrong occurredAt type
      { eventId: "e2", occurredAt: "not-a-number", kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-1" },
      // unknown kind
      { eventId: "e3", sequence: 3, occurredAt: 1500, kind: "weird_kind", action: "x", status: "started", runId: "run-1" },
      // unknown status
      { eventId: "e4", sequence: 4, occurredAt: 1600, kind: "agent_run", action: "x", status: "on_fire", runId: "run-1" },
      // no runId at all — cannot be grouped
      { eventId: "e5", sequence: 5, occurredAt: 1700, kind: "tool_action", action: "tool.action.started", status: "started", toolCallId: "tc-orphan" },
      null,
      evt({ eventId: "e6", sequence: 6, occurredAt: 2000, kind: "agent_run", action: "agent.run.finished", status: "succeeded", runId: "run-1" }),
    ] as unknown as AuditEvent[];

    const runs = groupRunsFromEvents(events);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe("run-1");
    expect(runs[0]!.status).toBe("succeeded");
    expect(runs[0]!.startedAt).toBe(1000);
    expect(runs[0]!.endedAt).toBe(2000);
  });

  test("groups multiple runs, each with their own tool calls", () => {
    const events: AuditEvent[] = [
      evt({ eventId: "r1-start", sequence: 1, occurredAt: 1000, kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-1" }),
      evt({ eventId: "r1-t1-s", sequence: 2, occurredAt: 1100, kind: "tool_action", action: "tool.action.started", status: "started", runId: "run-1", toolCallId: "tc-1", toolName: "exec" }),
      evt({ eventId: "r1-t1-f", sequence: 3, occurredAt: 1200, kind: "tool_action", action: "tool.action.finished", status: "succeeded", runId: "run-1", toolCallId: "tc-1", toolName: "exec" }),
      evt({ eventId: "r1-t2-s", sequence: 4, occurredAt: 1300, kind: "tool_action", action: "tool.action.started", status: "started", runId: "run-1", toolCallId: "tc-2", toolName: "read" }),
      evt({ eventId: "r1-t2-f", sequence: 5, occurredAt: 1400, kind: "tool_action", action: "tool.action.finished", status: "failed", runId: "run-1", toolCallId: "tc-2", toolName: "read" }),
      evt({ eventId: "r1-end", sequence: 6, occurredAt: 1500, kind: "agent_run", action: "agent.run.finished", status: "succeeded", runId: "run-1" }),

      evt({ eventId: "r2-start", sequence: 7, occurredAt: 2000, kind: "agent_run", action: "agent.run.started", status: "started", runId: "run-2" }),
      evt({ eventId: "r2-t1-s", sequence: 8, occurredAt: 2100, kind: "tool_action", action: "tool.action.started", status: "started", runId: "run-2", toolCallId: "tc-3", toolName: "web_search" }),
      evt({ eventId: "r2-t1-f", sequence: 9, occurredAt: 2400, kind: "tool_action", action: "tool.action.finished", status: "succeeded", runId: "run-2", toolCallId: "tc-3", toolName: "web_search" }),
      evt({ eventId: "r2-end", sequence: 10, occurredAt: 2500, kind: "agent_run", action: "agent.run.finished", status: "failed", runId: "run-2" }),
    ];

    const runs = groupRunsFromEvents(events);
    expect(runs).toHaveLength(2);

    const run1 = runs.find((r) => r.runId === "run-1");
    const run2 = runs.find((r) => r.runId === "run-2");
    expect(run1?.tools).toHaveLength(2);
    expect(run1?.tools.map((t) => t.toolCallId)).toEqual(["tc-1", "tc-2"]);
    expect(run2?.tools).toHaveLength(1);
    expect(run2?.status).toBe("failed");
  });
});
