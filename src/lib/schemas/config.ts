/**
 * Zod schema for `PATCH /api/config` — ports `validateConfigPayload`
 * (formerly inline in `src/app/api/config/route.ts`) one-for-one.
 *
 * Preserves every accepted shape, every rejection condition, and every
 * user-visible message string exactly — this is the "manual type checks"
 * precedent FOUND-03 exists to remove, not a behavior change (see
 * docs/API-CONTRACT.md §3, `.planning/phases/02-server-contract-hardening/02-04-PLAN.md`).
 *
 * D-04 note: this schema validates the PATCH write body only. It never
 * touches `restoreRedactedValues`, the redaction sentinel, or any part of
 * the GET response path — those stay exactly as they were before this
 * phase (`src/app/api/config/route.ts`).
 *
 * `superRefine` reproduces the original branching (`raw` takes priority over
 * `patch`; exactly one of the two, or neither, is an error) with the exact
 * original message text, so a failed parse still surfaces the same
 * human-readable string through `validationFailed()`'s first-issue message.
 * `.transform()` then computes `patchObj` once, so route handlers no longer
 * re-derive it from `raw`/`patch` themselves.
 */
import { z } from "zod";

const configWriteShape = z
  .object({
    raw: z.unknown().optional(),
    patch: z.unknown().optional(),
    baseHash: z.unknown().optional(),
    replacePaths: z.unknown().optional(),
    mode: z.unknown().optional(),
  })
  .passthrough();

export const configWriteSchema = configWriteShape
  .superRefine((data, ctx) => {
    if (data.raw !== undefined) {
      if (typeof data.raw !== "string") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "raw must be a JSON string", path: ["raw"] });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.raw);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid JSON: ${msg}`, path: ["raw"] });
        return;
      }
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Config must be a JSON object (not array or primitive)",
          path: ["raw"],
        });
      }
      return;
    }
    if (data.patch !== undefined) {
      if (data.patch === null || typeof data.patch !== "object" || Array.isArray(data.patch)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "patch must be a JSON object", path: ["patch"] });
      }
      return;
    }
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "raw or patch required", path: [] });
  })
  .transform((data) => {
    const patchObj: Record<string, unknown> =
      typeof data.raw === "string"
        ? (JSON.parse(data.raw) as Record<string, unknown>)
        : (data.patch as Record<string, unknown>);
    return {
      patchObj,
      raw: typeof data.raw === "string" ? data.raw : undefined,
      baseHash: typeof data.baseHash === "string" ? data.baseHash : undefined,
      replacePaths: data.replacePaths,
      mode: data.mode,
    };
  });

export type ConfigWriteInput = z.infer<typeof configWriteSchema>;
