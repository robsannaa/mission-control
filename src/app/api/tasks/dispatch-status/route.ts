import { NextRequest, NextResponse } from "next/server";
import { join } from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { getClient } from "@/lib/openclaw";

export async function GET(request: NextRequest) {
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

    const client = await getClient();
    const ws = await getDefaultWorkspace();
    const kanbanPath = join(ws, "kanban.json");
    const raw = await client.readFile(kanbanPath);
    const data = JSON.parse(raw);
    const tasks = Array.isArray(data.tasks) ? data.tasks : [];
    const task = tasks.find((t: { id: number }) => t.id === taskId);

    if (!task) {
      return NextResponse.json({ error: `Task ${taskId} not found` }, { status: 404 });
    }

    return NextResponse.json({
      taskId: task.id,
      column: task.column,
      dispatchStatus: task.dispatchStatus || "idle",
      dispatchRunId: task.dispatchRunId || null,
      dispatchedAt: task.dispatchedAt || null,
      completedAt: task.completedAt || null,
      dispatchError: task.dispatchError || null,
      agentId: task.agentId || null,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
