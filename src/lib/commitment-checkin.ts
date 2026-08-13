/**
 * Proactive commitment check-in — SERVER-ONLY.
 *
 * Real proactiveness: instead of waiting for the user to open the Commitments
 * tab, a managed cron job periodically runs the agent to review its due
 * follow-ups and MESSAGE the user on their own channel (announce delivery),
 * in the agent's voice — "Hey, how did the interview go?". The user answers
 * back on that channel, or in Mission Control (answer-in-place).
 *
 * The job is identified by a stable name so we can find, toggle, and reschedule
 * the single canonical check-in instead of piling up duplicates.
 */

import { gatewayCall } from "@/lib/openclaw";
import { listCommitments } from "./commitments";

export const CHECKIN_NAME = "Proactive commitment check-in";

const PROMPT = [
  "You are running a proactive check-in for your user — an executive-assistant heartbeat.",
  "",
  "Review your pending follow-up commitments (open loops you offered or promised but never closed).",
  "For any that are due now or overdue, and that you have NOT already followed up on, write ONE short,",
  "warm, natural message to the user checking in — in your own voice, like a thoughtful assistant.",
  'For example: "Hey — how did the HSBC/Tapfin interview go?" or "Did you want me to run the gbrain fix?"',
  "",
  "Rules:",
  "- Only mention items that are genuinely due right now. Never invent or pad.",
  "- One concise message even if several are due (group them naturally).",
  "- Never repeat a check-in you already sent for the same item.",
  "- If nothing is due right now, reply with exactly: NO_NUDGE",
].join("\n");

interface CronJob {
  id: string;
  name?: string;
  enabled?: boolean;
  schedule?: { kind?: string; everyMs?: number; expr?: string };
  delivery?: Record<string, unknown>;
}

export interface CheckinStatus {
  configured: boolean;
  enabled: boolean;
  jobId: string | null;
  everyMs: number | null;
  /** Channel the nudges are delivered to, for display. */
  target: string | null;
}

async function findJob(): Promise<CronJob | null> {
  const res = await gatewayCall<{ jobs?: CronJob[] }>("cron.list", {}, 10_000);
  const jobs = Array.isArray(res?.jobs) ? res.jobs : [];
  return jobs.find((j) => j.name === CHECKIN_NAME) ?? null;
}

export async function getCheckinStatus(): Promise<CheckinStatus> {
  const job = await findJob();
  if (!job) return { configured: false, enabled: false, jobId: null, everyMs: null, target: null };
  const d = job.delivery as { channel?: string; to?: string } | undefined;
  return {
    configured: true,
    enabled: job.enabled !== false,
    jobId: job.id,
    everyMs: job.schedule?.everyMs ?? null,
    target: d?.channel && d?.to ? `${d.channel}:${d.to}` : null,
  };
}

/** Derive an announce-delivery target from the user's pending commitments. */
async function deriveDelivery(): Promise<{ mode: "announce"; channel: string; to: string; bestEffort: true }> {
  const { commitments } = await listCommitments("pending");
  const withChannel = commitments.find((c) => c.channel && (c.senderId || c.to));
  if (!withChannel?.channel) {
    throw new Error(
      "No channel to message you on yet. This turns on once you have a pending commitment from a chat channel.",
    );
  }
  const to = (withChannel.senderId || withChannel.to || "").replace(/^[a-z]+:/i, "").trim();
  if (!to) throw new Error("Could not determine a recipient to message.");
  return { mode: "announce", channel: withChannel.channel, to, bestEffort: true };
}

export async function enableCheckin(everyMs = 60 * 60 * 1000): Promise<CheckinStatus> {
  const existing = await findJob();
  const schedule = { kind: "every", everyMs: Math.max(15 * 60 * 1000, everyMs) };
  if (existing) {
    await gatewayCall("cron.update", { id: existing.id, patch: { enabled: true, schedule } }, 15_000);
  } else {
    const delivery = await deriveDelivery();
    await gatewayCall(
      "cron.add",
      {
        name: CHECKIN_NAME,
        description: "Mission Control: proactively message me about due follow-ups.",
        agentId: "main",
        schedule,
        sessionTarget: "main",
        payload: { kind: "agentTurn", message: PROMPT },
        delivery,
        enabled: true,
      },
      15_000,
    );
  }
  return getCheckinStatus();
}

export async function disableCheckin(): Promise<CheckinStatus> {
  const existing = await findJob();
  if (existing) {
    await gatewayCall("cron.update", { id: existing.id, patch: { enabled: false } }, 15_000);
  }
  return getCheckinStatus();
}
