import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { PROTOCOL, cronRuntimeIdentityOf, finalEventText, interactionIdOf, questionOf } from "./protocol.js";

const pendingCronPauses = new Map();
const capturedQuestions = new Set();

function missionControlRequest(path, body) {
  const baseUrl = String(process.env.MISSION_CONTROL_URL || "http://127.0.0.1:3100").replace(/\/$/, "");
  const token = String(process.env.MISSION_CONTROL_AWARENESS_TOKEN || "").trim();
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function postQuestion({ question, context, runId, jobId, sessionKey, agentId }) {
  const response = await missionControlRequest("/api/interactions/intake", {
    interaction: {
      tenantId: process.env.MISSION_CONTROL_TENANT_ID || "local",
      userId: process.env.MISSION_CONTROL_USER_ID || "owner",
      agentId: agentId || null,
      kind: "clarification",
      title: "Scheduled work needs your input",
      question,
      context: context.slice(0, 2000) || null,
      reason: "The agent paused this run instead of guessing.",
      source: {
        kind: "cron",
        id: jobId,
        label: "Scheduled task",
        runId: runId || undefined,
        sessionKey: sessionKey || undefined,
        agentId: agentId || undefined,
        href: `/cron?job=${encodeURIComponent(jobId)}`,
      },
      idempotencyKey: `cron:${jobId}:${runId || sessionKey || "run"}:${question.trim().toLowerCase().replace(/\s+/g, " ")}`,
    },
  });
  if (!response.ok) throw new Error(`Mission Control intake returned ${response.status}`);
}

async function postCompletion({ id, runId, success, error }) {
  const response = await missionControlRequest("/api/interactions/intake", {
    action: "complete",
    id,
    runId: runId || undefined,
    success,
    error: error || undefined,
  });
  if (!response.ok) throw new Error(`Mission Control completion returned ${response.status}`);
  return response.json();
}

async function postCronPause(jobId) {
  const response = await missionControlRequest("/api/interactions/intake", {
    action: "pause",
    jobId,
  });
  if (!response.ok) throw new Error(`Mission Control cron pause returned ${response.status}`);
}

async function captureQuestion(event, ctx) {
  if (event?.success === false) return;
  const finalText = finalEventText(event);
  const question = questionOf(finalText);
  if (!question) return;
  const cronIdentity = cronRuntimeIdentityOf(event, ctx);
  const sessionKey = cronIdentity?.sessionKey || "";
  const jobId = String(ctx?.jobId || cronIdentity?.jobId || "").trim();
  // Hooks also run for ordinary chat/model turns. Missing cron identity is not
  // an error and must never become a user-facing warning notification.
  if (!jobId) return;
  const runKey = String(event?.runId || ctx?.runId || sessionKey).trim();
  const captureKey = `${jobId}:${runKey}:${question.trim().toLowerCase().replace(/\s+/g, " ")}`;
  if (capturedQuestions.has(captureKey)) return;
  capturedQuestions.add(captureKey);
  const context = finalText.replace(/\n?NEEDS_INPUT:[^\n]*\s*$/, "").trim();
  try {
    await postQuestion({
      question,
      context,
      runId: String(event?.runId || ctx?.runId || ""),
      jobId,
      sessionKey,
      agentId: String(ctx?.agentId || cronIdentity?.agentId || ""),
    });
    if (runKey) pendingCronPauses.set(runKey, jobId);
  } catch (error) {
    capturedQuestions.delete(captureKey);
    throw error;
  }
}

export default definePluginEntry({
  id: "mission-control-awareness",
  name: "Mission Control Awareness",
  description: "Makes background work pause and ask rather than guess.",
  register(api) {
    api.on("before_prompt_build", async (_event, ctx) => {
      if (!ctx?.jobId) return;
      return { appendSystemContext: PROTOCOL };
    }, { priority: 40 });

    api.on("heartbeat_prompt_contribution", async () => ({ appendContext: PROTOCOL }), { priority: 40 });

    // `lastAssistantMessage` is the authoritative finalized reply for cron
    // harnesses. Some agent_end message arrays omit that final outbound text.
    api.on("before_agent_finalize", captureQuestion, { priority: 40, timeoutMs: 10_000 });

    // Agent harnesses consistently expose the exact generated text here even
    // when their finalization/agent_end message snapshots are incomplete.
    api.on("llm_output", captureQuestion, { priority: 40, timeoutMs: 10_000 });

    api.on("agent_end", async (event, ctx) => {
      const interactionId = interactionIdOf(event?.messages);
      let resumedInteraction = null;
      if (interactionId) {
        const completed = await postCompletion({
          id: interactionId,
          runId: String(event?.runId || ctx?.runId || ""),
          success: event?.success !== false,
          error: String(event?.error || ""),
        });
        resumedInteraction = completed?.interaction || null;
      }
      if (event?.success === false) return;
      const resumedSource = resumedInteraction?.source?.kind === "cron"
        ? resumedInteraction.source
        : null;
      await captureQuestion(event, {
        ...ctx,
        jobId: String(ctx?.jobId || resumedSource?.id || ""),
        sessionKey: String(ctx?.sessionKey || resumedSource?.sessionKey || ""),
        agentId: String(ctx?.agentId || resumedSource?.agentId || ""),
      });
      const runKey = String(event?.runId || ctx?.runId || ctx?.sessionKey || "").trim();
      const pendingJobId = pendingCronPauses.get(runKey);
      if (pendingJobId) {
        try {
          // Pause only after agent_end. Updating the job during finalization can
          // be overwritten when OpenClaw persists the just-finished run state.
          await postCronPause(pendingJobId);
        } finally {
          pendingCronPauses.delete(runKey);
        }
      }
      for (const key of capturedQuestions) {
        if (key.startsWith(`${pendingJobId || ""}:${runKey}:`)) capturedQuestions.delete(key);
      }
    }, { timeoutMs: 10_000 });
  },
});

export { PROTOCOL, cronIdentityOf, cronRuntimeIdentityOf, finalEventText, interactionIdOf, questionOf } from "./protocol.js";
