import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { sanitizeConfigFile } = await import("./src/lib/gateway-config");
  await sanitizeConfigFile().catch(() => {});
}

/**
 * Captures an error that escapes a route handler entirely — the one class
 * of server error no route-level try/catch, `withRoute`, or
 * `withPassthroughRoute` can see (02-03-PLAN.md Task 1). Delegates to
 * `src/lib/instrumentation-error.ts` so the reporter logic is unit-tested
 * outside the Next.js instrumentation lifecycle; this export stays a thin,
 * runtime-guarded binding, matching `register()`'s own guard above.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { reportRequestError } = await import("./src/lib/instrumentation-error");
  reportRequestError(err, request, context);
};
