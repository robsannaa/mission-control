/**
 * Zod schema for `POST /api/accounts`.
 *
 * The route has a single action, `update-env-key`. It is still modeled as a
 * one-branch `z.discriminatedUnion` (not a bare `z.string().optional()`)
 * because that is what makes an unrecognized `action` fail schema
 * validation before the handler's env-key-write logic runs at all — the
 * same T-02-27 (elevation-of-privilege) mitigation applied to
 * `src/lib/schemas/integrations.ts` in this plan, precedented by the
 * `terminalPostSchema` discriminated union in `src/lib/schemas/streaming.ts`
 * (T-02-06). The visible side effect: an unrecognized action now produces
 * Zod's own "Invalid discriminator value" message (with a `details` tree)
 * instead of the route's former hand-written `Unknown action: <value>`
 * string — an intentional, precedented deviation, not an oversight.
 *
 * `key`/`value` stay required-in-handler checks (the route's
 * `ENV_KEY_NAME_RE` format guard and empty-value guard) so those specific
 * messages are byte-identical to before migration — same "required stays
 * manual, format stays manual when it already carries a specific message"
 * split as `src/lib/schemas/agents.ts`.
 */
import { z } from "zod";

const updateEnvKeyAction = z
  .object({
    action: z.literal("update-env-key"),
  })
  .passthrough();

export const accountsPostSchema = z.discriminatedUnion("action", [updateEnvKeyAction]);

export type AccountsPostInput = z.infer<typeof accountsPostSchema>;
