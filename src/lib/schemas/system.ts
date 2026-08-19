/**
 * Zod schemas for the system, runtime and device route group: exec/approval
 * permissions, heartbeat configuration, the browser extension relay, system
 * status/liveness dashboards, the security audit surface, and paired
 * devices.
 *
 * This group contains the two routes where an unvalidated payload changes
 * what the instance is allowed to do — `POST /api/permissions` and
 * `POST /api/security` — so their action-switch schemas are
 * `z.discriminatedUnion("action", [...])`, the T-02-27/T-02-43 pattern from
 * `src/lib/schemas/integrations.ts` and `src/lib/schemas/automation.ts`,
 * applied here as T-02-44: an unrecognized action fails schema validation
 * before the handler's switch (and therefore before any policy write) is
 * reached. `POST /api/devices` gets the same treatment for T-02-48 (a
 * device-record mutation must not fall through an unrecognized action to a
 * default branch). The accepted trade-off, already taken twice earlier in
 * this phase: an unrecognized action now produces Zod's own "Invalid
 * discriminator value" message (with a `details` tree) instead of each
 * route's former hand-written `Unknown action: <value>` string.
 *
 * `POST /api/heartbeat` keeps a loose `action` string (the
 * `src/lib/schemas/gateway.ts` pattern) — it is not named in this plan's
 * threat register, and its 9 existing `ok: false` branches are already
 * conformant; the goal here is to move them through the shared builders
 * without changing their status or message text.
 *
 * `POST /api/browser/relay` also keeps a loose `action` string (same
 * reasoning), but its `url` field — a caller-supplied forwarding target for
 * the "open-test-tab" action — is gated by `superRefine` to a parsed
 * absolute URL with an allowed scheme set (T-02-45), reproducing the route's
 * original two-message check (bad format vs. disallowed protocol) exactly so
 * neither user-visible string changes.
 *
 * Every field other than an action-switch discriminant stays a manual
 * required/format check in the route handler (no `details`, byte-identical
 * message) unless called out above — same split as `src/lib/schemas/agents.ts`.
 *
 * `GET /api/status`, `GET /api/system`, and `GET /api/live` take no body or
 * query input, so this file has no schemas for them.
 */
import { z } from "zod";

// ── POST /api/permissions ───────────────────────────────────────────────
//
// T-02-44 (Elevation of Privilege): this route writes exec-approval and
// elevated-tool policy. A malformed or unrecognized-action payload must be
// rejected before any policy write, not after a partial one. Required-field
// checks (`pattern`, at least one of security/ask/askFallback) and the
// security/ask/askFallback enum-format checks stay manual in the route
// handler — the latter's existing behavior returns 500 on an invalid enum
// value (not 400), and D-06 of this phase requires preserving every
// existing status code, so that check is not moved into the schema (which
// would turn it into a 400).

const permissionsAllowPatternAction = z
  .object({
    action: z.literal("allow-pattern"),
    pattern: z.string().optional(),
    agentId: z.string().optional(),
  })
  .passthrough();

const permissionsRevokePatternAction = z
  .object({
    action: z.literal("revoke-pattern"),
    pattern: z.string().optional(),
    agentId: z.string().optional(),
  })
  .passthrough();

const permissionsSetElevatedAction = z
  .object({
    action: z.literal("set-elevated"),
    enabled: z.unknown().optional(),
  })
  .passthrough();

const permissionsSetApprovalsDefaultsAction = z
  .object({
    action: z.literal("set-approvals-defaults"),
    security: z.unknown().optional(),
    ask: z.unknown().optional(),
    askFallback: z.unknown().optional(),
  })
  .passthrough();

export const permissionsPostSchema = z.discriminatedUnion("action", [
  permissionsAllowPatternAction,
  permissionsRevokePatternAction,
  permissionsSetElevatedAction,
  permissionsSetApprovalsDefaultsAction,
]);
export type PermissionsPostInput = z.infer<typeof permissionsPostSchema>;

// ── POST /api/heartbeat ─────────────────────────────────────────────────
//
// Loose action string — not in the T-02-44 threat register, and its
// pre-migration "action required" / "Unknown action: <value>" messages are
// preserved by keeping the discriminant out of the schema entirely.

export const heartbeatPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type HeartbeatPostInput = z.infer<typeof heartbeatPostSchema>;

// ── POST /api/browser/relay ─────────────────────────────────────────────
//
// T-02-45 (Elevation of Privilege): a caller-supplied forwarding target
// drives an outbound server-side request. `url` is only meaningful for the
// "open-test-tab" action (mirroring the route's original branch-scoped
// check), so the gate is a `superRefine` rather than a schema-wide field —
// an `action` of anything else never inspects `url` at all, matching
// pre-migration behavior exactly.

export const BROWSER_RELAY_ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
export const BROWSER_RELAY_DEFAULT_TEST_URL = "https://docs.openclaw.ai/tools/browser";
const BROWSER_RELAY_URL_FORMAT_MESSAGE = "Invalid URL format.";
const BROWSER_RELAY_URL_PROTOCOL_MESSAGE =
  "Invalid URL protocol. Only http:// and https:// URLs are allowed.";

export function isAllowedBrowserRelayUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return BROWSER_RELAY_ALLOWED_URL_SCHEMES.has(parsed.protocol);
}

export const browserRelayPostSchema = z
  .object({
    action: z.string().optional(),
    profile: z.string().nullable().optional(),
    url: z.string().optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.action !== "open-test-tab") return;
    const targetUrl = (value.url || "").trim() || BROWSER_RELAY_DEFAULT_TEST_URL;
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: BROWSER_RELAY_URL_FORMAT_MESSAGE, path: ["url"] });
      return;
    }
    if (!BROWSER_RELAY_ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: BROWSER_RELAY_URL_PROTOCOL_MESSAGE, path: ["url"] });
    }
  });
export type BrowserRelayPostInput = z.infer<typeof browserRelayPostSchema>;

export const browserRelayGetQuerySchema = z
  .object({
    profile: z.string().optional(),
  })
  .passthrough();
export type BrowserRelayGetQuery = z.infer<typeof browserRelayGetQuerySchema>;

// ── POST /api/security ──────────────────────────────────────────────────
//
// T-02-44 (Elevation of Privilege), same reasoning as permissions above:
// this route writes instance-level security state (`security audit --fix`
// mutates files under `~/.openclaw`). Rejection fires before any write.

const securityAuditAction = z
  .object({
    action: z.literal("audit"),
    mode: z.string().optional(),
  })
  .passthrough();

const securityFixAction = z.object({ action: z.literal("fix") }).passthrough();
const securityCheckSecretsAction = z.object({ action: z.literal("check-secrets") }).passthrough();
const securityCheckModelsAction = z.object({ action: z.literal("check-models") }).passthrough();

export const securityPostSchema = z.discriminatedUnion("action", [
  securityAuditAction,
  securityFixAction,
  securityCheckSecretsAction,
  securityCheckModelsAction,
]);
export type SecurityPostInput = z.infer<typeof securityPostSchema>;

export const securityGetQuerySchema = z
  .object({
    run: z.string().optional(),
    mode: z.string().optional(),
  })
  .passthrough();
export type SecurityGetQuery = z.infer<typeof securityGetQuerySchema>;

// ── POST /api/devices ────────────────────────────────────────────────────
//
// T-02-48 (Tampering): a device-record mutation must not fall through an
// unrecognized action to a default branch that alters a record. Required
// fields (`requestId`, `deviceId`+`role`) stay manual checks in the route
// handler so their exact pre-migration messages survive.

const devicesApproveAction = z
  .object({ action: z.literal("approve"), requestId: z.string().optional() })
  .passthrough();
const devicesRejectAction = z
  .object({ action: z.literal("reject"), requestId: z.string().optional() })
  .passthrough();
const devicesRevokeAction = z
  .object({
    action: z.literal("revoke"),
    deviceId: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

export const devicesPostSchema = z.discriminatedUnion("action", [
  devicesApproveAction,
  devicesRejectAction,
  devicesRevokeAction,
]);
export type DevicesPostInput = z.infer<typeof devicesPostSchema>;

// ── GET /api/capabilities ────────────────────────────────────────────────
//
// `refresh` is a bare optional flag string ("1", "true", or any non-empty
// value forces a fresh probe read) — the handler only checks truthiness, so
// this schema just guards that a non-string query value can't reach it.

export const capabilitiesGetQuerySchema = z
  .object({
    refresh: z.string().optional(),
  })
  .passthrough();
export type CapabilitiesGetQuery = z.infer<typeof capabilitiesGetQuerySchema>;
