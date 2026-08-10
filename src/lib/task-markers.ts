/**
 * The card protocol: how a dispatched agent tells the board what happened.
 *
 * The gateway offers no structured way to distinguish "I finished" from "I need
 * to ask you something". Verified against a live gateway: a question and a
 * success are byte-identical in `task.status`, `terminalSummary`,
 * `agent.wait.status`, `lifecycle.aborted`, `stopReason` and `session.status`.
 * Both are simply a run that ended normally.
 *
 * So we ask the agent to say which one it was. The prompt below is appended to
 * every dispatch, and the classifier reads the answer back. When the marker is
 * present the board can move a card with confidence; when it is absent we say so
 * rather than guessing, because a heuristic ("the text ends with a question
 * mark") strands cards in Review on every rhetorical flourish.
 */

/** Appended verbatim to every dispatched prompt. */
export const CARD_PROTOCOL_INSTRUCTIONS = `---
You are working a card on a Kanban board. If you need information from the user,
STOP and end your turn with a line starting exactly with \`NEEDS_INPUT:\` followed by
your question. If you finished the work, end your turn with a line starting exactly
with \`DONE:\` followed by a one-line summary. Emit exactly one of these markers as the
LAST line. Asking is a valid outcome — do not guess.`;

const NEEDS_INPUT_RE = /^NEEDS_INPUT:\s*(.+)$/m;
const DONE_RE = /^DONE:\s*(.+)$/m;

/**
 * What the run's final text turned out to mean.
 *
 * `confidence` is part of the contract, not a diagnostic: the UI must be able to
 * say "the agent asked this" differently from "we think it might be asking".
 */
export type MarkerVerdict =
  | { kind: "question"; confidence: "high"; question: string; text: string }
  | { kind: "done"; confidence: "high"; summary: string; text: string }
  | { kind: "unknown"; confidence: "low"; text: string };

export function classifyFinalText(raw: string | null | undefined): MarkerVerdict {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "unknown", confidence: "low", text: "" };

  /*
   * The protocol asks for exactly one marker, as the LAST line — so the LAST
   * marker in the text is the verdict, not the first one found anywhere.
   *
   * Matching anywhere let a mid-text mention beat the real outcome: an agent
   * that narrates the instructions it was given ("...end with `DONE: <one-line
   * summary>`") and then asks its question in prose would be read as finished,
   * and the card would land in Done carrying an unanswered question.
   */
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];

    const asked = NEEDS_INPUT_RE.exec(line);
    if (asked) {
      return { kind: "question", confidence: "high", question: asked[1].trim(), text };
    }

    const done = DONE_RE.exec(line);
    if (done) {
      return { kind: "done", confidence: "high", summary: done[1].trim(), text };
    }
  }

  return { kind: "unknown", confidence: "low", text };
}

/**
 * Build the message sent to the agent for a card.
 *
 * Everything the card knows goes in — a run that has to infer the task from a
 * bare title is exactly the run that ends up guessing.
 */
export function buildCardPrompt(input: {
  title: string;
  description?: string;
  priority?: string;
  column?: string;
  columnTitle?: string;
  attachments?: string[];
  /** Free-form extra context the user typed in the dispatch dialog. */
  context?: string;
}): string {
  const lines: string[] = [`Card: ${input.title}`];

  if (input.description?.trim()) {
    lines.push("", input.description.trim());
  }

  const facts: string[] = [];
  if (input.columnTitle || input.column) {
    facts.push(`Column: ${input.columnTitle || input.column}`);
  }
  if (input.priority) facts.push(`Priority: ${input.priority}`);
  if (input.attachments?.length) {
    facts.push(`Attachments: ${input.attachments.join(", ")}`);
  }
  if (facts.length) lines.push("", ...facts);

  if (input.context?.trim()) {
    lines.push("", "Extra context from the user:", input.context.trim());
  }

  lines.push("", CARD_PROTOCOL_INSTRUCTIONS);
  return lines.join("\n");
}

/**
 * The message sent when the user answers a question.
 *
 * The protocol block is repeated because the agent must be able to ask a second
 * time — a follow-up question is not a failure either.
 */
export function buildAnswerPrompt(answer: string, question?: string): string {
  const lines: string[] = [];
  if (question?.trim()) {
    lines.push(`You asked: ${question.trim()}`, "");
  }
  lines.push(`The user answered: ${answer.trim()}`, "", "Continue the card.");
  lines.push("", CARD_PROTOCOL_INSTRUCTIONS);
  return lines.join("\n");
}
