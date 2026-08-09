/**
 * Minimal-diff builder for OpenClaw config writes.
 *
 * OpenClaw's `config.patch` applies an RFC 7386 **JSON merge patch**:
 *
 *   - an object merges key-by-key into the target,
 *   - an explicit `null` DELETES the key,
 *   - a missing key means "no change" (it does NOT delete),
 *   - an array replaces the target array wholesale — and when the replacement
 *     would drop entries the gateway refuses the write unless the exact dotted
 *     path is listed in `replacePaths` (probed live on OpenClaw v2026.7.1-2:
 *     "config.patch would remove entries from array path(s): <path>. Pass
 *     replacePaths with the exact path(s) when this is intentional").
 *
 * Sending the whole document as a patch is therefore both wasteful and wrong:
 * a key the user deleted in the editor is simply absent from the payload, so
 * the gateway keeps it and Mission Control reports a save that never happened.
 *
 * This module turns (base, next) into the smallest correct write:
 *
 *   buildConfigDiff(base, next) -> { patch, replacePaths, changedPaths, changed }
 *
 * Everything here is pure: no I/O, no gateway calls, no mutation of the
 * inputs. `base` and `next` must be plain JSON values (the shape returned by
 * `config.get`'s `parsed`), not class instances.
 */

export type JsonObject = Record<string, unknown>;

export type ConfigDiff = {
  /**
   * JSON merge patch. Changed leaves carry their new value, keys removed in
   * `next` carry an explicit `null`, untouched subtrees are absent entirely.
   */
  patch: JsonObject;
  /**
   * Dotted paths of arrays that lost entries or were reordered. Pass straight
   * through to `config.patch`'s `replacePaths`. Nested arrays that live under
   * an array entry use the gateway's `[]` notation (`agents.list[].skills`).
   */
  replacePaths: string[];
  /**
   * Dotted path of every node the patch touches — a changed leaf, a deleted
   * key, or a replaced array. Used to look up `reloadKind` per path so a write
   * only restarts the gateway when the schema says it must.
   */
  changedPaths: string[];
  /** Dotted paths this patch deletes (subset of `changedPaths`). */
  deletedPaths: string[];
  /** False when `patch` is empty — nothing to send. */
  changed: boolean;
};

// ── Value helpers ────────────────────────────────

export function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonical JSON with sorted object keys — a stable identity for deep-equality
 * and multiset comparisons. `undefined` collapses to `null` so it compares the
 * same way JSON.stringify would drop it.
 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as JsonObject)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return stableStringify(a) === stableStringify(b);
}

function joinPath(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key;
}

// ── Array change classification ──────────────────

/**
 * True when replacing `baseArr` with `nextArr` drops or reorders entries — the
 * condition the gateway guards with `replacePaths`.
 *
 * The gateway's own rule (`arrayPreservesBaseEntries`, openclaw
 * dist/config-*.js) is an order-insensitive multiset-subset check: every base
 * entry must still be present, by deep equality, in the merged array. We match
 * that and additionally report a pure reorder, because a reorder is a real
 * semantic change for ordered config (model fallbacks, bindings, hook chains)
 * and the user should confirm it. Listing a path the gateway did not demand is
 * harmless — probed live: `config.patch` accepts unused and even unknown
 * `replacePaths` entries without complaint.
 *
 * Pure appends (every existing entry still at its original index, plus extra
 * entries at the end) are deliberately NOT reported, so growing an allowlist
 * never asks the user to confirm a destructive replace.
 */
export function arrayLosesEntries(baseArr: unknown[], nextArr: unknown[]): boolean {
  if (nextArr.length < baseArr.length) return true;

  // Any base entry that no longer appears (counting duplicates) is a removal.
  const remaining = new Map<string, number>();
  for (const item of nextArr) {
    const key = stableStringify(item);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const item of baseArr) {
    const key = stableStringify(item);
    const count = remaining.get(key) ?? 0;
    if (count === 0) return true;
    remaining.set(key, count - 1);
  }

  // Same entries, different order: still a destructive replace for anything
  // order-sensitive (model fallbacks, bindings, hook chains).
  for (let i = 0; i < baseArr.length; i += 1) {
    if (!deepEqual(baseArr[i], nextArr[i])) return true;
  }
  return false;
}

/**
 * Every array path reachable inside `base`.
 *
 * When a subtree is deleted or replaced by a non-object, the gateway treats
 * every array underneath it as losing all its entries
 * (`collectBaseArrayPaths`), so each of those paths must be confirmed too.
 */
export function collectArrayPathsUnder(base: unknown, path: string): string[] {
  if (Array.isArray(base)) return [path];
  if (!isPlainObject(base)) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    paths.push(...collectArrayPathsUnder(value, joinPath(path, key)));
  }
  return paths;
}

/**
 * Collect `replacePaths` for an array replacement, including arrays nested
 * inside array entries (`agents.list[].skills`), which the gateway guards
 * under the same rule.
 */
function collectArrayReplacePaths(
  path: string,
  baseArr: unknown[],
  nextArr: unknown[],
  acc: string[],
): void {
  if (arrayLosesEntries(baseArr, nextArr)) {
    pushUnique(acc, path);
  }
  const shared = Math.min(baseArr.length, nextArr.length);
  for (let i = 0; i < shared; i += 1) {
    collectNestedReplacePaths(`${path}[]`, baseArr[i], nextArr[i], acc);
  }
}

function collectNestedReplacePaths(
  prefix: string,
  baseEntry: unknown,
  nextEntry: unknown,
  acc: string[],
): void {
  if (Array.isArray(baseEntry) && Array.isArray(nextEntry)) {
    collectArrayReplacePaths(prefix, baseEntry, nextEntry, acc);
    return;
  }
  if (!isPlainObject(baseEntry) || !isPlainObject(nextEntry)) return;
  for (const [key, baseValue] of Object.entries(baseEntry)) {
    const nextValue = nextEntry[key];
    const childPath = joinPath(prefix, key);
    if (Array.isArray(baseValue)) {
      if (Array.isArray(nextValue)) {
        collectArrayReplacePaths(childPath, baseValue, nextValue, acc);
      } else if (!(key in nextEntry) || nextValue === null) {
        // The whole nested array goes away — that removes every entry.
        pushUnique(acc, childPath);
      }
      continue;
    }
    collectNestedReplacePaths(childPath, baseValue, nextValue, acc);
  }
}

function pushUnique(acc: string[], value: string): void {
  if (!acc.includes(value)) acc.push(value);
}

// ── Diff ─────────────────────────────────────────

type DiffAcc = {
  replacePaths: string[];
  changedPaths: string[];
  deletedPaths: string[];
};

const NO_CHANGE = Symbol("no-change");

function diffValue(
  path: string,
  baseValue: unknown,
  nextValue: unknown,
  acc: DiffAcc,
): unknown | typeof NO_CHANGE {
  // Deletion: the key vanished (or was explicitly cleared) in `next`.
  if (nextValue === undefined) {
    if (baseValue === undefined) return NO_CHANGE;
    acc.changedPaths.push(path);
    acc.deletedPaths.push(path);
    // Deleting a subtree removes every array inside it.
    for (const arrayPath of collectArrayPathsUnder(baseValue, path)) {
      pushUnique(acc.replacePaths, arrayPath);
    }
    return null;
  }

  if (Array.isArray(baseValue) && Array.isArray(nextValue)) {
    if (deepEqual(baseValue, nextValue)) return NO_CHANGE;
    acc.changedPaths.push(path);
    collectArrayReplacePaths(path, baseValue, nextValue, acc.replacePaths);
    return nextValue;
  }

  if (isPlainObject(baseValue) && isPlainObject(nextValue)) {
    const sub = diffObject(path, baseValue, nextValue, acc);
    return sub === NO_CHANGE ? NO_CHANGE : sub;
  }

  // Type change, scalar change, or object <-> scalar: merge patch replaces the
  // node wholesale. An object replacing a scalar is sent whole (its keys are
  // all new), which is exactly what merge-patch semantics require.
  if (deepEqual(baseValue, nextValue)) return NO_CHANGE;
  acc.changedPaths.push(path);
  // An explicit `null` in `next` is merge-patch for "delete this key".
  if (nextValue === null && baseValue !== undefined) acc.deletedPaths.push(path);
  // Reaching here means the node changed shape (array<->object<->scalar) or is
  // a scalar edit. Both-arrays and both-objects were handled above, so any
  // array under `baseValue` loses every entry — the gateway's rule exactly.
  for (const arrayPath of collectArrayPathsUnder(baseValue, path)) {
    pushUnique(acc.replacePaths, arrayPath);
  }
  return nextValue;
}

function diffObject(
  path: string,
  base: JsonObject,
  next: JsonObject,
  acc: DiffAcc,
): JsonObject | typeof NO_CHANGE {
  const patch: JsonObject = {};
  let changed = false;

  for (const key of Object.keys(next)) {
    if (next[key] === undefined) continue; // handled with the removal pass
    const childPath = joinPath(path, key);
    const result = diffValue(childPath, base[key], next[key], acc);
    if (result === NO_CHANGE) continue;
    patch[key] = result;
    changed = true;
  }

  for (const key of Object.keys(base)) {
    if (key in next && next[key] !== undefined) continue;
    const childPath = joinPath(path, key);
    const result = diffValue(childPath, base[key], undefined, acc);
    if (result === NO_CHANGE) continue;
    patch[key] = result;
    changed = true;
  }

  return changed ? patch : NO_CHANGE;
}

/**
 * Build the minimal merge patch that turns `base` into `next`.
 *
 * `base` should be the snapshot the editor loaded (`config.get` -> `parsed`),
 * `next` the edited document. Keys present in `base` and absent from `next`
 * become explicit `null`s so the gateway actually deletes them.
 */
export function buildConfigDiff(base: unknown, next: unknown): ConfigDiff {
  const acc: DiffAcc = { replacePaths: [], changedPaths: [], deletedPaths: [] };
  const baseObj = isPlainObject(base) ? base : {};
  const nextObj = isPlainObject(next) ? next : {};

  const patch: JsonObject = {};
  let changed = false;

  for (const key of Object.keys(nextObj)) {
    if (nextObj[key] === undefined) continue;
    // A brand-new section falls through `diffValue`'s type-change branch and
    // is written whole — including an empty `{}`, which creates the section.
    const result = diffValue(key, baseObj[key], nextObj[key], acc);
    if (result === NO_CHANGE) continue;
    patch[key] = result;
    changed = true;
  }

  for (const key of Object.keys(baseObj)) {
    if (key in nextObj && nextObj[key] !== undefined) continue;
    const result = diffValue(key, baseObj[key], undefined, acc);
    if (result === NO_CHANGE) continue;
    patch[key] = result;
    changed = true;
  }

  return {
    patch,
    replacePaths: acc.replacePaths,
    changedPaths: acc.changedPaths,
    deletedPaths: acc.deletedPaths,
    changed,
  };
}

// ── Patch introspection (server side) ────────────

/**
 * Dotted paths touched by an already-built merge patch.
 *
 * The route receives the patch from the client, not (base, next), so this is
 * how it learns which schema paths to look up for `reloadKind`. A `null` leaf
 * is a delete and still counts as a touched path; an empty object `{}` is a
 * section create and counts as its own path.
 *
 * Keys that already contain dots are treated as literal dotted paths so a
 * legacy caller sending `{ "gateway.port": 1 }` is still classified sanely.
 */
export function collectPatchPaths(patch: unknown, prefix = ""): string[] {
  if (!isPlainObject(patch)) return prefix ? [prefix] : [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = joinPath(prefix, key);
    if (isPlainObject(value) && Object.keys(value).length > 0) {
      paths.push(...collectPatchPaths(value, path));
      continue;
    }
    pushUnique(paths, path);
  }
  return paths;
}

/** Dotted paths a merge patch deletes (explicit `null` leaves). */
export function collectDeletedPaths(patch: unknown, prefix = ""): string[] {
  if (!isPlainObject(patch)) return [];
  const paths: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = joinPath(prefix, key);
    if (value === null) {
      pushUnique(paths, path);
      continue;
    }
    if (isPlainObject(value)) paths.push(...collectDeletedPaths(value, path));
  }
  return paths;
}

/**
 * Apply a merge patch to a document (RFC 7386). Used to preview the result of
 * a write and to prove `buildConfigDiff` round-trips in tests. Never mutates
 * its arguments.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isPlainObject(patch)) return clone(patch);
  const base: JsonObject = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    if (isPlainObject(value)) {
      base[key] = applyMergePatch(base[key], value);
      continue;
    }
    base[key] = clone(value);
  }
  return base;
}

function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

// ── Env indirection (parsed vs resolved) ─────────

/**
 * Unescaped `${VAR}` reference — the env-substitution syntax OpenClaw expands
 * when it builds `resolved` from `parsed`. Only uppercase names match, and
 * `$${VAR}` is the documented escape for a literal, so a preceding `$`
 * disqualifies the match (gateway/configuration.md, "Env var substitution").
 */
export const ENV_REFERENCE = /(?<!\$)\$\{[A-Z_][A-Z0-9_]*\}/;

/**
 * Dotted paths whose authored value carries env indirection.
 *
 * The editor authors against `parsed` so a `${VAR}` survives a round-trip
 * instead of being baked into its expansion on the first save. The UI still
 * needs to say "this field shows `${OPENAI_KEY}` and resolves to something
 * else at runtime", so report every string leaf that either references an env
 * var or disagrees with `resolved`.
 *
 * Array elements are reported with their index (`tools.media.models[0].command`)
 * because this is a display concern, not a write path.
 */
export function collectEnvSubstitutedPaths(
  parsed: unknown,
  resolved: unknown,
  prefix = "",
): string[] {
  const out: string[] = [];
  walkEnvSubstituted(parsed, resolved, prefix, out);
  return out;
}

function walkEnvSubstituted(
  parsedNode: unknown,
  resolvedNode: unknown,
  prefix: string,
  out: string[],
): void {
  if (typeof parsedNode === "string") {
    const authored = ENV_REFERENCE.test(parsedNode);
    const expanded = typeof resolvedNode === "string" && resolvedNode !== parsedNode;
    if ((authored || expanded) && prefix) pushUnique(out, prefix);
    return;
  }
  if (Array.isArray(parsedNode)) {
    const resolvedArray = Array.isArray(resolvedNode) ? resolvedNode : [];
    parsedNode.forEach((item, i) => {
      walkEnvSubstituted(item, resolvedArray[i], `${prefix}[${i}]`, out);
    });
    return;
  }
  if (isPlainObject(parsedNode)) {
    const resolvedRecord = isPlainObject(resolvedNode) ? resolvedNode : {};
    for (const [key, value] of Object.entries(parsedNode)) {
      walkEnvSubstituted(value, resolvedRecord[key], joinPath(prefix, key), out);
    }
  }
}

/**
 * Normalize a dotted path with concrete array indices (`agents.list[0].skills`)
 * into the gateway's schema/replacePaths notation (`agents.list[].skills`).
 */
export function normalizeArrayPath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

/**
 * Parse the array paths out of the gateway's replacePaths refusal so the route
 * can hand the UI an exact confirmation list instead of a raw error string.
 *
 * Live wording on v2026.7.1-2:
 *   "config.patch would remove entries from array path(s): a.b, c.d. Pass
 *    replacePaths with the exact path(s) when this is intentional, or use
 *    config.apply for full-config replacement."
 */
export function parseReplacePathsFromError(error: unknown): string[] {
  const message = String(error ?? "");
  const start = message.search(/remove entries from array path\(s\):/i);
  if (start < 0) return [];
  const afterLabel = message.slice(start).replace(/^[^:]*:\s*/, "");
  // The list ends at the sentence break the gateway always emits.
  const listSource = afterLabel.split(/\.\s+Pass\b/i)[0];
  const paths: string[] = [];
  for (const entry of listSource.split(",")) {
    const candidate = entry.trim().replace(/[.\s]+$/, "");
    // Config paths only: dotted segments, optional `[]` for arrays-in-arrays.
    if (/^[A-Za-z_$][\w$-]*(?:\[\])?(?:\.[\w$*-]+(?:\[\])?)*$/.test(candidate)) {
      pushUnique(paths, candidate);
    }
  }
  return paths;
}
