/**
 * Zod schemas for the workspace-file, doctor read-side, interactions,
 * commitments and approvals route group: `GET /api/workspace`,
 * `GET /api/workspace/file`, `GET /api/workspace/files`,
 * `GET /api/doctor/status`, `GET|DELETE /api/doctor/history`,
 * `GET /api/doctor/report`, `GET|POST /api/interactions`,
 * `POST /api/interactions/intake`, `GET /api/interactions/[id]`,
 * `GET|POST /api/commitments`, `GET|POST /api/approvals`.
 *
 * Path-safety pattern (T-02-55): `workspaceRelativePathSchema` reuses the
 * traversal-segment check from `src/lib/schemas/media.ts`
 * (`hasTraversalSegment`) and additionally rejects an absolute-path prefix
 * — the same constraint shape as `chatAttachmentPathSchema` in
 * `src/lib/schemas/chat.ts` — so the workspace-root containment check
 * already in `src/app/api/workspace/file/route.ts` never receives an
 * escaping value in the first place (defense-in-depth, same precedent as
 * the chat/docs routes in plans 02-08/02-11).
 *
 * `GET /api/workspace/files`'s `path` query parameter is a *different*
 * shape on purpose: this route browses an arbitrary absolute directory an
 * agent reports as its own workspace (`src/components/agents-view.tsx`
 * passes each agent's server-reported `workspace` path straight through) —
 * it never resolves against a single canonical workspace root the way
 * `workspace/file` does, so `workspaceDirectoryPathSchema` only bounds
 * length and rejects a null byte. Constraining it to a workspace-relative
 * shape would break the route's actual (pre-existing, out of scope for this
 * error-envelope migration per D-01/§5 of `docs/API-CONTRACT.md`) design.
 *
 * Identifier pattern (T-02-59): `interactionRouteParamsSchema` bounds the
 * `[id]` path segment on `GET /api/interactions/[id]` to the
 * `crypto.randomUUID()`-shaped format `src/lib/awareness/store.ts` always
 * mints (`GOOGLE_ACCOUNT_ID_PATTERN` precedent from
 * `src/lib/schemas/integrations.ts`), so an unvalidated segment can no
 * longer select a record lookup before the schema is checked.
 *
 * Doctor read-side query parameters (`GET /api/doctor/status|history|report`)
 * stay bounded-length optional strings rather than strict integers/enums:
 * every one of them already has documented, deliberately lenient fallback
 * parsing in the route (e.g. `doctor/status`'s "`Number(null)` is 0, not
 * NaN" comment) that this migration must not disturb (D-06) — the bound
 * here is defense against an oversized query string, not a format change.
 *
 * Every action field in this group (`interactions`, `interactions/intake`,
 * `commitments`, `approvals`) stays a manual required/format check in the
 * route handler — same "required stays manual, format stays manual when its
 * message is preserved" split as `src/lib/schemas/gateway.ts` — because
 * none of these routes is in this plan's threat register as needing action
 * enumeration, and each existing message (e.g. `id and answer are
 * required`) already matches D-06 exactly.
 */
import { z } from "zod";
import { hasTraversalSegment } from "@/lib/schemas/media";

const WORKSPACE_PATH_MESSAGE = "invalid path";
const WINDOWS_ABSOLUTE_PREFIX = /^[A-Za-z]:[\\/]/;

/* ── GET /api/workspace/file ──────────────────────────────────────────── */

export const workspaceRelativePathSchema = z
  .string()
  .max(1024, WORKSPACE_PATH_MESSAGE)
  .refine((value) => !value.includes("\0"), { message: WORKSPACE_PATH_MESSAGE })
  .refine((value) => !hasTraversalSegment(value), { message: WORKSPACE_PATH_MESSAGE })
  .refine((value) => !value.startsWith("/") && !WINDOWS_ABSOLUTE_PREFIX.test(value), {
    message: WORKSPACE_PATH_MESSAGE,
  });

export const workspaceFileGetQuerySchema = z
  .object({
    path: workspaceRelativePathSchema.optional(),
  })
  .passthrough();
export type WorkspaceFileGetQuery = z.infer<typeof workspaceFileGetQuerySchema>;

/* ── GET /api/workspace/files ──────────────────────────────────────────── */

export const workspaceDirectoryPathSchema = z
  .string()
  .max(4096, "invalid path")
  .refine((value) => !value.includes("\0"), { message: "invalid path" });

export const workspaceFilesGetQuerySchema = z
  .object({
    path: workspaceDirectoryPathSchema.optional(),
  })
  .passthrough();
export type WorkspaceFilesGetQuery = z.infer<typeof workspaceFilesGetQuerySchema>;

/* ── GET /api/doctor/status ───────────────────────────────────────────── */

export const doctorStatusGetQuerySchema = z
  .object({
    peek: z.string().max(8).optional(),
    refresh: z.string().max(8).optional(),
    history: z.string().max(8).optional(),
    maxAgeMs: z.string().max(32).optional(),
  })
  .passthrough();
export type DoctorStatusGetQuery = z.infer<typeof doctorStatusGetQuerySchema>;

/* ── GET|DELETE /api/doctor/history ───────────────────────────────────── */

export const doctorHistoryGetQuerySchema = z
  .object({
    limit: z.string().max(16).optional(),
    offset: z.string().max(16).optional(),
    summary: z.string().max(4).optional(),
  })
  .passthrough();
export type DoctorHistoryGetQuery = z.infer<typeof doctorHistoryGetQuerySchema>;

export const doctorHistoryDeleteQuerySchema = z
  .object({
    id: z.string().max(256).optional(),
  })
  .passthrough();
export type DoctorHistoryDeleteQuery = z.infer<typeof doctorHistoryDeleteQuerySchema>;

/* ── GET /api/doctor/report ───────────────────────────────────────────── */

export const doctorReportGetQuerySchema = z
  .object({
    format: z.string().max(16).optional(),
    transcript: z.string().max(8).optional(),
    refresh: z.string().max(8).optional(),
  })
  .passthrough();
export type DoctorReportGetQuery = z.infer<typeof doctorReportGetQuerySchema>;

/* ── GET|POST /api/interactions ───────────────────────────────────────── */

export const interactionsGetQuerySchema = z
  .object({
    id: z.string().max(256).optional(),
    status: z.string().max(32).optional(),
    source: z.string().max(64).optional(),
    limit: z.string().max(16).optional(),
  })
  .passthrough();
export type InteractionsGetQuery = z.infer<typeof interactionsGetQuerySchema>;

export const interactionsPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type InteractionsPostInput = z.infer<typeof interactionsPostSchema>;

/* ── POST /api/interactions/intake ────────────────────────────────────── */

export const interactionsIntakePostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type InteractionsIntakePostInput = z.infer<typeof interactionsIntakePostSchema>;

/* ── GET /api/interactions/[id] ───────────────────────────────────────── */

/**
 * The only way `src/lib/awareness/store.ts` ever mints an interaction id is
 * `crypto.randomUUID()`. Bounded to that shape (with the same
 * slightly-more-permissive-than-strict-UUID tolerance as
 * `GOOGLE_ACCOUNT_ID_PATTERN` in `src/lib/schemas/integrations.ts`) so a
 * malformed `[id]` segment is rejected before it ever reaches
 * `getInteraction()` (T-02-59).
 */
export const INTERACTION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

export const interactionRouteParamsSchema = z.object({
  id: z.string().regex(INTERACTION_ID_PATTERN, "Invalid interaction id"),
});
export type InteractionRouteParams = z.infer<typeof interactionRouteParamsSchema>;

/* ── GET|POST /api/commitments ────────────────────────────────────────── */

export const commitmentsGetQuerySchema = z
  .object({
    status: z.string().max(32).optional(),
  })
  .passthrough();
export type CommitmentsGetQuery = z.infer<typeof commitmentsGetQuerySchema>;

export const commitmentsPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type CommitmentsPostInput = z.infer<typeof commitmentsPostSchema>;

/* ── GET|POST /api/approvals ──────────────────────────────────────────── */

export const approvalsPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type ApprovalsPostInput = z.infer<typeof approvalsPostSchema>;
