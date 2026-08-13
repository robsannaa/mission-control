import type { UIMessage } from "ai";
import type { InteractionRequest } from "@/lib/awareness/types";

function message(
  interaction: InteractionRequest,
  role: "user" | "assistant",
  text: string,
  timestamp: number,
): UIMessage {
  return {
    id: `interaction-${interaction.id}-${role}`,
    role,
    parts: [{ type: "text", text }],
    metadata: { timestamp },
  } as UIMessage;
}

function acknowledgement(interaction: InteractionRequest): string | null {
  const source = interaction.source.label || "the background job";

  switch (interaction.status) {
    case "resuming":
      return `Thanks — I have the clarification. I’m continuing ${source} now.`;
    case "completed":
      return `Thanks — I have the clarification. ${source} has finished.`;
    case "failed":
      return `Your answer was saved, but ${source} could not continue.`;
    case "answered":
      return "Your answer was saved, but the original run no longer has a resumable session.";
    default:
      return null;
  }
}

/**
 * A clarification belongs immediately after its question, not in whichever
 * ordinary chat transcript happened to be open when the user answered it.
 * Build stable message rows from the durable interaction record so a refresh
 * preserves both the answer and its chronological position.
 */
export function interactionReplyMessages(
  interaction: InteractionRequest | null,
): UIMessage[] {
  const answer = interaction?.answer?.trim();
  if (!interaction || !answer) return [];

  const timestamp = interaction.answeredAt ?? interaction.updatedAt;
  const rows = [message(interaction, "user", answer, timestamp)];
  const reply = acknowledgement(interaction);
  if (reply) rows.push(message(interaction, "assistant", reply, timestamp + 1));
  return rows;
}
