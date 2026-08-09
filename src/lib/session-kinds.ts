/**
 * Session-origin classification — the single source of truth for which OpenClaw
 * sessions are user-facing chats.
 *
 * IMPORTANT, verified against a live gateway (OpenClaw 2026.7.1-2): the `kind`
 * field returned by `sessions.list` is the conversation MODE — it reads
 * "direct" for every session, including cron and subagent ones. It is NOT the
 * session type. The origin lives in the third segment of the session key:
 *
 *     agent:<agentId>:<origin>:<id>
 *            ^^^^^^^^  ^^^^^^^^
 *            segment 2  segment 3
 *
 * Filtering on segment 2 (the agent) while ignoring segment 3 is how a chat
 * session browser ends up listing cron runs, subagent scratch sessions, and —
 * worst of all — private channel transcripts.
 *
 * Observed origins on a working install:
 *   openresponses (dashboard chats), main, mission-control (internal),
 *   cron (scheduled jobs), subagent (spawned helpers), telegram/... (channels)
 * Only the first group belongs in a chat picker.
 */

/** Kinds that represent a conversation the dashboard user actually had here. */
export const CHAT_SESSION_KINDS = new Set(["openresponses", "main"]);

/**
 * Kinds a dashboard user may open explicitly (e.g. from the Sessions page),
 * but which must never be offered as "your chats". Channel transcripts
 * (telegram, whatsapp, ...) are deliberately absent: they are private
 * conversations that happen to share the agent, and surfacing them in the
 * dashboard is a disclosure the user never asked for.
 */
export const INSPECTABLE_SESSION_KINDS = new Set([
  ...CHAT_SESSION_KINDS,
  "mission-control",
  "cron",
  "subagent",
]);

export type SessionKindInfo = {
  kind: string;
  /** Belongs in the chat session picker. */
  isChat: boolean;
  /** May be read through the history API at all. */
  isInspectable: boolean;
  /** Human label for UI grouping. */
  label: string;
};

const KIND_LABELS: Record<string, string> = {
  openresponses: "Chat",
  main: "Chat",
  "mission-control": "Mission Control",
  cron: "Scheduled job",
  subagent: "Subagent",
};

/**
 * Derive the session origin from its key. The key is authoritative — the
 * record's `kind` field is the conversation mode ("direct"/"group") and must
 * not be used for this. Returns "" when the key has an unexpected shape, which
 * classifies as not-inspectable (fail closed).
 */
export function sessionKindOf(session: { kind?: string; key?: string }): string {
  const parts = (session.key ?? "").split(":");
  // agent:<agentId>:<origin>:<id>
  return parts[0] === "agent" && parts.length >= 4 ? parts[2] : "";
}

export function classifySessionKind(kind: string): SessionKindInfo {
  return {
    kind,
    isChat: CHAT_SESSION_KINDS.has(kind),
    isInspectable: INSPECTABLE_SESSION_KINDS.has(kind),
    label: KIND_LABELS[kind] ?? (kind ? `Channel: ${kind}` : "Unknown"),
  };
}

/** Agent id embedded in a session key, or null when the shape is unexpected. */
export function sessionAgentIdOf(session: { key?: string }): string | null {
  const parts = (session.key ?? "").split(":");
  return parts[0] === "agent" && parts[1] ? parts[1] : null;
}

/**
 * Best display title for a session row: the gateway's own label wins, then
 * displayName, and only as a last resort a generic kind label. Never invent a
 * title from the raw uuid — that is what made the old UI unreadable.
 */
export function sessionTitleOf(session: {
  label?: string;
  displayName?: string;
  kind?: string;
  key?: string;
}): string {
  const explicit = session.label?.trim() || session.displayName?.trim();
  if (explicit) return explicit;
  return classifySessionKind(sessionKindOf(session)).label;
}
