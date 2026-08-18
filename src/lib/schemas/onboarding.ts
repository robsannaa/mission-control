/**
 * Zod schemas for the onboarding/pairing route group (`/api/onboard`,
 * `/api/onboarding/*`, `/api/pairing`).
 *
 * Every schema here follows the same split documented in
 * `src/lib/schemas/agents.ts` and `src/lib/schemas/gateway.ts`: `action`
 * stays an optional/loose string rather than a strict `z.enum([...])` or
 * `z.discriminatedUnion(...)`, because every route in this group already
 * answers an unrecognized action with its own specific `Unknown action:
 * <value>` message (D-06, plain language) — a stricter schema would replace
 * that message with a generic Zod one for the same input, violating this
 * plan's message-preservation rule. Required-field checks for business
 * fields (provider, token, channel, code, requestId, etc.) likewise stay
 * manual in each route handler so their exact pre-migration error bodies
 * (no `details` tree) are unchanged.
 *
 * What the schema DOES add: every body must parse to a plain JSON object
 * (`.passthrough()` — arbitrary extra keys pass through untyped, matching
 * every route handler's existing wide field access). Before this, a
 * non-object JSON body (`null`, an array, a bare string) reached the
 * handler's `body.action` access unguarded — `null` in particular throws a
 * TypeError that the handler's outer catch turned into a 500. Rejecting a
 * non-object body at the schema layer with a 400 instead of crashing to 500
 * is a Rule 1 correctness fix, not a new validation rule the route didn't
 * already assume.
 */
import { z } from "zod";

/** Every route in this file accepts a plain JSON object with an optional,
 *  loosely-typed `action` discriminant — see the module doc above for why
 *  `action` is not a strict enum/discriminated union here. */
const looseActionBody = z.object({ action: z.string().optional() }).passthrough();

export const onboardPostSchema = looseActionBody;
export type OnboardPostInput = z.infer<typeof onboardPostSchema>;

export const modelAuthPostSchema = looseActionBody;
export type ModelAuthPostInput = z.infer<typeof modelAuthPostSchema>;

export const pairingPostSchema = looseActionBody;
export type PairingPostInput = z.infer<typeof pairingPostSchema>;

export const onboardingChannelPostSchema = looseActionBody;
export type OnboardingChannelPostInput = z.infer<typeof onboardingChannelPostSchema>;

export const onboardingDetectPostSchema = looseActionBody;
export type OnboardingDetectPostInput = z.infer<typeof onboardingDetectPostSchema>;

/**
 * `/api/onboarding/state` has no `action` field — its POST body is
 * `{ patch: Partial<OnboardingState> }`. `patch` stays `z.unknown().optional()`
 * so the handler's own `isRecord(patch)` check keeps producing the exact
 * pre-migration "patch object is required" body (no `details` tree) for a
 * missing/malformed patch.
 */
export const onboardingStatePostSchema = z
  .object({ patch: z.unknown().optional() })
  .passthrough();
export type OnboardingStatePostInput = z.infer<typeof onboardingStatePostSchema>;
