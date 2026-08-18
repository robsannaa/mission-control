/**
 * Zod schemas for the usage, cost and models route group
 * (`/api/usage/**`, `/api/models/**`).
 *
 * `usageProviderRouteParamsSchema` is the reference example of the
 * "route-parameter" slot in `withRoute`'s options: the dynamic `[provider]`
 * segment on `/api/usage/providers/[provider]` is constrained to
 * `SUPPORTED_BILLING_PROVIDERS` — the exact array `src/lib/provider-billing/
 * shared.ts` keys `PROVIDER_BILLING_REQUIREMENTS` (its billing/pricing
 * lookup table) on. An unknown provider segment is now rejected by the
 * wrapper (400, `details` tree) *before* the route handler runs, so it can
 * never reach `getProviderSnapshot()` and produce a misleading empty result
 * (T-02-30). This replaces the route's former inline
 * `supportedProviders.includes(...)` check (501) — that check is now dead
 * code and has been removed from the route file.
 *
 * `modelsPostSchema` is a `z.discriminatedUnion("action", [...])`, matching
 * the precedent set in `src/lib/schemas/integrations.ts` (not the looser
 * `z.string().optional()` pattern in `src/lib/schemas/gateway.ts`) — POST
 * `/api/models`'s actions sit directly upstream of provider credential
 * writes (`auth-provider`, `remove-provider`, `list-models`, `test-key`),
 * the same justification as `integrationsPostSchema`'s T-02-27. The visible
 * trade-off, accepted there and here: an unrecognized `action` now produces
 * Zod's own "Invalid input" discriminator message (with a `details` tree)
 * instead of the route's former hand-written `Unknown action: <value>`
 * string, pinned in `src/app/api/models/route.test.ts`.
 *
 * Every other action (`usage-alerts`, `usage-internal`'s `task`,
 * `usage/providers/[provider]`'s `save-credentials`) keeps the looser
 * "manual required/format check in the handler" split from
 * `src/lib/schemas/agents.ts` — none of those sit as directly upstream of a
 * credential write as the models action switch does, so their exact
 * `Unknown action`/`Unknown task` messages are preserved unchanged.
 */
import { z } from "zod";
import { SUPPORTED_BILLING_PROVIDERS } from "@/lib/provider-billing/shared";

// ── [provider] route param: /api/usage/providers/[provider] ────────────

/**
 * Cast (not widened to `string`) so `z.enum`'s inferred output keeps the
 * literal union `"openrouter" | "openai" | "anthropic"` — required for
 * `ctx.params.provider` to type-check as the parameter
 * `maybeCollectProvider`/`getAllProviderSnapshots` (both in
 * `src/lib/provider-billing/shared.ts`) already expect.
 */
type BillingProviderId = (typeof SUPPORTED_BILLING_PROVIDERS)[number];

export const usageProviderRouteParamsSchema = z.object({
  provider: z.enum(SUPPORTED_BILLING_PROVIDERS as [BillingProviderId, ...BillingProviderId[]]),
});
export type UsageProviderRouteParams = z.infer<typeof usageProviderRouteParamsSchema>;

// ── GET /api/usage/providers/[provider]?refresh= ────────────────────────

export const usageProviderRefreshQuerySchema = z
  .object({
    refresh: z.string().optional(),
  })
  .passthrough();
export type UsageProviderRefreshQuery = z.infer<typeof usageProviderRefreshQuerySchema>;

// ── POST /api/usage/providers/[provider] (save-credentials) ─────────────
//
// `action` stays a manual check (`action !== "save-credentials"` — the
// route's own "Unknown action" message is preserved); `values` is left
// loose (`z.record`) since the route itself filters it down to an
// allow-listed key set per provider (`PROVIDER_CREDENTIAL_KEYS`) before any
// value is used — narrowing it further here would duplicate that logic.

export const usageProviderPostSchema = z
  .object({
    action: z.string().optional(),
    values: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type UsageProviderPostInput = z.infer<typeof usageProviderPostSchema>;

// ── GET/POST /api/usage/alerts ───────────────────────────────────────────

export const usageAlertsPollQuerySchema = z
  .object({
    poll: z.string().optional(),
  })
  .passthrough();
export type UsageAlertsPollQuery = z.infer<typeof usageAlertsPollQuerySchema>;

/**
 * `action` stays `z.string().optional()` — the handler's own switch already
 * answers an unrecognized action with `Unknown action: <value>` (D-06), and
 * a stricter schema here would replace that with a generic Zod message.
 * Every other field (`kind`, `scopeType`, `timeline`, `thresholdValue`,
 * `ruleId`, ...) is validated exactly as before, inside the handler.
 */
export const usageAlertsPostSchema = z
  .object({
    action: z.string().optional(),
  })
  .passthrough();
export type UsageAlertsPostInput = z.infer<typeof usageAlertsPostSchema>;

// ── GET/POST /api/usage/internal?task=&token=&provider= ─────────────────
//
// This route is the one path exempted from the middleware auth gate
// (`src/middleware.ts`) — it authenticates itself via `isAuthorized()`
// (a token compared against `MISSION_CONTROL_USAGE_WEBHOOK_TOKEN` or the
// gateway token). None of that changes here; this schema only guards that
// `task`/`token`/`provider` are strings before `isAuthorized`/`handleTask`
// read them off `request.nextUrl.searchParams` — identical values, same
// `Unauthorized`/`Unknown task`/`Unsupported provider` messages.

export const usageInternalQuerySchema = z
  .object({
    task: z.string().optional(),
    token: z.string().optional(),
    provider: z.string().optional(),
  })
  .passthrough();
export type UsageInternalQuery = z.infer<typeof usageInternalQuerySchema>;

// ── POST /api/models ──────────────────────────────────────────────────
//
// Required-field checks inside each action (e.g. missing `provider`/`token`)
// stay manual in the route handler — same split as `src/lib/schemas/
// agents.ts` — so those specific error bodies carry no `details` tree.

const modelsActionLiterals = [
  "auth-provider",
  "probe-local",
  "connect-local",
  "remove-provider",
  "set-primary",
  "set-model-chain",
  "set-fallbacks",
  "list-models",
  "test-key",
] as const;

const modelsActionVariants = modelsActionLiterals.map((action) =>
  z.object({ action: z.literal(action) }).passthrough(),
) as [
  z.ZodObject<{ action: z.ZodLiteral<(typeof modelsActionLiterals)[number]> }>,
  ...z.ZodObject<{ action: z.ZodLiteral<(typeof modelsActionLiterals)[number]> }>[],
];

export const modelsPostSchema = z.discriminatedUnion("action", modelsActionVariants);
export type ModelsPostInput = z.infer<typeof modelsPostSchema>;
