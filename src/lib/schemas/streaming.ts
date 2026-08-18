/**
 * Zod schemas for the pre-stream inputs of Mission Control's streaming and
 * long-lived routes (`docs/API-CONTRACT.md` §4 — the passthrough rule).
 *
 * These routes are wrapped with `withPassthroughRoute`, never `withRoute`
 * (see `src/lib/api-route.ts`): validation here runs on the request body
 * and query string only, in the setup phase, before any handler constructs
 * a stream. Once a handler returns a stream-backed `Response`, the wrapper
 * never touches it again.
 *
 * Schemas here are deliberately permissive (`.passthrough()`, optional
 * fields) — they exist to reject a structurally malformed body before a
 * stream opens (D-01's "malformed body" truth), not to newly require fields
 * these routes have always treated as optional. A field that's simply
 * *missing* stays a manual check in the route handler (same pattern as
 * `src/lib/schemas/agents.ts`); only shape/type mismatches are caught here.
 */
import { z } from "zod";

// ── Chat-family message shape (chat, chat/stream) ──────────────────────

const chatMessagePartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    url: z.string().optional(),
    filename: z.string().optional(),
    mimeType: z.string().optional(),
  })
  .passthrough();

const chatMessageSchema = z
  .object({
    role: z.string(),
    parts: z.array(chatMessagePartSchema).optional(),
    content: z.string().optional(),
  })
  .passthrough();

// ── POST /api/chat ──────────────────────────────────────────────────────

export const chatPostSchema = z
  .object({
    messages: z.array(chatMessageSchema).optional(),
    agentId: z.string().optional(),
    agent: z.string().optional(),
    sessionKey: z.string().optional(),
    nudgeContext: z.string().optional(),
  })
  .passthrough();
export type ChatPostInput = z.infer<typeof chatPostSchema>;

// ── POST /api/chat/stream ───────────────────────────────────────────────

export const chatStreamPostSchema = z
  .object({
    messages: z.array(chatMessageSchema).optional(),
    agentId: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    sessionKey: z.string().optional(),
  })
  .passthrough();
export type ChatStreamPostInput = z.infer<typeof chatStreamPostSchema>;

// ── POST /api/onboarding/chat ───────────────────────────────────────────

export const onboardingChatPostSchema = z
  .object({
    prompt: z.string().optional(),
  })
  .passthrough();
export type OnboardingChatPostInput = z.infer<typeof onboardingChatPostSchema>;

// ── POST /api/doctor/run ────────────────────────────────────────────────
//
// `mode` stays a bare string (not a zod enum): the route's own
// `MODES`-membership check owns the "unknown mode" error, including the
// `expected` modes list in its response — moving that into the schema
// would swap the route's specific error message for Zod's generic one.

export const doctorRunPostSchema = z
  .object({
    mode: z.string().optional(),
    acknowledgeMutation: z.boolean().optional(),
  })
  .passthrough();
export type DoctorRunPostInput = z.infer<typeof doctorRunPostSchema>;

// ── POST /api/doctor/fix ────────────────────────────────────────────────

export const doctorFixPostSchema = z
  .object({
    fixId: z.string().optional(),
    confirm: z.boolean().optional(),
  })
  .passthrough();
export type DoctorFixPostInput = z.infer<typeof doctorFixPostSchema>;

// ── /api/terminal ───────────────────────────────────────────────────────
//
// POST control actions (threat T-02-06): a discriminated union on `action`
// means an action outside the four known literals fails schema validation
// before the handler — and therefore before the PTY session map or
// subprocess bridge — is ever reached. `cols`/`rows` use `z.coerce.number()`
// to keep the route's existing tolerance for a numeric-looking string,
// while still rejecting a value `Number()` can't make sense of.

const terminalCreateAction = z
  .object({
    action: z.literal("create"),
    cols: z.coerce.number().optional(),
    rows: z.coerce.number().optional(),
  })
  .passthrough();

const terminalInputAction = z
  .object({
    action: z.literal("input"),
    session: z.string().optional(),
    data: z.string().optional(),
  })
  .passthrough();

const terminalResizeAction = z
  .object({
    action: z.literal("resize"),
    session: z.string().optional(),
    cols: z.coerce.number().optional(),
    rows: z.coerce.number().optional(),
  })
  .passthrough();

const terminalKillAction = z
  .object({
    action: z.literal("kill"),
    session: z.string().optional(),
  })
  .passthrough();

export const terminalPostSchema = z.discriminatedUnion("action", [
  terminalCreateAction,
  terminalInputAction,
  terminalResizeAction,
  terminalKillAction,
]);
export type TerminalPostInput = z.infer<typeof terminalPostSchema>;

export const terminalGetQuerySchema = z
  .object({
    action: z.string().optional(),
    session: z.string().optional(),
  })
  .passthrough();
export type TerminalGetQuery = z.infer<typeof terminalGetQuerySchema>;

// ── POST /api/skills/install ────────────────────────────────────────────

export const skillsInstallPostSchema = z
  .object({
    name: z.string().optional(),
    installId: z.string().optional(),
    agentId: z.string().optional(),
  })
  .passthrough();
export type SkillsInstallPostInput = z.infer<typeof skillsInstallPostSchema>;

// ── GET /api/stats/stream ───────────────────────────────────────────────
//
// The route reads no query parameters today; this schema exists so the
// route can still be wrapped through the same `querySchema` contract as
// every other passthrough route, and so a future query param gets a home.

export const statsStreamQuerySchema = z.object({}).passthrough();
export type StatsStreamQuery = z.infer<typeof statsStreamQuerySchema>;
