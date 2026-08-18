/**
 * Zod schemas for the integrations, connected-accounts-adjacent, and
 * channels route group (`/api/integrations/**`, `/api/channels/**`).
 *
 * Action-switch schemas (`integrationsPostSchema`, `channelsPostSchema`) are
 * `z.discriminatedUnion("action", [...])`, one literal per known action —
 * not the looser `z.string().optional()` pattern used in
 * `src/lib/schemas/gateway.ts` / `src/lib/schemas/onboarding.ts`. That is a
 * deliberate difference: this route group is the only one in the phase
 * where an unrecognized action, left unchecked, sits directly upstream of a
 * credential-bearing external provider call (Gmail, Calendar, Drive) —
 * T-02-27 in `.planning/phases/02-server-contract-hardening/02-06-PLAN.md`.
 * A discriminated union rejects an unrecognized `action` at the schema
 * layer, before the handler's switch (and therefore before any provider
 * call) is reached. The same pattern was already applied to
 * `terminalPostSchema` in `src/lib/schemas/streaming.ts` for the same
 * reason (T-02-06). The visible trade-off, also accepted there: an
 * unrecognized action now produces Zod's own "Invalid discriminator value"
 * message (with a `details` tree) instead of each route's former
 * hand-written `Unknown action: <value>` string. Every *other* field
 * (email, accessLevel, capability, service, policy, channel id, token,
 * ...) stays a manual required/format check in the route handler exactly
 * as before, so those specific messages are untouched — same split as
 * `src/lib/schemas/agents.ts`.
 *
 * The six dynamic google-account routes (`/api/integrations/google/accounts`
 * and its five `[id]` sub-routes) share `googleAccountRouteParamsSchema` so
 * the `[id]` path segment is format- and length-bounded before it ever
 * reaches an account-store lookup (T-02-24). The bound matches
 * `crypto.randomUUID()` — the only way `src/lib/google-integrations-store.ts`
 * ever mints an account id — while staying slightly more permissive than a
 * strict UUID regex so a legacy/hand-edited store entry with a
 * non-canonical-but-still-safe id string isn't newly locked out.
 */
import { z } from "zod";

// ── Shared query schema: `?agentId=` ────────────────────────────────────
//
// Every GET in this group reads an optional `agentId` query param the same
// way (`request.nextUrl.searchParams.get("agentId")`, `null` when absent).
// Nothing here was previously validated, so this only guards the type.

export const agentIdQuerySchema = z
  .object({
    agentId: z.string().optional(),
  })
  .passthrough();
export type AgentIdQuery = z.infer<typeof agentIdQuerySchema>;

// ── Shared route-param schema: the dynamic `[id]` segment ──────────────
//
// Bounded length + character set (T-02-24) — no account lookup ever runs
// against a segment that fails this check.

export const GOOGLE_ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export const googleAccountRouteParamsSchema = z.object({
  id: z.string().regex(GOOGLE_ACCOUNT_ID_PATTERN, "Invalid Google account id"),
});
export type GoogleAccountRouteParams = z.infer<typeof googleAccountRouteParamsSchema>;

// ── GET /api/integrations/apple/events ──────────────────────────────────
//
// `days` stays a bare optional string — `readAppleCalendarEvents` already
// does its own `Number(...)` + `Number.isFinite` + clamp, so this schema
// only guards that a non-string query value can't reach that conversion.

export const appleEventsQuerySchema = z
  .object({
    days: z.string().optional(),
  })
  .passthrough();
export type AppleEventsQuery = z.infer<typeof appleEventsQuerySchema>;

// ── POST /api/integrations ──────────────────────────────────────────────

const integrationsActionLiterals = [
  "start-connect",
  "poll-auth-status",
  "finish-connect",
  "import-existing-account",
  "disconnect-account",
  "set-access-level",
  "set-custom-capability",
  "set-service-access",
  "set-agent-policy",
  "set-watch-config",
  "setup-watch",
  "check-access",
  "gmail-search",
  "gmail-read-thread",
  "gmail-draft",
  "gmail-reply",
  "gmail-send",
  "calendar-list",
  "calendar-create",
  "calendar-update",
  "approve-request",
  "deny-request",
] as const;

const integrationsActionVariants = integrationsActionLiterals.map((action) =>
  z.object({ action: z.literal(action) }).passthrough(),
) as [
  z.ZodObject<{ action: z.ZodLiteral<(typeof integrationsActionLiterals)[number]> }>,
  ...z.ZodObject<{ action: z.ZodLiteral<(typeof integrationsActionLiterals)[number]> }>[],
];

export const integrationsPostSchema = z.discriminatedUnion("action", integrationsActionVariants);
export type IntegrationsPostInput = z.infer<typeof integrationsPostSchema>;

// ── POST /api/channels ───────────────────────────────────────────────────

const channelsActionLiterals = ["add", "connect", "disconnect", "delete", "set-policy"] as const;

const channelsActionVariants = channelsActionLiterals.map((action) =>
  z.object({ action: z.literal(action) }).passthrough(),
) as [
  z.ZodObject<{ action: z.ZodLiteral<(typeof channelsActionLiterals)[number]> }>,
  ...z.ZodObject<{ action: z.ZodLiteral<(typeof channelsActionLiterals)[number]> }>[],
];

export const channelsPostSchema = z.discriminatedUnion("action", channelsActionVariants);
export type ChannelsPostInput = z.infer<typeof channelsPostSchema>;

// ── GET /api/channels/health ─────────────────────────────────────────────

export const channelsHealthQuerySchema = z
  .object({
    channel: z.string().optional(),
  })
  .passthrough();
export type ChannelsHealthQuery = z.infer<typeof channelsHealthQuerySchema>;
