import { NextRequest, NextResponse } from "next/server";
import {
  ensureTaskEngine,
  getEventsStatus,
  getRunSnapshot,
  listRunSnapshots,
} from "@/lib/task-engine";

/**
 * Live state for every card the engine knows about.
 *
 * This answers from memory: no gateway calls, no file reads, no work started per
 * request. The engine is already fed by pushed events, so a poll is a read of
 * state that was going to be there anyway — poll it as hard as you like, or
 * ignore it and take the same snapshots off `/api/tasks/stream`.
 *
 * `events.connected` is the honesty flag. False means the WebSocket to the
 * gateway is down and these snapshots are being kept up by periodic
 * reconciliation instead of live events; the UI should stop implying freshness.
 */
export async function GET(request: NextRequest) {
  ensureTaskEngine();

  const taskIdRaw = new URL(request.url).searchParams.get("taskId");
  if (taskIdRaw) {
    const taskId = Number(taskIdRaw);
    if (!Number.isFinite(taskId)) {
      return NextResponse.json({ error: "taskId must be a number" }, { status: 400 });
    }
    const run = getRunSnapshot(taskId);
    if (!run) {
      // Not an error: a card that has never been dispatched simply has no run.
      return NextResponse.json({ run: null, events: getEventsStatus(), now: Date.now() });
    }
    return NextResponse.json({ run, events: getEventsStatus(), now: Date.now() });
  }

  return NextResponse.json({
    runs: listRunSnapshots(),
    events: getEventsStatus(),
    now: Date.now(),
  });
}
