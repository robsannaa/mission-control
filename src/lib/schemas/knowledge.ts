/**
 * Zod schemas for the docs, calendar, g-brain, memory, and audit route group.
 *
 * `docPathSchema` reuses the traversal-segment check established in
 * `src/lib/schemas/media.ts` (T-02-34) and additionally rejects an
 * absolute-path prefix — `src/app/api/docs/route.ts`'s `safePath()` used to
 * silently strip a leading `/` and resolve inside `OPENCLAW_HOME` anyway;
 * this schema instead rejects the request outright at the boundary, before
 * `safePath()` (still kept as defense-in-depth) or any `fs` call runs.
 *
 * `calendarDaysQuerySchema` / `calendarDaysBodySchema` port
 * `src/app/api/calendar/route.ts`'s existing `parseDays()` clamp
 * (1-60, never-reject) into the schema layer (T-02-35) — same behavior,
 * now enforced before the value reaches `readAppleCalendarEvents` /
 * `icalBuddy`, not just inside the route handler.
 */
import { z } from "zod";
import { hasTraversalSegment } from "@/lib/schemas/media";

const INVALID_PATH_MESSAGE = "invalid path";

/** Windows drive-letter absolute prefix, e.g. `C:/` or `C:\`. */
const WINDOWS_ABSOLUTE_PREFIX = /^[A-Za-z]:[\\/]/;

/**
 * A workspace-relative document path. Bounded length, no `..` traversal
 * segment, and no absolute-path prefix (POSIX `/` or a Windows drive
 * letter) — pinned by `src/app/api/vector/route.test.ts` (T-02-34, T-02-37).
 */
export const docPathSchema = z
  .string()
  .min(1, "path required")
  .max(1024, INVALID_PATH_MESSAGE)
  .refine((value) => !hasTraversalSegment(value), { message: INVALID_PATH_MESSAGE })
  .refine((value) => !value.startsWith("/") && !WINDOWS_ABSOLUTE_PREFIX.test(value), {
    message: INVALID_PATH_MESSAGE,
  });

export const docsGetQuerySchema = z
  .object({
    path: docPathSchema.optional(),
  })
  .passthrough();
export type DocsGetQuery = z.infer<typeof docsGetQuerySchema>;

export const docsDeleteQuerySchema = z
  .object({
    path: docPathSchema.optional(),
  })
  .passthrough();
export type DocsDeleteQuery = z.infer<typeof docsDeleteQuerySchema>;

/**
 * A single workspace directory name (not a path) — bounded, no separators,
 * no traversal segment. Required-ness (`workspace` missing) stays a manual
 * handler check to preserve the exact pre-migration error body.
 */
export const workspaceNameSchema = z
  .string()
  .max(200, "invalid workspace")
  .refine((value) => !value.includes("/") && !value.includes("\\") && !hasTraversalSegment(value), {
    message: "invalid workspace",
  });

export const docsPostSchema = z
  .object({
    workspace: workspaceNameSchema.optional(),
    filename: z.string().max(255).optional(),
    content: z.string().optional(),
  })
  .passthrough();
export type DocsPostInput = z.infer<typeof docsPostSchema>;

export const docsPutSchema = z
  .object({
    path: docPathSchema.optional(),
    content: z.string().optional(),
  })
  .passthrough();
export type DocsPutInput = z.infer<typeof docsPutSchema>;

export const docsPatchSchema = z
  .object({
    action: z.string().optional(),
    path: docPathSchema.optional(),
    newName: z.string().max(255).optional(),
  })
  .passthrough();
export type DocsPatchInput = z.infer<typeof docsPatchSchema>;

/* ── Calendar ─────────────────────────────────────── */

function clampDays(value: number): number {
  return Math.max(1, Math.min(Math.round(value), 60));
}

/** Matches the original `Number(searchParams.get("days") || "14")` fallback. */
export const calendarDaysQuerySchema = z
  .preprocess((value) => {
    const raw = typeof value === "string" && value.length > 0 ? value : "14";
    const n = Number(raw);
    return Number.isFinite(n) ? n : 14;
  }, z.number())
  .transform(clampDays);

/** Matches the original `typeof body?.days === "number" ? body.days : null` fallback. */
export const calendarDaysBodySchema = z
  .preprocess((value) => (typeof value === "number" ? value : 14), z.number())
  .transform(clampDays);

export const calendarGetQuerySchema = z
  .object({
    days: calendarDaysQuerySchema.optional(),
  })
  .passthrough();
export type CalendarGetQuery = z.infer<typeof calendarGetQuerySchema>;

export const calendarPostSchema = z
  .object({
    action: z.string().optional(),
    days: calendarDaysBodySchema.optional(),
  })
  .passthrough();
export type CalendarPostInput = z.infer<typeof calendarPostSchema>;

/* ── G-Brain ──────────────────────────────────────── */

export const gbrainPostSchema = z
  .object({
    id: z.string().optional(),
    values: z.record(z.string(), z.string()).optional(),
    confirm: z.boolean().optional(),
  })
  .passthrough();
export type GbrainPostInput = z.infer<typeof gbrainPostSchema>;

/* ── Memory ───────────────────────────────────────── */

export const memoryPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type MemoryPostInput = z.infer<typeof memoryPostSchema>;
