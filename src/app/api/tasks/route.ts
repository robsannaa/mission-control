import { NextRequest, NextResponse } from "next/server";
import { join, dirname } from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { getClient } from "@/lib/openclaw";
import { gatewayCall } from "@/lib/openclaw";
import { notifyKanbanUpdated } from "@/lib/kanban-live";

async function getKanbanPath(): Promise<string> {
  const ws = await getDefaultWorkspace();
  return join(ws, "kanban.json");
}

const DEFAULT_COLUMNS = [
  { id: "backlog", title: "Backlog", color: "#6b7280" },
  { id: "in-progress", title: "In Progress", color: "#f59e0b" },
  { id: "review", title: "Review", color: "#8b5cf6" },
  { id: "done", title: "Done", color: "#10b981" },
];

/* ── helpers ──────────────────────────────────────── */

type KanbanTask = {
  id: number;
  title: string;
  description?: string;
  column: string;
  priority: string;
  assignee?: string;
  attachments?: string[];
  agentId?: string;
  dispatchStatus?: "idle" | "dispatching" | "running" | "completed" | "failed";
  dispatchRunId?: string;
  dispatchedAt?: number;
  completedAt?: number;
  dispatchError?: string;
};

type KanbanData = {
  columns: Array<{ id: string; title: string; color: string }>;
  tasks: KanbanTask[];
};

async function readKanban(): Promise<KanbanData> {
  const client = await getClient();
  const kanbanPath = await getKanbanPath();
  const raw = await client.readFile(kanbanPath);
  return JSON.parse(raw) as KanbanData;
}

async function writeKanban(data: KanbanData): Promise<void> {
  const client = await getClient();
  const kanbanPath = await getKanbanPath();
  await client.writeFile(kanbanPath, JSON.stringify(data, null, 2));
}

/* ── GET — read existing board ────────────────────── */

export async function GET() {
  try {
    const data = await readKanban();
    return NextResponse.json({ ...data, _fileExists: true });
  } catch {
    // Return empty kanban if file doesn't exist
    return NextResponse.json({
      columns: DEFAULT_COLUMNS,
      tasks: [],
      _fileExists: false,
    });
  }
}

/* ── PUT — save board ─────────────────────────────── */

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body.columns || !body.tasks) {
      return NextResponse.json(
        { error: "columns and tasks required" },
        { status: 400 }
      );
    }
    // Strip internal fields before saving
    const { _fileExists: _, ...saveData } = body;
    void _;
    await writeKanban(saveData as KanbanData);
    notifyKanbanUpdated();
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Tasks PUT error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST — init board, dispatch to agent ─────────── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action;

    if (action === "init") {
      return handleInit(body);
    }
    if (action === "dispatch") {
      return handleDispatch(body);
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    console.error("Tasks POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── dispatch handler ─────────────────────────────── */

async function handleDispatch(body: { taskId: number; agentId?: string }) {
  const { taskId } = body;
  if (!taskId) {
    return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  }

  // 1. Read kanban, find task, validate
  let data: KanbanData;
  try {
    data = await readKanban();
  } catch {
    return NextResponse.json({ error: "Could not read kanban.json" }, { status: 500 });
  }

  const taskIdx = data.tasks.findIndex((t) => t.id === taskId);
  if (taskIdx === -1) {
    return NextResponse.json({ error: `Task ${taskId} not found` }, { status: 404 });
  }

  const task = data.tasks[taskIdx];
  const agentId = body.agentId || task.agentId;
  if (!agentId) {
    return NextResponse.json(
      { error: "No agent assigned. Assign an agent before dispatching." },
      { status: 400 }
    );
  }

  // 2. Update task state — move to in-progress, set dispatch fields
  const idempotencyKey = crypto.randomUUID();
  const sessionKey = `task-${taskId}`;

  task.agentId = agentId;
  task.column = "in-progress";
  task.dispatchStatus = "running";
  task.dispatchedAt = Date.now();
  task.dispatchRunId = undefined;
  task.dispatchError = undefined;
  task.completedAt = undefined;
  data.tasks[taskIdx] = task;

  // 3. Send to agent via gateway RPC
  type AgentAccepted = { runId?: string; status?: string; acceptedAt?: number };
  let accepted: AgentAccepted;
  try {
    const message = task.description
      ? `Task: ${task.title}\n\n${task.description}`
      : `Task: ${task.title}`;

    accepted = await gatewayCall<AgentAccepted>(
      "agent",
      {
        agentId,
        message,
        sessionKey,
        idempotencyKey,
        label: "mission-control-tasks",
        inputProvenance: {
          kind: "external_user",
          sourceChannel: "web",
          sourceTool: "mission-control",
        },
      },
      30000
    );
  } catch (err) {
    // Dispatch failed — mark as failed, save, and return error
    task.dispatchStatus = "failed";
    task.dispatchError = err instanceof Error ? err.message : String(err);
    data.tasks[taskIdx] = task;
    try {
      await writeKanban(data);
      notifyKanbanUpdated();
    } catch { /* best-effort save */ }
    return NextResponse.json(
      { error: task.dispatchError },
      { status: 502 }
    );
  }

  const runId = String(accepted?.runId || idempotencyKey);
  task.dispatchRunId = runId;
  data.tasks[taskIdx] = task;

  // 4. Write updated kanban and notify
  await writeKanban(data);
  notifyKanbanUpdated();

  // 5. Background: wait for agent completion (up to 5 min)
  const waitTimeoutMs = 300000;
  (async () => {
    try {
      await gatewayCall<Record<string, unknown>>(
        "agent.wait",
        { runId, timeoutMs: waitTimeoutMs },
        waitTimeoutMs + 10000
      );

      // Success — re-read kanban (may have been modified during execution)
      let freshData: KanbanData;
      try {
        freshData = await readKanban();
      } catch {
        return;
      }
      const freshIdx = freshData.tasks.findIndex((t) => t.id === taskId);
      if (freshIdx === -1) return;

      freshData.tasks[freshIdx] = {
        ...freshData.tasks[freshIdx],
        column: "done",
        dispatchStatus: "completed",
        completedAt: Date.now(),
      };
      await writeKanban(freshData);
      notifyKanbanUpdated();
    } catch (err) {
      // Failure — mark as failed
      let freshData: KanbanData;
      try {
        freshData = await readKanban();
      } catch {
        return;
      }
      const freshIdx = freshData.tasks.findIndex((t) => t.id === taskId);
      if (freshIdx === -1) return;

      freshData.tasks[freshIdx] = {
        ...freshData.tasks[freshIdx],
        dispatchStatus: "failed",
        dispatchError: err instanceof Error ? err.message : String(err),
      };
      await writeKanban(freshData);
      notifyKanbanUpdated();
    }
  })();

  return NextResponse.json({ ok: true, runId, taskId });
}

/* ── init handler ─────────────────────────────────── */

async function handleInit(body: { starterTasks?: KanbanTask[] }) {
  const client = await getClient();
  const ws = await getDefaultWorkspace();
  const kanbanPath = join(ws, "kanban.json");
  const tasksMemoryPath = join(ws, "TASKS.md");

  // Ensure workspace directory exists via mkdir through exec
  try {
    const dir = dirname(kanbanPath);
    // Use the client to create the directory if needed
    // Try writing to kanban first; if the dir doesn't exist the write will error,
    // but the gateway transport handles directory creation internally.
  } catch { /* continue */ }

  // ── 1. Create kanban.json with smart starter tasks ──

  const starterBoard: KanbanData = {
    columns: DEFAULT_COLUMNS,
    tasks: body.starterTasks || [
      {
        id: 1,
        title: "Explore the Dashboard",
        description:
          "Check out the Mission Control dashboard to see your agents, cron jobs, system health, and more.",
        column: "in-progress",
        priority: "medium",
      },
      {
        id: 2,
        title: "Ask your agent to add a task",
        description:
          'Try chatting with your agent and say: "Add a task to review my weekly reports". It will update this board automatically.',
        column: "backlog",
        priority: "high",
      },
      {
        id: 3,
        title: "Set up your first cron job",
        description:
          "Automate a recurring task — like a daily summary or weekly check-in. Go to Cron Jobs to see what's running.",
        column: "backlog",
        priority: "low",
      },
    ],
  };

  await client.writeFile(
    kanbanPath,
    JSON.stringify(starterBoard, null, 2)
  );
  notifyKanbanUpdated();

  // ── 2. Create TASKS.md — agent instructions ──

  const tasksMemory = `# Task Board (kanban.json)

This workspace has a **Kanban task board** stored at \`kanban.json\` in this directory.
The user manages it through Mission Control (the dashboard app) and expects you to interact with it too.

## Structure

\`\`\`json
{
  "columns": [
    { "id": "backlog", "title": "Backlog", "color": "#6b7280" },
    { "id": "in-progress", "title": "In Progress", "color": "#f59e0b" },
    { "id": "review", "title": "Review", "color": "#8b5cf6" },
    { "id": "done", "title": "Done", "color": "#10b981" }
  ],
  "tasks": [
    {
      "id": 1,
      "title": "Task name",
      "description": "Optional description",
      "column": "backlog",
      "priority": "high | medium | low",
      "assignee": "optional name",
      "agentId": "optional agent ID — links this task to a specific agent",
      "dispatchStatus": "idle | dispatching | running | completed | failed",
      "dispatchRunId": "gateway run ID when dispatched",
      "dispatchedAt": 1700000000000,
      "completedAt": 1700000000000,
      "dispatchError": "error message if dispatch failed"
    }
  ]
}
\`\`\`

## How to Use

- **Read tasks:** Parse \`kanban.json\` to know what's on the board.
- **Add a task:** Append to the \`tasks\` array with a new unique \`id\` (increment from highest existing id). Default to \`"backlog"\` column if not specified.
- **Move a task:** Change the \`column\` field (e.g. from \`"backlog"\` to \`"in-progress"\`).
- **Complete a task:** Move it to \`"done"\`.
- **Update a task:** Modify \`title\`, \`description\`, \`priority\`, or \`assignee\`.
- **Delete a task:** Remove it from the array.
- **Always save** the full JSON back to \`kanban.json\` after changes.

## Agent Dispatch

Tasks can be dispatched to agents via Mission Control. When a task is dispatched:
- \`agentId\` links the task to the executing agent
- \`dispatchStatus\` tracks execution state: \`running\` → \`completed\` or \`failed\`
- \`dispatchRunId\` is the gateway run ID for tracking
- The task automatically moves to "done" when the agent completes successfully

If you are executing a dispatched task, update \`dispatchStatus\` to \`"completed"\` and move the task to \`"done"\` when finished.

## Guidelines

- When the user asks you to "add a task" or "remind me to...", create a task on this board.
- When you finish work that corresponds to a task, move it to "done".
- Proactively suggest moving tasks that seem completed based on context.
- Keep task titles concise (under 60 chars). Put details in description.
- Use priority: \`high\` = urgent, \`medium\` = normal, \`low\` = someday.
- The \`assignee\` field is optional — use the user's name or an agent name if relevant.
`;

  await client.writeFile(tasksMemoryPath, tasksMemory);

  return NextResponse.json({
    ok: true,
    kanbanPath,
    tasksMemoryPath,
    board: { ...starterBoard, _fileExists: true },
  });
}
