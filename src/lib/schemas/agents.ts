/**
 * Zod schema for `POST /api/agents` — ports the inline validation that used
 * to live in the route's `action` switch (see `src/app/api/agents/route.ts`
 * git history) to a discriminated union, one action per case.
 *
 * Envelope-shape note: a *missing* required field (e.g. no `name`, no `id`)
 * is intentionally left for the route handler to check directly — that keeps
 * matching the original `if (!name) return ...` behavior, whose error body
 * carries no `details` tree. A *present but malformed* value (e.g. `name`
 * that fails the format regex) IS caught by this schema, so it goes through
 * `validationFailed()` in `src/lib/api-route.ts` and carries a `details`
 * tree built from `z.treeifyError()`. Every field not given an explicit
 * check here is passed through unchanged via `.passthrough()` so the
 * existing business logic (which reads many optional fields per action)
 * keeps working without a full rewrite of the handler's field access.
 */
import { z } from "zod";

/** Same name-format rule as the original inline check in the "create" case. */
export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const NAME_FORMAT_MESSAGE =
  "Agent name must start with a letter/number and contain only letters, numbers, hyphens, or underscores";

const optionalAgentName = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  })
  .refine((value) => value === undefined || AGENT_NAME_PATTERN.test(value), {
    message: NAME_FORMAT_MESSAGE,
  });

const createAction = z
  .object({
    action: z.literal("create"),
    name: optionalAgentName,
  })
  .passthrough();

const updateAction = z
  .object({
    action: z.literal("update"),
  })
  .passthrough();

const reorderAction = z
  .object({
    action: z.literal("reorder"),
  })
  .passthrough();

const setIdentityAction = z
  .object({
    action: z.literal("set-identity"),
  })
  .passthrough();

const saveIdentityMarkdownAction = z
  .object({
    action: z.literal("save-identity-markdown"),
  })
  .passthrough();

const deleteAction = z
  .object({
    action: z.literal("delete"),
  })
  .passthrough();

export const agentsPostSchema = z.discriminatedUnion("action", [
  createAction,
  updateAction,
  reorderAction,
  setIdentityAction,
  saveIdentityMarkdownAction,
  deleteAction,
]);

export type AgentsPostInput = z.infer<typeof agentsPostSchema>;
