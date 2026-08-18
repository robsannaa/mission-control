/**
 * Zod schema for `POST /api/auth/login` — the one route in this codebase
 * reachable by a fully anonymous caller (T-02-21 in
 * `.planning/phases/02-server-contract-hardening/02-05-PLAN.md`).
 *
 * Unlike every other schema in this batch (`src/lib/schemas/onboarding.ts`),
 * `token` here is NOT left as a manual required-field check in the handler.
 * The plan's must_haves are explicit: a malformed sign-in payload must be
 * rejected — with a `details` issue tree naming the field path, never the
 * submitted value — before any credential comparison happens. Moving the
 * required-ness check into the schema is what buys that ordering: `withRoute`
 * runs `loginPostSchema.safeParse(...)` before the handler (and therefore
 * before `constantTimeEquals`) ever executes.
 *
 * `/api/auth/logout` has no request body — there is no sign-out schema to
 * pair with this one (docs/API-CONTRACT.md §3: "a field with a format rule
 * belongs in the schema" only applies when there is a field to validate).
 */
import { z } from "zod";

export const loginPostSchema = z
  .object({
    token: z.string().trim().min(1, "An access token is required"),
  })
  .passthrough();
export type LoginPostInput = z.infer<typeof loginPostSchema>;
