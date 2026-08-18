/**
 * Zod schemas for the media/vector-store route group:
 * `POST /api/audio`, `GET /api/audio`, `POST /api/vector`, `GET /api/vector`.
 *
 * Path-safety pattern (T-02-34, T-02-37): any field that flows toward a
 * filesystem read is bounded in length and rejected at the schema boundary
 * if it contains a parent-directory traversal segment (`..`) — before the
 * value ever reaches a path-resolution helper or an `fs` call. The rejection
 * message never echoes the submitted value back to the caller.
 *
 * Same "required check stays in the handler, format check moves to the
 * schema" split as `src/lib/schemas/agents.ts`: a *missing* field keeps its
 * original manual `if (!x) return badRequest(...)` check (no `details`); a
 * *present but malformed* field goes through this schema and gets a Zod
 * `details` tree via `validationFailed()`.
 */
import { resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";

/** Matches a `..` path segment on either POSIX or Windows separators. */
const TRAVERSAL_SEGMENT_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;

const PATH_NOT_ALLOWED_MESSAGE = "Path not allowed";

/** Reject a bare parent-directory traversal segment without echoing the value. */
export function hasTraversalSegment(value: string): boolean {
  return TRAVERSAL_SEGMENT_PATTERN.test(value);
}

/**
 * `GET /api/audio?scope=stream&path=...` serves an on-disk TTS render.
 * The path must resolve inside the OS temp directory — bounded length,
 * no traversal segments, checked before `stat`/`readFile` ever run.
 */
export const audioStreamPathSchema = z
  .string()
  .max(1024, PATH_NOT_ALLOWED_MESSAGE)
  .refine((value) => !hasTraversalSegment(value), { message: PATH_NOT_ALLOWED_MESSAGE });

/** True when `value` resolves inside the OS temp directory (no traversal). */
export function isWithinTmpDir(value: string): boolean {
  const base = resolve(tmpdir());
  const resolved = resolve(value);
  return resolved === base || resolved.startsWith(base + sep);
}

export const audioGetQuerySchema = z
  .object({
    scope: z.string().optional(),
    path: audioStreamPathSchema.optional(),
  })
  .passthrough();
export type AudioGetQuery = z.infer<typeof audioGetQuerySchema>;

/**
 * `POST /api/audio`'s action field stays a loose, passthrough-checked
 * string (not a discriminated union) so every existing action-specific
 * error message (e.g. "provider must be openai or elevenlabs") is
 * preserved exactly — same precedent as `POST /api/gateway` (02-04).
 */
export const audioPostSchema = z
  .object({
    action: z.string(),
  })
  .passthrough();
export type AudioPostInput = z.infer<typeof audioPostSchema>;

/* ── Vector store ─────────────────────────────────── */

const MAX_SEARCH_RESULTS = 200;

/**
 * `GET /api/vector?scope=search` numeric fields (T-02-36): bounded so an
 * oversized request cannot trigger an unbounded embedding/query workload.
 */
export const vectorGetQuerySchema = z
  .object({
    scope: z.string().optional(),
    fresh: z.string().optional(),
    q: z.string().max(2000).optional(),
    agent: z.string().max(200).optional(),
    max: z.coerce
      .number()
      .int("max must be a whole number")
      .min(1, "max must be at least 1")
      .max(MAX_SEARCH_RESULTS, `max cannot exceed ${MAX_SEARCH_RESULTS}`)
      .optional(),
    minScore: z.coerce.number().min(0, "minScore must be at least 0").max(1, "minScore cannot exceed 1").optional(),
  })
  .passthrough();
export type VectorGetQuery = z.infer<typeof vectorGetQuerySchema>;

/** Bounded list of workspace-relative or custom extra index paths (T-02-36). */
const extraPathsField = z
  .array(z.string().max(1024))
  .max(500, "extraPaths cannot exceed 500 entries")
  .optional();

const reindexAction = z.object({ action: z.literal("reindex") }).passthrough();
const deleteNamespaceAction = z.object({ action: z.literal("delete-namespace") }).passthrough();
const setupMemoryAction = z.object({ action: z.literal("setup-memory") }).passthrough();
const disableMemoryAction = z.object({ action: z.literal("disable-memory") }).passthrough();
const updateEmbeddingModelAction = z
  .object({ action: z.literal("update-embedding-model") })
  .passthrough();
const setExtraPathsAction = z
  .object({ action: z.literal("set-extra-paths"), extraPaths: extraPathsField })
  .passthrough();
const ensureExtraPathsAction = z.object({ action: z.literal("ensure-extra-paths") }).passthrough();

/**
 * `POST /api/vector`'s action field IS a discriminated union (unlike audio's
 * loose string) — this route sits directly upstream of embedding/query and
 * filesystem calls (T-02-36), so an unrecognized action is rejected with a
 * Zod-derived `details` tree naming the `action` field, pinned by
 * `src/app/api/vector/route.test.ts`.
 */
export const vectorPostSchema = z.discriminatedUnion("action", [
  reindexAction,
  deleteNamespaceAction,
  setupMemoryAction,
  disableMemoryAction,
  updateEmbeddingModelAction,
  setExtraPathsAction,
  ensureExtraPathsAction,
]);
export type VectorPostInput = z.infer<typeof vectorPostSchema>;
