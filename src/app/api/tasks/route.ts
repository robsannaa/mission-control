import { NextRequest, NextResponse } from "next/server";
import {
  auditTasks,
  cancelFlow,
  cancelTask,
  getTasksSnapshot,
  runMaintenance,
  setNotify,
  showTask,
} from "@/lib/tasks-native";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks?scope=active|all  — the native OpenClaw task + TaskFlow ledger.
 *      /api/tasks?id=<lookup>        — one task (show).
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const id = params.get("id")?.trim();
  try {
    if (id) {
      const task = await showTask(id);
      if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
      return NextResponse.json({ task });
    }
    const view = params.get("view");
    if (view === "audit") {
      return NextResponse.json(await auditTasks(params.get("code")?.trim() || undefined));
    }
    if (view === "maintenance") {
      // Dry-run preview only. Applying is an explicit POST.
      return NextResponse.json(await runMaintenance(false));
    }
    const scope = params.get("scope") === "all" ? "all" : "active";
    return NextResponse.json(await getTasksSnapshot(scope));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST — cancel a task/flow, or set a task's notify policy. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  try {
    if (action === "cancel") {
      await cancelTask(String(body.id || ""));
    } else if (action === "cancel-flow") {
      await cancelFlow(String(body.id || ""));
    } else if (action === "notify") {
      await setNotify(String(body.id || ""), String(body.policy || ""));
    } else if (action === "maintenance-apply") {
      const result = await runMaintenance(true);
      return NextResponse.json({ ok: true, maintenance: result });
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    const scope = body.scope === "all" ? "all" : "active";
    return NextResponse.json({ ok: true, ...(await getTasksSnapshot(scope)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Bug fix 2026-08-16: the OpenClaw CLI surfaces "Task not found" / "TaskFlow
    // not found" with a non-zero exit code. Map these to 404 instead of a generic
    // 500 so clients can distinguish "doesn't exist" from "internal failure".
    if (/Task(?:Flow)? not found/i.test(message)) {
      return NextResponse.json({ ok: false, error: message }, { status: 404 });
    }
    const status = /required|must be/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
