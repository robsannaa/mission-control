import { NextResponse } from "next/server";
import {
  MAX_LOOKUP_PATHS_PER_REQUEST,
  lookupConfigPath,
  lookupConfigPaths,
  type ConfigLookupOutcome,
  type NormalizedConfigLookup,
} from "@/lib/config-schema-lookup";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/config/lookup — per-path config schema intelligence.
 *
 * Surfaces OpenClaw's `config.schema.lookup` RPC so the config editor can show
 * real field docs, real constraints, and an honest "this will restart the
 * gateway" warning instead of guessing.
 *
 * ## Single path
 *
 * ```
 * GET /api/config/lookup?path=gateway.port
 * → 200 { path: "gateway.port", lookup: <normalized> | null, reason?: string }
 * ```
 *
 * ## Many paths
 *
 * ```
 * GET /api/config/lookup?paths=gateway.port,agents.defaults.model
 * GET /api/config/lookup?path=gateway.port&path=agents.defaults.model
 * → 200 {
 *     results: { "<path>": <normalized> | null, … },
 *     reasons?: { "<path>": "<why null / why degraded>" },
 *     reason?: string        // set when ONE cause explains every entry
 *   }
 * ```
 *
 * `paths` accepts a comma-separated list or repeated params, capped at
 * MAX_LOOKUP_PATHS_PER_REQUEST (25). Over the cap is a 400 with the cap
 * spelled out — the response is never silently truncated.
 *
 * ## Status codes
 *
 * 200 — the lookup ran. An unknown path is a successful answer with
 *       `lookup: null` plus a `reason`; a gateway that cannot answer yields a
 *       `degraded: true` lookup (reload hint only) plus a `reason`.
 * 400 — the request itself is unusable (no path, over the cap).
 * 500 — an unexpected server fault. The lookup service itself never throws.
 */

type LookupResponse = {
  path?: string;
  lookup?: NormalizedConfigLookup | null;
  results?: Record<string, NormalizedConfigLookup | null>;
  reasons?: Record<string, string>;
  reason?: string;
};

/** Split `?paths=a,b` / repeated `?path=` params into a clean list. */
function collectRequestedPaths(searchParams: URLSearchParams): string[] {
  const raw = [...searchParams.getAll("paths"), ...searchParams.getAll("path")];
  const paths: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed) paths.push(trimmed);
    }
  }
  return paths;
}

/**
 * A single top-level `reason` only when every outcome shares one cause — a
 * dead gateway is one message, not twenty-five copies of it.
 */
function sharedReason(outcomes: ConfigLookupOutcome[]): string | undefined {
  if (outcomes.length === 0) return undefined;
  const first = outcomes[0];
  if (!first.reason || !first.reasonCode) return undefined;
  if (first.reasonCode !== "unsupported" && first.reasonCode !== "unavailable") {
    return undefined;
  }
  return outcomes.every((outcome) => outcome.reasonCode === first.reasonCode)
    ? first.reason
    : undefined;
}

export const GET = withRoute({ name: "/api/config/lookup" }, async (request, ctx) => {
  const { searchParams } = new URL(request.url);
  const requested = collectRequestedPaths(searchParams);
  // `?paths=` (even with a single value) always answers in the map form, so
  // callers get a stable shape regardless of how many paths they asked for.
  const multi = searchParams.getAll("paths").length > 0 || requested.length > 1;

  try {
    if (requested.length === 0) {
      return badRequest(
        'Provide ?path=gateway.port for one field, or ?paths=gateway.port,agents.defaults.model for several.',
      );
    }

    if (requested.length > MAX_LOOKUP_PATHS_PER_REQUEST) {
      // `max` is a pinned top-level field (e2e/config-lookup.spec.ts), not a
      // `details` value — build this one manually rather than through
      // `badRequest`, whose `details` slot would move it under a nested key.
      return NextResponse.json(
        {
          ok: false,
          error: `Too many paths: ${requested.length}. This endpoint looks up at most ${MAX_LOOKUP_PATHS_PER_REQUEST} paths per request — split the request.`,
          max: MAX_LOOKUP_PATHS_PER_REQUEST,
        },
        { status: 400 },
      );
    }

    if (!multi) {
      const outcome = await lookupConfigPath(requested[0]);
      const body: LookupResponse = {
        path: outcome.path,
        lookup: outcome.lookup,
        ...(outcome.reason ? { reason: outcome.reason } : {}),
      };
      return NextResponse.json(body);
    }

    const outcomes = await lookupConfigPaths(requested);
    const results: Record<string, NormalizedConfigLookup | null> = {};
    const reasons: Record<string, string> = {};
    for (const outcome of outcomes) {
      results[outcome.path] = outcome.lookup;
      if (outcome.reason) reasons[outcome.path] = outcome.reason;
    }
    const shared = sharedReason(outcomes);

    const body: LookupResponse = {
      results,
      ...(Object.keys(reasons).length > 0 ? { reasons } : {}),
      ...(shared ? { reason: shared } : {}),
    };
    return NextResponse.json(body);
  } catch (err) {
    // lookupConfigPath* never throw; this is a genuine server fault.
    ctx.log.error(
      { err: err instanceof Error ? err.message : String(err), paths: requested.join(",") },
      "config lookup failed unexpectedly",
    );
    return serverError(String(err));
  }
});
