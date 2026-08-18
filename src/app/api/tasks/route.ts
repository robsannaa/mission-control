import { NextResponse } from "next/server";
import {
  auditTasks,
  cancelFlow,
  cancelTask,
  getTasksSnapshot,
  runMaintenance,
  setNotify,
  showTask,
} from "@/lib/tasks-native";
import { withRoute } from "@/lib/api-route";
import { apiError, notFound, serverError } from "@/lib/api-errors";
import { TASKS_MAX_BODY_BYTES, tasksPostSchema } from "@/lib/schemas/automation";

export const dynamic = "force-dynamic";

/**
 * GET /api/tasks?scope=active|all  — the native OpenClaw task + TaskFlow ledger.
 *      /api/tasks?id=<lookup>        — one task (show).
 */
export const GET = withRoute({ name: "/api/tasks" }, async (request, ctx) => {
  const params = request.nextUrl.searchParams;
  const id = params.get("id")?.trim();
  try {
    if (id) {
      const task = await showTask(id);
      if (!task) return notFound("Task not found");
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
    ctx.log.error({ err: error instanceof Error ? error.message : String(error) }, "Tasks GET error");
    return serverError(error instanceof Error ? error.message : String(error));
  }
});

/** POST — cancel a task/flow, or set a task's notify policy. */
export const POST = withRoute(
  { name: "/api/tasks", bodySchema: tasksPostSchema, maxBytes: TASKS_MAX_BODY_BYTES },
  async (request, ctx) => {
    const body = ctx.body as Record<string, unknown> & { action: string; id?: string };
    const action = body.action;
    try {
      if (action === "cancel") {
        await cancelTask(String(body.id));
      } else if (action === "cancel-flow") {
        await cancelFlow(String(body.id));
      } else if (action === "notify") {
        await setNotify(String(body.id), String(body.policy || ""));
      } else if (action === "maintenance-apply") {
        const result = await runMaintenance(true);
        return NextResponse.json({ ok: true, maintenance: result });
      } else {
        // Unreachable in practice — tasksPostSchema's discriminated union
        // already rejects any action outside the literal set above.
        return apiError(`Unknown action: ${action}`, 400);
      }
      const scope = body.scope === "all" ? "all" : "active";
      return NextResponse.json({ ok: true, ...(await getTasksSnapshot(scope)) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log.error({ err: message }, "Tasks POST error");
      // Bug fix 2026-08-16: the OpenClaw CLI surfaces "Task not found" / "TaskFlow
      // not found" with a non-zero exit code. Map these to 404 instead of a generic
      // 500 so clients can distinguish "doesn't exist" from "internal failure".
      if (/Task(?:Flow)? not found/i.test(message)) {
        return notFound(message);
      }
      const status = /required|must be/i.test(message) ? 400 : 500;
      return apiError(message, status);
    }
  },
);
