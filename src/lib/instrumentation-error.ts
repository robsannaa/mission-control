/**
 * Uncaught-request-error reporter — the target `instrumentation.ts`'s
 * `onRequestError` export delegates to.
 *
 * Split into its own module because the Next.js instrumentation lifecycle
 * (`onRequestError`) is not reachable from the route-handler test harness
 * (`next-test-api-route-handler`) — `instrumentation.ts` stays a thin
 * runtime-guarded binding, and this module is what gets unit-tested
 * directly (02-03-PLAN.md Task 1).
 *
 * Next.js awaits `onRequestError` inside its own try/catch and swallows a
 * reporter failure with a bare fallback (RESEARCH.md Architecture Pattern 2)
 * — so the entire emit here is wrapped in `safeLog` (T-02-11): an unguarded
 * throw in the reporter would silently lose the original error on top of
 * whatever crashed the request.
 */
import { logger, safeLog } from "@/lib/logger";
import type pino from "pino";

/** Minimal shape of Next's `errorRequest` argument this reporter needs. */
export type RequestErrorDescriptor = {
  path: string;
  method: string;
};

/**
 * Minimal shape of Next's `errorContext` argument this reporter needs.
 * Intersected with `Record<string, unknown>` because Next's real
 * `RequestErrorContext` (and any caller-supplied context in tests) can carry
 * extra fields beyond `routeType` — those extra fields are logged too so the
 * shared logger's redact config (`src/lib/logger.ts`) can censor a
 * credential-named field wherever it lands in the shape (T-02-10), rather
 * than only ever seeing a narrowed-down `routeType`.
 */
export type RequestErrorReportContext = { routeType: string } & Record<string, unknown>;

/**
 * Report an error that escaped a route handler entirely (uncaught by any
 * route-level try/catch, `withRoute`, or `withPassthroughRoute`).
 *
 * `err` is `unknown` because Next.js — and JavaScript's `throw` in general —
 * places no constraint on what gets thrown; a non-`Error` value is
 * normalized to a message string rather than dropped. A `digest` property
 * (Next.js attaches this to some internal errors) is surfaced separately
 * when present so it survives the string coercion.
 */
export function reportRequestError(
  err: unknown,
  request: RequestErrorDescriptor,
  context: RequestErrorReportContext,
  log: pino.Logger = logger,
): void {
  safeLog(() => {
    const isError = err instanceof Error;
    const message = isError ? err.message : String(err);
    const digest = (err as { digest?: unknown })?.digest;
    const { routeType, ...restContext } = context;

    log.error({
      route: request.path,
      method: request.method,
      routeType,
      error: message,
      ...(isError && err.stack ? { stack: err.stack } : {}),
      ...(digest !== undefined ? { digest } : {}),
      ...(Object.keys(restContext).length > 0 ? { context: restContext } : {}),
    });
  });
}
