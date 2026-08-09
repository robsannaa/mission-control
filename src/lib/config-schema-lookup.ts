/**
 * Per-path config schema intelligence, served from OpenClaw's
 * `config.schema.lookup` RPC.
 *
 * ## Why this exists
 *
 * Mission Control's config editor writes to `~/.openclaw/openclaw.json` with
 * no idea what a field means, whether it is required, what values it accepts,
 * or whether saving it will bounce the gateway. OpenClaw already knows all of
 * that per path — it just was never asked. This module asks.
 *
 * ## The gateway contract (probed live against OpenClaw v2026.7.1-2)
 *
 * ```
 * method : config.schema.lookup
 * params : { path: string }        // exactly ONE path; `paths` is rejected
 *                                  // ("at root: unexpected property 'paths'")
 *                                  // "." means the config root
 * result : {
 *   path: string,                  // normalized: "a.list[0].b" -> "a.list.0.b"
 *   schema: <shallow JSON Schema node>,
 *   reloadKind?: "restart" | "hot" | "none",
 *   hint?: { label?, help?, tags?, group?, order?, advanced?, sensitive?,
 *            placeholder?, itemTemplate? },
 *   hintPath?: string,
 *   children: Array<{ key, path, type?, required, hasChildren,
 *                     reloadKind?, hint?, hintPath? }>
 * }
 * errors : INVALID_REQUEST "config schema path not found"   (unknown path)
 *          INVALID_REQUEST "invalid config.schema.lookup params: ..."
 *          "unknown method: config.schema.lookup"           (older gateway)
 * ```
 *
 * Two facts drive the design:
 *
 *  1. **`required` is not on the node.** The gateway only reports `required`
 *     on *child* summaries. So to answer "is `gateway.port` required?" we look
 *     up `gateway` and read the `port` child. That is a second RPC, which is
 *     exactly why this module caches.
 *  2. **`default` is stripped.** `stripSchemaForLookup` keeps only the doc and
 *     validation keys; `default` is not among them on this gateway version.
 *     The full `config.schema` payload does carry defaults but weighs ~3 MB,
 *     far too heavy to fetch per field.
 *
 * ## Caching
 *
 * Entries are keyed by path and scoped to the gateway's config hash
 * (`config.get` → `hash`). When the hash changes the whole cache is dropped,
 * because a config change can add or remove plugin/channel schema branches.
 * The hash itself is memoized for a few seconds so a burst of lookups costs at
 * most one `config.get`.
 *
 * ## Degradation
 *
 * Nothing here throws. When the RPC is missing or the gateway is unreachable,
 * callers get a `degraded` lookup carrying only a `reloadKind` derived from the
 * documented reload matrix (see `reloadKindFromMatrix`), plus a `reason`.
 * An unknown path returns `null` with a reason — never a silent success.
 */

import { gatewayCall } from "./openclaw";
import {
  degradedConfigLookup,
  normalizeConfigSchemaLookup,
  type NormalizedConfigLookup,
  type RawConfigSchemaLookup,
} from "./config-schema-validate";

// The pure validator/normalizer is re-exported for server callers. Client
// components must import it from "@/lib/config-schema-validate" directly —
// this module pulls in the gateway transport (child_process, fs).
export {
  degradedConfigLookup,
  normalizeConfigSchemaLookup,
  reloadKindFromMatrix,
  validateConfigValue,
  type ConfigReloadKind,
  type ConfigReloadKindSource,
  type ConfigValueValidation,
  type NormalizedConfigLookup,
  type NormalizedConfigLookupChild,
  type RawConfigSchemaLookup,
} from "./config-schema-validate";

/** RPC this module speaks. */
const LOOKUP_METHOD = "config.schema.lookup";

const LOOKUP_TIMEOUT_MS = 10_000;
const CONFIG_GET_TIMEOUT_MS = 10_000;

/** How long a fetched config hash is trusted before re-reading it. */
const HASH_TTL_MS = 5_000;

/** How long "this gateway has no config.schema.lookup" is believed. */
const UNSUPPORTED_TTL_MS = 60_000;

/** Cache ceiling. The config schema has a few thousand paths; this is plenty. */
const CACHE_MAX_ENTRIES = 750;

/**
 * Maximum paths accepted in one multi-path request.
 *
 * Each path costs up to two gateway RPCs (the node plus its parent, for
 * `required`), so a batch of 25 is at most 50 round trips — enough for a
 * whole config section in one shot, small enough that one browser tab cannot
 * saturate the gateway. Callers asking for more get HTTP 400, never a
 * silently truncated answer.
 */
export const MAX_LOOKUP_PATHS_PER_REQUEST = 25;

/** Gateway cap on dotted path depth (`MAX_LOOKUP_PATH_SEGMENTS`). */
const MAX_PATH_SEGMENTS = 32;
const MAX_PATH_LENGTH = 512;

/** Why a lookup did not produce a schema node. */
export type ConfigLookupReasonCode =
  /** The caller's path is unusable (empty, too long, too deep, control chars). */
  | "invalid-path"
  /** The gateway answered, but no such path exists in the schema. */
  | "not-found"
  /** This gateway build does not implement `config.schema.lookup`. */
  | "unsupported"
  /** The gateway was unreachable or the RPC failed. */
  | "unavailable";

export type ConfigLookupOutcome = {
  /** Path exactly as requested. */
  path: string;
  lookup: NormalizedConfigLookup | null;
  /** Human-readable explanation. Present whenever `lookup` is null or degraded. */
  reason?: string;
  reasonCode?: ConfigLookupReasonCode;
};

type CacheEntry = {
  raw: RawConfigSchemaLookup | null;
  reasonCode?: ConfigLookupReasonCode;
  reason?: string;
};

const cache = new Map<string, CacheEntry>();
let cacheHash: string | null = null;

let hashValue: string | null = null;
let hashFetchedAt = 0;

let unsupportedUntil = 0;

/** Drop every cached lookup. Exposed for tests and for hash invalidation. */
export function clearConfigSchemaLookupCache(): void {
  cache.clear();
  cacheHash = null;
  hashValue = null;
  hashFetchedAt = 0;
  unsupportedUntil = 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? "");
}

/** The gateway rejects an unimplemented RPC with "unknown method: <name>". */
function isUnknownMethodError(err: unknown): boolean {
  const msg = errorText(err).toLowerCase();
  return (
    msg.includes("unknown method") ||
    msg.includes("method not found") ||
    msg.includes("unsupported method")
  );
}

/** Exact wording used by OpenClaw when a dotted path is not in the schema. */
function isPathNotFoundError(err: unknown): boolean {
  return errorText(err).toLowerCase().includes("config schema path not found");
}

/**
 * Normalize a caller-supplied path the same way the gateway does, so cache
 * keys, parent derivation and the matrix fallback all agree.
 *
 * Returns `"."` for the config root and `null` when the path is unusable.
 */
export function normalizeConfigPath(input: string): string | null {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_PATH_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  if (trimmed === ".") return ".";

  const dotted = trimmed
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[\]/g, ".*")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
  if (!dotted) return null;

  const segments = dotted.split(".");
  if (segments.length > MAX_PATH_SEGMENTS) return null;
  if (segments.some((segment) => segment.length === 0)) return null;
  return dotted;
}

/** Parent of a normalized path: `"gateway.auth.mode"` → `"gateway.auth"`, `"gateway"` → `"."`. */
function parentOf(path: string): string | null {
  if (path === ".") return null;
  const index = path.lastIndexOf(".");
  return index === -1 ? "." : path.slice(0, index);
}

function lastSegment(path: string): string {
  const index = path.lastIndexOf(".");
  return index === -1 ? path : path.slice(index + 1);
}

/**
 * Current gateway config hash, memoized briefly.
 *
 * Returns `""` when the gateway cannot be reached — the cache then simply
 * stays under the empty-hash scope instead of thrashing.
 */
async function currentConfigHash(): Promise<string> {
  const now = Date.now();
  if (hashValue !== null && now - hashFetchedAt < HASH_TTL_MS) return hashValue;
  try {
    const data = await gatewayCall<Record<string, unknown>>(
      "config.get",
      undefined,
      CONFIG_GET_TIMEOUT_MS,
    );
    hashValue = String(data?.hash ?? "");
  } catch {
    hashValue = "";
  }
  hashFetchedAt = now;
  return hashValue;
}

/** Drop the cache when the config hash moved. */
async function syncCacheScope(): Promise<void> {
  const hash = await currentConfigHash();
  if (cacheHash !== hash) {
    cache.clear();
    cacheHash = hash;
  }
}

function rememberCacheEntry(path: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Simple FIFO eviction — insertion order is Map iteration order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(path, entry);
}

/**
 * One cached `config.schema.lookup` round trip for an already-normalized path.
 * Never throws.
 */
async function fetchRawLookup(normalizedPath: string): Promise<CacheEntry> {
  const cached = cache.get(normalizedPath);
  if (cached) return cached;

  if (Date.now() < unsupportedUntil) {
    return {
      raw: null,
      reasonCode: "unsupported",
      reason: `This gateway does not implement ${LOOKUP_METHOD}.`,
    };
  }

  let entry: CacheEntry;
  try {
    const raw = await gatewayCall<RawConfigSchemaLookup>(
      LOOKUP_METHOD,
      { path: normalizedPath },
      LOOKUP_TIMEOUT_MS,
    );
    if (!isRecord(raw)) {
      // Not cached: an unreadable payload is a gateway hiccup, not a fact
      // about this path.
      return {
        raw: null,
        reasonCode: "unavailable",
        reason: `${LOOKUP_METHOD} returned an unreadable payload.`,
      };
    }
    entry = { raw };
  } catch (err) {
    if (isUnknownMethodError(err)) {
      unsupportedUntil = Date.now() + UNSUPPORTED_TTL_MS;
      // Not cached: the flag above already short-circuits, and caching it per
      // path would survive a gateway upgrade.
      return {
        raw: null,
        reasonCode: "unsupported",
        reason: `This gateway does not implement ${LOOKUP_METHOD}.`,
      };
    }
    if (isPathNotFoundError(err)) {
      entry = {
        raw: null,
        reasonCode: "not-found",
        reason: `"${normalizedPath}" is not a known OpenClaw config path.`,
      };
    } else {
      // Transient — do not cache, so a recovered gateway answers immediately.
      return {
        raw: null,
        reasonCode: "unavailable",
        reason: `Could not reach OpenClaw to read the schema: ${errorText(err)}`,
      };
    }
  }

  rememberCacheEntry(normalizedPath, entry);
  return entry;
}

/**
 * `required` for a path, read from the parent node's child summaries.
 *
 * Array-index and wildcard members inherit the parent's `*` child, which the
 * gateway synthesizes for `additionalProperties` / `items` schemas.
 */
async function resolveRequired(normalizedPath: string): Promise<boolean | null> {
  const parent = parentOf(normalizedPath);
  if (!parent) return null;
  const entry = await fetchRawLookup(parent);
  if (!entry.raw || !Array.isArray(entry.raw.children)) return null;
  const key = lastSegment(normalizedPath);
  const children = entry.raw.children.filter(isRecord);
  const exact = children.find((child) => child.key === key);
  if (exact) return exact.required === true;
  const wildcard = children.find((child) => child.key === "*");
  return wildcard ? wildcard.required === true : null;
}

/**
 * Look up one dotted config path.
 *
 * Never throws. Returns `{ path, lookup, reason?, reasonCode? }` where
 * `lookup` is null for an unknown/unusable path, and a `degraded: true` stub
 * (reload hint only) when the gateway cannot answer.
 */
export async function lookupConfigPath(requestedPath: string): Promise<ConfigLookupOutcome> {
  const normalized = normalizeConfigPath(requestedPath);
  if (!normalized) {
    return {
      path: requestedPath,
      lookup: null,
      reasonCode: "invalid-path",
      reason:
        "Config path must be a non-empty dotted path such as \"gateway.port\" " +
        `(max ${MAX_PATH_SEGMENTS} segments, ${MAX_PATH_LENGTH} characters).`,
    };
  }

  await syncCacheScope();
  const entry = await fetchRawLookup(normalized);

  if (!entry.raw) {
    if (entry.reasonCode === "unsupported" || entry.reasonCode === "unavailable") {
      return {
        path: requestedPath,
        lookup: degradedConfigLookup(normalized),
        reasonCode: entry.reasonCode,
        reason: `${entry.reason ?? "Schema unavailable."} Showing the documented reload behaviour only; field constraints are unknown.`,
      };
    }
    return {
      path: requestedPath,
      lookup: null,
      reasonCode: entry.reasonCode ?? "not-found",
      reason: entry.reason,
    };
  }

  const required = await resolveRequired(normalized);
  const lookup = normalizeConfigSchemaLookup(entry.raw, {
    requestedPath,
    required,
  });
  if (!lookup) {
    return {
      path: requestedPath,
      lookup: null,
      reasonCode: "unavailable",
      reason: `${LOOKUP_METHOD} returned an unreadable payload.`,
    };
  }
  return { path: requestedPath, lookup };
}

/**
 * Look up several paths at once.
 *
 * Sequential on purpose: the gateway is a single WS peer and these lookups are
 * cheap and heavily cached, so a burst of parallel RPCs buys nothing and risks
 * competing with the config write path. Duplicates collapse.
 */
export async function lookupConfigPaths(
  requestedPaths: string[],
): Promise<ConfigLookupOutcome[]> {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of requestedPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }

  const outcomes: ConfigLookupOutcome[] = [];
  for (const path of unique) {
    outcomes.push(await lookupConfigPath(path));
  }
  return outcomes;
}
