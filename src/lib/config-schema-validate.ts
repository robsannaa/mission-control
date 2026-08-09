/**
 * Pure, dependency-free half of the config schema intelligence.
 *
 * **This module is browser-safe on purpose.** It has zero imports, touches no
 * Node built-ins and performs no I/O, so client components can import it
 * directly:
 *
 * ```ts
 * import { validateConfigValue } from "@/lib/config-schema-validate";
 * ```
 *
 * The server-only lookup service lives in `@/lib/config-schema-lookup` and
 * re-exports everything here for convenience — but that module pulls in the
 * gateway transport (child_process, fs), so **never import it from a client
 * component**. Import the validator from this file instead.
 *
 * What lives here:
 *   - the normalized lookup shape the config editor consumes
 *   - `normalizeConfigSchemaLookup` — gateway payload → normalized shape
 *   - `reloadKindFromMatrix` — the documented reload table, used when the
 *     gateway does not report `reloadKind`
 *   - `validateConfigValue` — real client-side validation
 */

/* ────────────────────────────── types ────────────────────────────────── */

/**
 * How the gateway reacts to a write at this path.
 *
 * `restart` — the whole gateway restarts.
 * `hot`     — applied live (possibly restarting just that subsystem).
 * `none`    — no reload action at all.
 *
 * Source: `config.schema.lookup` `reloadKind` (OpenClaw `src/config/schema.ts`),
 * documented in docs/gateway/protocol.md line 419.
 */
export type ConfigReloadKind = "restart" | "hot" | "none";

/** Where `reloadKind` came from. */
export type ConfigReloadKindSource = "gateway" | "matrix";

/** One immediate child of a looked-up node. */
export type NormalizedConfigLookupChild = {
  key: string;
  /** Full dotted path of the child. `key` is `*` for wildcard/array-item nodes. */
  path: string;
  /** Single JSON type when unambiguous. */
  type?: string;
  /** Every JSON type the child accepts (union/composition aware). */
  types?: string[];
  required: boolean;
  hasChildren: boolean;
  reloadKind: ConfigReloadKind | null;
  label?: string;
  help?: string;
  sensitive?: boolean;
};

/**
 * The stable shape the config editor consumes.
 *
 * A superset of the fields OpenClaw returns: the mandated core
 * (`reloadKind`, `required`, `deprecated`, `readOnly`, `type`, `title`,
 * `description`, `enum`, `pattern`, `minimum`, `maximum`, `minLength`,
 * `maxLength`, `default`) plus the extras needed to validate correctly
 * (`exclusiveMinimum`/`exclusiveMaximum` — `gateway.port` really is
 * `exclusiveMinimum: 0`, so a plain `minimum` would wrongly accept port 0)
 * and to render well (`label`, `help`, `sensitive`, `children`).
 *
 * Tri-state fields are `null` when the gateway did not say, never guessed.
 */
export type NormalizedConfigLookup = {
  /** Path as the gateway normalized it (`agents.list[0].x` → `agents.list.0.x`). */
  path: string;
  /** Path exactly as the caller asked for it. */
  requestedPath: string;

  reloadKind: ConfigReloadKind | null;
  /** `gateway` when the RPC reported it; `matrix` when derived from the docs table. */
  reloadKindSource: ConfigReloadKindSource | null;

  required: boolean | null;
  deprecated: boolean | null;
  readOnly: boolean | null;
  writeOnly: boolean | null;

  type?: string;
  types?: string[];
  title?: string;
  description?: string;
  enum?: unknown[];
  const?: unknown;
  format?: string;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  /**
   * Schema default.
   *
   * OpenClaw v2026.7.1-2 strips `default` from lookup nodes
   * (`stripSchemaForLookup` keeps only the doc/validation keys), so in
   * practice this is `undefined` today. Kept in the contract because the
   * field is part of the shape the editor was promised and newer gateways
   * may start returning it.
   */
  default?: unknown;

  /** UI hint metadata (`hint.label` etc. from the gateway's uiHints). */
  label?: string;
  help?: string;
  group?: string;
  order?: number;
  advanced?: boolean;
  sensitive?: boolean;
  placeholder?: string;
  /** Path whose hint matched (may be a wildcard ancestor of `path`). */
  hintPath?: string;

  hasChildren: boolean;
  children: NormalizedConfigLookupChild[];

  /** Verbatim shallow schema node, for callers that need the raw JSON Schema. */
  schema: Record<string, unknown> | null;

  /**
   * True when the payload was synthesized locally (gateway RPC unavailable),
   * so only `reloadKind` is meaningful and every constraint is unknown.
   */
  degraded?: boolean;
};

/** Result of validating one candidate value. */
export type ConfigValueValidation = { ok: true } | { ok: false; message: string };

/* ─────────────────────── reload matrix fallback ──────────────────────── */

/**
 * Prefixes that force a full gateway restart.
 *
 * Transcribed from docs/gateway/configuration.md, "What hot-applies vs what
 * needs a restart" (lines ~534-585): everything hot-applies except
 * `gateway.*` (port, bind, auth, tailscale, TLS, HTTP, push) and the
 * Infrastructure row — `discovery`, `browser`, `plugins.load`,
 * `plugins.installs`.
 */
const RESTART_PREFIXES = [
  "gateway",
  "discovery",
  "browser",
  "plugins.load",
  "plugins.installs",
];

/**
 * Documented exceptions inside `gateway.*` that do NOT restart.
 *
 * Same doc, the Note under the table: "`gateway.reload` and `gateway.remote`
 * are exceptions under `gateway.*`".
 */
const RESTART_EXCEPTION_PREFIXES = ["gateway.reload", "gateway.remote"];

function isPathUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}.`);
}

/**
 * Best-effort `reloadKind` for a path from the documented reload matrix.
 *
 * Only used when the gateway does not report `reloadKind` (older gateway, or
 * the RPC is unavailable). Returns `restart` or `hot` — it can never say
 * `none`, because the matrix does not distinguish "hot-applied" from
 * "no reload needed"; treating an unknown as `hot` is the safe, non-alarming
 * default. Individual plugins may widen the restart set, so a `hot` answer
 * from here is a hint, not a promise.
 */
export function reloadKindFromMatrix(path: string): ConfigReloadKind {
  const normalized = normalizeLookupPathForMatrix(path);
  if (!normalized) return "restart"; // the root replaces everything
  for (const exception of RESTART_EXCEPTION_PREFIXES) {
    if (isPathUnder(normalized, exception)) return "hot";
  }
  for (const prefix of RESTART_PREFIXES) {
    if (isPathUnder(normalized, prefix)) return "restart";
  }
  return "hot";
}

function normalizeLookupPathForMatrix(path: string): string {
  const trimmed = String(path ?? "").trim();
  if (!trimmed || trimmed === ".") return "";
  return trimmed
    .replace(/\[(\d+)\]/g, ".$1")
    .replace(/\[\]/g, ".*")
    .replace(/\.+/g, ".")
    .replace(/^\.|\.$/g, "");
}

/* ─────────────────────────── normalization ───────────────────────────── */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

function compositionBranches(node: Record<string, unknown>): Record<string, unknown>[] {
  const branches: Record<string, unknown>[] = [];
  for (const key of COMPOSITION_KEYS) {
    const value = node[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (isRecord(entry)) branches.push(entry);
    }
  }
  return branches;
}

/**
 * Every JSON type a node accepts.
 *
 * `type` may be a string, an array of strings, or absent on a composition
 * node — `gateway.auth.mode` is four `{ type: "string", const: … }` branches
 * with no top-level `type`, and `agents.defaults.model` is `string | object`.
 */
function collectTypes(node: Record<string, unknown>, depth = 0): string[] {
  const direct = node.type;
  if (typeof direct === "string") return [direct];
  if (Array.isArray(direct)) {
    const entries = direct.filter((t): t is string => typeof t === "string");
    if (entries.length > 0) return entries;
  }
  if (depth >= 4) return [];
  const seen: string[] = [];
  for (const branch of compositionBranches(node)) {
    for (const type of collectTypes(branch, depth + 1)) {
      if (!seen.includes(type)) seen.push(type);
    }
  }
  return seen;
}

/**
 * The allowed value set, flattened out of `enum`, `const`, or a composition
 * whose every branch is itself a closed set.
 *
 * This is what turns `gateway.auth.mode`'s four `const` branches into a real
 * dropdown instead of a free-text box.
 */
function collectEnum(node: Record<string, unknown>, depth = 0): unknown[] | undefined {
  if (Array.isArray(node.enum) && node.enum.length > 0) return [...node.enum];
  if (Object.prototype.hasOwnProperty.call(node, "const")) return [node.const];
  if (depth >= 4) return undefined;
  const branches = Array.isArray(node.anyOf)
    ? node.anyOf
    : Array.isArray(node.oneOf)
      ? node.oneOf
      : null;
  if (!branches || branches.length === 0) return undefined;
  const values: unknown[] = [];
  for (const branch of branches) {
    if (!isRecord(branch)) return undefined;
    const branchValues = collectEnum(branch, depth + 1);
    // One open branch (free-form string, object, …) makes the whole union open.
    if (!branchValues) return undefined;
    for (const value of branchValues) {
      if (!values.some((existing) => sameValue(existing, value))) values.push(value);
    }
  }
  return values.length > 0 ? values : undefined;
}

/**
 * Read a constraint from the node, or from its composition branches when
 * every branch agrees on the same value (a union of identically-bounded
 * strings still has that bound).
 */
function hoist<T>(
  node: Record<string, unknown>,
  key: string,
  cast: (value: unknown) => T | undefined,
): T | undefined {
  const own = cast(node[key]);
  if (own !== undefined) return own;
  const branches = compositionBranches(node);
  if (branches.length === 0) return undefined;
  let agreed: T | undefined;
  for (const branch of branches) {
    const value = cast(branch[key]);
    if (value === undefined) return undefined;
    if (agreed === undefined) agreed = value;
    else if (agreed !== value) return undefined;
  }
  return agreed;
}

/** UI hint block as returned inside a lookup payload. */
type RawHint = {
  label?: unknown;
  help?: unknown;
  group?: unknown;
  order?: unknown;
  advanced?: unknown;
  sensitive?: unknown;
  placeholder?: unknown;
};

/** Verbatim `config.schema.lookup` result, before normalization. */
export type RawConfigSchemaLookup = {
  path?: unknown;
  schema?: unknown;
  reloadKind?: unknown;
  hint?: unknown;
  hintPath?: unknown;
  children?: unknown;
};

function asReloadKind(value: unknown): ConfigReloadKind | null {
  return value === "restart" || value === "hot" || value === "none" ? value : null;
}

function normalizeChild(entry: unknown): NormalizedConfigLookupChild | null {
  if (!isRecord(entry)) return null;
  const key = asString(entry.key);
  const path = asString(entry.path);
  if (!key || !path) return null;
  const hint = isRecord(entry.hint) ? (entry.hint as RawHint) : null;
  const types = collectTypes(entry);
  return {
    key,
    path,
    ...(types.length === 1 ? { type: types[0] } : {}),
    ...(types.length > 0 ? { types } : {}),
    required: entry.required === true,
    hasChildren: entry.hasChildren === true,
    reloadKind: asReloadKind(entry.reloadKind) ?? reloadKindFromMatrix(path),
    ...(hint && asString(hint.label) ? { label: asString(hint.label) } : {}),
    ...(hint && asString(hint.help) ? { help: asString(hint.help) } : {}),
    ...(hint && asBoolean(hint.sensitive) !== undefined
      ? { sensitive: asBoolean(hint.sensitive) }
      : {}),
  };
}

/**
 * Turn a raw `config.schema.lookup` payload into the normalized shape.
 *
 * Pure and total: any malformed payload degrades to nulls rather than
 * throwing. `required` is not part of the lookup payload for the node itself
 * (the gateway only reports it on *child* summaries), so callers pass it in
 * after looking up the parent — see `config-schema-lookup.ts`.
 */
export function normalizeConfigSchemaLookup(
  raw: RawConfigSchemaLookup | null | undefined,
  options: { requestedPath: string; required?: boolean | null },
): NormalizedConfigLookup | null {
  if (!isRecord(raw)) return null;
  const path = asString(raw.path) ?? options.requestedPath;
  const schema = isRecord(raw.schema) ? (raw.schema as Record<string, unknown>) : null;
  const node = schema ?? {};
  const hint = isRecord(raw.hint) ? (raw.hint as RawHint) : null;

  const children: NormalizedConfigLookupChild[] = Array.isArray(raw.children)
    ? raw.children
        .map(normalizeChild)
        .filter((child): child is NormalizedConfigLookupChild => child !== null)
    : [];

  const gatewayReloadKind = asReloadKind(raw.reloadKind);
  const types = collectTypes(node);
  const enumValues = collectEnum(node);

  const normalized: NormalizedConfigLookup = {
    path,
    requestedPath: options.requestedPath,
    reloadKind: gatewayReloadKind ?? reloadKindFromMatrix(path),
    reloadKindSource: gatewayReloadKind ? "gateway" : "matrix",
    required: options.required ?? null,
    deprecated: asBoolean(node.deprecated) ?? null,
    readOnly: asBoolean(node.readOnly) ?? null,
    writeOnly: asBoolean(node.writeOnly) ?? null,
    hasChildren: children.length > 0,
    children,
    schema,
  };

  if (types.length === 1) normalized.type = types[0];
  if (types.length > 0) normalized.types = types;
  if (enumValues) normalized.enum = enumValues;
  if (Object.prototype.hasOwnProperty.call(node, "const")) normalized.const = node.const;
  if (Object.prototype.hasOwnProperty.call(node, "default")) normalized.default = node.default;

  const stringKeys = ["title", "description", "format", "pattern"] as const;
  for (const key of stringKeys) {
    const value = hoist(node, key, asString);
    if (value !== undefined) normalized[key] = value;
  }

  const numberKeys = [
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ] as const;
  for (const key of numberKeys) {
    const value = hoist(node, key, asNumber);
    if (value !== undefined) normalized[key] = value;
  }

  const uniqueItems = hoist(node, "uniqueItems", asBoolean);
  if (uniqueItems !== undefined) normalized.uniqueItems = uniqueItems;

  if (hint) {
    const label = asString(hint.label);
    const help = asString(hint.help);
    const group = asString(hint.group);
    const placeholder = asString(hint.placeholder);
    const order = asNumber(hint.order);
    const advanced = asBoolean(hint.advanced);
    const sensitive = asBoolean(hint.sensitive);
    if (label) normalized.label = label;
    if (help) normalized.help = help;
    if (group) normalized.group = group;
    if (placeholder) normalized.placeholder = placeholder;
    if (order !== undefined) normalized.order = order;
    if (advanced !== undefined) normalized.advanced = advanced;
    if (sensitive !== undefined) normalized.sensitive = sensitive;
  }
  const hintPath = asString(raw.hintPath);
  if (hintPath) normalized.hintPath = hintPath;

  // Titles and help text live on the schema node too; mirror them so the
  // editor has one place to read a label from.
  if (!normalized.label && normalized.title) normalized.label = normalized.title;
  if (!normalized.help && normalized.description) normalized.help = normalized.description;

  return normalized;
}

/**
 * Synthesize a lookup for a path when the gateway RPC is unavailable.
 *
 * Everything except `reloadKind` is unknown — `degraded: true` tells the
 * editor to show the restart warning but claim nothing about constraints.
 */
export function degradedConfigLookup(requestedPath: string): NormalizedConfigLookup {
  return {
    path: normalizeLookupPathForMatrix(requestedPath) || ".",
    requestedPath,
    reloadKind: reloadKindFromMatrix(requestedPath),
    reloadKindSource: "matrix",
    required: null,
    deprecated: null,
    readOnly: null,
    writeOnly: null,
    hasChildren: false,
    children: [],
    schema: null,
    degraded: true,
  };
}

/* ──────────────────────────── validation ─────────────────────────────── */

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function fieldLabel(lookup: NormalizedConfigLookup): string {
  if (lookup.title) return lookup.title;
  if (lookup.label) return lookup.label;
  const segments = lookup.path.split(".").filter(Boolean);
  return segments[segments.length - 1] || lookup.path;
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return "text";
    case "number":
      return "a number";
    case "boolean":
      return "true/false";
    case "object":
      return "an object";
    default:
      return typeof value;
  }
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      // Unknown JSON type keyword — do not invent a failure.
      return true;
  }
}

function typeExpectation(types: string[]): string {
  const parts = types.map((type) => {
    switch (type) {
      case "string":
        return "text";
      case "integer":
        return "a whole number";
      case "number":
        return "a number";
      case "boolean":
        return "true or false";
      case "array":
        return "a list";
      case "object":
        return "an object";
      case "null":
        return "nothing";
      default:
        return type;
    }
  });
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

function formatEnum(values: unknown[]): string {
  return values
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join(", ");
}

/**
 * Validate a candidate value against a normalized lookup.
 *
 * Pure and side-effect free — safe to call on every keystroke in the browser.
 * Enforces required / readOnly / type / enum / pattern / minimum / maximum /
 * exclusiveMinimum / exclusiveMaximum / multipleOf / minLength / maxLength /
 * minItems / maxItems / uniqueItems.
 *
 * Deliberately permissive where the schema is silent: an unknown lookup
 * (`null`), a degraded lookup, or a constraint the gateway did not report
 * all pass. This validator's job is to stop writes that OpenClaw would
 * certainly reject — not to invent rules the gateway does not have.
 *
 * `undefined`, `null` and blank strings all count as "no value": on a
 * required field that is an error, otherwise it is a legitimate clear/delete.
 */
export function validateConfigValue(
  lookup: NormalizedConfigLookup | null | undefined,
  value: unknown,
): ConfigValueValidation {
  if (!lookup || lookup.degraded) return { ok: true };

  const label = fieldLabel(lookup);

  if (lookup.readOnly === true) {
    return { ok: false, message: `${label} is read-only and cannot be changed here.` };
  }

  const isBlank =
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim().length === 0);

  if (isBlank) {
    if (lookup.required === true) {
      return { ok: false, message: `${label} is required.` };
    }
    return { ok: true };
  }

  const types = lookup.types ?? (lookup.type ? [lookup.type] : []);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    return {
      ok: false,
      message: `${label} must be ${typeExpectation(types)} — got ${describeValue(value)}.`,
    };
  }

  if (lookup.enum && lookup.enum.length > 0) {
    if (!lookup.enum.some((allowed) => sameValue(allowed, value))) {
      return {
        ok: false,
        message: `${label} must be one of: ${formatEnum(lookup.enum)}.`,
      };
    }
  }

  if (typeof value === "string") {
    if (lookup.minLength !== undefined && value.length < lookup.minLength) {
      return {
        ok: false,
        message: `${label} must be at least ${lookup.minLength} character${
          lookup.minLength === 1 ? "" : "s"
        } long.`,
      };
    }
    if (lookup.maxLength !== undefined && value.length > lookup.maxLength) {
      return {
        ok: false,
        message: `${label} must be at most ${lookup.maxLength} character${
          lookup.maxLength === 1 ? "" : "s"
        } long.`,
      };
    }
    if (lookup.pattern) {
      let regex: RegExp | null = null;
      try {
        regex = new RegExp(lookup.pattern);
      } catch {
        // An unusable pattern is the schema's problem, not the user's.
        regex = null;
      }
      if (regex && !regex.test(value)) {
        return { ok: false, message: `${label} does not match the required format.` };
      }
    }
  }

  if (typeof value === "number") {
    if (lookup.minimum !== undefined && value < lookup.minimum) {
      return { ok: false, message: `${label} must be ${lookup.minimum} or more.` };
    }
    if (lookup.maximum !== undefined && value > lookup.maximum) {
      return { ok: false, message: `${label} must be ${lookup.maximum} or less.` };
    }
    if (lookup.exclusiveMinimum !== undefined && value <= lookup.exclusiveMinimum) {
      return { ok: false, message: `${label} must be greater than ${lookup.exclusiveMinimum}.` };
    }
    if (lookup.exclusiveMaximum !== undefined && value >= lookup.exclusiveMaximum) {
      return { ok: false, message: `${label} must be less than ${lookup.exclusiveMaximum}.` };
    }
    if (lookup.multipleOf !== undefined && lookup.multipleOf > 0) {
      const ratio = value / lookup.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) {
        return { ok: false, message: `${label} must be a multiple of ${lookup.multipleOf}.` };
      }
    }
  }

  if (Array.isArray(value)) {
    if (lookup.minItems !== undefined && value.length < lookup.minItems) {
      return {
        ok: false,
        message: `${label} needs at least ${lookup.minItems} item${
          lookup.minItems === 1 ? "" : "s"
        }.`,
      };
    }
    if (lookup.maxItems !== undefined && value.length > lookup.maxItems) {
      return {
        ok: false,
        message: `${label} allows at most ${lookup.maxItems} item${
          lookup.maxItems === 1 ? "" : "s"
        }.`,
      };
    }
    if (lookup.uniqueItems === true) {
      for (let i = 0; i < value.length; i += 1) {
        for (let j = i + 1; j < value.length; j += 1) {
          if (sameValue(value[i], value[j])) {
            return { ok: false, message: `${label} must not contain duplicate entries.` };
          }
        }
      }
    }
  }

  return { ok: true };
}
