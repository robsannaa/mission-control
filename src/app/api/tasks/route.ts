import { NextRequest, NextResponse } from "next/server";
import { join } from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { getClient } from "@/lib/openclaw";
import { notifyKanbanUpdated } from "@/lib/kanban-live";
import {
  DEFAULT_COLUMNS,
  KanbanConflictError,
  readKanban,
  saveKanban,
  type DispatchAssignee,
  type KanbanData,
  type KanbanTask,
} from "@/lib/kanban-store";
import {
  answerTask,
  cancelTask,
  dispatchTask,
  ensureTaskEngine,
  getRunSnapshot,
  healInProgressInvariant,
  resolveTask,
} from "@/lib/task-engine";

/* ── GET — read existing board ────────────────────── */

export async function GET() {
  // Every entry point into the tasks API starts the engine: a Next route module
  // is only loaded when it is first hit, and there is no earlier moment that
  // reliably happens on every deployment shape.
  ensureTaskEngine();
  try {
    // In Progress must mean a live agent. Return any card stranded there with
    // no run behind it to the to-do lane before we answer, so the board the
    // user sees is always the true state.
    await healInProgressInvariant().catch(() => undefined);
    const data = await readKanban();
    return NextResponse.json({ ...data, _fileExists: true });
  } catch {
    // Return empty kanban if file doesn't exist
    return NextResponse.json({
      columns: DEFAULT_COLUMNS,
      tasks: [],
      rev: 0,
      _fileExists: false,
    });
  }
}

/* ── PUT — save board ─────────────────────────────── */

/**
 * Replace the board.
 *
 * Two protections, because a whole-blob overwrite is how run state was lost
 * before. Engine-owned `dispatch*` fields are always merged from disk, never
 * taken from the request — the browser's copy of them is stale the moment an
 * agent does anything. And if the caller sends the `rev` it read, a board that
 * has moved on since rejects the write with 409 and the current board attached,
 * instead of erasing whatever changed.
 */
export async function PUT(request: NextRequest) {
  ensureTaskEngine();
  try {
    const body = await request.json();
    if (!body.columns || !body.tasks) {
      return NextResponse.json(
        { error: "columns and tasks required" },
        { status: 400 }
      );
    }
    const { _fileExists: _, rev, ...saveData } = body;
    void _;
    const saved = await saveKanban(
      saveData as KanbanData,
      typeof rev === "number" ? rev : undefined,
    );
    return NextResponse.json({ ok: true, rev: saved.rev, board: { ...saved, _fileExists: true } });
  } catch (err) {
    if (err instanceof KanbanConflictError) {
      return NextResponse.json(
        {
          error: err.message,
          conflict: true,
          rev: err.actualRev,
          board: { ...err.current, _fileExists: true },
        },
        { status: 409 },
      );
    }
    console.error("Tasks PUT error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST — init, dispatch, answer, cancel, resolve ── */

export async function POST(request: NextRequest) {
  ensureTaskEngine();
  try {
    const body = await request.json();
    switch (body.action) {
      case "init":
        return handleInit(body);
      case "dispatch":
        return handleDispatch(body);
      case "answer":
        return handleAnswer(body);
      case "cancel":
        return handleCancel(body);
      case "resolve":
        return handleResolve(body);
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (err) {
    console.error("Tasks POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── dispatch, answer, cancel, resolve ────────────── */

function normalizeAssignee(value: unknown): DispatchAssignee | undefined {
  return value === "agent" || value === "subagent" ? value : undefined;
}

function taskIdOf(body: { taskId?: unknown }): number | null {
  const id = Number(body.taskId);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Start an agent on a card.
 *
 * The prompt is built by the engine and always carries the card's title,
 * description and context plus the instruction to ask rather than guess. The
 * response is deliberately thin: everything that happens next arrives on the
 * event stream, not here.
 */
async function handleDispatch(body: {
  taskId?: number;
  agentId?: string;
  assignee?: unknown;
  context?: string;
}) {
  const taskId = taskIdOf(body);
  if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });

  const result = await dispatchTask({
    taskId,
    agentId: body.agentId,
    assignee: normalizeAssignee(body.assignee),
    context: typeof body.context === "string" ? body.context : undefined,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, taskId, ...(result.detail ?? {}) },
      { status: result.status },
    );
  }
  return NextResponse.json({
    ok: true,
    taskId: result.taskId,
    runId: result.runId,
    sessionKey: result.sessionKey,
    agentId: result.agentId,
    assignee: result.assignee,
    dispatchStatus: "running",
    run: getRunSnapshot(result.taskId),
  });
}

/** Answer the agent's question. Same session, new turn — the agent keeps its context. */
async function handleAnswer(body: { taskId?: number; answer?: string; agentId?: string }) {
  const taskId = taskIdOf(body);
  if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  if (typeof body.answer !== "string" || !body.answer.trim()) {
    return NextResponse.json({ error: "answer is required" }, { status: 400 });
  }

  const result = await answerTask({ taskId, answer: body.answer, agentId: body.agentId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, taskId }, { status: result.status });
  }
  return NextResponse.json({
    ok: true,
    taskId: result.taskId,
    runId: result.runId,
    sessionKey: result.sessionKey,
    agentId: result.agentId,
    dispatchStatus: "running",
    run: getRunSnapshot(result.taskId),
  });
}

async function handleCancel(body: { taskId?: number; agentId?: string }) {
  const taskId = taskIdOf(body);
  if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });

  const result = await cancelTask({ taskId, agentId: body.agentId });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, taskId }, { status: result.status });
  }
  return NextResponse.json({ ...result, run: getRunSnapshot(taskId) });
}

/** The user's call on a card that ended without saying what it meant. */
async function handleResolve(body: { taskId?: number; outcome?: unknown }) {
  const taskId = taskIdOf(body);
  if (!taskId) return NextResponse.json({ error: "taskId is required" }, { status: 400 });
  if (body.outcome !== "done" && body.outcome !== "reopen") {
    return NextResponse.json({ error: 'outcome must be "done" or "reopen"' }, { status: 400 });
  }

  const result = await resolveTask({ taskId, outcome: body.outcome });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, taskId }, { status: result.status });
  }
  return NextResponse.json({ ok: true, task: result.task, run: getRunSnapshot(taskId) });
}


/* ── init handler ─────────────────────────────────── */

async function handleInit(body: { starterTasks?: KanbanTask[] }) {
  const client = await getClient();
  const ws = await getDefaultWorkspace();
  const kanbanPath = join(ws, "kanban.json");
  const tasksMemoryPath = join(ws, "TASKS.md");

  // ── 1. Create kanban.json with smart starter tasks ──

  const starterBoard: KanbanData = {
    rev: 1,
    columns: DEFAULT_COLUMNS,
    tasks: body.starterTasks || [
      {
        id: 1,
        title: "Explore the Dashboard",
        description:
          "Check out the Mission Control dashboard to see your agents, cron jobs, system health, and more. Drag this card into In Progress to watch an agent actually start working on it.",
        column: "backlog",
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
      "dispatchAssignee": "agent | subagent — run in the agent's session, or an isolated subagent",
      "dispatchStatus": "idle | dispatching | running | asking | needs-review | completed | failed | cancelled",
      "dispatchRunId": "gateway run ID for the current turn",
      "dispatchSessionKey": "session the run lives in — used to read its transcript and to resume it",
      "dispatchedAt": 1700000000000,
      "completedAt": 1700000000000,
      "dispatchError": "error message if the run failed",
      "dispatchResultText": "the agent's final answer (truncated)",
      "dispatchStopReason": "why the run stopped",
      "dispatchQuestion": "the question the agent stopped to ask",
      "dispatchConfidence": "high | low — whether the agent said so explicitly",
      "askedFromColumn": "column to restore once the question is answered",
      "dispatchTurns": 2,
      "dispatchTransitions": [
        { "at": 1700000000000, "from": "running", "to": "asking", "by": "agent", "reason": "The agent stopped to ask you a question." }
      ]
    }
  ],
  "rev": 12
}
\`\`\`

\`rev\` is a revision counter. Mission Control bumps it on every write and uses it
to reject a stale whole-board overwrite. If you rewrite this file by hand, leave
\`rev\` alone — do not invent a value.

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
- \`dispatchAssignee\` says where it runs: \`"agent"\` (the agent's own session) or \`"subagent"\` (an isolated background run with a fresh transcript)
- \`dispatchRunId\` and \`dispatchSessionKey\` identify the run for progress, results, and cancellation
- \`dispatchResultText\` holds what the agent finally said; \`dispatchError\` holds why it failed
- The card moves itself between columns as the run progresses, and \`dispatchTransitions\` records why

### If you are the agent working a dispatched card

The prompt you receive ends with a protocol block. Honour it exactly:

- Need something from the user? End your turn with a line starting \`NEEDS_INPUT:\`
  followed by the question. The card moves itself to Review and waits for an
  answer. **Asking is a valid outcome — never guess to avoid asking.**
- Finished? End your turn with a line starting \`DONE:\` followed by a one-line
  summary. The card moves itself to Done.
- Emit exactly one marker, as the last line.

Without a marker the card lands in \`needs-review\`: Mission Control will not
pretend to know whether you finished or wanted to ask, and the user has to sort
it out by hand.

Do NOT hand-edit the \`dispatch*\` fields — Mission Control owns them and will overwrite your changes when the run settles.

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
