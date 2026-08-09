/**
 * Session-kind classification — the single source of truth for which OpenClaw
 * sessions are user-facing chats.
 *
 * The gateway's `sessions.list` returns a `kind` field (and `label`,
 * `displayName`, `archived`, `pinned`, `unread`) on every session. Do NOT
 * hand-parse the session key: `agent:<agentId>:<kind>:<id>` is an
 * implementation detail, and treating segment 2 as the whole story is how a
 * chat session browser ends up listing cron runs, subagent scratch sessions,
 * and — worst of all — private channel transcripts.
 *
 * On a typical install the kind distribution looks like:
 *   openresponses (dashboard chats), mission-control (internal), main,
 *   cron (scheduled jobs), subagent (spawned helpers), telegram/discord/... (channels)
 * Only the first group belongs in a chat UI.
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
 * Derive the kind from a session record. Prefers the gateway-provided `kind`
 * field and only falls back to key parsing for older gateways that omit it.
 */
export function sessionKindOf(session: { kind?: string; key?: string }): string {
  if (session.kind) return session.kind;
  const parts = (session.key ?? "").split(":");
  // agent:<agentId>:<kind>:<id>
  return parts.length >= 3 ? parts[2] : "";
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
