import { NextRequest, NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";

export const dynamic = "force-dynamic";

type CronJob = {
  id: string;
  agentId?: string;
  name: string;
  enabled: boolean;
  description?: string;
  createdAtMs?: number;
  updatedAtMs?: number;
  deleteAfterRun?: boolean;
  schedule: { kind: string; expr?: string; everyMs?: number; tz?: string };
  payload: {
    kind: string;
    message?: string;
    text?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    lightContext?: boolean;
  };
  delivery: { mode: string; channel?: string; to?: string; accountId?: string; bestEffort?: boolean };
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastRunStatus?: string;
    lastDurationMs?: number;
    consecutiveErrors?: number;
    lastError?: string;
  };
  sessionTarget?: string;
  sessionKey?: string | null;
  wakeMode?: string;
};

type CronList = { jobs: CronJob[] };

type CronRunEntry = {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  durationMs?: number;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  nextRunAtMs?: number;
};

type GatewayMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  [k: string]: unknown;
};

type CronRunsResult = {
  entries?: CronRunEntry[];
};

type CronRunResult = {
  ok?: boolean;
  ran?: boolean;
  alreadyRunning?: boolean;
};

type DeliveryMode = "announce" | "webhook" | "none";

function formatChatHistoryAsText(messages: GatewayMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const role = (msg.role || "unknown").toLowerCase();
    const parts = Array.isArray(msg.content)
      ? (msg.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c?.type === "text" && typeof c.text === "string")
          .map((c) => (c as { text: string }).text)
      : [];
    const text = parts.join("\n").trim();
    if (!text) continue;
    const label = role === "user" ? "User" : role === "assistant" ? "Assistant" : role;
    lines.push(`[${label}]`);
    lines.push(text);
    lines.push("");
  }
  return lines.join("\n").trim();
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeDeliveryMode(value: unknown): DeliveryMode | null {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "announce" || mode === "webhook" || mode === "none") {
    return mode;
  }
  return null;
}

function isValidWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function buildDeliveryConfig(
  params: Record<string, unknown>,
  current?: CronJob["delivery"],
): CronJob["delivery"] {
  const deliveryMode =
    normalizeDeliveryMode(params.deliveryMode) ??
    (params.announce === true
      ? "announce"
      : params.announce === false
        ? "none"
        : normalizeDeliveryMode(current?.mode) ?? "none");

  if (deliveryMode === "none") {
    return { mode: "none" };
  }

  const rawTo = hasOwn(params, "to")
    ? String(params.to || "").trim()
    : String(current?.to || "").trim();
  const bestEffort = hasOwn(params, "bestEffort")
    ? Boolean(params.bestEffort)
    : Boolean(current?.bestEffort);

  if (deliveryMode === "webhook") {
    if (!rawTo) {
      throw new Error('Webhook delivery requires a target URL in "to".');
    }
    if (!isValidWebhookUrl(rawTo)) {
      throw new Error("Webhook delivery URL must start with http:// or https://");
    }
    return {
      mode: "webhook",
      to: rawTo,
      ...(bestEffort ? { bestEffort: true } : {}),
    };
  }

  const rawChannel = hasOwn(params, "channel")
    ? String(params.channel || "").trim()
    : String(current?.channel || "").trim();

  return {
    mode: "announce",
    ...(rawChannel ? { channel: rawChannel } : {}),
    ...(rawTo ? { to: rawTo } : {}),
    ...(bestEffort ? { bestEffort: true } : {}),
  };
}

/**
 * Extract known delivery targets from:
 *   1. Existing cron jobs that already have `delivery.to` set
 *   2. Gateway sessions.list payload (deliveryContext.to and origin.from fields)
 */
async function collectKnownTargets(): Promise<
  { target: string; channel: string; source: string }[]
> {
  const targets: Map<string, { channel: string; source: string }> = new Map();

  // 1. Extract from existing cron jobs
  try {
    const data = await listCronJobs();
    for (const job of data.jobs || []) {
      if (job.delivery?.mode === "announce" && job.delivery?.to) {
        const ch = job.delivery.channel || detectChannel(job.delivery.to);
        targets.set(job.delivery.to, { channel: ch, source: `cron: ${job.name}` });
      }
    }
  } catch {
    /* ignore */
  }

  // 2. Scan gateway session list for delivery targets
  try {
    const data = await gatewayCall<{
      sessions?: Array<{
        key?: string;
        deliveryContext?: { channel?: string; to?: string };
        origin?: { from?: string; to?: string; surface?: string };
      }>;
    }>("sessions.list", undefined, 10000);
    for (const sess of data.sessions || []) {
      const key = String(sess.key || "");
      const agentId = key.startsWith("agent:") ? (key.split(":")[1] || "unknown") : "unknown";
      if (sess.deliveryContext?.to) {
        const to = sess.deliveryContext.to;
        const ch = sess.deliveryContext.channel || detectChannel(to);
        if (!targets.has(to)) {
          targets.set(to, { channel: ch, source: `session (${agentId})` });
        }
      }
      if (sess.origin?.from && sess.origin.from !== sess.deliveryContext?.to) {
        const from = sess.origin.from;
        const ch = sess.origin.surface || detectChannel(from);
        if (!targets.has(from)) {
          targets.set(from, { channel: ch, source: `session (${agentId})` });
        }
      }
    }
  } catch {
    /* ignore */
  }

  return Array.from(targets.entries())
    .map(([target, info]) => ({
      target,
      channel: info.channel,
      source: info.source,
    }))
    .sort((a, b) => {
      const left = `${a.channel}\u0000${a.target}`.toLowerCase();
      const right = `${b.channel}\u0000${b.target}`.toLowerCase();
      return left.localeCompare(right);
    });
}

function detectChannel(to: string): string {
  if (to.startsWith("telegram:")) return "telegram";
  if (to.startsWith("discord:")) return "discord";
  if (to.startsWith("slack:")) return "slack";
  if (to.startsWith("webchat:")) return "webchat";
  if (to.startsWith("web:")) return "web";
  if (to.startsWith("signal:")) return "signal";
  if (to.startsWith("+")) return "whatsapp";
  return "";
}

function parseEveryInterval(value: string): number {
  const raw = value.trim().toLowerCase();
  if (!raw) {
    throw new Error("interval is required");
  }

  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }

  const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!match) {
    throw new Error(`Unsupported interval: ${value}`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid interval: ${value}`);
  }

  switch (unit) {
    case "ms":
      return Math.round(amount);
    case "s":
      return Math.round(amount * 1000);
    case "m":
    case "min":
    case "mins":
    case "minute":
    case "minutes":
      return Math.round(amount * 60_000);
    case "h":
    case "hr":
    case "hrs":
    case "hour":
    case "hours":
      return Math.round(amount * 3_600_000);
    case "d":
    case "day":
    case "days":
      return Math.round(amount * 86_400_000);
    default:
      throw new Error(`Unsupported interval: ${value}`);
  }
}

function normalizeAtTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid time: ${value}`);
  }
  return parsed.toISOString();
}

async function listCronJobs(): Promise<CronList> {
  return gatewayCall<CronList>("cron.list", {}, 10000);
}

function isSystemManagedCronJob(job: CronJob): boolean {
  const name = String(job.name || "").trim().toLowerCase();
  const description = String(job.description || "").trim().toLowerCase();
  return name.startsWith("mc-") && description.includes("mission control system-managed usage job");
}

function filterUserVisibleCronJobs(data: CronList): CronList {
  return {
    jobs: (data.jobs || []).filter((job) => !isSystemManagedCronJob(job)),
  };
}

async function getCronJobById(id: string): Promise<CronJob | null> {
  const data = await listCronJobs();
  return (data.jobs || []).find((job) => job.id === id) || null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action");
  const jobId = searchParams.get("id");

  try {
    if (action === "runs" && jobId) {
      // Get run history for a specific job
      const limit = searchParams.get("limit") || "10";
      const data = await gatewayCall<CronRunsResult>(
        "cron.runs",
        {
          scope: "job",
          id: jobId,
          limit: Number(limit),
        },
        10000,
      );
      return NextResponse.json({ entries: Array.isArray(data.entries) ? data.entries : [] });
    }

    // Get the actual session output (agent transcript) for the latest run of a job
    if (action === "runOutput" && jobId) {
      const limit = searchParams.get("limit") || "5";
      const data = await gatewayCall<CronRunsResult>(
        "cron.runs",
        {
          scope: "job",
          id: jobId,
          limit: Number(limit),
        },
        10000,
      );
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const latestWithSession = entries.find((e) => e.sessionKey);
      if (!latestWithSession?.sessionKey) {
        return NextResponse.json({ output: "" });
      }
      try {
        const history = await gatewayCall<{ messages?: GatewayMessage[] }>(
          "chat.history",
          { sessionKey: latestWithSession.sessionKey, limit: 200 },
          15000
        );
        const messages = history.messages ?? [];
        const output = formatChatHistoryAsText(messages);
        return NextResponse.json({ output });
      } catch {
        return NextResponse.json({ output: "" });
      }
    }

    if (action === "targets") {
      // Collect known delivery targets from sessions + existing cron jobs
      const targets = await collectKnownTargets();
      return NextResponse.json({ targets });
    }

    // Default: list all jobs
    const data = await listCronJobs();
    return NextResponse.json(filterUserVisibleCronJobs(data));
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    console.error("Cron GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, id, ...params } = body as {
      action: string;
      id: string;
      [key: string]: unknown;
    };

    if (!action) {
      return NextResponse.json({ error: "action required" }, { status: 400 });
    }

    switch (action) {
      case "enable": {
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
        await gatewayCall("cron.update", { id, patch: { enabled: true } }, 15000);
        return NextResponse.json({ ok: true, action: "enabled", id });
      }

      case "disable": {
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
        await gatewayCall("cron.update", { id, patch: { enabled: false } }, 15000);
        return NextResponse.json({ ok: true, action: "disabled", id });
      }

      case "run": {
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
        const result = await gatewayCall<CronRunResult>(
          "cron.run",
          { id, mode: "force" },
          30000,
        );
        const ok = result.ok !== false;
        const output = ok
          ? "Run requested. Waiting for transcript..."
          : "Cron run request failed.";
        return NextResponse.json({
          ok,
          action: ok ? "triggered" : "failed",
          id,
          output,
          ...(ok ? {} : { error: output }),
        });
      }

      case "delete": {
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
        await gatewayCall("cron.remove", { id }, 15000);
        return NextResponse.json({ ok: true, action: "deleted", id });
      }

      case "edit": {
        if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
        const current = await getCronJobById(id);
        if (!current) {
          return NextResponse.json({ error: `job not found: ${id}` }, { status: 404 });
        }

        const patch: Record<string, unknown> = {};

        if (params.name !== undefined) patch.name = String(params.name);
        if (params.agentId !== undefined) patch.agentId = String(params.agentId);

        let nextPayload: CronJob["payload"] | null = null;
        if (params.message !== undefined || params.model !== undefined) {
          nextPayload = { ...current.payload };
          if (params.message !== undefined) {
            if (nextPayload.kind === "systemEvent") nextPayload.text = String(params.message);
            else nextPayload.message = String(params.message);
          }
          if (params.model !== undefined) nextPayload.model = String(params.model);
        }
        if (nextPayload) patch.payload = nextPayload;

        if (params.cron !== undefined) {
          patch.schedule = {
            kind: "cron",
            expr: String(params.cron),
            ...(params.tz !== undefined
              ? { tz: String(params.tz) }
              : current.schedule.tz
                ? { tz: current.schedule.tz }
                : {}),
          };
        } else if (params.every !== undefined) {
          patch.schedule = {
            kind: "every",
            everyMs: parseEveryInterval(String(params.every)),
          };
        } else if (params.tz !== undefined && current.schedule.kind === "cron" && current.schedule.expr) {
          patch.schedule = {
            kind: "cron",
            expr: current.schedule.expr,
            tz: String(params.tz),
          };
        }

        if (
          hasOwn(params, "deliveryMode") ||
          hasOwn(params, "announce") ||
          hasOwn(params, "channel") ||
          hasOwn(params, "to") ||
          hasOwn(params, "bestEffort")
        ) {
          patch.delivery = buildDeliveryConfig(params, current.delivery);
        }

        await gatewayCall("cron.update", { id, patch }, 10000);
        return NextResponse.json({ ok: true, action: "edited", id });
      }

      case "create": {
        if (!params.name) return NextResponse.json({ error: "name is required" }, { status: 400 });

        let schedule: Record<string, unknown>;
        if (params.scheduleKind === "cron") {
          if (!params.cronExpr) {
            return NextResponse.json({ error: "cron expression is required" }, { status: 400 });
          }
          schedule = {
            kind: "cron",
            expr: String(params.cronExpr),
            ...(params.tz ? { tz: String(params.tz) } : {}),
          };
        } else if (params.scheduleKind === "every") {
          if (!params.everyInterval) {
            return NextResponse.json({ error: "interval is required" }, { status: 400 });
          }
          schedule = {
            kind: "every",
            everyMs: parseEveryInterval(String(params.everyInterval)),
          };
        } else if (params.scheduleKind === "at") {
          if (!params.atTime) {
            return NextResponse.json({ error: "time is required" }, { status: 400 });
          }
          schedule = {
            kind: "at",
            at: normalizeAtTime(String(params.atTime)),
          };
        } else {
          return NextResponse.json({ error: "scheduleKind must be cron, every, or at" }, { status: 400 });
        }

        let payload: Record<string, unknown>;
        if (params.payloadKind === "systemEvent") {
          payload = {
            kind: "systemEvent",
            text: String(params.message || ""),
          };
        } else {
          payload = {
            kind: "agentTurn",
            message: String(params.message || ""),
            ...(params.model ? { model: String(params.model) } : {}),
            ...(params.thinking ? { thinking: String(params.thinking) } : {}),
          };
        }

        const delivery = buildDeliveryConfig(params);

        const created = await gatewayCall<Record<string, unknown>>(
          "cron.add",
          {
            name: String(params.name),
            ...(params.description ? { description: String(params.description) } : {}),
            ...(params.agent ? { agentId: String(params.agent) } : {}),
            schedule,
            sessionTarget: params.sessionTarget === "isolated" ? "isolated" : "main",
            ...(params.wakeMode ? { wakeMode: String(params.wakeMode) } : {}),
            payload,
            delivery,
            ...(params.scheduleKind === "at" ? { deleteAfterRun: params.deleteAfterRun !== false } : {}),
            enabled: params.disabled === true ? false : true,
          },
          15000,
        );

        const createdId =
          (typeof created.id === "string" && created.id) ||
          (typeof created.jobId === "string" && created.jobId) ||
          null;

        return NextResponse.json({ ok: true, action: "created", id: createdId, raw: created });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    console.error("Cron POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
