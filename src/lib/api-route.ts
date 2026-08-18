/**
 * Shared API route wrappers — the migration contract every route in
 * `src/app/api/**` adopts across this phase (D-05).
 *
 * `withRoute` handles the common request lifecycle for ordinary JSON routes:
 * validate body/query/params against Zod schemas, invoke the handler, catch
 * anything it throws, and log exactly one structured line per request.
 *
 * `withPassthroughRoute` is the variant for streaming routes (SSE, PTY) — it
 * runs the same pre-stream validation, but returns whatever the handler
 * returns untouched: no status read, no body inspection, no re-wrapping.
 * Reading `.status` off a streaming `Response` is technically safe (it's a
 * property set at construction, not a body read), but this wrapper still
 * avoids it so the passthrough contract stays simple and never has to be
 * re-audited as streaming internals change (see `src/lib/doctor-sse.ts`,
 * `src/app/api/chat/stream/route.ts`, `src/app/api/terminal/route.ts`).
 */
import type { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { readJsonBody } from "@/lib/http";
import { apiError, validationFailed, serverError } from "@/lib/api-errors";
import { logger, childLogger, safeLog } from "@/lib/logger";
import type pino from "pino";

/** Matches the size guard used elsewhere in the codebase (e.g. tasks route). */
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Matches the shape Next.js's App Router always passes as the second route
 * handler argument (`{ params: Promise<...> }`) — required, and always a
 * Promise, even for routes with no dynamic segments. Next's own generated
 * route type-check (`.next/types/app/**`) enforces this exact shape, so this
 * type must not add `?` or a non-Promise alternative.
 */
export type NextRouteContext<P = Record<string, string>> = {
  params: Promise<P>;
};

export type RouteHandlerCtx<B = unknown, Q = unknown, P = Record<string, string>> = {
  body: B;
  query: Q;
  params: P;
  log: pino.Logger;
};

export type WithRouteOptions<B = unknown, Q = unknown, P = Record<string, string>> = {
  bodySchema?: ZodType<B>;
  querySchema?: ZodType<Q>;
  routeSchema?: ZodType<P>;
  maxBytes?: number;
  /** Log/route identifier. Defaults to the request pathname. */
  name?: string;
};

export type RouteHandler<B = unknown, Q = unknown, P = Record<string, string>> = (
  request: NextRequest,
  ctx: RouteHandlerCtx<B, Q, P>,
) => Promise<Response> | Response;

function routeNameFor(opts: { name?: string }, request: NextRequest): string {
  return opts.name || request.nextUrl.pathname;
}

function logOneLine(
  routeName: string,
  method: string,
  status: number,
  startedAt: number,
  err?: unknown,
) {
  safeLog(() => {
    const durationMs = Date.now() - startedAt;
    if (err !== undefined) {
      logger.error({
        route: routeName,
        method,
        status,
        durationMs,
        err: err instanceof Error ? { message: err.message, stack: err.stack } : String(err),
      });
      return;
    }
    logger.info({ route: routeName, method, status, durationMs });
  });
}

/**
 * `readJsonBody` (src/lib/http.ts) predates the canonical envelope and
 * answers `{ error: string }` with no `ok` field. Re-shape its response
 * through `apiError` so every error this wrapper returns — including the
 * body-parsing/size-guard failures readJsonBody catches — carries `ok: false`
 * (D-01), without reimplementing readJsonBody's own maxBytes/JSON-parse logic.
 */
async function normalizeReadJsonBodyError(response: Response): Promise<Response> {
  let message = "Invalid request";
  try {
    const original = (await response.clone().json()) as { error?: unknown };
    if (typeof original.error === "string") message = original.error;
  } catch {
    // Body wasn't JSON (shouldn't happen for readJsonBody's own responses) —
    // fall back to the generic message rather than throwing.
  }
  return apiError(message, response.status);
}

/**
 * Resolve+validate the dynamic route params, query string, and JSON body for
 * a request against the schemas in `opts`. Returns either the validated
 * inputs or a ready-to-send error `Response` (mirroring `readJsonBody`'s
 * `{ ok, ... }` tuple idiom).
 */
async function resolveInputs<B, Q, P>(
  request: NextRequest,
  context: NextRouteContext<P>,
  opts: WithRouteOptions<B, Q, P>,
): Promise<{ ok: true; body: B; query: Q; params: P } | { ok: false; response: Response }> {
  let params: P = await context.params;
  if (opts.routeSchema) {
    const parsed = opts.routeSchema.safeParse(params);
    if (!parsed.success) return { ok: false, response: validationFailed(parsed.error) };
    params = parsed.data;
  }

  let query = {} as Q;
  if (opts.querySchema) {
    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = opts.querySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, response: validationFailed(parsed.error) };
    query = parsed.data;
  }

  let body = undefined as unknown as B;
  if (opts.bodySchema) {
    const read = await readJsonBody(request, { maxBytes: opts.maxBytes ?? DEFAULT_MAX_BODY_BYTES });
    if (!read.ok) return { ok: false, response: await normalizeReadJsonBodyError(read.response) };
    const parsed = opts.bodySchema.safeParse(read.body);
    if (!parsed.success) return { ok: false, response: validationFailed(parsed.error) };
    body = parsed.data;
  }

  return { ok: true, body, query, params };
}

/**
 * Wrap an ordinary (non-streaming) route handler. Validates body/query/params,
 * invokes `handler`, catches anything it throws, and logs exactly one
 * structured line per request. Returns a handler-built raw `Response`
 * (e.g. from `pairingRequiredResponse`) unchanged — reading `.status` for the
 * log line does not touch or clone the response body.
 */
export function withRoute<B = unknown, Q = unknown, P = Record<string, string>>(
  opts: WithRouteOptions<B, Q, P>,
  handler: RouteHandler<B, Q, P>,
) {
  return async function routeHandler(
    request: NextRequest,
    context: NextRouteContext<P>,
  ): Promise<Response> {
    const startedAt = Date.now();
    const routeName = routeNameFor(opts, request);
    const method = request.method;

    const inputs = await resolveInputs(request, context, opts);
    if (!inputs.ok) {
      logOneLine(routeName, method, inputs.response.status, startedAt);
      return inputs.response;
    }

    const log = childLogger({ route: routeName });

    try {
      const response = await handler(request, {
        body: inputs.body,
        query: inputs.query,
        params: inputs.params,
        log,
      });
      logOneLine(routeName, method, response.status, startedAt);
      return response;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const response = serverError(message);
      logOneLine(routeName, method, response.status, startedAt, err);
      return response;
    }
  };
}

/**
 * Wrap a streaming route handler (SSE, PTY). Runs the same pre-stream
 * validation as `withRoute`, then returns whatever `handler` returns exactly
 * as constructed — no status read, no body inspection, no re-wrapping. Use
 * this for any handler that returns a raw `ReadableStream`-backed `Response`.
 */
export function withPassthroughRoute<B = unknown, Q = unknown, P = Record<string, string>>(
  opts: WithRouteOptions<B, Q, P>,
  handler: RouteHandler<B, Q, P>,
) {
  return async function passthroughRouteHandler(
    request: NextRequest,
    context: NextRouteContext<P>,
  ): Promise<Response> {
    const startedAt = Date.now();
    const routeName = routeNameFor(opts, request);
    const method = request.method;

    const inputs = await resolveInputs(request, context, opts);
    if (!inputs.ok) {
      logOneLine(routeName, method, inputs.response.status, startedAt);
      return inputs.response;
    }

    const log = childLogger({ route: routeName });

    // No try/catch, no status read, no body inspection past this point —
    // the handler owns everything about how the stream starts and ends.
    return handler(request, {
      body: inputs.body,
      query: inputs.query,
      params: inputs.params,
      log,
    });
  };
}
