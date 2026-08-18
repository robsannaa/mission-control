/**
 * Zod schemas for the update, network, settings, secrets and backup route
 * group: `POST /api/mission-control-update`, `POST /api/openclaw-update`,
 * `POST /api/tailscale`, `POST /api/settings`, `POST /api/secrets`,
 * `POST /api/backup`.
 *
 * Action-enumeration pattern (T-02-57/T-02-58): `tailscalePostSchema` is
 * `z.discriminatedUnion("action", [...])` — the T-02-27/T-02-44 precedent
 * from `src/lib/schemas/integrations.ts` and `src/lib/schemas/system.ts` —
 * because an unrecognized action on this route changes how reachable the
 * instance is. The accepted trade-off, already taken several times earlier
 * in this phase: an unrecognized or missing action now produces Zod's own
 * discriminator-mismatch message (with a `details` tree) instead of the
 * route's former hand-written `Unknown action: <value>` / `Action is
 * required` string. `missionControlUpdatePostSchema` and
 * `openclawUpdatePostSchema` enumerate their action as an optional
 * literal/enum (T-02-58) so the pre-existing "default to run-update when
 * action is omitted" behavior survives, while a *present but wrong* action
 * value is now rejected before an update starts.
 *
 * `secretsPostSchema` takes a narrower approach: `action` is a *required,
 * non-empty* string (`z.string().min(1, ...)`) rather than a full
 * discriminated union. A missing/empty action fails the schema and carries a
 * `details` tree naming `["action"]` (T-02-54's route sits directly upstream
 * of a credential write, so it deserves an explicit requiredness check), but
 * a *present, merely unrecognized* action (e.g. a typo) still falls through
 * to the handler's own switch and its exact original `Unknown action:
 * <value>` message — preserving D-06 for that branch specifically, unlike
 * the full-enumeration routes above.
 *
 * `settingsPostSchema` and `backupPostSchema`'s action fields, and
 * `missionControlUpdatePostSchema`/`openclawUpdatePostSchema`'s sibling
 * fields (`timezone`, `scope`, `channel`, `noRestart`, `dryRun`), stay
 * manual required/format checks in the route handler — same "required stays
 * manual, format stays manual when its message is preserved" split as
 * `src/lib/schemas/gateway.ts` — because each of those checks builds a
 * message that already matches D-06 exactly (including one, `timezone`,
 * that echoes the submitted value back — pre-existing behavior, not new
 * reflection of secret material).
 *
 * Path-safety pattern (T-02-54, T-02-56): `secretsPlanPathSchema` and
 * `backupArchivePathSchema` reuse the traversal-segment check from
 * `src/lib/schemas/media.ts` (`hasTraversalSegment`). The backup archive
 * identifier additionally must end in the `.tar.gz` extension every backup
 * archive is created with (`src/components/backup-view.tsx`,
 * `src/lib/backup.ts`), so an arbitrary value cannot select an unrelated
 * file for restore/verification. Neither schema's rejection message ever
 * echoes the submitted value, and each stays `.optional()` in its object
 * schema so a genuinely *missing* path keeps its own manual, no-`details`
 * "path is required" check in the route handler.
 */
import { z } from "zod";
import { hasTraversalSegment } from "@/lib/schemas/media";

const INVALID_PATH_MESSAGE = "Path not allowed";

/* ── POST /api/mission-control-update ─────────────────────────────────── */

export const missionControlUpdatePostSchema = z
  .object({
    action: z.literal("run-update").optional(),
  })
  .passthrough();
export type MissionControlUpdatePostInput = z.infer<typeof missionControlUpdatePostSchema>;

/* ── POST /api/openclaw-update ────────────────────────────────────────── */

export const openclawUpdatePostSchema = z
  .object({
    action: z.enum(["status", "run-update"]).optional(),
    channel: z.string().optional(),
    noRestart: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .passthrough();
export type OpenClawUpdatePostInput = z.infer<typeof openclawUpdatePostSchema>;

/* ── POST /api/tailscale ──────────────────────────────────────────────── */

const TAILSCALE_RUNTIME_ACTIONS = [
  "up",
  "down",
  "logout",
  "serve-reset",
  "funnel-reset",
  "serve-status",
  "funnel-status",
  "ip",
  "netcheck",
  "status",
] as const;

const tailscaleRunAction = z
  .object({
    action: z.literal("run"),
    args: z.unknown().optional(),
  })
  .passthrough();

const tailscaleRuntimeAction = z
  .object({
    action: z.enum(TAILSCALE_RUNTIME_ACTIONS),
  })
  .passthrough();

export const tailscalePostSchema = z.discriminatedUnion("action", [
  tailscaleRunAction,
  tailscaleRuntimeAction,
]);
export type TailscalePostInput = z.infer<typeof tailscalePostSchema>;

/* ── POST /api/settings ───────────────────────────────────────────────── */

export const settingsPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type SettingsPostInput = z.infer<typeof settingsPostSchema>;

/* ── POST /api/secrets ────────────────────────────────────────────────── */

/**
 * `--from <planPath>` is passed straight through to `openclaw secrets apply`
 * as a CLI argument (execFile array form — never shell-interpolated), but a
 * caller-supplied path still deserves the same bounded/no-traversal
 * constraint every other filesystem-adjacent input in this codebase gets.
 */
export const secretsPlanPathSchema = z
  .string()
  .max(1024, INVALID_PATH_MESSAGE)
  .refine((value) => !value.includes("\0"), { message: INVALID_PATH_MESSAGE })
  .refine((value) => !hasTraversalSegment(value), { message: INVALID_PATH_MESSAGE });

export const secretsPostSchema = z
  .object({
    action: z.string().min(1, "action is required"),
    providersOnly: z.boolean().optional(),
    skipProviderSetup: z.boolean().optional(),
    apply: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    planPath: secretsPlanPathSchema.optional(),
  })
  .passthrough();
export type SecretsPostInput = z.infer<typeof secretsPostSchema>;

/* ── POST /api/backup ─────────────────────────────────────────────────── */

const ARCHIVE_FORMAT_MESSAGE = "Invalid archive path";
const ARCHIVE_EXTENSION_PATTERN = /\.tar\.gz$/i;

/**
 * Every backup archive this codebase creates is a timestamped `.tar.gz`
 * (`src/lib/backup.ts`, `src/components/backup-view.tsx`). Bounded length,
 * no traversal segment, no null byte, and the archive extension is required
 * — so an arbitrary string cannot select an unrelated file for `backup
 * verify` (T-02-56).
 */
export const backupArchivePathSchema = z
  .string()
  .max(1024, ARCHIVE_FORMAT_MESSAGE)
  .refine((value) => !value.includes("\0"), { message: ARCHIVE_FORMAT_MESSAGE })
  .refine((value) => !hasTraversalSegment(value), { message: ARCHIVE_FORMAT_MESSAGE })
  .refine((value) => ARCHIVE_EXTENSION_PATTERN.test(value), { message: ARCHIVE_FORMAT_MESSAGE });

export const backupPostSchema = z
  .object({
    action: z.string().optional(),
    path: backupArchivePathSchema.optional(),
  })
  .passthrough();
export type BackupPostInput = z.infer<typeof backupPostSchema>;
