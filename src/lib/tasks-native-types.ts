/**
 * Native OpenClaw tasks — CLIENT-SAFE types + grouping (no server imports).
 *
 * These mirror `openclaw tasks list` / `tasks flow list`. Mission Control's
 * Tasks page is a MONITOR of this single source of truth — there is no separate
 * kanban store. The server module `@/lib/tasks-native` re-exports these.
 */

export type TaskRuntime = "cron" | "subagent" | "cli" | "acp" | string;

export interface NativeTask {
  taskId: string;
  runtime: TaskRuntime;
  sourceId?: string;
  requesterSessionKey?: string;
  ownerKey?: string;
  scopeKind?: string;
  childSessionKey?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task?: string;
  status: string;
  deliveryStatus?: string;
  notifyPolicy?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  progressSummary?: string;
  terminalSummary?: string;
}

export interface TaskFlow {
  flowId: string;
  syncMode?: string;
  ownerKey?: string;
  requesterOrigin?: string;
  revision?: number;
  status: string;
  notifyPolicy?: string;
  goal?: string;
  waitJson?: string;
  createdAt?: number;
  updatedAt?: number;
  endedAt?: number;
  tasks?: string[];
  // Nested: { total, active, terminal, failures, byStatus:{…}, byRuntime:{…} }.
  taskSummary?: Record<string, unknown> | string;
}

export interface TasksSnapshot {
  tasks: NativeTask[];
  flows: TaskFlow[];
  count: number;
}

// ── status classification ──────────────────────────────────────────────────

export type StatusBucket = "running" | "queued" | "waiting" | "done" | "failed" | "cancelled";

export function statusBucket(status: string | undefined): StatusBucket {
  const s = String(status || "").toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/fail|error|lost|dead|timeout/.test(s)) return "failed";
  if (/run|active|in[-_ ]?progress/.test(s)) return "running";
  if (/wait|block|paused|needs/.test(s)) return "waiting";
  if (/queue|pending|scheduled/.test(s)) return "queued";
  if (/done|complete|success|finish|delivered|ok/.test(s)) return "done";
  return "queued";
}

export const BUCKET_LABEL: Record<StatusBucket, string> = {
  running: "Running",
  queued: "Queued",
  waiting: "Waiting",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

export type BucketTone = "success" | "warning" | "destructive" | "info" | "secondary" | "outline";

export const BUCKET_TONE: Record<StatusBucket, BucketTone> = {
  running: "info",
  queued: "secondary",
  waiting: "warning",
  done: "success",
  failed: "destructive",
  cancelled: "outline",
};

export function isActive(bucket: StatusBucket): boolean {
  return bucket === "running" || bucket === "queued" || bucket === "waiting";
}

export function isCancellable(status: string | undefined): boolean {
  return isActive(statusBucket(status));
}

const BUCKET_ORDER: StatusBucket[] = ["running", "waiting", "queued", "failed", "done", "cancelled"];

export interface TaskGroup {
  bucket: StatusBucket;
  label: string;
  tone: BucketTone;
  tasks: NativeTask[];
}

/** Group tasks into ordered status buckets, newest activity first within each. */
export function groupTasks(tasks: NativeTask[]): TaskGroup[] {
  const map = new Map<StatusBucket, NativeTask[]>();
  for (const t of tasks) {
    const b = statusBucket(t.status);
    const arr = map.get(b) ?? [];
    arr.push(t);
    map.set(b, arr);
  }
  return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
    bucket: b,
    label: BUCKET_LABEL[b],
    tone: BUCKET_TONE[b],
    tasks: (map.get(b) ?? []).sort(
      (a, z) => (z.lastEventAt ?? z.startedAt ?? z.createdAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? a.createdAt ?? 0),
    ),
  }));
}

/** Human title for a task: its label, else the task text, else the id. */
export function taskTitle(t: NativeTask): string {
  return t.label?.trim() || t.task?.trim()?.split("\n")[0]?.slice(0, 80) || t.taskId.slice(0, 8);
}

export function runtimeLabel(runtime: TaskRuntime): string {
  switch (runtime) {
    case "cron":
      return "Cron";
    case "subagent":
      return "Subagent";
    case "cli":
      return "CLI";
    case "acp":
      return "ACP";
    default:
      return runtime ? runtime.charAt(0).toUpperCase() + runtime.slice(1) : "Task";
  }
}

// ── audit + maintenance (ledger health) ─────────────────────────────────────

export interface AuditFinding {
  kind: "task" | "flow" | string;
  severity: "warn" | "error" | string;
  code: string;
  detail: string;
  ageMs?: number;
  status?: string;
  token?: string;
  task?: NativeTask;
}

export interface AuditSummary {
  total: number;
  warnings: number;
  errors: number;
  byCode?: Record<string, number>;
  combined?: { total: number; errors: number; warnings: number };
}

export interface AuditResult {
  count: number;
  summary: AuditSummary;
  findings: AuditFinding[];
}

export interface MaintenanceResult {
  mode: "preview" | "apply" | string;
  maintenance: {
    tasks?: { reconciled?: number; recovered?: number; cleanupStamped?: number; pruned?: number };
    taskFlows?: { reconciled?: number; pruned?: number };
    sessions?: {
      retentionMs?: number;
      runningCronJobs?: number;
      pruned?: number;
      stores?: Array<{ agentId?: string; beforeCount?: number; afterCount?: number; pruned?: number }>;
    };
  };
}

const FINDING_CODE_LABEL: Record<string, string> = {
  stale_queued: "Stuck queued",
  stale_running: "Stuck running",
  lost: "Lost",
  delivery_failed: "Delivery failed",
  missing_cleanup: "Missing cleanup",
  inconsistent_timestamps: "Bad timestamps",
  restore_failed: "Restore failed",
  stale_waiting: "Stuck waiting",
  stale_blocked: "Stuck blocked",
  cancel_stuck: "Cancel stuck",
  missing_linked_tasks: "Missing linked tasks",
  blocked_task_missing: "Blocked task missing",
};

export function findingCodeLabel(code: string): string {
  return FINDING_CODE_LABEL[code] ?? code.replace(/_/g, " ");
}

/** One-line human summary of what a maintenance run did (or would do). */
export function maintenanceSummary(r: MaintenanceResult): string {
  const t = r.maintenance?.tasks ?? {};
  const f = r.maintenance?.taskFlows ?? {};
  const s = r.maintenance?.sessions ?? {};
  const parts: string[] = [];
  const changed =
    (t.reconciled ?? 0) + (t.recovered ?? 0) + (t.cleanupStamped ?? 0) + (t.pruned ?? 0) + (f.reconciled ?? 0) + (f.pruned ?? 0) + (s.pruned ?? 0);
  if (t.reconciled) parts.push(`${t.reconciled} reconciled`);
  if (t.recovered) parts.push(`${t.recovered} recovered`);
  if (t.cleanupStamped) parts.push(`${t.cleanupStamped} cleaned`);
  if (t.pruned) parts.push(`${t.pruned} tasks pruned`);
  if (f.pruned) parts.push(`${f.pruned} flows pruned`);
  if (s.pruned) parts.push(`${s.pruned} sessions pruned`);
  if (changed === 0) return "Everything is tidy — nothing to reconcile or prune.";
  return parts.join(" · ");
}

/** Relative "3m ago" style time. */
export function relativeTime(ms: number | undefined): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
