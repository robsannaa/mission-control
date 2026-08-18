/**
 * Zod schemas for the chat-surface route group: `GET /api/chat/files`,
 * `GET /api/chat/files/preview`, `POST /api/chat/command`,
 * `GET /api/chat/commands`, `GET /api/chat/history`,
 * `GET|PATCH|DELETE /api/chat/sessions`, `GET /api/chat/bootstrap`, and
 * `GET|DELETE /api/sessions`.
 *
 * Attachment-path pattern (T-02-49): `chatAttachmentPathSchema` reuses the
 * traversal-segment check established in `src/lib/schemas/media.ts`
 * (`hasTraversalSegment`) and additionally rejects an absolute-path prefix
 * — same constraint shape as `docPathSchema` in `src/lib/schemas/knowledge.ts`
 * — so the resolved-path containment check already in
 * `src/app/api/chat/files/preview/route.ts` never receives an escaping
 * value in the first place. That containment check stays in the route as
 * defense-in-depth (same precedent as the docs route in plan 02-08).
 *
 * Session-identifier pattern: `sessionKeySchema` is the same
 * `agent:<id>:<kind>:<uuid>`-shaped format bound used by
 * `src/lib/schemas/activity.ts`, shared here because the chat/sessions
 * route group addresses the same gateway session store.
 *
 * Same "required check stays in the handler, format check moves to the
 * schema" split as `src/lib/schemas/agents.ts`.
 */
import { z } from "zod";
import { hasTraversalSegment } from "@/lib/schemas/media";

const INVALID_PATH_MESSAGE = "invalid path";
const WINDOWS_ABSOLUTE_PREFIX = /^[A-Za-z]:[\\/]/;

/** Session-key identifier format shared with `src/lib/schemas/activity.ts`. */
export const SESSION_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

/**
 * Missing-ness stays a manual handler check (preserving each route's own
 * "sessionKey is required"/"session key required" body with no `details`
 * tree) — trimmed and mapped to `undefined` when empty, same transform
 * shape as `activitySessionKeySchema` in `src/lib/schemas/activity.ts`.
 */
export const sessionKeySchema = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  })
  .refine((value) => value === undefined || SESSION_KEY_PATTERN.test(value), {
    message: "invalid sessionKey",
  });

/* ── GET /api/chat/files ──────────────────────────── */

export const chatFilesGetQuerySchema = z
  .object({
    agentId: z.string().max(200).optional(),
    q: z.string().max(500).optional(),
  })
  .passthrough();
export type ChatFilesGetQuery = z.infer<typeof chatFilesGetQuerySchema>;

/* ── GET /api/chat/files/preview ──────────────────── */

const MAX_ATTACHMENT_PATH_LENGTH = 512;

/**
 * A workspace-relative attachment path. Bounded length, no null byte, no
 * `..` traversal segment, and no absolute-path prefix (POSIX `/` or a
 * Windows drive letter) — rejected at the schema boundary before
 * `path.resolve`/`readFile` ever run (T-02-49).
 */
export const chatAttachmentPathSchema = z
  .string()
  .max(MAX_ATTACHMENT_PATH_LENGTH, INVALID_PATH_MESSAGE)
  .refine((value) => !value.includes("\0"), { message: INVALID_PATH_MESSAGE })
  .refine((value) => !hasTraversalSegment(value), { message: INVALID_PATH_MESSAGE })
  .refine((value) => !value.startsWith("/") && !WINDOWS_ABSOLUTE_PREFIX.test(value), {
    message: INVALID_PATH_MESSAGE,
  });

export const chatFilesPreviewGetQuerySchema = z
  .object({
    path: chatAttachmentPathSchema.optional(),
    agentId: z.string().max(200).optional(),
  })
  .passthrough();
export type ChatFilesPreviewGetQuery = z.infer<typeof chatFilesPreviewGetQuerySchema>;

/* ── POST /api/chat/command ───────────────────────── */

const MAX_COMMAND_LENGTH = 4000;

export const chatCommandPostSchema = z
  .object({
    sessionKey: z.string().max(256).optional(),
    command: z.string().max(MAX_COMMAND_LENGTH, "command is too long").optional(),
  })
  .passthrough();
export type ChatCommandPostInput = z.infer<typeof chatCommandPostSchema>;

/* ── GET /api/chat/history ────────────────────────── */

export const DEFAULT_CHAT_HISTORY_LIMIT = 100;
export const MAX_CHAT_HISTORY_LIMIT = 500;

/**
 * Ports the route's existing `Number(...) → clamp(1, MAX)` fallback into the
 * schema layer (same non-rejecting transform shape as
 * `calendarDaysQuerySchema` in `src/lib/schemas/knowledge.ts`) — this route's
 * `limit` is not one of the reject-on-malformed pins in task 3, so its
 * original silent-clamp behavior is preserved exactly, just enforced one
 * layer earlier.
 */
export const chatHistoryLimitSchema = z
  .preprocess((value) => {
    const raw = typeof value === "string" && value.length > 0 ? value : String(DEFAULT_CHAT_HISTORY_LIMIT);
    const n = Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_CHAT_HISTORY_LIMIT;
  }, z.number())
  .transform((n) => Math.min(Math.max(Math.trunc(n), 1), MAX_CHAT_HISTORY_LIMIT));

export const chatHistoryGetQuerySchema = z
  .object({
    sessionKey: sessionKeySchema,
    limit: chatHistoryLimitSchema.optional(),
  })
  .passthrough();
export type ChatHistoryGetQuery = z.infer<typeof chatHistoryGetQuerySchema>;

/* ── /api/chat/sessions ───────────────────────────── */

export const MAX_CHAT_SESSIONS_LIMIT = 500;

/**
 * The route previously passed an unbounded `limit` straight to
 * `listChatSessions` (T-02-51) — now clamped (not rejected, matching this
 * route's original never-reject behavior) to an explicit maximum.
 */
export const chatSessionsLimitSchema = z
  .preprocess((value) => {
    if (typeof value !== "string" || value.length === 0) return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }, z.number().optional())
  .transform((n) => (n === undefined ? undefined : Math.min(Math.max(Math.trunc(n), 1), MAX_CHAT_SESSIONS_LIMIT)));

export const chatSessionsGetQuerySchema = z
  .object({
    agentId: z.string().max(200).optional(),
    limit: chatSessionsLimitSchema,
    archived: z.string().max(10).optional(),
  })
  .passthrough();
export type ChatSessionsGetQuery = z.infer<typeof chatSessionsGetQuerySchema>;

export const chatSessionsPatchSchema = z
  .object({
    key: sessionKeySchema,
    label: z.string().max(500).optional(),
    pinned: z.boolean().optional(),
    unread: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .passthrough();
export type ChatSessionsPatchInput = z.infer<typeof chatSessionsPatchSchema>;

export const chatSessionsDeleteQuerySchema = z
  .object({
    key: sessionKeySchema,
  })
  .passthrough();
export type ChatSessionsDeleteQuery = z.infer<typeof chatSessionsDeleteQuerySchema>;

/* ── /api/sessions ─────────────────────────────────── */

export const sessionsDeleteQuerySchema = z
  .object({
    key: sessionKeySchema,
  })
  .passthrough();
export type SessionsDeleteQuery = z.infer<typeof sessionsDeleteQuerySchema>;
