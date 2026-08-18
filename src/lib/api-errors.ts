/**
 * Canonical API error envelope + response builders.
 *
 * Every API route in this codebase answers an error with the same shape:
 * `{ ok: false, error: string, details?: unknown }` (D-01, docs/API-CONTRACT.md).
 * `details` is populated only from a Zod schema issue tree — never from a raw
 * request body or a raw gateway error object (threat T-02-02), so a credential
 * submitted in a malformed body is never echoed back to the client.
 *
 * Kept free of Next-runtime-only imports beyond `next/server` so this module
 * stays importable from tests outside the Next runtime, matching the note on
 * `pairingRequiredResponse` in `src/lib/gateway-errors.ts`.
 */
import { NextResponse } from "next/server";
import { z } from "zod";

export type ApiErrorBody = {
  ok: false;
  error: string;
  details?: unknown;
};

/** Build an error `Response` carrying the canonical envelope. */
export function apiError(message: string, status: number, details?: unknown): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = details === undefined ? { ok: false, error: message } : { ok: false, error: message, details };
  return NextResponse.json(body, { status });
}

export function badRequest(message: string, details?: unknown): NextResponse<ApiErrorBody> {
  return apiError(message, 400, details);
}

export function unauthorized(message = "Unauthorized"): NextResponse<ApiErrorBody> {
  return apiError(message, 401);
}

export function forbidden(message = "Forbidden"): NextResponse<ApiErrorBody> {
  return apiError(message, 403);
}

export function notFound(message = "Not found"): NextResponse<ApiErrorBody> {
  return apiError(message, 404);
}

export function conflict(message: string): NextResponse<ApiErrorBody> {
  return apiError(message, 409);
}

export function payloadTooLarge(message = "Payload too large"): NextResponse<ApiErrorBody> {
  return apiError(message, 413);
}

export function serverError(message: string): NextResponse<ApiErrorBody> {
  return apiError(message, 500);
}

/**
 * Build the 400 response for a failed `schema.safeParse(...)`. `error` is
 * the first issue's own message (plain language, set by the schema — D-06),
 * falling back to a generic message only when Zod produced no issues at all.
 * `details` is always `z.treeifyError()` output — the Zod v4 standalone
 * function, never the removed v3 `.format()` instance method — so it can
 * never carry a raw request body or a raw gateway error object.
 */
export function validationFailed(error: z.ZodError): NextResponse<ApiErrorBody> {
  const message = error.issues[0]?.message || "Invalid request";
  return badRequest(message, z.treeifyError(error));
}
