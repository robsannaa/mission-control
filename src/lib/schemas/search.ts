/**
 * Zod schemas for the search and web-search route group
 * (`/api/web-search`, `/api/search`, `/api/search/web/**`).
 *
 * This group fans out to a third-party search backend (Perplexity/Brave/
 * gateway `web_search`/`web_fetch` tools) with free-text and URL-shaped
 * input. Two shapes are bounded here (T-02-31, T-02-32):
 *
 * - Every field that is forwarded to the search backend as a query string is
 *   capped at `MAX_SEARCH_QUERY_LENGTH` so an unbounded string can't be sent
 *   downstream. The cap uses a static message (no interpolation of the
 *   submitted value), so the length-rejection response never echoes the
 *   oversized query.
 * - `search/web/read`'s `url` field is constrained with `.url(...)` to a
 *   parsed URL string rather than an arbitrary one, using the route's own
 *   pre-migration message.
 *
 * `search/web/run`'s minimum-length rejection ("Type at least 2 characters
 * to search.") and `search/web/save`'s URL selection (`finalUrl` preferred
 * over `url`, either may be malformed as long as the other is a good URL)
 * are NOT format rules a schema can express without changing behavior —
 * both stay manual checks in their route handlers, same as every
 * required-field check in this phase (`src/lib/schemas/agents.ts`). Moving
 * `search/web/run`'s check into the schema would also swap its response
 * body from `{ ok: false, reason }` (the shape
 * `src/components/search/search-playground.tsx` reads) to the canonical
 * `{ ok: false, error, details }` — a real UI-string regression the schema
 * layer has no way to avoid, so that one specific rejection stays exactly
 * as written pre-migration.
 */
import { z } from "zod";

/**
 * Chosen generously above any real search-box input (a few sentences,
 * comfortably over the length of a pasted paragraph) while still rejecting
 * an attempt to forward an unbounded string to the search backend.
 */
export const MAX_SEARCH_QUERY_LENGTH = 500;

const TOO_LONG_MESSAGE = "Search query is too long.";

/** Shared free-text query field — trimmed, capped. Each route composes its
 *  own minimum-length rule (or leaves it manual) to match its pre-migration
 *  message exactly. */
const searchQueryField = z.string().trim().max(MAX_SEARCH_QUERY_LENGTH, TOO_LONG_MESSAGE);

// ── GET /api/search?q= ───────────────────────────────────────────────────

export const searchQuerySchema = z
  .object({
    q: searchQueryField.optional(),
  })
  .passthrough();
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// ── GET/PATCH/POST /api/web-search ───────────────────────────────────────

export const webSearchPatchSchema = z
  .object({
    action: z.string().optional(),
    model: z.string().optional(),
    provider: z.string().optional(),
    apiKey: z.string().optional(),
    makeDefault: z.boolean().optional(),
  })
  .passthrough();
export type WebSearchPatchInput = z.infer<typeof webSearchPatchSchema>;

/**
 * `query`'s minimum-length message ("Search query must be at least 2
 * characters") was already the canonical `{ ok: false, error }` shape
 * pre-migration, so moving it into the schema (and gaining a `details`
 * tree) changes nothing about how the client reads the response.
 */
export const webSearchPostSchema = z
  .object({
    query: searchQueryField.min(2, "Search query must be at least 2 characters"),
    agentId: z.string().optional(),
    resultCount: z.number().optional(),
  })
  .passthrough();
export type WebSearchPostInput = z.infer<typeof webSearchPostSchema>;

// ── POST /api/search/web/run ─────────────────────────────────────────────
//
// `query` is capped at the schema layer (new behavior — T-02-31) but its
// minimum-length check stays manual in the route handler: this route
// answers `{ ok: false, reason }`, not the canonical envelope, and
// `src/components/search/search-playground.tsx` reads `data.reason`
// directly. Routing that specific rejection through `validationFailed()`
// would silently drop the message the UI shows.

export const searchWebRunPostSchema = z
  .object({
    query: searchQueryField,
    count: z.number().optional(),
  })
  .passthrough();
export type SearchWebRunPostInput = z.infer<typeof searchWebRunPostSchema>;

// ── POST /api/search/web/read ────────────────────────────────────────────
//
// `url` stays optional at the schema layer — a missing `url` is a manual
// check in the handler (no `details` tree, matching the "required stays
// manual" split) — but format-checked with `.url()` when present, using the
// route's own pre-migration message. The http/https-only restriction is a
// separate, deliberate manual check left in the route handler (a malformed
// scheme like `file://` or `ftp://` still parses as a valid URL, so `.url()`
// alone would accept it); both paths now return through the same
// `api-errors.ts` `badRequest()` builder, so the response shape is
// consistent across every rejection reason on this route (only the field
// name changed, `reason` → `error` — the fallback text in
// `src/components/search/result-item.tsx` covers this edge case, which is
// unreachable through the UI's own read flow since it always passes back a
// URL a prior search result already returned).

export const searchWebReadPostSchema = z
  .object({
    url: z.string().url("That does not look like a web address.").optional(),
  })
  .passthrough();
export type SearchWebReadPostInput = z.infer<typeof searchWebReadPostSchema>;

// ── POST /api/search/web/save ────────────────────────────────────────────
//
// `url`/`finalUrl` stay loose optional strings at the schema layer — NOT
// `.url()` — because the handler's own selection logic
// (`finalUrl` preferred over `url`, whichever is non-empty) means a
// malformed `url` must not reject the request when a well-formed
// `finalUrl` was also sent (the handler never even looks at `url` in that
// case). A schema-level `.url()` on both fields would reject that request
// before the handler's selection logic ever ran — a false rejection this
// route's real behavior does not have. The handler's own `new URL(rawUrl)`
// + http/https-only re-check after selection is unchanged and remains the
// sole point where a malformed/absent URL is rejected.

export const searchWebSavePostSchema = z
  .object({
    url: z.string().optional(),
    finalUrl: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();
export type SearchWebSavePostInput = z.infer<typeof searchWebSavePostSchema>;
