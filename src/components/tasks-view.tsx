"use client";
/* eslint-disable @next/next/no-img-element */

import { useEffect, useState, useCallback, useRef, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  Plus,
  ChevronLeft,
  ChevronRight,
  Trash2,
  Pencil,
  X,
  Check,
  ListChecks,
  Rocket,
  CheckCircle,
  GripVertical,
  Copy,
  Play,
  AlertCircle,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { SectionLayout } from "@/components/section-layout";
import { useFocusTrap, useBodyScrollLock } from "@/hooks/use-modal-accessibility";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
} from "@/lib/time-format-preference";

/* ── types ─────────────────────────────────────── */

type Column = { id: string; title: string; color: string };
type Task = {
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

type AgentInfo = {
  id: string;
  name: string;
  emoji: string;
};
type KanbanData = { columns: Column[]; tasks: Task[]; _fileExists?: boolean };

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
function isImageAttachment(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}
function attachmentUrl(path: string): string {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `/api/workspace/file?path=${encodeURIComponent(trimmed)}`;
}

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-danger",
  medium: "bg-warning",
  low: "bg-info",
};
const PRIORITY_TEXT: Record<string, string> = {
  high: "text-danger-fg",
  medium: "text-warning-fg",
  low: "text-info-fg",
};
const PRIORITIES = ["high", "medium", "low"];

/* ── component ─────────────────────────────────── */

export function TasksView() {
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [data, setData] = useState<KanbanData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | null>(null);
  const [addingToColumn, setAddingToColumn] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState<number | null>(null);
  const saveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevDataRef = useRef<KanbanData | null>(null);
  const savingRef = useRef(false);
  const [draggingTaskId, setDraggingTaskId] = useState<number | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);
  const [renamingTaskId, setRenamingTaskId] = useState<number | null>(null);
  const [detailTaskId, setDetailTaskId] = useState<number | null>(null);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Modal accessibility: focus trapping and body scroll lock
  const detailFocusTrapRef = useFocusTrap(detailTaskId != null);
  const lightboxFocusTrapRef = useFocusTrap(lightboxImage != null);
  useBodyScrollLock(detailTaskId != null || lightboxImage != null);
  const streamRef = useRef<EventSource | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [dispatchingTaskIds, setDispatchingTaskIds] = useState<Set<number>>(new Set());

  useEffect(() => {
    fetch("/api/tasks")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Fetch agents for assignment dropdown
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

  // Live updates: when kanban is written (dashboard or agent), refetch without polling
  // Skip SSE refetch while a local save is in-flight to avoid clobbering edits
  useEffect(() => {
    const es = new EventSource("/api/tasks/stream");
    streamRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload?.type === "kanban-updated") {
          if (savingRef.current) return; // don't clobber in-flight edits
          fetch("/api/tasks")
            .then((r) => r.json())
            .then((d) => setData(d))
            .catch(() => {});
        }
      } catch {
        /* ignore */
      }
    };
    return () => {
      es.close();
      streamRef.current = null;
    };
  }, []);

  /* ── persist helpers ───────────────────────────── */

  const persist = useCallback((newData: KanbanData) => {
    prevDataRef.current = data;
    setData(newData);
    setSaveStatus("saving");
    savingRef.current = true;
    if (saveRef.current) clearTimeout(saveRef.current);
    saveRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/tasks", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(newData),
        });
        if (res.ok) {
          prevDataRef.current = null;
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus(null), 2000);
        } else {
          // Rollback on server rejection
          if (prevDataRef.current) setData(prevDataRef.current);
          prevDataRef.current = null;
          setSaveStatus(null);
        }
      } catch {
        // Rollback on network failure
        if (prevDataRef.current) setData(prevDataRef.current);
        prevDataRef.current = null;
        setSaveStatus(null);
      } finally {
        savingRef.current = false;
      }
    }, 500);
  }, [data]);

  /* ── task CRUD ─────────────────────────────────── */

  const addTask = useCallback(
    (task: Omit<Task, "id">) => {
      if (!data) return;
      const maxId = data.tasks.reduce((m, t) => Math.max(m, t.id), 0);
      const newData = {
        ...data,
        tasks: [...data.tasks, { ...task, id: maxId + 1 }],
      };
      persist(newData);
    },
    [data, persist]
  );

  const updateTask = useCallback(
    (id: number, updates: Partial<Task>) => {
      if (!data) return;
      const newData = {
        ...data,
        tasks: data.tasks.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      };
      persist(newData);
    },
    [data, persist]
  );

  const moveTask = useCallback(
    (id: number, direction: "left" | "right") => {
      if (!data) return;
      const task = data.tasks.find((t) => t.id === id);
      if (!task) return;
      const colIdx = data.columns.findIndex((c) => c.id === task.column);
      const newIdx =
        direction === "right"
          ? Math.min(colIdx + 1, data.columns.length - 1)
          : Math.max(colIdx - 1, 0);
      if (newIdx === colIdx) return;
      updateTask(id, { column: data.columns[newIdx].id });
    },
    [data, updateTask]
  );

  const deleteTask = useCallback(
    (id: number) => {
      if (!data) return;
      const newData = {
        ...data,
        tasks: data.tasks.filter((t) => t.id !== id),
      };
      persist(newData);
    },
    [data, persist]
  );

  /* ── dispatch to agent ────────────────────────── */

  const dispatchTask = useCallback(
    async (taskId: number, agentId?: string) => {
      setDispatchingTaskIds((prev) => new Set(prev).add(taskId));
      try {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "dispatch", taskId, agentId }),
        });
        if (res.ok) {
          // Refetch board to get updated status
          const boardRes = await fetch("/api/tasks");
          if (boardRes.ok) {
            const d = await boardRes.json();
            setData(d);
          }
        }
      } catch { /* handled by SSE */ }
      setDispatchingTaskIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    },
    []
  );

  /* ── rendering ─────────────────────────────────── */

  if (loading) {
    return (
      <SectionLayout>
        <ScreenLoadingState />
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

  /* ── Normal board view ── */
  return (
    <SectionLayout>
      {/* Stats header */}
      <div className="shrink-0 space-y-3 px-4 md:px-6 pt-5 pb-4">
        <div className="flex items-center justify-between">
          <div className="flex flex-wrap items-center gap-5 text-sm">
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
          </div>
          {saveStatus && (
            <span
              className={cn(
                "text-xs",
                saveStatus === "saving" ? "text-muted-foreground" : "text-success-fg"
              )}
            >
              {saveStatus === "saving" ? "Saving..." : "Saved"}
            </span>
          )}
        </div>
        <p className="text-xs text-fg-subtle">
          Source: workspace/kanban.json &bull; {totalTasks} tasks across{" "}
          {columns.length} columns
          <span className="ml-2 text-fg-subtle/60 italic select-none" title="You know it's true.">
            &mdash; added because every dude on X is flexing their Kanban board, so <strong>maybe</strong> it&apos;s not BS after all
          </span>
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
                  updateTask(taskId, { column: col.id });
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
                    if (!data) return;
                    const maxId = data.tasks.reduce((m, t) => Math.max(m, t.id), 0);
                    const newId = maxId + 1;
                    addTask(task);
                    setAddingToColumn(null);
                    if (task.agentId) {
                      // Dispatch after a short delay to ensure the task is saved
                      setTimeout(() => dispatchTask(newId, task.agentId), 700);
                    }
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
                    {isDragTarget ? "Drop here" : "No tasks"}
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
                      <TaskCard
                        key={task.id}
                        task={task}
                        columns={columns}
                        agents={agents}
                        onEdit={() => setEditingTask(task.id)}
                        onMove={(dir) => moveTask(task.id, dir)}
                        onDelete={() => deleteTask(task.id)}
                        onOpenDetail={() => setDetailTaskId(task.id)}
                        onAttachmentClick={(url) => setLightboxImage(url)}
                        onDispatch={(agentId) => dispatchTask(task.id, agentId)}
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
      {detailTaskId != null && data && (() => {
        const task = data.tasks.find((t) => t.id === detailTaskId);
        if (!task) return null;
        const column = data.columns.find((c) => c.id === task.column);
        const columnTitle = column?.title ?? task.column;
        return (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
            onClick={() => setDetailTaskId(null)}
          >
            <div
              ref={detailFocusTrapRef}
              role="dialog"
              aria-modal="true"
              aria-label="Task details"
              className="relative w-full max-w-md rounded-xl border border-foreground/10 bg-card shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2 border-b border-foreground/10 px-4 py-3">
                <h3 className="text-sm font-semibold text-foreground truncate pr-8">
                  {task.title}
                </h3>
                <button
                  type="button"
                  onClick={() => setDetailTaskId(null)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-3 space-y-3 text-sm">
                {task.description && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1">Description</p>
                    <p className="text-foreground whitespace-pre-wrap">{task.description}</p>
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <div>
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Priority</span>
                    <p className={cn("font-medium capitalize", PRIORITY_TEXT[task.priority] || "text-muted-foreground")}>
                      {task.priority}
                    </p>
                  </div>
                  {task.agentId && (
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Agent</span>
                      <p className="text-foreground">
                        {(() => {
                          const ag = agents.find((a) => a.id === task.agentId);
                          return ag ? `${ag.emoji} ${ag.name}` : task.agentId;
                        })()}
                      </p>
                    </div>
                  )}
                  {task.assignee && (
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Assignee</span>
                      <p className="text-foreground">{task.assignee}</p>
                    </div>
                  )}
                  <div>
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Status</span>
                    <p className="text-foreground">{columnTitle}</p>
                  </div>
                  <div>
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">ID</span>
                    <p className="text-muted-foreground font-mono text-xs">{task.id}</p>
                  </div>
                  {task.dispatchStatus && task.dispatchStatus !== "idle" && (
                    <div>
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Dispatch</span>
                      <p className={cn(
                        "font-medium capitalize",
                        task.dispatchStatus === "running" && "text-warning-fg",
                        task.dispatchStatus === "completed" && "text-success-fg",
                        task.dispatchStatus === "failed" && "text-danger-fg",
                      )}>
                        {task.dispatchStatus}
                      </p>
                    </div>
                  )}
                </div>
                {task.dispatchStatus === "failed" && task.dispatchError && (
                  <div className="rounded-lg border border-danger-border bg-danger-bg p-2">
                    <p className="text-xs text-danger-fg">{task.dispatchError}</p>
                  </div>
                )}
                {(task as Task & Record<string, unknown>).completedAt != null && (
                  <div>
                    <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Completed</span>
                    <p className="text-foreground">
                      {new Date((task as Task & Record<string, unknown>).completedAt as string | number).toLocaleString(
                        undefined,
                        withTimeFormat(
                          {
                            year: "numeric",
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          },
                          timeFormat,
                        ),
                      )}
                    </p>
                  </div>
                )}
                {task.attachments && task.attachments.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">Attachments</p>
                    <div className="flex flex-wrap gap-2">
                      {task.attachments.filter(isImageAttachment).map((path, i) => (
                        <button
                          key={`${path}-${i}`}
                          type="button"
                          onClick={() => setLightboxImage(attachmentUrl(path))}
                          aria-label={`View attachment ${i + 1}`}
                          className="overflow-hidden rounded-lg border border-foreground/10 bg-muted/50 transition-opacity hover:opacity-90 focus:ring-2 focus:ring-border-strong"
                        >
                          <img
                            src={attachmentUrl(path)}
                            alt=""
                            className="h-20 w-20 object-cover"
                          />
                        </button>
                      ))}
                      {task.attachments.filter((p) => !isImageAttachment(p)).length > 0 && (
                        <span className="text-xs text-muted-foreground self-center">
                          +{task.attachments.filter((p) => !isImageAttachment(p)).length} file(s)
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="flex justify-end gap-2 border-t border-foreground/10 px-4 py-2">
                {task.agentId && task.dispatchStatus !== "running" && (
                  <button
                    type="button"
                    disabled={dispatchingTaskIds.has(task.id)}
                    onClick={() => {
                      dispatchTask(task.id);
                      setDetailTaskId(null);
                    }}
                    className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-success-fg hover:bg-success-bg transition-colors disabled:opacity-40"
                  >
                    <Play className="h-3 w-3" />
                    {task.dispatchStatus === "failed" ? "Retry" : "Run"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setEditingTask(task.id);
                    setDetailTaskId(null);
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => setDetailTaskId(null)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium bg-muted text-foreground hover:bg-muted/80 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        );
      })()}

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

/* ── TaskCard ────────────────────────────────────── */

function TaskCard({
  task,
  columns,
  agents,
  onEdit,
  onMove,
  onDelete,
  onOpenDetail,
  onAttachmentClick,
  onDispatch,
  isDispatching,
  isDragging,
  onDragStart,
  onDragEnd,
  isRenaming,
  onStartRename,
  onRename,
}: {
  task: Task;
  columns: Column[];
  agents: AgentInfo[];
  onEdit: () => void;
  onMove: (dir: "left" | "right") => void;
  onDelete: () => void;
  onOpenDetail?: () => void;
  onAttachmentClick?: (url: string) => void;
  onDispatch?: (agentId?: string) => void;
  isDispatching?: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  isRenaming: boolean;
  onStartRename: () => void;
  onRename: (title: string) => void;
}) {
  const colIdx = columns.findIndex((c) => c.id === task.column);
  const canLeft = colIdx > 0;
  const canRight = colIdx < columns.length - 1;
  const [renameValue, setRenameValue] = useState(task.title);
  const renameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      queueMicrotask(() => setRenameValue(task.title));
      setTimeout(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      }, 0);
    }
  }, [isRenaming, task.title]);

  return (
    <div
      className={cn(
        "group min-w-0 rounded-xl border border-foreground/10 bg-card p-3.5 shadow-sm transition-all hover:border-foreground/15 hover:shadow-md",
        isDragging && "opacity-40 scale-95",
        !isRenaming && "cursor-grab active:cursor-grabbing"
      )}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(task.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={() => !isRenaming && onOpenDetail?.()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!isRenaming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpenDetail?.();
        }
      }}
    >
      <div className="flex items-start gap-2">
        <GripVertical className="mt-1 h-3.5 w-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-subtle" />
        <div
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            PRIORITY_COLORS[task.priority] || "bg-muted-foreground"
          )}
        />
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              ref={renameRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRename(renameValue.trim() || task.title);
                if (e.key === "Escape") onRename(task.title);
              }}
              onBlur={() => onRename(renameValue.trim() || task.title)}
              className="w-full bg-transparent text-sm font-medium text-foreground outline-none border-b border-border-strong pb-0.5"
            />
          ) : (
            <p
              className="break-words text-sm font-medium text-foreground"
              onDoubleClick={(e) => {
                e.preventDefault();
                onStartRename();
              }}
              title="Double-click to rename"
            >
              {task.title}
            </p>
          )}
          {task.description && !isRenaming && (
            <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
              {task.description}
            </p>
          )}
          {task.attachments && task.attachments.length > 0 && isImageAttachment(task.attachments[0]) && !isRenaming && (
            <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
              {task.attachments.filter(isImageAttachment).slice(0, 3).map((path, i) => (
                <button
                  key={`${path}-${i}`}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAttachmentClick?.(attachmentUrl(path));
                  }}
                  className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-foreground/10 bg-muted/50 object-cover transition-opacity hover:opacity-90 focus:ring-2 focus:ring-border-strong"
                >
                  <img
                    src={attachmentUrl(path)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
              {task.attachments.filter(isImageAttachment).length > 3 && (
                <span className="flex h-14 shrink-0 items-center rounded-md bg-muted/50 px-2 text-xs text-muted-foreground">
                  +{task.attachments.filter(isImageAttachment).length - 3}
                </span>
              )}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 text-xs">
            <span
              className={cn(
                "font-medium capitalize",
                PRIORITY_TEXT[task.priority] || "text-muted-foreground"
              )}
            >
              {task.priority}
            </span>
            {task.agentId && (() => {
              const ag = agents.find((a) => a.id === task.agentId);
              return (
                <>
                  <span className="text-fg-subtle">&bull;</span>
                  <span className="inline-flex items-center gap-1 text-muted-foreground" title={`Agent: ${task.agentId}`}>
                    <span>{ag?.emoji || "🤖"}</span>
                    <span className="truncate max-w-[80px]">{ag?.name || task.agentId}</span>
                  </span>
                </>
              );
            })()}
            {task.assignee && !task.agentId && (
              <>
                <span className="text-fg-subtle">&bull;</span>
                <span className="text-muted-foreground">{task.assignee}</span>
              </>
            )}
            {task.dispatchStatus === "running" && (
              <>
                <span className="text-fg-subtle">&bull;</span>
                <span className="inline-flex items-center gap-1 text-warning-fg">
                  <span className="h-1.5 w-1.5 rounded-full bg-warning animate-pulse" />
                  Running
                </span>
              </>
            )}
            {task.dispatchStatus === "failed" && (
              <>
                <span className="text-fg-subtle">&bull;</span>
                <span className="inline-flex items-center gap-1 text-danger-fg" title={task.dispatchError || "Failed"}>
                  <AlertCircle className="h-3 w-3" />
                  Failed
                </span>
              </>
            )}
            {task.dispatchStatus === "completed" && (
              <>
                <span className="text-fg-subtle">&bull;</span>
                <span className="inline-flex items-center gap-1 text-success-fg">
                  <CheckCircle className="h-3 w-3" />
                  Done
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Action bar -- visible on hover */}
      <div
        className="mt-2 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={!canLeft}
          onClick={() => onMove("left")}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary disabled:opacity-30"
          title="Move left"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!canRight}
          onClick={() => onMove("right")}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary disabled:opacity-30"
          title="Move right"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        {task.agentId && task.dispatchStatus !== "running" && (
          <button
            type="button"
            disabled={isDispatching}
            onClick={() => onDispatch?.()}
            className="rounded p-1 text-success-fg transition-colors hover:bg-success-bg hover:text-success-fg disabled:opacity-40"
            title={task.dispatchStatus === "failed" ? "Retry dispatch" : "Run with agent"}
          >
            {isDispatching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
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
        placeholder="Task title..."
        className="mb-2 w-full bg-transparent text-sm font-medium text-foreground outline-none placeholder:text-fg-subtle"
      />
      <textarea
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        placeholder="Description (optional)"
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
            <option key={p} value={p}>
              {p}
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
        <input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          className="flex-1 rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none placeholder:text-fg-subtle"
        />
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-muted-foreground hover:text-fg-secondary"
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
            className="flex items-center gap-1 rounded bg-success text-primary-foreground px-2.5 py-1 text-xs font-medium transition-colors hover:bg-success disabled:opacity-40"
          >
            <Play className="h-3 w-3" /> Add & Run
          </button>
        )}
        <button
          type="button"
          onClick={submit}
          disabled={!title.trim()}
          className="rounded bg-primary text-primary-foreground px-2.5 py-1 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>
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

/* ── FeatureRow (onboarding) ─────────────────────── */


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

  const save = () => {
    if (!title.trim()) return;
    onSave({
      title: title.trim(),
      description: desc.trim() || undefined,
      priority,
      column,
      assignee: assignee.trim() || undefined,
      agentId: agentId || undefined,
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
        placeholder="Description"
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
            <option key={p} value={p}>
              {p}
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
        <input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="Assignee"
          className="flex-1 rounded border border-foreground/10 bg-muted px-2 py-1 text-xs text-muted-foreground outline-none placeholder:text-fg-subtle"
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
          className="flex items-center gap-1 rounded bg-primary text-primary-foreground px-2.5 py-1 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-40"
        >
          <Check className="h-3 w-3" /> Save
        </button>
      </div>
    </div>
  );
}
