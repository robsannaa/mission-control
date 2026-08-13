export const VERSION = "mc-awareness-v1";

export const PROTOCOL = `[Mission Control awareness protocol: ${VERSION}]
Work like an attentive assistant. Search whatever context and memory tools are available before asking; do not assume a particular memory provider exists.
If material uncertainty blocks correctness, safety, or usefulness, finish safe independent work, do not guess or commit uncertain memory, and end with exactly one final line: NEEDS_INPUT: followed by one concise question. Immediately before it, explain what is paused and why the answer matters.
If no answer is needed, finish normally. Routine success should be quiet. Never ask merely to appear active.`;

export function textOf(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item.text === "string") return item.text;
      if (item && "content" in item) return textOf(item.content);
      return "";
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object" && "content" in value) return textOf(value.content);
  return "";
}

export function finalAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== "assistant") continue;
    const text = textOf(list[index]).trim();
    if (text) return text;
  }
  return "";
}

/** OpenClaw exposes the finalized reply directly on before_agent_finalize. */
export function finalEventText(event) {
  const direct = typeof event?.lastAssistantMessage === "string"
    ? event.lastAssistantMessage.trim()
    : "";
  if (direct) return direct;
  const assistantTexts = Array.isArray(event?.assistantTexts) ? event.assistantTexts : [];
  for (let index = assistantTexts.length - 1; index >= 0; index -= 1) {
    const text = typeof assistantTexts[index] === "string" ? assistantTexts[index].trim() : "";
    if (text) return text;
  }
  return finalAssistantText(event?.messages);
}

export function questionOf(text) {
  const lines = String(text || "").trim().split(/\r?\n/);
  const last = lines.at(-1)?.trim() || "";
  const match = /^NEEDS_INPUT:\s*(.+)$/.exec(last);
  return match?.[1]?.trim() || null;
}

/**
 * Cron conversation keys are canonical OpenClaw identities:
 * `agent:<agentId>:cron:<jobId>[:run:<runId>]`. Current conversation hooks
 * expose this key consistently even when their separate `jobId` field is
 * omitted; isolated cron turns append their per-run UUID.
 */
export function cronIdentityOf(sessionKey) {
  const match = /^agent:([^:]+):cron:([^:]+)(?::run:[^:]+)?$/.exec(String(sessionKey || "").trim());
  if (!match) return null;
  return { agentId: match[1], jobId: match[2] };
}

/**
 * Hook payloads differ between before_agent_finalize, llm_output, and
 * agent_end. Resolve the canonical cron identity from every supported location
 * instead of allowing an unrelated/empty event field to shadow ctx.sessionKey.
 */
export function cronRuntimeIdentityOf(event, context) {
  const sources = [event, context];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    const candidates = [
      source.sessionKey,
      source.session?.key,
      source.session?.sessionKey,
    ];
    for (const candidate of candidates) {
      const sessionKey = String(candidate || "").trim();
      const identity = cronIdentityOf(sessionKey);
      if (identity) return { ...identity, sessionKey };
    }
  }
  return null;
}

export function interactionIdOf(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.role !== "user") continue;
    const lines = textOf(list[index]).split(/\r?\n/);
    for (const line of lines) {
      const match = /^\[Mission Control interaction:\s*([0-9a-f]{8}-[0-9a-f-]{27})\]$/i.exec(line.trim());
      if (match?.[1]) return match[1];
    }
  }
  return null;
}
