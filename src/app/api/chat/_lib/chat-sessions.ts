/**
 * Server-side helpers shared by the chat session routes.
 *
 * Everything here is deliberately conservative about which sessions the
 * dashboard is allowed to see or touch: the single source of truth is
 * `src/lib/session-kinds.ts`, so a channel transcript (telegram, whatsapp, ...)
 * can never be listed, renamed, read or deleted from the chat surface.
 */

import { gatewayCall } from "@/lib/openclaw";
import {
  CHAT_SESSION_KINDS,
  classifySessionKind,
  sessionAgentIdOf,
  sessionKindOf,
  sessionTitleOf,
} from "@/lib/session-kinds";

/** Session keys are `agent:<id>:<origin>:<uuid>` — reject anything exotic early. */
export const SESSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

export type GatewaySession = {
  key?: string;
  kind?: string;
  label?: string;
  displayName?: string;
  updatedAt?: number;
  lastActivityAt?: number;
  archived?: boolean;
  pinned?: boolean;
  unread?: boolean;
  sessionId?: string;
  model?: string;
  contextTokens?: number;
  totalTokens?: number;
  hasActiveRun?: boolean;
};

export type ChatSessionRow = {
  key: string;
  sessionId: string | null;
  agentId: string | null;
  title: string;
  /** Where the title came from — the UI shows derived titles in a quieter tone. */
  titleSource: "label" | "derived" | "fallback";
  preview: string | null;
  updatedAt: number;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  hasActiveRun: boolean;
  model: string | null;
  totalTokens: number;
};

/* ── Content normalisation ────────────────────────────────────────────────── */

type ContentBlock = { type?: string; text?: string } | string;

/**
 * `chat.history` returns `content` as a plain string for user turns and as an
 * array of typed blocks for assistant turns (verified live). Anything else is
 * treated as empty rather than stringified — a JSON blob makes a terrible
 * session title.
 */
export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (block && typeof block === "object" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

const MENTION_BLOCK_RE = /\n+Referenced (?:files|agents)[\s\S]*$/i;

/** Turn a raw first message into something readable in a 220px-wide row. */
export function toTitle(raw: string, max = 60): string {
  const cleaned = raw
    .replace(MENTION_BLOCK_RE, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#*_`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  if (cleaned.length <= max) return cleaned;
  const cut = cleaned.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/* ── Derived titles ───────────────────────────────────────────────────────── */

type TitleCacheEntry = { title: string; preview: string | null };

/**
 * On this install every session label is empty, so a naive list renders as a
 * column of uuids and timestamps. Titles are therefore derived from the first
 * user message, and cached per (key, updatedAt) so a poll costs nothing until
 * the conversation actually moves.
 */
const titleCache = new Map<string, TitleCacheEntry>();
const TITLE_CACHE_MAX = 400;

/**
 * `chat.history` returns the *tail* of a transcript (verified: limit=1 on a
 * 4-message session returns message 4). There is no offset/ordering parameter,
 * so the opening message of a very long conversation is not reachable cheaply.
 * We pull a bounded window and use the earliest user turn inside it, which is
 * the real first message for the overwhelming majority of sessions.
 */
const TITLE_WINDOW = 24;

function cacheKey(key: string, updatedAt: number): string {
  return `${key}@${updatedAt}`;
}

async function deriveTitle(key: string): Promise<TitleCacheEntry> {
  const data = await gatewayCall<{
    messages?: Array<{ role?: string; content?: unknown }>;
  }>("chat.history", { sessionKey: key, limit: TITLE_WINDOW }, 10_000);

  const messages = Array.isArray(data.messages) ? data.messages : [];
  let title = "";
  let commandFallback = "";
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = toTitle(textFromContent(message.content));
    if (!text) continue;
    // A session that opens with "/status" is better titled by its first real
    // sentence; keep the command only if nothing else exists.
    if (text.startsWith("/")) {
      commandFallback ||= text;
      continue;
    }
    title = text;
    break;
  }

  const lastAssistant = [...messages]
    .reverse()
    .find((m) => m.role === "assistant");
  const preview = lastAssistant
    ? toTitle(textFromContent(lastAssistant.content), 90) || null
    : null;

  return { title: title || commandFallback, preview };
}

/** Resolve derived titles for a bounded set of rows, with limited concurrency. */
async function fillDerivedTitles(
  rows: ChatSessionRow[],
  budget: number,
): Promise<void> {
  const pending = rows
    .filter((row) => row.titleSource === "fallback")
    .slice(0, budget);
  if (pending.length === 0) return;

  const queue = [...pending];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const id = cacheKey(row.key, row.updatedAt);
      let entry = titleCache.get(id);
      if (!entry) {
        try {
          entry = await deriveTitle(row.key);
        } catch {
          // A single unreadable transcript must not blank the whole list.
          continue;
        }
        if (titleCache.size >= TITLE_CACHE_MAX) {
          const oldest = titleCache.keys().next().value;
          if (oldest) titleCache.delete(oldest);
        }
        titleCache.set(id, entry);
      }
      if (entry.title) {
        row.title = entry.title;
        row.titleSource = "derived";
      }
      row.preview = entry.preview;
    }
  });

  await Promise.all(workers);
}

/* ── Listing ──────────────────────────────────────────────────────────────── */

export type ListChatSessionsOptions = {
  agentId?: string;
  /** How many rows to return (and therefore how many titles to derive). */
  limit?: number;
  includeArchived?: boolean;
};

export type ListChatSessionsResult = {
  sessions: ChatSessionRow[];
  /** Total chat sessions before the display limit — honest "showing N of M". */
  total: number;
  archivedCount: number;
};

function toRow(session: GatewaySession): ChatSessionRow | null {
  const key = typeof session.key === "string" ? session.key : "";
  if (!key || !SESSION_KEY_RE.test(key)) return null;
  if (!classifySessionKind(sessionKindOf(session)).isChat) return null;

  const explicit = session.label?.trim() || session.displayName?.trim() || "";
  const updatedAt =
    Number(session.updatedAt) || Number(session.lastActivityAt) || 0;

  return {
    key,
    sessionId: session.sessionId ?? null,
    agentId: sessionAgentIdOf(session),
    title: explicit || sessionTitleOf(session),
    titleSource: explicit ? "label" : "fallback",
    preview: null,
    updatedAt,
    pinned: Boolean(session.pinned),
    unread: Boolean(session.unread),
    archived: Boolean(session.archived),
    hasActiveRun: Boolean(session.hasActiveRun),
    model: session.model ? String(session.model) : null,
    totalTokens: Number(session.totalTokens) || 0,
  };
}

export async function listChatSessions(
  options: ListChatSessionsOptions = {},
): Promise<ListChatSessionsResult> {
  const limit = Math.min(Math.max(options.limit ?? 24, 1), 100);

  const listing = await gatewayCall<{ sessions?: GatewaySession[] }>(
    "sessions.list",
    { limit: 500 },
    12_000,
  );
  const raw = Array.isArray(listing.sessions) ? listing.sessions : [];

  const all: ChatSessionRow[] = [];
  for (const session of raw) {
    const row = toRow(session);
    if (!row) continue;
    if (options.agentId && row.agentId !== options.agentId) continue;
    all.push(row);
  }

  const archivedCount = all.filter((row) => row.archived).length;
  const visible = options.includeArchived
    ? all
    : all.filter((row) => !row.archived);

  visible.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  const page = visible.slice(0, limit);
  await fillDerivedTitles(page, limit);

  return { sessions: page, total: visible.length, archivedCount };
}

/* ── Write-side guard ─────────────────────────────────────────────────────── */

export type SessionGuardFailure = { status: 400 | 403 | 404; message: string };

/**
 * Confirm a key names a session this surface may mutate. The gateway's own
 * listing is authoritative — never the caller's key shape — except that a key
 * absent from the listing is simply unknown (404).
 */
export async function assertChatSession(
  key: string,
): Promise<SessionGuardFailure | null> {
  if (!key || !SESSION_KEY_RE.test(key)) {
    return { status: 400, message: "invalid session key" };
  }
  const listing = await gatewayCall<{ sessions?: GatewaySession[] }>(
    "sessions.list",
    { limit: 500 },
    12_000,
  );
  const sessions = Array.isArray(listing.sessions) ? listing.sessions : [];
  const match = sessions.find((session) => session.key === key);
  if (!match) return { status: 404, message: "session not found" };
  if (!classifySessionKind(sessionKindOf(match)).isChat) {
    return {
      status: 403,
      message: "this session is not a dashboard conversation",
    };
  }
  return null;
}

/**
 * Shape-only check, for writes that create a session that does not exist yet
 * (the first slash command in a brand new chat). It only admits keys whose
 * origin segment is already in the chat allowlist, so it can never be used to
 * address a channel, cron or subagent session.
 */
export function isNewChatSessionKey(key: string): boolean {
  if (!key || !SESSION_KEY_RE.test(key)) return false;
  const parts = key.split(":");
  if (parts.length < 4 || parts[0] !== "agent" || !parts[1]) return false;
  return CHAT_SESSION_KINDS.has(parts[2]);
}
