/**
 * Zod schemas for the activity, session-activity and logs route group
 * (`GET /api/activity`, `GET /api/activity/session`, `GET /api/logs`).
 *
 * Every pagination/line-count parameter in this group is a bounded integer
 * with an explicit maximum (T-02-51): an oversized or non-integer value is
 * rejected at the schema boundary — before any log file is read — rather
 * than silently clamped, so the shape mirrors `src/lib/schemas/media.ts`'s
 * `vectorGetQuerySchema.max` numeric-bound pattern instead of this route
 * group's own previous silent-clamp behavior.
 *
 * The log `type` parameter (T-02-50) is the actual file-selector in
 * `src/app/api/logs/route.ts` (it picks between `gateway.log` /
 * `gateway.err.log` / the tslog tmp files) and is constrained to its
 * enumerated set, so an unexpected value cannot select an unintended file.
 * `search`/`source`/`level` only filter already-loaded, already-parsed
 * entries in memory and stay free-form (bounded in length only).
 *
 * Same "required check stays in the handler, format check moves to the
 * schema" split as `src/lib/schemas/agents.ts`.
 */
import { z } from "zod";

/** Session-key identifier format shared with `src/lib/schemas/chat.ts`. */
const SESSION_KEY_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

/* ── GET /api/activity ────────────────────────────── */

const ACTIVITY_EVENT_TYPES = ["cron", "session", "log", "system"] as const;

export const activityGetQuerySchema = z
  .object({
    type: z.enum(ACTIVITY_EVENT_TYPES).optional(),
  })
  .passthrough();
export type ActivityGetQuery = z.infer<typeof activityGetQuerySchema>;

/* ── GET /api/activity/session ────────────────────── */

export const DEFAULT_ACTIVITY_SESSION_LIMIT = 160;
export const MAX_ACTIVITY_SESSION_LIMIT = 300;

/**
 * `sessionKey` stays optional here (missing-ness is still a manual handler
 * check, preserving the original "sessionKey is required" body with no
 * `details` tree) — trimmed and mapped to `undefined` when empty, same
 * transform shape as `optionalAgentName` in `src/lib/schemas/agents.ts`.
 */
export const activitySessionKeySchema = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  })
  .refine((value) => value === undefined || SESSION_KEY_PATTERN.test(value), {
    message: "invalid sessionKey",
  });

/**
 * A present-but-malformed `limit` (non-integer, out of range) is rejected
 * with a 400 and a `details` tree naming the field, replacing the route's
 * former silent clamp-or-default behavior (pinned by
 * `src/app/api/logs/route.test.ts`).
 */
export const activitySessionLimitSchema = z.coerce
  .number()
  .int("limit must be a whole number")
  .min(1, "limit must be at least 1")
  .max(MAX_ACTIVITY_SESSION_LIMIT, `limit cannot exceed ${MAX_ACTIVITY_SESSION_LIMIT}`);

export const activitySessionGetQuerySchema = z
  .object({
    sessionKey: activitySessionKeySchema,
    limit: activitySessionLimitSchema.optional(),
  })
  .passthrough();
export type ActivitySessionGetQuery = z.infer<typeof activitySessionGetQuerySchema>;

/* ── GET /api/logs ─────────────────────────────────── */

const LOG_TYPES = ["gateway", "error", "all"] as const;

export const DEFAULT_LOGS_LIMIT = 200;
export const MAX_LOGS_LIMIT = 1000;

/** An explicit empty `?type=` keeps the original "fall back to all" behavior. */
export const logsTypeSchema = z.preprocess(
  (value) => (value === "" ? "all" : value),
  z.enum(LOG_TYPES),
);

export const logsLimitSchema = z.coerce
  .number()
  .int("limit must be a whole number")
  .min(1, "limit must be at least 1")
  .max(MAX_LOGS_LIMIT, `limit cannot exceed ${MAX_LOGS_LIMIT}`);

export const logsGetQuerySchema = z
  .object({
    type: logsTypeSchema.optional(),
    limit: logsLimitSchema.optional(),
    search: z.string().max(500).optional(),
    source: z.string().max(200).optional(),
    level: z.string().max(20).optional(),
  })
  .passthrough();
export type LogsGetQuery = z.infer<typeof logsGetQuerySchema>;
