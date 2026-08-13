/**
 * Commitments — SERVER-ONLY. Wraps `openclaw commitments` + `message send`.
 */

import { gatewayCall, runCli, runCliJson, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import type { Commitment, CommitmentsResult } from "./commitments-types";

export * from "./commitments-types";

export async function listCommitments(status = "pending"): Promise<CommitmentsResult> {
  const raw = await runCliJson<CommitmentsResult>(["commitments", "list", "--status", status], 20_000);
  if (!raw || !Array.isArray(raw.commitments)) return { count: 0, status, commitments: [] };
  return raw;
}

export async function dismissCommitments(ids: string[]): Promise<void> {
  const clean = ids.map((s) => String(s).trim()).filter(Boolean);
  if (clean.length === 0) throw new Error("At least one commitment id is required");
  await runCli(["commitments", "dismiss", ...clean], CONFIG_WRITE_TIMEOUT_MS);
}

/**
 * Resolve a commitment IN Mission Control: deliver the user's answer into the
 * agent's own session (chat.send, the same admission path awareness uses to
 * resume), so the agent actually learns the outcome and can act on it — then
 * drop the open loop. No bouncing the user to another app.
 */
export async function answerCommitment(
  commitment: Commitment,
  answer: string,
): Promise<{ delivered: boolean }> {
  const text = String(answer || "").trim();
  if (!text) throw new Error("An answer is required");
  const sessionKey = commitment.sessionKey;
  if (!sessionKey) throw new Error("This commitment has no session to answer into");
  const context = commitment.suggestedText ? `Following up on “${commitment.suggestedText}”: ` : "";
  await gatewayCall(
    "chat.send",
    {
      sessionKey,
      message: `${context}${text}`,
      idempotencyKey: `commitment-answer-${commitment.id}`,
    },
    20_000,
  );
  await dismissCommitments([commitment.id]).catch(() => {});
  return { delivered: true };
}

/**
 * Send a commitment's suggested nudge back over its channel. Outward action —
 * the API only calls this on an explicit user request. `dryRun` renders the
 * payload without sending.
 */
export async function sendNudge(commitment: Commitment, dryRun = false): Promise<{ sent: boolean; output: string }> {
  const target = commitment.to || commitment.senderId;
  const text = commitment.suggestedText;
  if (!commitment.channel) throw new Error("Commitment has no channel to send on");
  if (!target) throw new Error("Commitment has no recipient");
  if (!text) throw new Error("Commitment has no suggested text");
  const args = ["message", "send", "--channel", commitment.channel, "--target", target, "--message", text];
  if (commitment.accountId) args.push("--account", commitment.accountId);
  if (dryRun) args.push("--dry-run");
  const output = await runCli(args, CONFIG_WRITE_TIMEOUT_MS);
  return { sent: !dryRun, output };
}
