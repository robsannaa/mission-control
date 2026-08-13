"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Ban,
  Bell,
  CheckCircle2,
  Clock,
  Cpu,
  GitBranch,
  Loader2,
  RefreshCw,
  Stethoscope,
  Terminal,
  Wrench,
  Workflow,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState, InlineSpinner } from "@/components/ui/loading-state";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  BUCKET_TONE,
  findingCodeLabel,
  groupTasks,
  isCancellable,
  maintenanceSummary,
  relativeTime,
  runtimeLabel,
  statusBucket,
  taskTitle,
  type AuditResult,
  type MaintenanceResult,
  type NativeTask,
  type TaskFlow,
  type TasksSnapshot,
} from "@/lib/tasks-native-types";

type Scope = "active" | "all";

async function fetchSnapshot(scope: Scope): Promise<TasksSnapshot> {
  const res = await fetch(`/api/tasks?scope=${scope}`, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Failed to load tasks");
  return body as TasksSnapshot;
}

async function postAction(payload: Record<string, unknown>): Promise<TasksSnapshot | null> {
  const res = await fetch("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(body?.error || "Action failed");
  return Array.isArray(body?.tasks) ? (body as TasksSnapshot) : null;
}

const RUNTIME_ICON: Record<string, typeof Cpu> = {
  cron: Clock,
  subagent: Cpu,
  cli: Terminal,
  acp: GitBranch,
};

export function TasksView() {
  const [snap, setSnap] = useState<TasksSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<Scope>("active");
  const [openId, setOpenId] = useState<string | null>(null);
  const [healthOpen, setHealthOpen] = useState(false);
  const [auditCount, setAuditCount] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/tasks?view=audit", { cache: "no-store" });
        const body = await res.json();
        if (active && res.ok) setAuditCount(body?.summary?.combined?.total ?? body?.count ?? 0);
      } catch {
        /* health badge is best-effort */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    try {
      const next = await fetchSnapshot(scope);
      setSnap(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [scope]);

  useEffect(() => {
    setLoading(true);
    void load();
    const iv = setInterval(() => void load(true), 15_000);
    return () => clearInterval(iv);
  }, [load]);

  const apply = useCallback((next: TasksSnapshot | null) => {
    if (next) setSnap(next);
    else void load(true);
  }, [load]);

  const tasks = snap?.tasks ?? [];
  const flows = snap?.flows ?? [];
  const groups = useMemo(() => groupTasks(tasks), [tasks]);
  const openTask = tasks.find((t) => t.taskId === openId) ?? null;
  const activeCount = tasks.filter((t) => ["running", "queued", "waiting"].includes(statusBucket(t.status))).length;

  return (
    <SectionLayout>
      <SectionHeader
        title="Tasks"
        description="Every background run your agents are doing — cron jobs, subagents, CLI and ACP work — straight from OpenClaw's task ledger."
        meta={
          snap
            ? `${activeCount} active · ${flows.length} flow${flows.length === 1 ? "" : "s"} · ${snap.count} tracked total`
            : undefined
        }
        actions={
          <>
            <div className="flex items-center gap-1 rounded-control bg-secondary p-0.5">
              {(["active", "all"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setScope(s)}
                  className={cn(
                    "rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1 text-xs font-medium capitalize transition-colors",
                    scope === s ? "bg-card text-foreground shadow-sm" : "text-fg-subtle hover:text-foreground",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={() => setHealthOpen(true)}>
              <Stethoscope className="size-4" />
              Health
              {auditCount != null && auditCount > 0 && (
                <Badge variant="warning" className="ml-0.5">{auditCount}</Badge>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void load(true)}
              disabled={refreshing}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
          </>
        }
      />

      <SectionBody width="content">
        {loading ? (
          <ContentLoadingState />
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-danger-border bg-danger-bg px-6 py-10 text-center">
            <p className="max-w-md text-sm text-danger-fg">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : tasks.length === 0 && flows.length === 0 ? (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border px-8 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-fg-secondary">
              <Workflow className="size-5" />
            </div>
            <h2 className="text-base font-semibold text-foreground">Nothing running</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {scope === "active"
                ? "No active background work right now. Cron jobs, subagents, and flows appear here the moment they start."
                : "No tasks tracked yet."}
            </p>
          </div>
        ) : (
          <div className="space-y-7">
            {flows.length > 0 && (
              <section className="space-y-2.5">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                  <Workflow className="size-3.5" /> TaskFlows
                </h3>
                <div className="space-y-2.5">
                  {flows.map((f) => (
                    <FlowCard key={f.flowId} flow={f} onChanged={apply} scope={scope} />
                  ))}
                </div>
              </section>
            )}

            {groups.map((g) => (
              <section key={g.bucket} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <Badge variant={g.tone}>{g.label}</Badge>
                  <span className="text-xs text-fg-subtle">{g.tasks.length}</span>
                </div>
                <div className="space-y-2">
                  {g.tasks.map((t) => (
                    <TaskCard key={t.taskId} task={t} onOpen={() => setOpenId(t.taskId)} onChanged={apply} scope={scope} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </SectionBody>

      {openTask && (
        <TaskDrawer taskId={openTask.taskId} initial={openTask} onClose={() => setOpenId(null)} onChanged={apply} scope={scope} />
      )}

      <TaskHealthDrawer
        open={healthOpen}
        onClose={() => setHealthOpen(false)}
        onAuditCount={setAuditCount}
        onMaintained={() => void load(true)}
      />
    </SectionLayout>
  );
}

// ── ledger health drawer (audit + maintenance) ────────────────────────────────

function TaskHealthDrawer({
  open,
  onClose,
  onAuditCount,
  onMaintained,
}: {
  open: boolean;
  onClose: () => void;
  onAuditCount: (n: number) => void;
  onMaintained: () => void;
}) {
  const [audit, setAudit] = useState<AuditResult | null>(null);
  const [preview, setPreview] = useState<MaintenanceResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<MaintenanceResult | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setApplied(null);
    (async () => {
      try {
        const [a, m] = await Promise.all([
          fetch("/api/tasks?view=audit", { cache: "no-store" }).then((r) => r.json()),
          fetch("/api/tasks?view=maintenance", { cache: "no-store" }).then((r) => r.json()),
        ]);
        if (!active) return;
        setAudit(a as AuditResult);
        setPreview(m as MaintenanceResult);
        onAuditCount(a?.summary?.combined?.total ?? a?.count ?? 0);
      } catch {
        /* surfaced as empty state */
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [open, onAuditCount]);

  const findings = audit?.findings ?? [];

  const apply = async () => {
    setApplying(true);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "maintenance-apply" }),
      });
      const body = await res.json();
      if (res.ok && body.maintenance) {
        setApplied(body.maintenance as MaintenanceResult);
        onMaintained();
        // Re-audit after applying.
        const a = await fetch("/api/tasks?view=audit", { cache: "no-store" }).then((r) => r.json());
        setAudit(a as AuditResult);
        onAuditCount(a?.summary?.combined?.total ?? a?.count ?? 0);
      }
    } finally {
      setApplying(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Stethoscope className="size-4 text-fg-subtle" /> Ledger health
          </SheetTitle>
          <SheetDescription>
            Find stale, lost, or stuck background work — and reconcile or prune it in one click.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <InlineSpinner /> Checking the ledger…
            </div>
          ) : (
            <>
              {/* Audit findings */}
              <section className="space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Findings</h3>
                {findings.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-xl border border-success-border bg-success-bg px-3 py-2.5 text-sm text-success-fg">
                    <CheckCircle2 className="size-4" /> No issues — the task ledger is healthy.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {findings.map((f, i) => (
                      <div
                        key={i}
                        className={cn(
                          "flex items-start gap-2.5 rounded-xl border px-3 py-2.5",
                          f.severity === "error" ? "border-danger-border bg-danger-bg" : "border-warning-border bg-warning-bg",
                        )}
                      >
                        <AlertTriangle
                          className={cn("mt-0.5 size-3.5 shrink-0", f.severity === "error" ? "text-danger-fg" : "text-warning-fg")}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <Badge variant={f.severity === "error" ? "destructive" : "warning"}>
                              {findingCodeLabel(f.code)}
                            </Badge>
                            {f.task?.label && <span className="truncate text-xs font-medium text-foreground">{f.task.label}</span>}
                          </div>
                          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{f.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              {/* Maintenance */}
              <section className="space-y-2.5 rounded-xl border border-border bg-card p-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Wrench className="size-4 text-fg-subtle" /> Maintenance
                </h3>
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {applied
                    ? maintenanceSummary(applied)
                    : preview
                      ? `Preview: ${maintenanceSummary(preview)}`
                      : "Reconciles half-finished tasks, recovers lost ones, and prunes old records."}
                </p>
                {applied ? (
                  <div className="flex items-center gap-2 text-sm font-medium text-success-fg">
                    <CheckCircle2 className="size-4" /> Maintenance applied.
                  </div>
                ) : (
                  <Button size="sm" onClick={() => void apply()} disabled={applying}>
                    {applying ? <Loader2 className="size-3.5 animate-spin" /> : <Wrench className="size-3.5" />}
                    Run maintenance
                  </Button>
                )}
              </section>
            </>
          )}
        </div>

        <SheetFooter className="flex-row justify-end border-t border-border px-6 py-4">
          <SheetClose asChild>
            <Button variant="outline" size="sm">
              Close
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function TaskCard({
  task,
  onOpen,
  onChanged,
  scope,
}: {
  task: NativeTask;
  onOpen: () => void;
  onChanged: (next: TasksSnapshot | null) => void;
  scope: Scope;
}) {
  const [busy, setBusy] = useState(false);
  const bucket = statusBucket(task.status);
  const Icon = RUNTIME_ICON[task.runtime] ?? Cpu;
  const when = task.lastEventAt ?? task.startedAt ?? task.createdAt;
  const summary = task.progressSummary || task.terminalSummary;

  return (
    <div
      className="group flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-border-strong"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-secondary text-fg-secondary">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{taskTitle(task)}</span>
          <Badge variant="outline" className="shrink-0">{runtimeLabel(task.runtime)}</Badge>
          <Badge variant={BUCKET_TONE[bucket]} className="shrink-0 capitalize">{task.status}</Badge>
        </div>
        {summary && <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{summary}</p>}
        <p className="mt-0.5 text-xs text-fg-subtle">
          {task.agentId ? `${task.agentId} · ` : ""}
          {relativeTime(when)}
        </p>
      </div>
      {isCancellable(task.status) && (
        <div onClick={(e) => e.stopPropagation()}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="opacity-0 group-hover:opacity-100 text-danger-fg"
            disabled={busy}
            title="Cancel task"
            aria-label="Cancel task"
            onClick={async () => {
              setBusy(true);
              try {
                onChanged(await postAction({ action: "cancel", id: task.taskId, scope }));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
          </Button>
        </div>
      )}
    </div>
  );
}

function FlowCard({
  flow,
  onChanged,
  scope,
}: {
  flow: TaskFlow;
  onChanged: (next: TasksSnapshot | null) => void;
  scope: Scope;
}) {
  const [busy, setBusy] = useState(false);
  const bucket = statusBucket(flow.status);
  const ts = flow.taskSummary;
  const summary =
    typeof ts === "string"
      ? ts
      : ts && typeof ts === "object"
        ? Object.entries(ts)
            .filter(([, v]) => typeof v === "number") // scalar counts only, skip byStatus/byRuntime objects
            .map(([k, v]) => `${v} ${k}`)
            .join(" · ") || `${flow.tasks?.length ?? 0} tasks`
        : `${flow.tasks?.length ?? 0} tasks`;

  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control bg-secondary text-fg-secondary">
          <Workflow className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{flow.goal || flow.flowId.slice(0, 8)}</span>
            <Badge variant={BUCKET_TONE[bucket]} className="shrink-0 capitalize">{flow.status}</Badge>
          </div>
          <p className="mt-0.5 text-xs text-fg-subtle">{summary} · {relativeTime(flow.updatedAt ?? flow.createdAt)}</p>
        </div>
        {["running", "queued", "waiting"].includes(bucket) && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-danger-fg"
            disabled={busy}
            title="Cancel flow"
            aria-label="Cancel flow"
            onClick={async () => {
              setBusy(true);
              try {
                onChanged(await postAction({ action: "cancel-flow", id: flow.flowId, scope }));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
          </Button>
        )}
      </div>
    </div>
  );
}

function TaskDrawer({
  taskId,
  initial,
  onClose,
  onChanged,
  scope,
}: {
  taskId: string;
  initial: NativeTask;
  onClose: () => void;
  onChanged: (next: TasksSnapshot | null) => void;
  scope: Scope;
}) {
  const [task, setTask] = useState<NativeTask>(initial);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch(`/api/tasks?id=${encodeURIComponent(taskId)}`, { cache: "no-store" });
        const body = await res.json();
        if (active && res.ok && body.task) setTask(body.task as NativeTask);
      } catch {
        /* keep the list row's copy */
      }
    })();
    return () => {
      active = false;
    };
  }, [taskId]);

  const rows: Array<[string, React.ReactNode]> = [
    ["Runtime", runtimeLabel(task.runtime)],
    ["Status", task.status],
    ["Agent", task.agentId || "—"],
    ["Started", task.startedAt ? relativeTime(task.startedAt) : "—"],
    ["Ended", task.endedAt ? relativeTime(task.endedAt) : "—"],
    ["Notify", task.notifyPolicy || "—"],
  ];
  if (task.runId) rows.push(["Run", <Mono key="r">{task.runId}</Mono>]);
  if (task.childSessionKey) rows.push(["Session", <Mono key="s">{task.childSessionKey}</Mono>]);

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle className="text-lg">{taskTitle(task)}</SheetTitle>
          <SheetDescription className="font-mono text-xs">{task.taskId}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {task.task && (
            <div className="rounded-xl border border-border bg-muted/40 p-3">
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground">{task.task}</p>
            </div>
          )}
          {(task.progressSummary || task.terminalSummary) && (
            <div className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Summary</h3>
              <p className="text-sm leading-relaxed text-foreground">{task.terminalSummary || task.progressSummary}</p>
            </div>
          )}
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5 text-sm">
            {rows.map(([k, v], i) => (
              <div key={i} className="contents">
                <dt className="text-fg-subtle">{k}</dt>
                <dd className="min-w-0 break-words capitalize text-foreground">{v}</dd>
              </div>
            ))}
          </dl>

          <div className="space-y-2">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              <Bell className="size-3.5" /> Notify policy
            </h3>
            <div className="flex gap-2">
              {(["done_only", "state_changes", "silent"] as const).map((p) => (
                <Button
                  key={p}
                  size="xs"
                  variant={task.notifyPolicy === p ? "default" : "outline"}
                  disabled={busy !== null}
                  onClick={async () => {
                    setBusy(`notify:${p}`);
                    try {
                      onChanged(await postAction({ action: "notify", id: task.taskId, policy: p, scope }));
                      setTask((t) => ({ ...t, notifyPolicy: p }));
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {p.replace("_", " ")}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t border-border px-6 py-4">
          {isCancellable(task.status) ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-danger-fg"
              disabled={busy !== null}
              onClick={async () => {
                setBusy("cancel");
                try {
                  onChanged(await postAction({ action: "cancel", id: task.taskId, scope }));
                  onClose();
                } finally {
                  setBusy(null);
                }
              }}
            >
              {busy === "cancel" ? <Loader2 className="size-3.5 animate-spin" /> : <Ban className="size-3.5" />}
              Cancel task
            </Button>
          ) : (
            <span />
          )}
          <SheetClose asChild>
            <Button variant="outline" size="sm">
              Close
            </Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="break-all font-mono text-xs text-foreground">{children}</span>;
}
