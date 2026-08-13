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
  taskSummary?: Record<string, number> | string;
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
