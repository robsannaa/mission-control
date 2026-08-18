# API Contract

Mission Control's `src/app/api/**` routes answer a single, predictable error
shape and are migrated onto two shared wrappers in `src/lib/api-route.ts`.
This document is the single source of truth for that contract — read it
before touching any route in `src/app/api/**`, and read it first if you are
executing plans 02-02 through 02-12 of the server-contract-hardening phase.

## 1. The canonical error envelope

Every error response in this codebase has exactly this shape:

```ts
type ApiErrorBody = {
  ok: false;
  error: string;      // plain-language message, no jargon (D-06)
  details?: unknown;   // present only for a failed schema.safeParse(...)
};
```

- `ok` is always `false` on an error response. There is no matching `ok: true`
  requirement on success responses — success shapes are unrelated to this
  contract (see §5).
- `error` is a short, human-readable message. No "gateway", "cron", "token",
  or "skills" jargon (product-wide jargon ban, carried into error strings by
  D-06 of this phase).
- `details` is populated **only** from a Zod schema issue tree
  (`z.treeifyError(error)` — the Zod v4 standalone function, never the
  removed v3 `.format()` instance method). `details` must never be assigned
  a raw request body or a raw gateway error object: doing so risks echoing a
  credential the caller submitted in a malformed body back into the response
  (threat T-02-02 in `.planning/phases/02-server-contract-hardening/02-01-PLAN.md`).
  A field that's simply *missing* is checked directly by the route handler
  (no `details`); a field that's *present but malformed* against a schema
  rule goes through `validationFailed()` and carries a `details` tree. See
  `src/lib/schemas/agents.ts` for the reference example of this split.

Build every error response through a builder in `src/lib/api-errors.ts` —
never construct `{ ok: false, ... }` by hand in a route file. The builders
are the single envelope producer; that's what keeps this shape consistent
across ~104 route files without each one re-deriving it.

## 2. Status-code table

| Builder (`src/lib/api-errors.ts`) | Status | Default message |
|---|---|---|
| `apiError(message, status, details?)` | caller-supplied | caller-supplied |
| `badRequest(message, details?)` | 400 | — |
| `unauthorized(message?)` | 401 | `"Unauthorized"` |
| `forbidden(message?)` | 403 | `"Forbidden"` |
| `notFound(message?)` | 404 | `"Not found"` |
| `conflict(message)` | 409 | — |
| `payloadTooLarge(message?)` | 413 | `"Payload too large"` |
| `serverError(message)` | 500 | — |
| `validationFailed(zodError)` | 400 | first Zod issue's own message |

`apiError` is the shared primitive every other builder calls; use it directly
only when you need a status code none of the named builders cover.

## 3. Migration recipe

Follow these steps for every route in `src/app/api/**` that is not already
migrated:

1. **Read the route.** Note every place it parses a JSON body, reads
   `request.nextUrl.searchParams`, or reads a dynamic segment (`[id]`,
   `[provider]`, etc.).
2. **Identify body and query inputs.** List the fields the route actually
   uses and which ones are required vs. optional today. Match the *current*
   behavior — don't invent new required fields as part of a migration.
3. **Add a schema module.** Create `src/lib/schemas/<group>.ts` (one file per
   route group, matching the route's URL segment — e.g. `agents.ts` for
   `/api/agents`). Export the Zod schema and its inferred type together
   (named exports, no default export, no barrel `index.ts` in
   `src/lib/schemas/` — parallel plans add sibling files and a shared barrel
   would be a write conflict). A field that is simply *required* can stay a
   manual check in the route handler if you want to preserve the exact
   original error body (no `details`); a field with a *format* rule (regex,
   enum, min/max) belongs in the schema so it gets a `details` tree for free.
4. **Wrap the exported verbs.** For an ordinary JSON route:
   ```ts
   export const POST = withRoute(
     { name: "/api/your-route", bodySchema: yourSchema },
     async (request, ctx) => {
       // ctx.body   — parsed, schema-validated body
       // ctx.query  — parsed, schema-validated query (if querySchema given)
       // ctx.params — resolved dynamic route params (if routeSchema given)
       // ctx.log    — a route-scoped structured logger
       ...
     },
   );
   ```
   For a streaming route (SSE, PTY), use `withPassthroughRoute` instead —
   see §4.
5. **Replace every error return with a builder.** Swap
   `NextResponse.json({ error: "..." }, { status })` (or the older
   `{ ok: false, error }` shape) for the matching `src/lib/api-errors.ts`
   builder, so the response always carries `ok: false`.
6. **Replace bare logging.** Swap `console.log` / `console.warn` /
   `console.error` for `ctx.log.info` / `ctx.log.warn` / `ctx.log.error`
   (the injected, route-scoped logger from `src/lib/logger.ts`). Do not call
   the module-level `logger` singleton directly from inside a wrapped
   handler — `ctx.log` already carries the route binding.
7. **Run `npm run test:unit`.** Confirm no regression in the fast lane, then
   add/extend a `route.test.ts` for the migrated route's pre-gateway
   validation branches (see the NTARH pattern in
   `src/app/api/agents/route.test.ts`).

## 4. The passthrough rule

`withRoute` reads a handler's returned `Response.status` to log the request's
outcome. That's safe for an ordinary JSON response, but for a route that
returns a live `ReadableStream`-backed `Response` (Server-Sent Events, a PTY
session), even touching the response after construction risks coupling the
wrapper to streaming internals it has no business knowing about. Streaming
routes use `withPassthroughRoute` instead: it runs the same pre-stream
validation (body/query/params schemas, one log line on a validation
failure), then returns whatever the handler returns **exactly as
constructed** — no status read, no body inspection, no re-wrapping, and no
completion log line once the handler has been called (see
`src/lib/api-route.ts` for the implementation and rationale).

Every route in this codebase that returns a `text/event-stream` or a raw
`ReadableStream`-backed response is a passthrough route:

| Route | Verb | Stream mechanism |
|---|---|---|
| `/api/chat` | POST | `ReadableStream` (OpenResponses fallback) |
| `/api/chat/stream` | POST | `TransformStream` (SSE piped from the gateway) |
| `/api/doctor/run` | POST | `sseResponse` (`src/lib/doctor-sse.ts`) |
| `/api/doctor/fix` | POST | `sseResponse` (`src/lib/doctor-sse.ts`) |
| `/api/terminal` | GET | `ReadableStream` (PTY session, manual heartbeat) |
| `/api/skills/install` | POST | `ReadableStream` (SSE progress events) |
| `/api/stats/stream` | GET | `ReadableStream` (SSE) |
| `/api/onboarding/chat` | POST | `ReadableStream` (SSE) |

If you are migrating one of these routes, only wrap it with
`withPassthroughRoute`, never `withRoute`. A non-streaming action inside the
same route file (e.g. `/api/terminal`'s POST session-control actions:
`create`/`input`/`resize`/`kill`) may still use `withRoute` — the rule is per
handler, not per file.

## 5. Success shapes are out of scope this phase

This phase (server-contract-hardening) standardizes **error** envelopes
only. Success response shapes are untouched and stay exactly as each route
already returns them — including routes that already send `ok: true` on
success (e.g. `/api/terminal`'s `Response.json({ ok: true, session: id })`)
and routes that never sent an `ok` field at all. Do not add, remove, or
rename fields on a success response as part of an error-envelope migration;
that's a separate, later decision (see `.planning/phases/02-server-contract-hardening/02-CONTEXT.md`,
"Deferred Ideas").

## 6. `/api/config` stays unredacted on the wire

`GET /api/config` serves its response body — including secrets (the gateway
token, provider API keys) — unredacted, by product decision documented in
the route source. That is not a leak this phase fixes. Redaction from
`src/lib/logger.ts` applies only to **log output**: if `/api/config`'s
handler logs its own request/response objects, those log lines are
redacted; the HTTP response body itself is not. See D-04 in
`.planning/phases/02-server-contract-hardening/02-CONTEXT.md`. Phase 6 is
expected to re-confirm this product decision still holds for hosted
(AgentBay VPC) instances.
