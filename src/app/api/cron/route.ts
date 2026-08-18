import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import { injectCronPayloadAwareness } from "@/lib/awareness/protocol";
import {
  cronRunFailed,
  cronRunOutput,
  selectTriggeredCronRun,
} from "@/lib/cron-run-status";
import { readCronLiveLog } from "@/lib/cron-live-log";
import { buildCronDeliveryConfig } from "@/lib/cron-delivery";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound, serverError } from "@/lib/api-errors";
import { cronGetQuerySchema, cronPostSchema } from "@/lib/schemas/automation";

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
    isRunning?: boolean;
    runningStartedAtMs?: number;
    runningAtMs?: number;
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
  runId?: string;
};

type CronGatewaySession = {
  key?: string;
  hasActiveRun?: boolean;
  startedAt?: number | string;
  updatedAt?: number | string;
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

function epochMs(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return number < 1_000_000_000_000 ? Math.trunc(number * 1000) : Math.trunc(number);
}

function sessionBelongsToCron(session: CronGatewaySession, jobId: string): boolean {
  const key = String(session.key || "");
  return key.includes(`:cron:${jobId}`);
}

async function listCronSessions(): Promise<CronGatewaySession[]> {
  try {
    const data = await gatewayCall<{ sessions?: CronGatewaySession[] }>(
      "sessions.list",
      undefined,
      10000,
    );
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch {
    return [];
  }
}

async function readCronTranscript(sessionKey: string | undefined): Promise<string> {
  if (!sessionKey) return "";
  try {
    const history = await gatewayCall<{ messages?: GatewayMessage[] }>(
      "chat.history",
      { sessionKey, limit: 200 },
      15000,
    );
    return formatChatHistoryAsText(history.messages ?? []);
  } catch {
    return "";
  }
}

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
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
      const left = `${a.channel} ${a.target}`.toLowerCase();
      const right = `${b.channel} ${b.target}`.toLowerCase();
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

export const GET = withRoute(
  { name: "/api/cron", querySchema: cronGetQuerySchema },
  async (request, ctx) => {
    const { action, id: jobId, limit, requestedAt: requestedAtRaw, baselineRunAt: baselineRunAtRaw } = ctx.query;

    try {
      if (action === "runs" && jobId) {
        // Get run history for a specific job
        const data = await gatewayCall<CronRunsResult>(
          "cron.runs",
          {
            scope: "job",
            id: jobId,
            limit: Number(limit || "10"),
          },
          10000,
        );
        return NextResponse.json({ entries: Array.isArray(data.entries) ? data.entries : [] });
      }

      if (action === "runStatus" && jobId) {
        const requestedAtMs = Number(requestedAtRaw || 0);
        const baselineRunAtMs = Number(baselineRunAtRaw || 0);
        if (!Number.isFinite(requestedAtMs) || requestedAtMs <= 0) {
          return badRequest("requestedAt required");
        }

        const [runData, sessions, job] = await Promise.all([
          gatewayCall<CronRunsResult>(
            "cron.runs",
            { scope: "job", id: jobId, limit: 20 },
            10000,
          ),
          listCronSessions(),
          getCronJobById(jobId),
        ]);
        const entries = Array.isArray(runData.entries) ? runData.entries : [];
        const completedRun = selectTriggeredCronRun(entries, requestedAtMs, baselineRunAtMs);
        const cronSessions = sessions.filter((session) => sessionBelongsToCron(session, jobId));
        const activeSession = cronSessions.find((session) => session.hasActiveRun);
        const cronReportsRunning = Boolean(
          job?.state.runningAtMs || job?.state.lastStatus === "running",
        );
        const transcriptKey = activeSession?.key || completedRun?.sessionKey;

        if (completedRun) {
          const failed = cronRunFailed(completedRun);
          const recordedOutput = cronRunOutput(completedRun);
          const transcript = recordedOutput ? "" : await readCronTranscript(transcriptKey);
          return NextResponse.json({
            status: failed ? "error" : "done",
            phase: failed ? "Run failed" : "Run completed",
            output: cronRunOutput(completedRun, transcript),
            sessionKey: completedRun.sessionKey || transcriptKey || null,
            run: completedRun,
          });
        }

        const transcript = await readCronTranscript(activeSession?.key);
        const diagnostics = transcript ? "" : await readCronLiveLog(jobId, requestedAtMs);
        return NextResponse.json({
          status: "running",
          phase: activeSession
            ? "Agent is working"
            : cronReportsRunning
              ? "Job is running"
              : "Waiting for final run update",
          output: transcript || diagnostics,
          sessionKey: transcriptKey || null,
          active: Boolean(activeSession),
        });
      }

      // Get the actual session output (agent transcript) for the latest run of a job
      if (action === "runOutput" && jobId) {
        const data = await gatewayCall<CronRunsResult>(
          "cron.runs",
          {
            scope: "job",
            id: jobId,
            limit: Number(limit || "5"),
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
      const [data, sessions] = await Promise.all([listCronJobs(), listCronSessions()]);
      const activeSessions = sessions.filter((session) => session.hasActiveRun);
      const withLiveState: CronList = {
        jobs: (data.jobs || []).map((job) => {
          const active = activeSessions.find((session) => sessionBelongsToCron(session, job.id));
          if (!active) return job;
          return {
            ...job,
            state: {
              ...job.state,
              isRunning: true,
              runningStartedAtMs: epochMs(active.startedAt) || epochMs(active.updatedAt),
            },
          };
        }),
      };
      return NextResponse.json(filterUserVisibleCronJobs(withLiveState));
    } catch (err) {
      const pairing = pairingRequiredResponse(err);
      if (pairing) return pairing;
      ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Cron GET error");
      return serverError(String(err));
    }
  },
);

export const POST = withRoute(
  { name: "/api/cron", bodySchema: cronPostSchema },
  async (request, ctx) => {
    const { action, id, ...params } = ctx.body as Record<string, unknown> & { action: string; id?: string };

    try {
      switch (action) {
        case "enable": {
          if (!id) return badRequest("id required");
          await gatewayCall("cron.update", { id, patch: { enabled: true } }, 15000);
          return NextResponse.json({ ok: true, action: "enabled", id });
        }

        case "disable": {
          if (!id) return badRequest("id required");
          await gatewayCall("cron.update", { id, patch: { enabled: false } }, 15000);
          return NextResponse.json({ ok: true, action: "disabled", id });
        }

        case "run": {
          if (!id) return badRequest("id required");
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
            requestedAtMs: Date.now(),
            alreadyRunning: Boolean(result.alreadyRunning),
            ...(ok ? {} : { error: output }),
          });
        }

        case "delete": {
          if (!id) return badRequest("id required");
          await gatewayCall("cron.remove", { id }, 15000);
          return NextResponse.json({ ok: true, action: "deleted", id });
        }

        case "edit": {
          if (!id) return badRequest("id required");
          const current = await getCronJobById(id);
          if (!current) {
            return notFound(`job not found: ${id}`);
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

          if (nextPayload?.kind === "agentTurn") {
            patch.payload = injectCronPayloadAwareness(nextPayload);
          }

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
            patch.delivery = buildCronDeliveryConfig(params, current.delivery);
          }

          await gatewayCall("cron.update", { id, patch }, 10000);
          return NextResponse.json({ ok: true, action: "edited", id });
        }

        case "create": {
          if (!params.name) return badRequest("name is required");

          let schedule: Record<string, unknown>;
          if (params.scheduleKind === "cron") {
            if (!params.cronExpr) {
              return badRequest("cron expression is required");
            }
            schedule = {
              kind: "cron",
              expr: String(params.cronExpr),
              ...(params.tz ? { tz: String(params.tz) } : {}),
            };
          } else if (params.scheduleKind === "every") {
            if (!params.everyInterval) {
              return badRequest("interval is required");
            }
            schedule = {
              kind: "every",
              everyMs: parseEveryInterval(String(params.everyInterval)),
            };
          } else if (params.scheduleKind === "at") {
            if (!params.atTime) {
              return badRequest("time is required");
            }
            schedule = {
              kind: "at",
              at: normalizeAtTime(String(params.atTime)),
            };
          } else {
            return badRequest("scheduleKind must be cron, every, or at");
          }

          let payload: Record<string, unknown>;
          if (params.payloadKind === "systemEvent") {
            payload = {
              kind: "systemEvent",
              text: String(params.message || ""),
            };
          } else {
            payload = injectCronPayloadAwareness({
              kind: "agentTurn",
              message: String(params.message || ""),
              ...(params.model ? { model: String(params.model) } : {}),
              ...(params.thinking ? { thinking: String(params.thinking) } : {}),
            });
          }

          const delivery = buildCronDeliveryConfig(params);

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
          // Unreachable in practice — cronPostSchema's discriminated union
          // already rejects any action outside the literal set above.
          return badRequest(`Unknown action: ${action}`);
      }
    } catch (err) {
      const pairing = pairingRequiredResponse(err);
      if (pairing) return pairing;
      ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Cron POST error");
      return serverError(String(err));
    }
  },
);
