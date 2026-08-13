/**
 * Native OpenClaw tasks — SERVER-ONLY. The single source of truth for the
 * Tasks page. Wraps `openclaw tasks {list,show,cancel,notify}` and
 * `openclaw tasks flow {list,show,cancel}`. There is no kanban store.
 */

import { runCli, runCliJson, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import {
  isActive,
  statusBucket,
  type NativeTask,
  type TaskFlow,
  type TasksSnapshot,
} from "./tasks-native-types";

export * from "./tasks-native-types";

const RECENT_MS = 48 * 60 * 60 * 1000;
const ACTIVE_CAP = 200;

interface RawTaskList {
  count?: number;
  runtime?: string | null;
  status?: string | null;
  tasks?: NativeTask[];
}
interface RawFlowList {
  count?: number;
  status?: string | null;
  flows?: TaskFlow[];
}

async function listTasksRaw(): Promise<NativeTask[]> {
  const raw = await runCliJson<RawTaskList>(["tasks", "list"], 20_000);
  return Array.isArray(raw?.tasks) ? raw.tasks : [];
}

async function listFlowsRaw(): Promise<TaskFlow[]> {
  try {
    const raw = await runCliJson<RawFlowList>(["tasks", "flow", "list"], 20_000);
    return Array.isArray(raw?.flows) ? raw.flows : [];
  } catch {
    return [];
  }
}

/**
 * A snapshot for the Tasks monitor. `scope="active"` (default) keeps running/
 * queued/waiting tasks plus anything that ended recently, so the page isn't
 * flooded by hundreds of old cron runs; `scope="all"` returns everything.
 */
export async function getTasksSnapshot(scope: "active" | "all" = "active"): Promise<TasksSnapshot> {
  const [all, flows] = await Promise.all([listTasksRaw(), listFlowsRaw()]);
  const total = all.length;
  let tasks = all;
  if (scope === "active") {
    const cutoff = Date.now() - RECENT_MS;
    tasks = all
      .filter((t) => {
        if (isActive(statusBucket(t.status))) return true;
        const ended = t.endedAt ?? t.lastEventAt ?? 0;
        return ended >= cutoff;
      })
      .sort(
        (a, b) => (b.lastEventAt ?? b.startedAt ?? b.createdAt ?? 0) - (a.lastEventAt ?? a.startedAt ?? a.createdAt ?? 0),
      )
      .slice(0, ACTIVE_CAP);
  }
  // Only surface flows that still matter (not long-finished) unless scope=all.
  const visibleFlows =
    scope === "all"
      ? flows
      : flows.filter((f) => isActive(statusBucket(f.status)) || (f.endedAt ?? f.updatedAt ?? 0) >= Date.now() - RECENT_MS);

  return { tasks, flows: visibleFlows, count: total };
}

export async function showTask(lookup: string): Promise<NativeTask | null> {
  const id = String(lookup || "").trim();
  if (!id) throw new Error("A task id is required");
  try {
    const raw = await runCliJson<{ task?: NativeTask } | NativeTask>(["tasks", "show", id], 20_000);
    if (raw && typeof raw === "object" && "task" in raw && raw.task) return raw.task as NativeTask;
    return (raw as NativeTask) ?? null;
  } catch {
    return null;
  }
}

export async function showFlow(flowId: string): Promise<TaskFlow | null> {
  const id = String(flowId || "").trim();
  if (!id) throw new Error("A flow id is required");
  try {
    const raw = await runCliJson<{ flow?: TaskFlow } | TaskFlow>(["tasks", "flow", "show", id], 20_000);
    if (raw && typeof raw === "object" && "flow" in raw && raw.flow) return raw.flow as TaskFlow;
    return (raw as TaskFlow) ?? null;
  } catch {
    return null;
  }
}

export async function cancelTask(lookup: string): Promise<void> {
  const id = String(lookup || "").trim();
  if (!id) throw new Error("A task id is required");
  await runCli(["tasks", "cancel", id], CONFIG_WRITE_TIMEOUT_MS);
}

export async function cancelFlow(flowId: string): Promise<void> {
  const id = String(flowId || "").trim();
  if (!id) throw new Error("A flow id is required");
  await runCli(["tasks", "flow", "cancel", id], CONFIG_WRITE_TIMEOUT_MS);
}

const NOTIFY_POLICIES = new Set(["done_only", "state_changes", "silent"]);

export async function setNotify(lookup: string, policy: string): Promise<void> {
  const id = String(lookup || "").trim();
  if (!id) throw new Error("A task id is required");
  if (!NOTIFY_POLICIES.has(policy)) throw new Error("Notify policy must be done_only, state_changes, or silent");
  await runCli(["tasks", "notify", id, policy], CONFIG_WRITE_TIMEOUT_MS);
}
