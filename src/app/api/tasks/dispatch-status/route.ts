import { NextRequest, NextResponse } from "next/server";
import { getTask } from "@/lib/kanban-store";
import {
  activityOf,
  errorMessage,
  fetchHistory,
  finalAssistantText,
  lastToolError,
  type TaskActivityEntry,
} from "@/lib/task-dispatch";
import { ensureTaskEngine, getEventsStatus, getRunSnapshot } from "@/lib/task-engine";

/**
 * Everything known about one dispatched card.
 *
 * Three tiers, so a caller pays only for what it needs:
 *
 *   - default   — the durable card state plus the engine's in-memory snapshot
 *                 (status, question, activity, transitions). No gateway calls.
 *   - `?live=1` — additionally asks the gateway for session vitals and rebuilds
 *                 the activity feed from `chat.history`. Use this to fill in a
 *                 card whose live log is empty after a server restart, not on a
 *                 timer: the pushed events on `/api/tasks/stream` are the live
 *                 path and cost nothing.
 *   - `?transcript=1` — the raw messages, for a details panel.
 */
export async function GET(request: NextRequest) {
  ensureTaskEngine();
  try {
    const { searchParams } = new URL(request.url);
    const taskIdRaw = searchParams.get("taskId");
    if (!taskIdRaw) {
      return NextResponse.json({ error: "taskId is required" }, { status: 400 });
    }
    const taskId = Number(taskIdRaw);
    if (isNaN(taskId)) {
      return NextResponse.json({ error: "taskId must be a number" }, { status: 400 });
    }

    const task = await getTask(taskId);
    if (!task) {
      return NextResponse.json({ error: `Task ${taskId} not found` }, { status: 404 });
    }

    const wantsLive = isTruthy(searchParams.get("live"));
    const wantsTranscript = isTruthy(searchParams.get("transcript"));
    const limit = clampLimit(searchParams.get("limit"));

    const base = {
      taskId: task.id,
      column: task.column,
      dispatchStatus: task.dispatchStatus || "idle",
      dispatchRunId: task.dispatchRunId || null,
      dispatchSessionKey: task.dispatchSessionKey || null,
      dispatchedAt: task.dispatchedAt || null,
      completedAt: task.completedAt || null,
      dispatchError: task.dispatchError || null,
      agentId: task.agentId || null,
      // Assignment target. Absent on boards written before this existed, which
      // means the pre-existing behaviour: run in the agent's own session.
      assignee: task.dispatchAssignee || "agent",
      turns: task.dispatchTurns ?? 0,
      /**
       * The question, and how much to trust it.
       *
       * `confidence: "high"` means the agent explicitly emitted `NEEDS_INPUT:` —
       * render it as "the agent asked". `"low"` means the run simply ended with
       * no marker and this is its final text; render it as "finished — needs
       * your review" and offer both answering and marking done. Do not collapse
       * the two: the whole point is that the board never pretends to know.
       */
      question: task.dispatchQuestion
        ? {
            text: task.dispatchQuestion,
            confidence: task.dispatchConfidence ?? "low",
            askedFromColumn: task.askedFromColumn ?? null,
          }
        : null,
      /** Why this card is where it is, newest last. */
      transitions: task.dispatchTransitions ?? [],
      result: {
        text: task.dispatchResultText || null,
        truncated: task.dispatchResultTruncated === true,
        stopReason: task.dispatchStopReason || null,
        runtimeMs: task.dispatchRuntimeMs ?? null,
        totalTokens: task.dispatchTotalTokens ?? null,
        costUsd: task.dispatchCostUsd ?? null,
      },
      /** In-memory live view: activity lines, streaming text, event health. */
      run: getRunSnapshot(task.id),
      events: getEventsStatus(),
    };

    if (!wantsLive && !wantsTranscript) {
      return NextResponse.json(base);
    }
    if (!task.dispatchSessionKey || !task.agentId) {
      return NextResponse.json({ ...base, live: null, liveError: "This task has no run yet." });
    }

    let history;
    try {
      history = await fetchHistory(task.dispatchSessionKey, task.agentId, limit);
    } catch (err) {
      // A live read failing must not blank out the stored answer.
      return NextResponse.json({ ...base, live: null, liveError: errorMessage(err) });
    }

    const info = history.sessionInfo ?? {};
    const activity: TaskActivityEntry[] = activityOf(history.messages);

    return NextResponse.json({
      ...base,
      live: {
        sessionId: history.sessionId ?? null,
        status: info.status ?? null,
        hasActiveRun: info.hasActiveRun === true,
        activeRunIds: info.activeRunIds ?? [],
        abortedLastRun: info.abortedLastRun === true,
        startedAt: info.startedAt ?? null,
        endedAt: info.endedAt ?? null,
        runtimeMs: info.runtimeMs ?? null,
        totalTokens: info.totalTokens ?? null,
        costUsd: info.estimatedCostUsd ?? null,
        finalText: finalAssistantText(history.messages) || null,
        lastToolError: lastToolError(history.messages) || null,
        activity,
      },
      ...(wantsTranscript ? { transcript: history.messages } : {}),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function isTruthy(value: string | null): boolean {
  return value === "1" || value === "true";
}

function clampLimit(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 50;
  return Math.min(Math.floor(n), 200);
}
