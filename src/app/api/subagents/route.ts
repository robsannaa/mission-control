import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { getDefaultAgentId } from "@/lib/paths";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { subagentsGetQuerySchema, subagentsPostSchema } from "@/lib/schemas/automation";

type GatewayMessage = {
  role?: string;
  content?: Array<{ type?: string; text?: string; [k: string]: unknown }>;
  toolName?: string;
  timestamp?: number;
};

type ChatHistoryResult = {
  sessionKey?: string;
  messages?: GatewayMessage[];
};

type AgentAccepted = {
  runId?: string;
  status?: string;
  acceptedAt?: number;
};

type SpawnAccepted = {
  status?: string;
  childSessionKey?: string;
  runId?: string;
  note?: string;
  modelApplied?: boolean;
  label?: string;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function sanitizeArg(value: unknown, maxLen = 2000): string {
  return String(value ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, maxLen);
}

function quoteForSlash(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function extractText(msg: GatewayMessage): string {
  const chunks = Array.isArray(msg.content) ? msg.content : [];
  return chunks
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

function parseToolResultJson(msg: GatewayMessage): unknown {
  if (msg.role !== "toolResult") return null;
  const txt = extractText(msg);
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null;
  }
}

function maybeSpawnAccepted(v: unknown): SpawnAccepted | null {
  const rec = asRecord(v);
  if (String(rec.status || "").toLowerCase() !== "accepted") return null;
  if (!rec.childSessionKey && !rec.runId) return null;
  return {
    status: String(rec.status || "accepted"),
    childSessionKey: rec.childSessionKey ? String(rec.childSessionKey) : undefined,
    runId: rec.runId ? String(rec.runId) : undefined,
    note: rec.note ? String(rec.note) : undefined,
    modelApplied:
      typeof rec.modelApplied === "boolean" ? (rec.modelApplied as boolean) : undefined,
    label: rec.label ? String(rec.label) : undefined,
  };
}

function isSpawnCommand(message: string): boolean {
  return message.trim().toLowerCase().startsWith("/subagents spawn ");
}

async function runAgentMessage(params: {
  agentId: string;
  message: string;
  sessionKey: string;
  thinking?: string;
  timeoutSeconds?: number;
  waitTimeoutMs?: number;
  agentParams?: Record<string, unknown>;
}) {
  const idempotencyKey = crypto.randomUUID();
  const timeoutSeconds = Number.isFinite(params.timeoutSeconds)
    ? Math.max(10, Math.min(3600, Math.trunc(params.timeoutSeconds as number)))
    : undefined;
  const waitTimeoutMs = Number.isFinite(params.waitTimeoutMs)
    ? Math.max(5000, Math.min(600000, Math.trunc(params.waitTimeoutMs as number)))
    : 90000;

  const agentExtra = asRecord(params.agentParams);
  const extraTimeout = Number(agentExtra.timeout);
  const resolvedTimeout = timeoutSeconds ?? (Number.isFinite(extraTimeout) ? Math.trunc(extraTimeout) : undefined);

  const accepted = await gatewayCall<AgentAccepted>(
    "agent",
    {
      ...agentExtra,
      agentId: params.agentId,
      message: params.message,
      sessionKey: params.sessionKey,
      thinking: params.thinking,
      timeout: resolvedTimeout,
      idempotencyKey,
      label: "mission-control-subagents",
      inputProvenance: {
        kind: "external_user",
        sourceChannel: "web",
        sourceTool: "mission-control",
      },
    },
    waitTimeoutMs + 10000
  );

  const runId = String(accepted?.runId || idempotencyKey);

  let wait: Record<string, unknown> | null = null;
  let waitError: string | null = null;
  try {
    wait = await gatewayCall<Record<string, unknown>>(
      "agent.wait",
      { runId, timeoutMs: waitTimeoutMs },
      waitTimeoutMs + 10000
    );
  } catch (err) {
    waitError = err instanceof Error ? err.message : String(err);
  }

  const history = await gatewayCall<ChatHistoryResult>(
    "chat.history",
    { sessionKey: params.sessionKey, limit: 40 },
    20000
  );

  const messages = Array.isArray(history.messages) ? history.messages : [];
  const lastUserIdx = (() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i];
      if (m.role !== "user") continue;
      if (extractText(m) === params.message) return i;
    }
    return -1;
  })();
  const slice = lastUserIdx >= 0 ? messages.slice(lastUserIdx) : messages.slice(-10);

  const lastAssistant = [...slice]
    .reverse()
    .find((m) => m.role === "assistant" && extractText(m).length > 0);

  const toolResults = slice
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      toolName: m.toolName || null,
      text: extractText(m),
      parsed: parseToolResultJson(m),
    }));

  const spawnAccepted = isSpawnCommand(params.message)
    ? (() => {
        for (const tr of toolResults) {
          const parsed = maybeSpawnAccepted(tr.parsed);
          if (parsed) return parsed;
        }
        return null;
      })()
    : null;

  const defaultText =
    (lastAssistant ? extractText(lastAssistant) : "") ||
    toolResults.map((t) => t.text).filter(Boolean).join("\n\n") ||
    "No output.";
  const text = spawnAccepted
    ? `Spawn accepted.\nchildSessionKey: ${spawnAccepted.childSessionKey || "n/a"}\nrunId: ${
        spawnAccepted.runId || "n/a"
      }\n${spawnAccepted.note ? `note: ${spawnAccepted.note}` : ""}`.trim()
    : defaultText;

  return {
    ok: true,
    runId,
    accepted,
    wait,
    pending: Boolean(waitError),
    waitError,
    sessionKey: params.sessionKey,
    command: params.message,
    assistantText: lastAssistant ? extractText(lastAssistant) : "",
    spawnAccepted,
    toolResults,
    messages: slice,
    text,
  };
}

function defaultSessionKey(agentId: string): string {
  return `agent:${agentId}:subagents:mission-control`;
}

export const GET = withRoute(
  { name: "/api/subagents", querySchema: subagentsGetQuerySchema },
  async (request, ctx) => {
  try {
    // "main" is a mainKey alias rather than an agent id — the CLI accepts it and
    // silently targets a workspace inside the real one — so resolve the default.
    const agentId = sanitizeArg(
      ctx.query.agentId || (await getDefaultAgentId()) || "main",
      64,
    );
    const sessionKey = sanitizeArg(ctx.query.sessionKey || defaultSessionKey(agentId), 200);
    const out = await runAgentMessage({
      agentId,
      sessionKey,
      message: "/subagents list",
      thinking: "minimal",
      waitTimeoutMs: 90000,
    });
    return NextResponse.json(out);
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Subagents GET error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);

export const POST = withRoute(
  { name: "/api/subagents", bodySchema: subagentsPostSchema },
  async (request, ctx) => {
  try {
    const body = ctx.body as Record<string, unknown>;
    const action = sanitizeArg(body?.action, 24).toLowerCase();
    const agentId = sanitizeArg(body?.agentId || (await getDefaultAgentId()) || "main", 64);
    const sessionKey = sanitizeArg(body?.sessionKey || defaultSessionKey(agentId), 200);
    const waitTimeoutMs = Number(body?.waitTimeoutMs || 120000);
    const thinking = sanitizeArg(body?.thinking || "minimal", 16);
    const timeoutSeconds = body?.timeoutSeconds ? Number(body.timeoutSeconds) : undefined;
    const agentParams = asRecord(body?.agentParams);

    let command = "";

    if (action === "list") {
      command = "/subagents list";
    } else if (action === "spawn") {
      const spawnAgentId = sanitizeArg(body?.spawnAgentId || body?.target, 64);
      const task = sanitizeArg(body?.task || body?.prompt, 1500);
      if (!spawnAgentId || !task) {
        return badRequest("spawnAgentId and task are required");
      }

      const model = sanitizeArg(body?.model, 200);
      const spawnThinking = sanitizeArg(body?.spawnThinking, 16);
      const runTimeoutSeconds = Number(body?.runTimeoutSeconds || 0);
      const cleanup = Boolean(body?.cleanup);
      const label = sanitizeArg(body?.label, 180);

      command = `/subagents spawn ${spawnAgentId} ${quoteForSlash(task)}`;
      if (model) command += ` --model ${quoteForSlash(model)}`;
      if (spawnThinking) command += ` --thinking ${spawnThinking}`;
      if (Number.isFinite(runTimeoutSeconds) && runTimeoutSeconds > 0) {
        command += ` --run-timeout-seconds ${Math.trunc(runTimeoutSeconds)}`;
      }
      if (cleanup) command += " --cleanup";
      if (label) command += ` --label ${quoteForSlash(label)}`;
    } else if (action === "kill") {
      const target = sanitizeArg(body?.target, 128);
      if (!target) return badRequest("target is required");
      command = `/subagents kill ${target}`;
    } else if (action === "info") {
      const target = sanitizeArg(body?.target, 128);
      command = target ? `/subagents info ${target}` : "/subagents info";
    } else if (action === "log") {
      const target = sanitizeArg(body?.target, 128);
      if (!target) return badRequest("target is required");
      const limit = Number(body?.limit || 0);
      const includeTools = Boolean(body?.includeTools);
      command = `/subagents log ${target}`;
      if (Number.isFinite(limit) && limit > 0) command += ` ${Math.trunc(limit)}`;
      if (includeTools) command += " tools";
    } else if (action === "steer") {
      const target = sanitizeArg(body?.target, 128);
      const prompt = sanitizeArg(body?.prompt, 1500);
      if (!target || !prompt) {
        return badRequest("target and prompt are required");
      }
      command = `/subagents steer ${target} ${quoteForSlash(prompt)}`;
    } else if (action === "send") {
      const target = sanitizeArg(body?.target, 128);
      const prompt = sanitizeArg(body?.prompt, 1500);
      if (!target || !prompt) {
        return badRequest("target and prompt are required");
      }
      command = `/subagents send ${target} ${quoteForSlash(prompt)}`;
    } else if (action === "raw") {
      const raw = sanitizeArg(body?.rawCommand, 1800);
      if (!raw.startsWith("/subagents")) {
        return badRequest("rawCommand must start with /subagents");
      }
      command = raw;
    } else if (action === "agent-send") {
      const message = sanitizeArg(body?.message, 1800);
      if (!message) {
        return badRequest("message is required");
      }
      command = message;
    } else {
      // The action field stays a loose optional string in the schema (see
      // src/lib/schemas/automation.ts) because this handler case-folds it
      // before comparing — so this branch is the actual guard against an
      // unrecognized action, not a schema-enforced discriminant.
      return badRequest(`Unknown action: ${action}`);
    }

    const out = await runAgentMessage({
      agentId,
      message: command,
      sessionKey,
      thinking,
      timeoutSeconds,
      waitTimeoutMs,
      agentParams: action === "agent-send" ? agentParams : undefined,
    });

    return NextResponse.json(out);
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Subagents POST error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);
