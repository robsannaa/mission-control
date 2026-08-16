import type { InteractionChoice, InteractionKind, WorkflowSource } from "./types";

export const AWARENESS_PROTOCOL_VERSION = "mc-awareness-v1";
export const NEEDS_INPUT_PREFIX = "NEEDS_INPUT:";

/**
 * Stable guidance for all model-backed background work. This is deliberately
 * independent of any memory implementation: the runtime may expose OpenClaw
 * Memory, G-Brain, both, or neither.
 */
export const AWARENESS_PROTOCOL = `[Mission Control awareness protocol: ${AWARENESS_PROTOCOL_VERSION}]
Work like an attentive assistant. Before asking the user, search the context and memory tools available to you. Do not assume a particular memory provider exists.

If material uncertainty blocks correctness, safety, or a useful result:
1. Finish any independent work that is safe to finish.
2. Do not guess, invent a fact, or commit an uncertain memory.
3. End the turn with exactly one final line beginning \`NEEDS_INPUT:\` followed by one concise, directly answerable question.
4. In the text immediately before that line, briefly say what you were doing, why the answer matters, and what is paused.

If no answer is needed, finish normally. Routine success should be quiet unless the job explicitly asks for a report. Never ask a question merely to appear active.`;

const VERSION_RE = /\[Mission Control awareness protocol:\s*mc-awareness-v\d+\]/i;
const NEEDS_INPUT_RE = /^NEEDS_INPUT:\s*(.+)$/;

export function hasAwarenessProtocol(text: string | null | undefined): boolean {
  return VERSION_RE.test(String(text || ""));
}

export function injectAwarenessProtocol(text: string | null | undefined): string {
  const base = String(text || "").trim();
  if (hasAwarenessProtocol(base)) return base;
  return base ? `${base}\n\n${AWARENESS_PROTOCOL}` : AWARENESS_PROTOCOL;
}

/** Only model-backed payloads have a prompt. Other cron kinds use outcomes. */
export function injectCronPayloadAwareness<T extends { kind?: string; message?: string; text?: string }>(
  payload: T,
): T {
  if (payload.kind !== "agentTurn") return { ...payload };
  return { ...payload, message: injectAwarenessProtocol(payload.message) };
}

export type ParsedAwarenessOutcome =
  | { kind: "needs-input"; question: string }
  | { kind: "complete" };

export function parseAwarenessOutcome(text: string | null | undefined): ParsedAwarenessOutcome {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  // Tolerate trailing blank lines and closing code fences that some model
  // harnesses append after the final content line, so the control line is not
  // missed just because a "```" or an empty line follows it.
  while (lines.length && (!lines[lines.length - 1]!.trim() || /^`{3,}/.test(lines[lines.length - 1]!.trim()))) {
    lines.pop();
  }
  // Strip any stray wrapping backticks the model may have added to the line.
  const last = (lines[lines.length - 1] ?? "").trim().replace(/^`+|`+$/g, "").trim();
  const match = NEEDS_INPUT_RE.exec(last);
  if (match?.[1]?.trim()) return { kind: "needs-input", question: match[1].trim() };
  return { kind: "complete" };
}

export function buildInteractionIdempotencyKey(source: WorkflowSource, question: string): string {
  const run = source.runId || source.sessionKey || "no-run";
  return `${source.kind}:${source.id}:${run}:${normalizeQuestion(question)}`;
}

export function normalizeQuestion(question: string): string {
  return question.trim().replace(/\s+/g, " ").toLowerCase();
}

const QUESTION_STOP_WORDS = new Set([
  "the", "this", "that", "which", "who", "what", "when", "where", "why", "how",
  "your", "you", "our", "their", "from", "with", "into", "onto", "about", "before",
  "after", "there", "another", "please", "tell", "share", "does", "did", "has", "have",
  "is", "are", "was", "were", "can", "could", "should", "would", "will", "and", "or",
  "for", "not", "but", "then", "than", "its", "it's", "i", "me", "my", "a", "an",
  "to", "of", "on", "in", "it",
]);

function meaningfulQuestionTokens(question: string): Set<string> {
  const words = normalizeQuestion(question).match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter((word) => word.length > 2 && !QUESTION_STOP_WORDS.has(word)));
}

/**
 * Models often rephrase the same blocking question on every scheduled run.
 * Compare meaningful-token containment rather than exact prose so those
 * rewrites do not reopen an interaction the user just resolved.
 */
export function questionsAreSimilar(left: string, right: string): boolean {
  if (normalizeQuestion(left) === normalizeQuestion(right)) return true;
  const leftTokens = meaningfulQuestionTokens(left);
  const rightTokens = meaningfulQuestionTokens(right);
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  if (smaller < 3) return false;
  let shared = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) shared += 1;
  }
  return shared >= 3 && shared / smaller >= 0.5;
}

export function validateQuestion(input: {
  question: string;
  title: string;
  kind?: InteractionKind;
  choices?: InteractionChoice[];
}): string[] {
  const errors: string[] = [];
  // Bug fix 2026-08-16: callers previously sent non-string values (numbers,
  // arrays) or strings containing NUL bytes. `.trim()` blew up with
  // "a.title.trim is not a function" or "a.question.trim is not a function",
  // and NUL bytes made it to `sqlite3` which threw "must be a string without
  // null bytes". Reject those inputs up front with a clear 400-style error.
  if (typeof input.title !== "string") errors.push("title must be a string");
  if (typeof input.question !== "string") errors.push("question must be a string");
  if (typeof input.title === "string" && input.title.includes("\u0000")) {
    errors.push("title must not contain NUL bytes");
  }
  if (typeof input.question === "string" && input.question.includes("\u0000")) {
    errors.push("question must not contain NUL bytes");
  }
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (typeof input.title === "string" && !input.title.trim()) errors.push("title is required");
  if (!question) errors.push("question is required");
  if (question.length > 2000) errors.push("question must be 2000 characters or fewer");
  if (typeof input.title === "string" && input.title.trim().length > 240) errors.push("title must be 240 characters or fewer");
  const ids = new Set<string>();
  for (const choice of input.choices || []) {
    if (typeof choice.id !== "string" || typeof choice.label !== "string" || typeof choice.value !== "string" ||
        !choice.id.trim() || !choice.label.trim() || !choice.value.trim()) {
      errors.push("every choice requires id, label, and value");
      continue;
    }
    if (ids.has(choice.id)) errors.push(`duplicate choice id: ${choice.id}`);
    ids.add(choice.id);
  }
  return errors;
}
