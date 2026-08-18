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
