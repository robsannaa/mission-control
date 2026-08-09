/**
 * Pure helpers behind the config editor's write experience.
 *
 * The editor keeps two documents in state — the pristine snapshot it loaded
 * (`base`, the gateway's `parsed` document) and the user's `draft` — and turns
 * them into a minimal merge patch with `buildConfigDiff` from
 * `@/lib/config-diff`. Everything here supports that model: reading and
 * writing dotted paths immutably, turning a diff into a human-readable
 * added/changed/removed list, masking secrets in that list, and answering
 * "will this restart the gateway, and why".
 *
 * No React, no I/O — so the e2e suite can assert the exact save payload and
 * the exact preview rows without a browser.
 */

import {
  buildConfigDiff,
  deepEqual,
  isPlainObject,
  type ConfigDiff,
  type JsonObject,
} from "@/lib/config-diff";
import type {
  ConfigReloadKind,
  NormalizedConfigLookup,
} from "@/lib/config-schema-validate";

/* ── dotted-path access ─────────────────────────────────────────────── */

/** Read a dotted path. `undefined` when any segment is missing. */
export function getAtPath(root: unknown, path: string): unknown {
  if (!path) return root;
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (!isPlainObject(cur)) return undefined;
    cur = (cur as JsonObject)[part];
  }
  return cur;
}

/** Immutably write a dotted path, creating intermediate objects as needed. */
export function setAtPath(root: JsonObject, path: string, value: unknown): JsonObject {
  const parts = path.split(".");
  const result: JsonObject = { ...root };
  let cur = result;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const existing = cur[key];
    cur[key] = isPlainObject(existing) ? { ...existing } : {};
    cur = cur[key] as JsonObject;
  }
  cur[parts[parts.length - 1]] = value;
  return result;
}

/**
 * Immutably remove a dotted path.
 *
 * The key is really removed rather than set to `undefined`, so the diff
 * builder sees an absent key and emits the explicit `null` that makes OpenClaw
 * delete it. Missing intermediates are a no-op.
 */
export function deleteAtPath(root: JsonObject, path: string): JsonObject {
  const parts = path.split(".");
  const result: JsonObject = { ...root };
  let cur = result;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const existing = cur[key];
    if (!isPlainObject(existing)) return root;
    cur[key] = { ...existing };
    cur = cur[key] as JsonObject;
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) return root;
  delete cur[last];
  return result;
}

/* ── secrets ────────────────────────────────────────────────────────── */

export const SENSITIVE_SECTIONS = new Set(["env", "auth"]);

export const SENSITIVE_KEY_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
];

type SensitivityHints = Record<string, { sensitive?: boolean } | undefined>;

/** True when a path's value should be masked until the user reveals it. */
export function isSensitiveConfigPath(hints: SensitivityHints, path: string): boolean {
  if (hints[path]?.sensitive) return true;
  const parts = path.split(".");
  if (SENSITIVE_SECTIONS.has(parts[0])) return true;
  const lastKey = parts[parts.length - 1] ?? "";
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(lastKey));
}

/** Fixed-width mask — never leaks the length of a real secret. */
export function maskSecret(value: unknown): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  return "••••••••";
}

/** One-line rendering of a JSON value for the diff preview. */
export function formatConfigValue(value: unknown, maxLength = 160): string {
  if (value === undefined) return "—";
  if (value === null) return "null";
  if (typeof value === "string") return truncate(JSON.stringify(value), maxLength);
  const text = JSON.stringify(value, null, isPlainObject(value) || Array.isArray(value) ? 0 : 0);
  return truncate(text ?? String(value), maxLength);
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/* ── env indirection ────────────────────────────────────────────────── */

/**
 * True when `path` (or anything inside it) resolves from the environment.
 *
 * `meta.envSubstituted` reports array elements with their index
 * (`tools.media.models[0].command`) while form field paths are plain dotted
 * paths, so match a path, its `[i]`-indexed variants, and its descendants.
 */
export function isEnvSubstitutedPath(envSubstituted: string[], path: string): boolean {
  if (envSubstituted.length === 0 || !path) return false;
  return envSubstituted.some(
    (entry) => entry === path || entry.startsWith(`${path}.`) || entry.startsWith(`${path}[`)
  );
}

/* ── change list ────────────────────────────────────────────────────── */

export type ChangeKind = "added" | "changed" | "removed";

export type ChangeEntry = {
  path: string;
  kind: ChangeKind;
  before: unknown;
  after: unknown;
  sensitive: boolean;
  envSubstituted: boolean;
  reloadKind: ConfigReloadKind | null;
  /** True when only a docs-derived fallback matrix, not the gateway, said so. */
  reloadKindInferred: boolean;
  /** Set when this path also needs an explicit `replacePaths` confirmation. */
  replaceConfirm: boolean;
};

export type DescribeChangesOptions = {
  hints: SensitivityHints;
  envSubstituted: string[];
  lookup: (path: string) => NormalizedConfigLookup | null | undefined;
};

/**
 * Turn a diff into the rows the preview renders — one per touched path, in the
 * order a person reads them (removals first: they are the destructive ones).
 */
export function describeChanges(
  base: unknown,
  next: unknown,
  diff: ConfigDiff,
  options: DescribeChangesOptions
): ChangeEntry[] {
  const replaceSet = new Set(diff.replacePaths);
  const seen = new Set<string>();
  const entries: ChangeEntry[] = [];

  for (const path of diff.changedPaths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const before = getAtPath(base, path);
    const after = getAtPath(next, path);
    const kind: ChangeKind =
      after === undefined ? "removed" : before === undefined ? "added" : "changed";
    const info = options.lookup(path);
    entries.push({
      path,
      kind,
      before,
      after,
      sensitive: isSensitiveConfigPath(options.hints, path),
      envSubstituted: isEnvSubstitutedPath(options.envSubstituted, path),
      reloadKind: info?.reloadKind ?? null,
      reloadKindInferred: info?.reloadKindSource === "matrix",
      replaceConfirm: replaceSet.has(path) || replaceSet.has(`${path}[]`),
    });
  }

  const rank: Record<ChangeKind, number> = { removed: 0, changed: 1, added: 2 };
  return entries.sort((a, b) => rank[a.kind] - rank[b.kind] || a.path.localeCompare(b.path));
}

/* ── restart planning ───────────────────────────────────────────────── */

export type RestartPlan = {
  required: boolean;
  paths: string[];
  /** True when at least one verdict came from the fallback matrix, not the RPC. */
  inferred: boolean;
  /** True when some touched path has no verdict at all yet. */
  unknownPaths: string[];
};

/**
 * Which of these changes force a gateway restart.
 *
 * Only `reloadKind: "restart"` counts. A path we have not looked up yet is
 * reported in `unknownPaths` rather than assumed safe — the UI says "may
 * restart" instead of promising it will not.
 */
export function planRestart(entries: ChangeEntry[]): RestartPlan {
  const paths: string[] = [];
  const unknownPaths: string[] = [];
  let inferred = false;
  for (const entry of entries) {
    if (entry.reloadKind === "restart") {
      paths.push(entry.path);
      if (entry.reloadKindInferred) inferred = true;
    } else if (entry.reloadKind === null) {
      unknownPaths.push(entry.path);
    }
  }
  return { required: paths.length > 0, paths, inferred, unknownPaths };
}

/**
 * Switching `gateway.auth.mode` to `token` without a token in the document
 * makes the server mint one (`ensureGatewayAuthPatchDefaults` in
 * src/app/api/config/route.ts). That must never happen invisibly: every client
 * currently connected with the old credentials gets locked out.
 */
export function detectAuthTokenMint(base: unknown, next: unknown): boolean {
  const mode = getAtPath(next, "gateway.auth.mode");
  if (typeof mode !== "string" || mode.trim().toLowerCase() !== "token") return false;
  const previousMode = getAtPath(base, "gateway.auth.mode");
  if (typeof previousMode === "string" && previousMode.trim().toLowerCase() === "token") {
    // Already in token mode and staying there — no mint unless the token went away.
    const existing = getAtPath(next, "gateway.auth.token");
    return !(typeof existing === "string" && existing.trim().length > 0);
  }
  const token = getAtPath(next, "gateway.auth.token");
  return !(typeof token === "string" && token.trim().length > 0);
}

/* ── conflict analysis ──────────────────────────────────────────────── */

export type ConflictAnalysis = {
  /** Paths both the local draft and the remote document moved away from base. */
  contested: string[];
  /** Paths only the other operator changed. */
  theirs: string[];
  /** Paths only this editor changed. */
  mine: string[];
  /** True when re-applying the local diff would overwrite someone else's value. */
  overlaps: boolean;
};

/**
 * Compare "what I changed" with "what they changed", both relative to the
 * snapshot this editor loaded. A path in `contested` is one where a rebase
 * silently discards the other operator's value — the user has to be told.
 */
export function analyzeConflict(
  base: unknown,
  mine: unknown,
  theirs: unknown
): ConflictAnalysis {
  const myDiff = buildConfigDiff(base, mine);
  const theirDiff = buildConfigDiff(base, theirs);
  const theirSet = new Set(theirDiff.changedPaths);
  const mySet = new Set(myDiff.changedPaths);

  const contested = myDiff.changedPaths.filter(
    (path) =>
      theirSet.has(path) ||
      theirDiff.changedPaths.some((t) => t.startsWith(`${path}.`) || path.startsWith(`${t}.`))
  );
  return {
    contested,
    theirs: theirDiff.changedPaths.filter((p) => !mySet.has(p)),
    mine: myDiff.changedPaths.filter((p) => !contested.includes(p)),
    overlaps: contested.length > 0,
  };
}

/* ── save payload ───────────────────────────────────────────────────── */

export type ConfigSaveBody = {
  patch: JsonObject;
  baseHash: string;
  replacePaths?: string[];
};

/**
 * The exact PATCH body for a form save: a minimal merge patch plus the array
 * paths whose shrink/reorder the user confirmed. Never the whole document —
 * that is what made deletes silent no-ops.
 */
export function buildSaveBody(
  base: unknown,
  next: unknown,
  baseHash: string,
  extraReplacePaths: string[] = []
): { body: ConfigSaveBody; diff: ConfigDiff } {
  const diff = buildConfigDiff(base, next);
  const replacePaths = Array.from(new Set([...diff.replacePaths, ...extraReplacePaths]));
  return {
    body: {
      patch: diff.patch,
      baseHash,
      ...(replacePaths.length > 0 ? { replacePaths } : {}),
    },
    diff,
  };
}

/** True when the draft differs from the loaded snapshot in any way. */
export function isDirty(base: unknown, next: unknown): boolean {
  return !deepEqual(base ?? {}, next ?? {});
}

/* ── field search index ─────────────────────────────────────────────── */

export type FieldIndexEntry = {
  path: string;
  section: string;
  label: string;
};

const MAX_INDEX_DEPTH = 4;

/**
 * Searchable index of FIELDS, not just sections.
 *
 * Built from the union of the schema's declared properties, the uiHints, and
 * the keys actually present in the document, so a never-configured field is
 * still findable.
 */
export function buildFieldIndex(
  config: JsonObject,
  schemaSections: Record<string, { properties?: Record<string, unknown> } | undefined>,
  hints: Record<string, { label?: string } | undefined>
): FieldIndexEntry[] {
  const entries = new Map<string, FieldIndexEntry>();

  const add = (path: string) => {
    if (entries.has(path)) return;
    const section = path.split(".")[0];
    const leaf = path.split(".").slice(-1)[0];
    entries.set(path, { path, section, label: hints[path]?.label || leaf });
  };

  const walk = (node: unknown, prefix: string, depth: number) => {
    if (depth > MAX_INDEX_DEPTH || !isPlainObject(node)) return;
    for (const key of Object.keys(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      add(path);
      walk((node as JsonObject)[key], path, depth + 1);
    }
  };

  walk(config, "", 1);

  for (const [sectionKey, sectionSchema] of Object.entries(schemaSections)) {
    const props = sectionSchema?.properties;
    if (!isPlainObject(props)) continue;
    for (const key of Object.keys(props)) add(`${sectionKey}.${key}`);
  }

  for (const path of Object.keys(hints)) {
    if (path.includes(".")) add(path);
  }

  return Array.from(entries.values());
}

/** Rank field-index entries against a query. Empty query returns nothing. */
export function searchFields(
  index: FieldIndexEntry[],
  query: string,
  limit = 12
): FieldIndexEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ entry: FieldIndexEntry; score: number }> = [];
  for (const entry of index) {
    const label = entry.label.toLowerCase();
    const path = entry.path.toLowerCase();
    let score = -1;
    if (label === q || path === q) score = 0;
    else if (label.startsWith(q)) score = 1;
    else if (path.endsWith(`.${q}`)) score = 2;
    else if (label.includes(q)) score = 3;
    else if (path.includes(q)) score = 4;
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) => a.score - b.score || a.entry.path.length - b.entry.path.length
  );
  return scored.slice(0, limit).map((s) => s.entry);
}
