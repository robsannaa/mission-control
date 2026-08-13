import { randomUUID } from "node:crypto";
import { gatewayCall } from "@/lib/openclaw";
import { buildInteractionIdempotencyKey } from "./protocol";
import {
  answerInteraction,
  createInteraction,
  findActiveInteractionsForSource,
  transitionInteraction,
} from "./store";
import type { CreateInteractionInput, InteractionRequest, InteractionResolution } from "./types";

export async function requestClarification(
  input: Omit<CreateInteractionInput, "idempotencyKey"> & { idempotencyKey?: string },
) {
  return createInteraction({
    ...input,
    idempotencyKey:
      input.idempotencyKey || buildInteractionIdempotencyKey(input.source, input.question),
  });
}

export function buildResumePrompt(question: string, answer: string, interactionId?: string): string {
  return [
    `[Mission Control clarification response]`,
    interactionId ? `[Mission Control interaction: ${interactionId}]` : null,
    `You paused and asked: ${question.trim()}`,
    `The user answered: ${answer.trim()}`,
    "Continue the original workflow from its checkpoint. Do not repeat completed work.",
    "If another material uncertainty remains, use the Mission Control awareness protocol again.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Re-enable a cron schedule that was paused for a clarification — but ONLY once
 * the source has no other unresolved question. This is the single, idempotent
 * re-enable path for cron-sourced interactions: safe to call on ANY terminal
 * transition (completed, failed, skipped, cancelled) and it will not un-pause a
 * job whose resumed run has already raised a fresh question. Re-enabling an
 * already-enabled job is a harmless no-op. Fails soft so a gateway hiccup never
 * throws out of an answer/skip flow.
 */
export async function reEnableCronIfSettled(interaction: InteractionRequest): Promise<boolean> {
  const source = interaction.source;
  if (source.kind !== "cron" || !source.id) return false;
  try {
    const active = await findActiveInteractionsForSource(source, interaction.tenantId);
    // A newer question for the same source is still open — keep it paused.
    if (active.some((other) => other.id !== interaction.id)) return false;
    await gatewayCall("cron.update", { id: source.id, patch: { enabled: true } }, 10_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Accept the first response transactionally, then resume the same OpenClaw
 * session when one exists. A failed gateway call leaves the interaction in a
 * visible failed state; the accepted answer itself is never lost. The cron
 * schedule is re-enabled off the terminal transition (see reEnableCronIfSettled),
 * never off `chat.send` admission, so a run that immediately re-asks stays paused.
 */
export async function answerAndResume(input: {
  id: string;
  answer: string;
  tenantId?: string;
  userId?: string;
  channel?: string;
  externalId?: string | null;
}): Promise<InteractionResolution & {
  resumed: boolean;
  scheduleResumed?: boolean;
  runId?: string;
  error?: string;
}> {
  const resolution = await answerInteraction(input);
  if (!resolution.accepted) return { ...resolution, resumed: false };

  const source = resolution.interaction.source;
  if (!source.sessionKey) {
    // No OpenClaw session to resume (e.g. a fire-and-forget cron run). The
    // answer is recorded; still lift any pause so the schedule is not stranded
    // disabled just because there was nothing to resume.
    const scheduleResumed = await reEnableCronIfSettled(resolution.interaction);
    return { ...resolution, resumed: false, scheduleResumed };
  }

  const resuming = await transitionInteraction({
    id: input.id,
    tenantId: input.tenantId,
    status: "resuming",
  });
  const runId = `mc-awareness-${randomUUID()}`;
  try {
    await gatewayCall(
      "chat.send",
      {
        sessionKey: source.sessionKey,
        message: buildResumePrompt(resolution.interaction.question, input.answer, input.id),
        idempotencyKey: runId,
      },
      20_000,
    );
    // chat.send acknowledges admission, not completion. Keep the interaction in
    // `resuming` and DO NOT re-enable the schedule here — that happens off the
    // terminal transition (agent_end → complete → reEnableCronIfSettled), so a
    // resumed run that immediately re-asks does not get un-paused early (H2).
    return {
      ...resolution,
      interaction: resuming,
      resumed: true,
      runId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = await transitionInteraction({
      id: input.id,
      tenantId: input.tenantId,
      status: "failed",
      detail: { error: message },
    });
    // A failed resume is terminal for this pause — lift it so the job recovers
    // rather than staying disabled forever (H1).
    const scheduleResumed = await reEnableCronIfSettled(failed);
    return { ...resolution, interaction: failed, resumed: false, scheduleResumed, error: message };
  }
}
