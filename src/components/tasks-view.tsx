"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import type { CSSProperties } from "react";
import {
  Plus,
  Trash2,
  X,
  Check,
  ListChecks,
  Rocket,
  CheckCircle,
  Copy,
  Play,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { SectionLayout } from "@/components/section-layout";
import { useFocusTrap, useBodyScrollLock } from "@/hooks/use-modal-accessibility";
import { notifyError, notifyWarning } from "@/lib/notification-store";
import { TaskCard } from "@/components/tasks/task-card";
import { TaskDetailDialog } from "@/components/tasks/task-detail-dialog";
import { StopRunDialog, type StopIntent } from "@/components/tasks/stop-run-dialog";
import { AnswerDialog, type AnswerIntent } from "@/components/tasks/answer-dialog";
import { DispatchDialog, type DispatchIntent } from "@/components/tasks/dispatch-dialog";
import { LiveDot } from "@/components/tasks/run-strip";
import { useAllRuns, useKanbanSignal, useStreamEvents } from "@/components/tasks/run-store";
import { useCardFlip } from "@/components/tasks/use-card-flip";
import {
  ENGINE_OWNED_FIELDS,
  agentLabel,
  columnTitle,
  isAwaitingUser,
  isRunActive,
  type AgentInfo,
  type Column,
  type DispatchAssignee,
  type KanbanData,
  type Task,
} from "@/components/tasks/types";

const PRIORITIES = [
  { value: "high", label: "High priority" },
  { value: "medium", label: "Medium priority" },
  { value: "low", label: "Low priority" },
];

/** A change to the board, expressed so it can be replayed onto a fresher copy. */
type Mutator = (board: KanbanData) => KanbanData;

/**
 * The engine owns these and takes them from disk regardless. Sending them back
 * would mean echoing a run's state from whenever this tab last read it.
 */
function stripEngineFields(task: Task): Task {
  const clean = { ...task } as Record<string, unknown>;
  for (const field of ENGINE_OWNED_FIELDS) delete clean[field];
  return clean as Task;
}

function forWire(board: KanbanData) {
  return {
    columns: board.columns,
    tasks: board.tasks.map(stripEngineFields),
    rev: board.rev,
  };
}

/* ── component ─────────────────────────────────── */

export function TasksView() {
  const [data, setData] = useState<KanbanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | null>(null);
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<number | null>(null);
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const dataRef = useRef<KanbanData | null>(null);
  /** Changes not yet acknowledged by the server, ready to replay onto a conflict. */
  const pending = useRef<Mutator[]>([]);
  /**
   * A card added with "Add & run", waiting for its real id. The mutator fills
   * `taskId` in — and fills it in again if a conflict makes us rebase, so the
   * dispatch always names the card that was actually written.
   */
  const autoRun = useRef<{
    taskId: number | null;
    agentId: string;
    assignee: DispatchAssignee;
  } | null>(null);
  /** Set below — lets the save handler dispatch without a circular dependency. */
  const sendDispatchRef = useRef<
    | ((
        taskId: number,
        opts: { agentId: string; assignee: DispatchAssignee; context?: string },
      ) => Promise<{ ok: boolean; error?: string }>)
    | null
  >(null);
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<number | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [stopIntent, setStopIntent] = useState<StopIntent | null>(null);
  const [answerIntent, setAnswerIntent] = useState<AnswerIntent | null>(null);
  const [dispatchIntent, setDispatchIntent] = useState<DispatchIntent | null>(null);

  const lightboxFocusTrapRef = useFocusTrap(lightboxImage != null);
  useBodyScrollLock(lightboxImage != null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [dispatchingTaskIds, setDispatchingTaskIds] = useState<Set<number>>(new Set());

  const runs = useAllRuns();
  const events = useStreamEvents();
  const boardRef = useCardFlip<HTMLDivElement>();

  dataRef.current = data;

  useEffect(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => {
        if (d.agents && Array.isArray(d.agents)) {
          setAgents(
            d.agents.map((a: { id: string; name: string; emoji: string }) => ({
              id: a.id,
              name: a.name,
              emoji: a.emoji,
            }))
          );
        }
      })
      .catch(() => {});
  }, []);

  const refetchBoard = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks");
      if (!res.ok) return;
      setData(await res.json());
    } catch {
      /* the stream will bring us back */
    }
  }, []);

  // One socket for the whole board (see run-store). When the file changes —
  // this tab, the agent, or another window — refetch, unless we are mid-write.
  useKanbanSignal(
    useCallback(() => {
      if (savingRef.current) return;
      void refetchBoard();
    }, [refetchBoard])
  );

  /* ── persist ───────────────────────────────────── */

  /**
   * Apply a change optimistically, then write it.
   *
   * The change is kept as a function so that if the server says someone else
   * wrote first (409), it can be replayed onto their board instead of blindly
   * retrying and clobbering them.
   */
  const mutate = useCallback((fn: Mutator) => {
    const current = dataRef.current;
    if (!current) return;
    const next = fn(current);
    dataRef.current = next;
    setData(next);
    pending.current.push(fn);
    setSaveStatus("saving");
    savingRef.current = true;

    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(async () => {
      const board = dataRef.current;
      if (!board) return;
      const replay = pending.current.slice();
      try {
        let res = await fetch("/api/tasks", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(forWire(board)),
        });

        if (res.status === 409) {
          // Someone else wrote first. Rebase our edits onto their board and go
          // once more — never a blind retry.
          const conflict = await res.json().catch(() => ({}));
          const fresh: KanbanData | undefined = conflict?.board;
          if (fresh) {
            const rebased = replay.reduce<KanbanData>((acc, step) => step(acc), fresh);
            dataRef.current = rebased;
            setData(rebased);
            res = await fetch("/api/tasks", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(forWire(rebased)),
            });
          }
        }

        if (res.ok) {
          const body = await res.json().catch(() => ({}));

          /*
           * Only the mutators THIS request carried are done. An edit made while
           * it was in flight is still queued behind them, and clearing the whole
           * list here — then overwriting local state with the server's board —
           * silently threw that edit away. Keep the unsent tail and replay it
           * onto whatever the server just confirmed.
           */
          const unsent = pending.current.slice(replay.length);
          pending.current = unsent;

          // Take the server's revision so the next write is conditional on it.
          if (body?.board) {
            const rebased = unsent.reduce<KanbanData>((acc, step) => step(acc), body.board);
            dataRef.current = rebased;
            setData(rebased);
          } else if (typeof body?.rev === "number") {
            setData((prev) => (prev ? { ...prev, rev: body.rev } : prev));
          }

          // A queued edit means another save is already armed — do not claim
          // "saved" while something is still waiting to go out.
          if (unsent.length === 0) {
            setSaveStatus("saved");
            setTimeout(() => setSaveStatus(null), 2000);
          }
          // "Add & run" waits for the id the card was actually written with —
          // a rebase onto someone else's board can hand it a different one.
          const queued = autoRun.current;
          autoRun.current = null;
          if (queued && queued.taskId != null) {
            void sendDispatchRef.current?.(queued.taskId, {
              agentId: queued.agentId,
              assignee: queued.assignee,
            });
          }
        } else {
          pending.current = [];
          setSaveStatus(null);
          notifyError(
            "Could not save the board",
            "Your change was rolled back. The board has been reloaded.",
            "Tasks"
          );
          await refetchBoard();
        }
      } catch {
        pending.current = [];
        setSaveStatus(null);
        await refetchBoard();
      } finally {
        savingRef.current = false;
      }
    }, 500);
  }, [refetchBoard]);

  /* ── task CRUD ─────────────────────────────────── */

  const addTask = useCallback(
    (task: Omit<Task, "id">, onIdAssigned?: (id: number) => void) => {
      mutate((board) => {
        const maxId = board.tasks.reduce((m, t) => Math.max(m, t.id), 0);
        const id = maxId + 1;
        // Runs again on a rebase, so the caller always ends up with the id the
        // card was really written with rather than the one we first guessed.
        onIdAssigned?.(id);
        return { ...board, tasks: [...board.tasks, { ...task, id }] };
      });
    },
    [mutate]
  );

  const updateTask = useCallback(
    (id: number, updates: Partial<Task>) => {
      mutate((board) => ({
        ...board,
        tasks: board.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      }));
    },
    [mutate]
  );

  const deleteTask = useCallback(
    (id: number) => {
      mutate((board) => ({ ...board, tasks: board.tasks.filter((t) => t.id !== id) }));
    },
    [mutate]
  );

  /**
   * Moving a card that is mid-run means stopping the run. That is destructive,
   * so it is always confirmed; the move happens only once the run is settled.
   */
  const requestMove = useCallback(
    (id: number, columnId: string) => {
      const board = dataRef.current;
      if (!board) return;
      const task = board.tasks.find((t) => t.id === id);
      if (!task || task.column === columnId) return;
      const status = runs.get(id)?.status ?? task.dispatchStatus;
      if (isRunActive(status)) {
        setStopIntent({
          taskId: id,
          taskTitle: task.title,
          agentLabel: agentLabel(agents, task.agentId),
          moveTo: { columnId, columnTitle: columnTitle(board.columns, columnId) },
        });
        return;
      }
      updateTask(id, { column: columnId });
    },
    [agents, runs, updateTask]
  );

  const moveTaskByStep = useCallback(
    (id: number, direction: "left" | "right") => {
      const board = dataRef.current;
      if (!board) return;
      const task = board.tasks.find((t) => t.id === id);
      if (!task) return;
      const colIdx = board.columns.findIndex((c) => c.id === task.column);
      const newIdx =
        direction === "right"
          ? Math.min(colIdx + 1, board.columns.length - 1)
          : Math.max(colIdx - 1, 0);
      if (newIdx === colIdx) return;
      requestMove(id, board.columns[newIdx].id);
    },
    [requestMove]
  );

  const requestStop = useCallback(
    (id: number) => {
      const board = dataRef.current;
      if (!board) return;
      const task = board.tasks.find((t) => t.id === id);
      if (!task) return;
      setStopIntent({
        taskId: id,
        taskTitle: task.title,
        agentLabel: agentLabel(agents, task.agentId),
      });
    },
    [agents]
  );

  /* ── dispatch, answer, resolve ─────────────────── */

  const sendDispatch = useCallback(
    async (
      taskId: number,
      opts: { agentId: string; assignee: DispatchAssignee; context?: string }
    ): Promise<{ ok: boolean; error?: string }> => {
      setDispatchingTaskIds((prev) => new Set(prev).add(taskId));
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "dispatch", taskId, ...opts }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          const message = body?.error || `The gateway refused (${res.status}).`;
          if (res.status === 409) notifyWarning("Already running", message, "Tasks");
          return { ok: false, error: message };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      } finally {
        await refetchBoard();
        setDispatchingTaskIds((prev) => {
          const next = new Set(prev);
          next.delete(taskId);
          return next;
        });
      }
    },
    [refetchBoard]
  );
  sendDispatchRef.current = sendDispatch;

  /** Re-running a card that already has an agent needs no dialog. */
  const rerun = useCallback(
    async (task: Task) => {
      if (!task.agentId) {
        setDispatchIntent({ task, assignee: task.dispatchAssignee ?? "agent" });
        return;
      }
      const result = await sendDispatch(task.id, {
        agentId: task.agentId,
        assignee: task.dispatchAssignee ?? "agent",
      });
      if (!result.ok && result.error) {
        notifyError("Could not start the run", result.error, "Tasks");
      }
    },
    [sendDispatch]
  );

  const openAnswer = useCallback(
    (task: Task) => {
      const run = runs.get(task.id);
      const question = run?.question?.text ?? task.dispatchQuestion ?? "";
      const confidence =
        run?.question?.confidence ??
        task.dispatchConfidence ??
        (run?.status === "needs-review" ? "low" : "high");
      const back = run?.question?.askedFromColumn ?? task.askedFromColumn ?? null;
      setAnswerIntent({
        taskId: task.id,
        taskTitle: task.title,
        agentLabel: agentLabel(agents, task.agentId),
        question,
        confidence,
        returnColumnTitle: back ? columnTitle(dataRef.current?.columns ?? [], back) : null,
        turns: run?.turns ?? task.dispatchTurns ?? 1,
      });
    },
    [agents, runs]
  );

  const markDone = useCallback(
    async (taskId: number) => {
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resolve", taskId, outcome: "done" }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          notifyError(
            "Could not mark it done",
            body?.error || `The gateway refused (${res.status}).`,
            "Tasks"
          );
        }
      } catch (err) {
        notifyError(
          "Could not mark it done",
          err instanceof Error ? err.message : String(err),
          "Tasks"
        );
      } finally {
        await refetchBoard();
      }
    },
    [refetchBoard]
  );

  /* ── rendering ─────────────────────────────────── */

  if (loading) {
    return (
      <SectionLayout>
        <ContentLoadingState />
      </SectionLayout>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-danger-bg">
            <ListChecks className="h-7 w-7 text-danger-fg" />
          </div>
          <h2 className="text-xs font-semibold text-foreground">
            Could not load Kanban board
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Something went wrong while loading your tasks. This could be a
            temporary issue. Try refreshing the page.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-lg bg-foreground/10 px-4 py-2 text-xs font-medium text-fg-secondary transition-colors hover:bg-foreground/10"
          >
            Refresh
          </button>
        </div>
      </div>
    );
  }

  const { columns, tasks } = data;
  const fileExists = data._fileExists !== false;
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.column === "done").length;
  const inProgress = tasks.filter((t) => t.column === "in-progress").length;
  const completionPct =
    totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

  // Counts come from live state, not the file: the file is written a beat later.
  const statusOf = (task: Task) => runs.get(task.id)?.status ?? task.dispatchStatus;
  const runningTasks = tasks.filter((t) => isRunActive(statusOf(t))).length;
  const waitingTasks = tasks.filter((t) => isAwaitingUser(statusOf(t))).length;

  /* ── Onboarding empty state ── */
  if (totalTasks === 0) {
    return (
      <BoardOnboarding
        fileExists={fileExists}
        columns={columns}
        onBoardCreated={(board) => setData(board)}
        addingToColumn={addingToColumn}
        setAddingToColumn={setAddingToColumn}
        addTask={addTask}
      />
    );
  }

  const detailTask = detailTaskId != null ? tasks.find((t) => t.id === detailTaskId) : undefined;

  /* ── Normal board view ── */
  return (
    <SectionLayout>
      {/* Stats header */}
      <div className="shrink-0 space-y-3 px-4 md:px-6 pt-5 pb-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 text-sm">
            <span>
              <strong className="text-xs font-semibold text-foreground">
                {totalTasks}
              </strong>{" "}
              <span className="text-muted-foreground">Total</span>
            </span>
            <span>
              <strong className="text-xs font-semibold text-foreground">
                {inProgress}
              </strong>{" "}
              <span className="text-muted-foreground">In progress</span>
            </span>
            <span>
              <strong className="text-xs font-semibold text-foreground">
                {doneTasks}
              </strong>{" "}
              <span className="text-muted-foreground">Done</span>
            </span>
            <span>
              <strong className="text-xs font-semibold text-foreground">
                {completionPct}%
              </strong>{" "}
              <span className="text-muted-foreground">Completion</span>
            </span>
            {runningTasks > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 animate-enter">
                <LiveDot />
                <span className="text-xs text-fg-secondary">
                  {runningTasks} running
                </span>
              </span>
            )}
            {waitingTasks > 0 && (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2.5 py-0.5 animate-enter">
                <span className="text-xs text-fg-secondary">
                  {waitingTasks} waiting on you
                </span>
              </span>
            )}
          </div>
          {saveStatus && (
            <span className="shrink-0 text-xs text-muted-foreground">
              {saveStatus === "saving" ? "Saving..." : "Saved"}
            </span>
          )}
        </div>
        <p className="text-xs text-fg-subtle">
          {totalTasks} {totalTasks === 1 ? "task" : "tasks"} across{" "}
          {columns.length} columns
          {!events.connected && " · live updates are reconnecting"}
        </p>
      </div>

      {/*
        Responsive Kanban:
        - phones stack full-width columns and scroll vertically;
        - mid-size screens keep usable column widths with horizontal scroll;
        - wide screens fit every column into the available board width.
      */}
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-4 pb-6 md:overflow-x-auto md:overflow-y-hidden md:px-6">
        <div
          ref={boardRef}
          className="kanban-board-grid items-start gap-4 pb-2"
          style={{ "--kanban-column-count": columns.length } as CSSProperties}
        >
          {columns.map((col) => {
          const colTasks = tasks.filter((t) => t.column === col.id);
          const isDragTarget = dragOverColumn === col.id && draggingTaskId !== null;
          return (
            <div
              key={col.id}
              className={cn(
                "flex w-full min-w-0 flex-col overflow-hidden rounded-xl border border-foreground/5 bg-muted/30 px-3 py-3 transition-all",
                isDragTarget && "bg-muted-foreground/10 border-border-strong ring-1 ring-inset ring-border-strong"
              )}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOverColumn !== col.id) setDragOverColumn(col.id);
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOverColumn(null);
                }
              }}
              onDrop={(e) => {
                e.preventDefault();
                const taskId = Number(e.dataTransfer.getData("text/plain"));
                if (taskId && !isNaN(taskId)) {
                  requestMove(taskId, col.id);
                }
                setDraggingTaskId(null);
                setDragOverColumn(null);
              }}
            >
              <div className="mb-3 flex min-w-0 items-center gap-2 px-1">
                <div
                  className="h-3 w-3 shrink-0 rounded-full shadow-sm"
                  style={{ backgroundColor: col.color }}
                />
                <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
                  {col.title}
                </h3>
                <span
                  className="rounded-full bg-foreground/10 px-2 py-0.5 text-xs font-medium text-muted-foreground"
                  style={{ minWidth: "1.5rem", textAlign: "center" }}
                >
                  {colTasks.length}
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() =>
                    setAddingToColumn(
                      addingToColumn === col.id ? null : col.id
                    )
                  }
                  className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary"
                  title={`Add task to ${col.title}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Inline add form */}
              {addingToColumn === col.id && (
                <AddTaskInline
                  column={col.id}
                  agents={agents}
                  onAdd={(task) => {
                    addTask(task);
                    setAddingToColumn(null);
                  }}
                  onAddAndRun={(task) => {
                    setAddingToColumn(null);
                    if (!task.agentId) {
                      addTask(task);
                      return;
                    }
                    // Queue the run; the save reports the real id and fires it.
                    autoRun.current = {
                      taskId: null,
                      agentId: task.agentId,
                      assignee: task.dispatchAssignee ?? "agent",
                    };
                    addTask(task, (id) => {
                      if (autoRun.current) autoRun.current.taskId = id;
                    });
                  }}
                  onCancel={() => setAddingToColumn(null)}
                />
              )}

              <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overflow-x-hidden min-w-0">
                {colTasks.length === 0 && addingToColumn !== col.id ? (
                  <div className={cn(
                    "flex items-center justify-center rounded-lg border border-dashed py-8 text-xs transition-colors",
                    isDragTarget
                      ? "border-border-strong text-fg-secondary bg-muted-foreground/5"
                      : "border-foreground/10 text-fg-subtle"
                  )}>
                    {isDragTarget ? "Drop here" : "Nothing here yet"}
                  </div>
                ) : (
                  colTasks.map((task) =>
                    editingTask === task.id ? (
                      <EditTaskInline
                        key={task.id}
                        task={task}
                        columns={columns}
                        agents={agents}
                        onSave={(updates) => {
                          updateTask(task.id, updates);
                          setEditingTask(null);
                        }}
                        onCancel={() => setEditingTask(null)}
                        onDelete={() => {
                          deleteTask(task.id);
                          setEditingTask(null);
                        }}
                      />
                    ) : (
                      /* data-task-id is what the flip animation tracks. */
                      <div key={task.id} data-task-id={task.id} className="min-w-0">
                        <TaskCard
                          task={task}
                          columns={columns}
                          agents={agents}
                          onEdit={() => setEditingTask(task.id)}
                          onMove={(dir) => moveTaskByStep(task.id, dir)}
                          onDelete={() => deleteTask(task.id)}
                          onOpenDetail={() => setDetailTaskId(task.id)}
                          onAttachmentClick={(url) => setLightboxImage(url)}
                          onDispatch={() => {
                            if (task.agentId && task.dispatchStatus && task.dispatchStatus !== "idle") {
                              void rerun(task);
                            } else {
                              setDispatchIntent({
                                task,
                                agentId: task.agentId,
                                assignee: task.dispatchAssignee ?? "agent",
                              });
                            }
                          }}
                          onAssign={(next) =>
                            updateTask(task.id, {
                              agentId: next.agentId,
                              dispatchAssignee: next.assignee,
                            })
                          }
                          onStop={() => requestStop(task.id)}
                          onAnswer={() => openAnswer(task)}
                          onMarkDone={() => void markDone(task.id)}
                          isDispatching={dispatchingTaskIds.has(task.id)}
                          isDragging={draggingTaskId === task.id}
                          onDragStart={() => setDraggingTaskId(task.id)}
                          onDragEnd={() => { setDraggingTaskId(null); setDragOverColumn(null); }}
                          isRenaming={renamingTaskId === task.id}
                          onStartRename={() => setRenamingTaskId(task.id)}
                          onRename={(title) => {
                            if (title !== task.title) updateTask(task.id, { title });
                            setRenamingTaskId(null);
                          }}
                        />
                      </div>
                    )
                  )
                )}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {/* Task detail popup */}
      {detailTask && (
        <TaskDetailDialog
          task={detailTask}
          columns={columns}
          agents={agents}
          isDispatching={dispatchingTaskIds.has(detailTask.id)}
          onClose={() => setDetailTaskId(null)}
          onEdit={() => {
            setEditingTask(detailTask.id);
            setDetailTaskId(null);
          }}
          onDispatch={() => {
            if (detailTask.agentId && detailTask.dispatchStatus && detailTask.dispatchStatus !== "idle") {
              void rerun(detailTask);
            } else {
              setDispatchIntent({
                task: detailTask,
                agentId: detailTask.agentId,
                assignee: detailTask.dispatchAssignee ?? "agent",
              });
            }
          }}
          onAssign={(next) =>
            updateTask(detailTask.id, {
              agentId: next.agentId,
              dispatchAssignee: next.assignee,
            })
          }
          onStop={() => requestStop(detailTask.id)}
          onAnswer={() => openAnswer(detailTask)}
          onMarkDone={() => void markDone(detailTask.id)}
          onAttachmentClick={(url) => setLightboxImage(url)}
        />
      )}

      {/* Handing a card to an agent */}
      {dispatchIntent && (
        <DispatchDialog
          intent={dispatchIntent}
          agents={agents}
          onClose={() => setDispatchIntent(null)}
          onDispatch={async (opts) => {
            // Remember the choice on the card so a later re-run needs no dialog.
            updateTask(dispatchIntent.task.id, {
              agentId: opts.agentId,
              dispatchAssignee: opts.assignee,
            });
            return sendDispatch(dispatchIntent.task.id, opts);
          }}
        />
      )}

      {/* Answering a question — the card resumes where it left off */}
      {answerIntent && (
        <AnswerDialog
          intent={answerIntent}
          onClose={() => setAnswerIntent(null)}
          onResumed={() => void refetchBoard()}
        />
      )}

      {/* Stopping a run — always confirmed, outcome always reported */}
      {stopIntent && (
        <StopRunDialog
          intent={stopIntent}
          onStopped={(moveToColumnId) => {
            if (moveToColumnId) updateTask(stopIntent.taskId, { column: moveToColumnId });
            else void refetchBoard();
          }}
          onClose={() => setStopIntent(null)}
        />
      )}

      {/* Image lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div
            ref={lightboxFocusTrapRef}
            role="dialog"
            aria-modal="true"
            aria-label="Image preview"
            className="relative flex items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              className="absolute right-3 top-3 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 transition-colors"
              aria-label="Close image preview"
            >
              <X className="h-5 w-5" />
            </button>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={lightboxImage}
              alt="Attachment"
              className="max-h-full max-w-full object-contain rounded-lg shadow-2xl"
            />
          </div>
        </div>
      )}
    </SectionLayout>
  );
}

/* ── AddTaskInline ───────────────────────────────── */

function AddTaskInline({
  column,
  agents,
  onAdd,
  onCancel,
  onAddAndRun,
}: {
  column: string;
  agents: AgentInfo[];
  onAdd: (t: Omit<Task, "id">) => void;
  onCancel: () => void;
  onAddAndRun?: (t: Omit<Task, "id">) => void;
}) {
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState("medium");
  const [assignee, setAssignee] = useState("");
  const [agentId, setAgentId] = useState("");
  const [runMode, setRunMode] = useState<DispatchAssignee>("agent");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const buildTask = (): Omit<Task, "id"> => ({
    title: title.trim(),
    description: desc.trim() || undefined,
    column,
    priority,
    assignee: assignee.trim() || undefined,
    agentId: agentId || undefined,
    dispatchAssignee: agentId ? runMode : undefined,
  });

  const submit = () => {
    if (!title.trim()) return;
    onAdd(buildTask());
  };

  return (
    <div className="mb-2.5 rounded-lg border border-border-strong bg-card p-3.5">
      <input
        ref={inputRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="What needs doing?"
        className="mb-2 w-full bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-fg-subtle"
      />
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Add more detail, if it helps"
        rows={2}
        className="mb-2 w-full resize-none bg-transparent text-xs leading-5 text-muted-foreground outline-none placeholder:text-fg-subtle"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none"
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        {agents.length > 0 && (
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none"
          >
            <option value="">No agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
        )}
        {agentId && <RunModeSelect value={runMode} onChange={setRunMode} />}
        <input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          className="min-w-0 flex-1 rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-muted-foreground hover:text-fg-secondary"
          aria-label="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        {agentId && onAddAndRun && (
          <button
            type="button"
            onClick={() => {
              if (!title.trim()) return;
              onAddAndRun(buildTask());
            }}
            disabled={!title.trim()}
            className="flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Play className="h-3 w-3" /> Add & run
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!title.trim()}
          className="rounded-full border border-border-subtle px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
  );
}

/** Where a dispatched task runs — the agent's session, or a fresh isolated one. */
function RunModeSelect({
  value,
  onChange,
}: {
  value: DispatchAssignee;
  onChange: (next: DispatchAssignee) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as DispatchAssignee)}
      title="Where this task runs"
      className="rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none"
    >
      <option value="agent">Agent session</option>
      <option value="subagent">Isolated subagent</option>
    </select>
  );
}

/* ── BoardOnboarding ─────────────────────────────── */

function BoardOnboarding({
  fileExists,
  columns,
  onBoardCreated,
  addingToColumn,
  setAddingToColumn,
  addTask,
}: {
  fileExists: boolean;
  columns: Column[];
  onBoardCreated: (board: KanbanData) => void;
  addingToColumn: string | null;
  setAddingToColumn: (col: string | null) => void;
  addTask: (task: Omit<Task, "id">) => void;
}) {
  const [initializing, setInitializing] = useState(false);
  const [initStep, setInitStep] = useState(0); // 0=idle, 1=creating board, 2=teaching agent, 3=done
  const [copied, setCopied] = useState(false);

  const exampleJson = JSON.stringify({ columns, tasks: [] }, null, 2);

  const copyExample = useCallback(() => {
    navigator.clipboard.writeText(exampleJson).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [exampleJson]);

  const initBoard = useCallback(async () => {
    setInitializing(true);
    setInitStep(1);

    try {
      // Animate through steps
      await new Promise((r) => setTimeout(r, 600));
      setInitStep(2);

      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "init" }),
      });

      if (!res.ok) throw new Error("Failed to initialize");
      const data = await res.json();

      setInitStep(3);
      await new Promise((r) => setTimeout(r, 800));

      // Transition to the board
      onBoardCreated(data.board);
    } catch {
      setInitializing(false);
      setInitStep(0);
    }
  }, [onBoardCreated]);

  // --- Initializing animation ---
  if (initializing) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
        <div className="relative">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted-foreground/10">
            {initStep < 3 ? (
              <span className="inline-flex items-center gap-1">
                <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
              </span>
            ) : (
              <CheckCircle className="h-9 w-9 text-success-fg" />
            )}
          </div>
        </div>

        <div className="text-center">
          <h2 className="text-xs font-semibold text-foreground">
            {initStep === 3 ? "You're all set!" : "Setting up your board..."}
          </h2>
          <div className="mt-5 space-y-3">
            <StepIndicator
              step={1}
              current={initStep}
              label="Creating kanban.json"
              sublabel="Board with 4 columns: Backlog, In Progress, Review, Done"
            />
            <StepIndicator
              step={2}
              current={initStep}
              label="Teaching your agent about the board"
              sublabel="Writing TASKS.md so your agent can manage tasks"
            />
            <StepIndicator
              step={3}
              current={initStep}
              label="Adding starter tasks"
              sublabel="A few helpful tasks to get you oriented"
            />
          </div>
        </div>
      </div>
    );
  }

  // --- First-time onboarding (no file) ---
  if (!fileExists) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto">
            <div className="mx-auto max-w-xl px-4 md:px-6 py-12">
            {/* One idea, one action. The three bordered feature cards read as a
                pitch deck; what a person needs here is what this is and how to
                start, with the detail available but quiet. */}
            <div className="text-center">
              <h1 className="text-[26px] font-medium tracking-tight text-foreground">
                Task board
              </h1>
              <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
                A shared Kanban board for you and your agents. Add a task here,
                or just ask your agent in chat — both sides stay in sync.
              </p>

              <button
                type="button"
                onClick={initBoard}
                className="mt-7 inline-flex items-center gap-2 rounded-full bg-primary px-6 py-2.5 text-[13.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                <Rocket className="h-4 w-4" />
                Create the board
              </button>
              <p className="mt-3 text-[12px] text-muted-foreground">
                Creates{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11.5px]">
                  kanban.json
                </code>{" "}
                in your workspace. Nothing else changes.
              </p>
            </div>

            {/* Columns, stated plainly rather than previewed as chips with
                decorative colour. */}
            <p className="mt-10 text-center text-[12.5px] text-muted-foreground">
              Columns:{" "}
              {columns.map((col, index) => (
                <span key={col.id}>
                  <span className="text-fg-secondary">{col.title}</span>
                  {index < columns.length - 1 ? " · " : ""}
                </span>
              ))}
            </p>

            {/* Or copy-paste: for users who prefer to create the file themselves */}
            <details className="mt-10 border-t border-border pt-8">
              <summary className="mb-3 cursor-pointer list-none text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
                Prefer to create the file yourself?
              </summary>
              <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
                Save as <code className="rounded bg-foreground/5 px-1 text-xs">kanban.json</code> in your workspace and paste:
              </p>
              <div className="relative">
                <pre className="overflow-x-auto rounded-lg border border-foreground/10 bg-foreground/5 px-4 py-3.5 pr-12 text-left text-[11px] leading-snug text-foreground">
                  {exampleJson}
                </pre>
                <button
                  type="button"
                  onClick={copyExample}
                  className="absolute right-2.5 top-2.5 flex items-center gap-1.5 rounded-md border border-foreground/10 bg-background px-2.5 py-1.5 text-xs font-medium text-muted-foreground shadow-sm transition-colors hover:bg-foreground/5 hover:text-foreground"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </>
                  )}
                </button>
              </div>
            </details>
          </div>
        </div>
      </div>
    );
  }

  // --- Board exists but is empty ---
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-lg px-4 md:px-6 py-12">
          <div className="text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-success-bg">
              <CheckCircle className="h-7 w-7 text-success-fg" />
            </div>
            <h1 className="text-sm font-semibold text-foreground">
              Board is clear
            </h1>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
              All tasks done! Add a new one or ask your agent to add tasks for you.
            </p>
          </div>

          <div className="mt-8 flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => setAddingToColumn("backlog")}
              className="flex items-center gap-2 rounded-xl bg-primary text-primary-foreground px-6 py-3 text-xs font-medium transition-all hover:bg-primary/90"
            >
              <Plus className="h-4.5 w-4.5" />
              Add a task
            </button>
            <p className="text-xs text-fg-subtle">
              Or tell your agent: &ldquo;Add a task to&hellip;&rdquo;
            </p>
          </div>

          {addingToColumn && (
            <div className="mx-auto mt-6 max-w-sm">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Adding to: <span className="text-fg-secondary capitalize">{addingToColumn}</span>
              </p>
              <AddTaskInline
                column={addingToColumn}
                agents={[]}
                onAdd={(task) => {
                  addTask(task);
                  setAddingToColumn(null);
                }}
                onCancel={() => setAddingToColumn(null)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── StepIndicator (init animation) ──────────────── */

function StepIndicator({
  step,
  current,
  label,
  sublabel,
}: {
  step: number;
  current: number;
  label: string;
  sublabel: string;
}) {
  const isDone = current > step;
  const isActive = current === step;
  const isPending = current < step;

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-4 py-2.5 transition-all duration-300",
        isDone && "bg-success-bg",
        isActive && "bg-muted-foreground/5",
        isPending && "opacity-40"
      )}
    >
      <div className="flex h-6 w-6 shrink-0 items-center justify-center">
        {isDone ? (
          <CheckCircle className="h-5 w-5 text-success-fg" />
        ) : isActive ? (
          <span className="inline-flex items-center gap-0.5">
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
          </span>
        ) : (
          <div className="h-2 w-2 rounded-full bg-fg-secondary" />
        )}
      </div>
      <div className="min-w-0">
        <p
          className={cn(
            "text-sm font-medium",
            isDone ? "text-success-fg" : isActive ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
        </p>
        <p className="text-xs text-fg-subtle">{sublabel}</p>
      </div>
    </div>
  );
}

/* ── EditTaskInline ──────────────────────────────── */

function EditTaskInline({
  task,
  columns,
  agents,
  onSave,
  onCancel,
  onDelete,
}: {
  task: Task;
  columns: Column[];
  agents: AgentInfo[];
  onSave: (updates: Partial<Task>) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [desc, setDesc] = useState(task.description || "");
  const [priority, setPriority] = useState(task.priority);
  const [column, setColumn] = useState(task.column);
  const [assignee, setAssignee] = useState(task.assignee || "");
  const [agentId, setAgentId] = useState(task.agentId || "");
  const [runMode, setRunMode] = useState<DispatchAssignee>(
    task.dispatchAssignee || "agent"
  );

  const save = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      description: desc.trim() || undefined,
      priority,
      column,
      assignee: assignee.trim() || undefined,
      agentId: agentId || undefined,
      dispatchAssignee: agentId ? runMode : undefined,
    });
  };

  return (
    <div className="rounded-lg border border-border-strong bg-card p-3.5">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") save();
          if (e.key === "Escape") onCancel();
        }}
        className="mb-2 w-full bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-fg-subtle"
        autoFocus
      />
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Add more detail, if it helps"
        rows={2}
        className="mb-2 w-full resize-none bg-transparent text-xs leading-5 text-muted-foreground outline-none placeholder:text-fg-subtle"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          className="rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none"
        >
          {PRIORITIES.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          className="rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none"
        >
          {columns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        {agents.length > 0 && (
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none"
          >
            <option value="">No agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name}
              </option>
            ))}
          </select>
        )}
        {agentId && <RunModeSelect value={runMode} onChange={setRunMode} />}
        <input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          className="min-w-0 flex-1 rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg"
          title="Delete task"
          aria-label="Delete task"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-fg-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={!title.trim()}
          className="flex items-center gap-1 rounded-full bg-primary text-primary-foreground px-2.5 py-1 text-xs font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          <Check className="h-3 w-3" /> Save
        </button>
      </div>
    </div>
  );
}
