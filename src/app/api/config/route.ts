import { NextResponse } from "next/server";
import { CONFIG_WRITE_TIMEOUT_MS, gatewayCall, runCliCaptureBoth } from "@/lib/openclaw";
import {
  gatewayConfigApply,
  gatewayConfigPatch,
  sanitizeConfigFile,
} from "@/lib/gateway-config";
import {
  buildConfigDiff,
  collectDeletedPaths,
  collectEnvSubstitutedPaths,
  collectPatchPaths,
  normalizeArrayPath,
  parseReplacePathsFromError,
} from "@/lib/config-diff";
import { readFile } from "fs/promises";
import { join } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { randomBytes } from "crypto";
import { withRoute } from "@/lib/api-route";
import { configWriteSchema } from "@/lib/schemas/config";
import { badRequest, serverError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";
const OPENCLAW_HOME = getOpenClawHome();

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sentinel the gateway substitutes for secret values in `config.get` output.
 */
const GATEWAY_REDACTED_SENTINEL = "__OPENCLAW_REDACTED__";

/**
 * Restore gateway-redacted values from the config file on disk.
 *
 * Secrets are intentionally readable in Mission Control — protection comes
 * from authenticating the caller, not from hiding values — but the gateway
 * blanks them to a sentinel in `config.get`. Wherever the payload carries the
 * sentinel and the on-disk config has a string at the same path, serve the
 * real value. Everything else passes through untouched.
 *
 * This is exact now that the served surface is `parsed`: `parsed` is the
 * on-disk document (verified live — `parsed` and `sourceConfig` are identical),
 * so sentinel positions line up with disk positions key for key.
 */
function restoreRedactedValues(node: unknown, diskNode: unknown): unknown {
  if (typeof node === "string") {
    return node === GATEWAY_REDACTED_SENTINEL && typeof diskNode === "string"
      ? diskNode
      : node;
  }
  if (Array.isArray(node)) {
    const diskArray = Array.isArray(diskNode) ? diskNode : [];
    return node.map((item, i) => restoreRedactedValues(item, diskArray[i]));
  }
  if (node && typeof node === "object") {
    const diskRecord = isRecord(diskNode) ? diskNode : {};
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      result[k] = restoreRedactedValues(v, diskRecord[k]);
    }
    return result;
  }
  return node;
}

/** Best-effort read of ~/.openclaw/openclaw.json (null when unreadable). */
async function readDiskConfig(): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(join(OPENCLAW_HOME, "openclaw.json"), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTransientGatewayError(err: unknown): boolean {
  const msg = String(err).toLowerCase();

  // Scope/auth errors are permanent — never retry.
  if (
    msg.includes("missing scope") ||
    msg.includes("forbidden") ||
    msg.includes("unauthorized") ||
    msg.includes("returned 403") ||
    msg.includes("returned 401")
  ) {
    return false;
  }

  return (
    msg.includes("gateway closed") ||
    msg.includes("1006") ||
    msg.includes("abnormal closure") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up")
  );
}

function formatGatewayError(err: unknown): string {
  const msg = String(err);
  if (isTransientGatewayError(err)) {
    return "Gateway temporarily unavailable while loading configuration. Please retry in a moment.";
  }
  return msg;
}

async function gatewayCallWithRetry<T>(
  method: string,
  params: Record<string, unknown> | undefined,
  timeout: number,
  retries = 1
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await gatewayCall<T>(method, params, timeout);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !isTransientGatewayError(err)) break;
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function lowerError(err: unknown): string {
  return String(err || "").toLowerCase();
}

/**
 * Base-hash conflict. The live wording on OpenClaw v2026.7.1-2 (probed against
 * both `config.patch` and `config.apply`) is
 * "config changed since last load; re-run config.get and retry" — the older
 * phrasings are kept so a downgraded gateway is still recognised.
 */
function isHashConflictError(err: unknown): boolean {
  const msg = lowerError(err);
  return (
    msg.includes("config changed since last load") ||
    msg.includes("hash mismatch") ||
    msg.includes("stale base hash") ||
    msg.includes("base hash mismatch") ||
    msg.includes("config conflict")
  );
}

function isInvalidConfigError(err: unknown): boolean {
  const msg = lowerError(err);
  return msg.includes("invalid config") || msg.includes("config validation failed");
}

function isRateLimitError(err: unknown): boolean {
  const msg = lowerError(err);
  return msg.includes("rate limit exceeded") || msg.includes("retry after");
}

/** The gateway refused a destructive array replacement (needs `replacePaths`). */
function isReplacePathsError(err: unknown): boolean {
  return lowerError(err).includes("would remove entries from array path");
}

/**
 * Only a gateway that does not implement the method at all should fall back to
 * the CLI. A rejection (conflict, validation, rate limit, array guard) is a
 * real answer and must never be retried through an unguarded `config set`.
 */
function isUnsupportedMethodError(err: unknown): boolean {
  const msg = lowerError(err);
  return (
    msg.includes("unknown method") ||
    msg.includes("method not found") ||
    msg.includes("unsupported method") ||
    msg.includes("not implemented")
  );
}

/** `retryAfterMs` from the gateway error, falling back to the message text. */
function extractRetryAfterMs(err: unknown): number | undefined {
  const details = (err as { details?: unknown })?.details;
  if (isRecord(details) && typeof details.retryAfterMs === "number") {
    return details.retryAfterMs;
  }
  if (isRecord(err) && typeof err.retryAfterMs === "number") {
    return err.retryAfterMs;
  }
  const match = String(err || "").match(/retry after\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

function getByDottedPath(obj: unknown, path: string): unknown {
  if (!isRecord(obj)) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) {
    return (obj as Record<string, unknown>)[path];
  }
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const part of parts) {
    if (!isRecord(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Set a dotted path inside a patch object, creating intermediate objects.
 *
 * Deliberately NOT a literal `obj["a.b.c"] = v`: a merge patch with a dotted
 * key creates a top-level key called "a.b.c" in openclaw.json instead of
 * nesting, which is how the previous auth-token safety net could corrupt the
 * config it was meant to protect.
 */
function setDottedPath(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj;
  const parts = path.split(".");
  const root: Record<string, unknown> = { ...obj };
  let cursor = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const existing = cursor[key];
    const next: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
    cursor[key] = next;
    cursor = next;
  }
  cursor[parts[parts.length - 1]] = value;
  return root;
}

/**
 * Switching `gateway.auth.mode` to "token" without a token would lock every
 * operator out, so mint one when neither the patch nor the current config has
 * a usable value. Never overwrites an existing token.
 */
function ensureGatewayAuthPatchDefaults(
  patchObj: Record<string, unknown>,
  currentParsed: Record<string, unknown> | null
): Record<string, unknown> {
  const modeRaw = getByDottedPath(patchObj, "gateway.auth.mode");
  const mode = typeof modeRaw === "string" ? modeRaw.trim().toLowerCase() : "";
  if (mode !== "token") return patchObj;

  const patchToken = getByDottedPath(patchObj, "gateway.auth.token");
  const currentToken = getByDottedPath(currentParsed, "gateway.auth.token");
  const existingToken =
    (typeof patchToken === "string" && patchToken.trim()) ||
    (typeof currentToken === "string" &&
      currentToken !== GATEWAY_REDACTED_SENTINEL &&
      currentToken.trim()) ||
    "";
  if (existingToken) return patchObj;

  return setDottedPath(
    patchObj,
    "gateway.auth.token",
    randomBytes(24).toString("hex")
  );
}

type ConfigSetEntry = {
  path: string;
  value: unknown;
};

const MAX_CONFIG_SET_FALLBACK_ENTRIES = 24;

function collectConfigSetEntries(
  patchObj: Record<string, unknown>,
  prefix = ""
): ConfigSetEntry[] {
  const entries: ConfigSetEntry[] = [];
  for (const [key, value] of Object.entries(patchObj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && Object.keys(value).length > 0 && !key.includes(".")) {
      entries.push(...collectConfigSetEntries(value, path));
      continue;
    }
    entries.push({ path, value });
  }
  return entries;
}

function buildConfigSetFallbackEntries(
  patchObj: Record<string, unknown>,
  rawProvided: boolean
): { entries: ConfigSetEntry[] | null; reason?: string } {
  if (rawProvided) {
    return { entries: null, reason: "raw payload is not eligible for fallback" };
  }

  const entries = collectConfigSetEntries(patchObj).filter((entry) => entry.path.trim().length > 0);
  if (entries.length === 0) {
    return { entries: null, reason: "empty patch payload" };
  }
  if (entries.length > MAX_CONFIG_SET_FALLBACK_ENTRIES) {
    return {
      entries: null,
      reason: `patch has ${entries.length} entries (limit: ${MAX_CONFIG_SET_FALLBACK_ENTRIES})`,
    };
  }

  for (const entry of entries) {
    if (entry.value === undefined) {
      return { entries: null, reason: `unsupported undefined value for ${entry.path}` };
    }
    const encoded = JSON.stringify(entry.value);
    if (encoded === undefined) {
      return { entries: null, reason: `failed to encode JSON value for ${entry.path}` };
    }
  }

  return { entries };
}

async function applyConfigSetFallback(entries: ConfigSetEntry[]): Promise<{
  updatedPaths: string[];
  failures: Array<{ path: string; error: string }>;
}> {
  const failures: Array<{ path: string; error: string }> = [];
  const updatedPaths: string[] = [];

  for (const entry of entries) {
    try {
      const encoded = JSON.stringify(entry.value);
      if (encoded === undefined) {
        throw new Error("Value cannot be encoded as JSON");
      }
      const setResult = await runCliCaptureBoth(
        ["config", "set", "--strict-json", entry.path, encoded],
        CONFIG_WRITE_TIMEOUT_MS
      );
      if (setResult.code !== 0) {
        const details = String(setResult.stderr || setResult.stdout || "").trim();
        throw new Error(details || `config set exited with code ${String(setResult.code)}`);
      }
      updatedPaths.push(entry.path);
    } catch (err) {
      failures.push({ path: entry.path, error: String(err || "unknown error") });
    }
  }

  return { updatedPaths, failures };
}

async function readConfigSnapshot(): Promise<{
  baseHash: string;
  parsed: Record<string, unknown>;
  resolved: Record<string, unknown>;
}> {
  const configData = await gatewayCallWithRetry<Record<string, unknown>>(
    "config.get",
    undefined,
    10000,
    1
  );
  return {
    baseHash: String(configData.hash || "").trim(),
    parsed: isRecord(configData.parsed) ? (configData.parsed as Record<string, unknown>) : {},
    resolved: isRecord(configData.resolved)
      ? (configData.resolved as Record<string, unknown>)
      : {},
  };
}

async function runDoctorFixCapture(): Promise<{
  ok: boolean;
  output: string;
}> {
  const { stdout, stderr, code } = await runCliCaptureBoth(["doctor", "--fix"], 60000);
  const output = String(stdout || stderr || "").trim();
  return {
    ok: code === 0,
    output,
  };
}

function friendlyPatchError(err: unknown): string {
  const raw = String(err || "");
  if (isRateLimitError(err)) {
    return "OpenClaw is temporarily rate-limiting config changes. Please wait a minute and try again.";
  }
  if (isInvalidConfigError(err)) {
    return "OpenClaw rejected this change because the local config is invalid. Mission Control tried to repair it automatically, but the change still could not be applied.";
  }
  if (isReplacePathsError(err)) {
    return "This change removes entries from a list. Confirm the removal and Mission Control will resend it as an intentional replacement.";
  }
  if (isHashConflictError(err)) {
    return "Your config changed in another session. Please retry once.";
  }
  return raw;
}

// ── Reload planning (config.schema.lookup) ───────

type ReloadKind = "restart" | "hot" | "none";

type SchemaLookupResult = {
  reloadKind?: ReloadKind;
  schema?: Record<string, unknown>;
};

/**
 * `config.schema.lookup` answers are static for a given gateway build, and a
 * save can touch a couple of dozen paths — memoize so a form save costs one
 * RPC per *new* path instead of one per field, every time.
 */
const RELOAD_KIND_TTL_MS = 5 * 60_000;
const reloadKindCache = new Map<string, { value: ReloadKind | null; at: number }>();
const MAX_LOOKUP_PATHS = 40;
const LOOKUP_CONCURRENCY = 6;

/**
 * Documented fallback (gateway/configuration.md "What hot-applies vs what
 * needs a restart") used only when the schema lookup is unavailable.
 * `gateway.reload` and `gateway.remote` are the documented exceptions.
 */
const RESTART_PREFIXES = ["gateway", "discovery", "browser", "plugins.load", "plugins.installs"];
const RESTART_EXCEPTIONS = ["gateway.reload", "gateway.remote"];

function fallbackReloadKind(path: string): ReloadKind {
  if (RESTART_EXCEPTIONS.some((p) => path === p || path.startsWith(`${p}.`))) return "hot";
  if (RESTART_PREFIXES.some((p) => path === p || path.startsWith(`${p}.`))) return "restart";
  return "hot";
}

async function lookupReloadKind(path: string): Promise<ReloadKind | null> {
  const cached = reloadKindCache.get(path);
  if (cached && Date.now() - cached.at < RELOAD_KIND_TTL_MS) return cached.value;

  // Deep leaves are not always present in the schema tree (probed live:
  // `agents.defaults.model.primary` answers "config schema path not found"),
  // so walk up until a node answers.
  const segments = path.split(".");
  for (let depth = segments.length; depth >= 1; depth -= 1) {
    const candidate = segments.slice(0, depth).join(".");
    try {
      const result = await gatewayCall<SchemaLookupResult>(
        "config.schema.lookup",
        { path: candidate },
        8000
      );
      const kind = result?.reloadKind;
      if (kind === "restart" || kind === "hot" || kind === "none") {
        reloadKindCache.set(path, { value: kind, at: Date.now() });
        return kind;
      }
    } catch {
      // try the parent path
    }
  }
  reloadKindCache.set(path, { value: null, at: Date.now() });
  return null;
}

/**
 * Decide restart necessity from the schema, per touched path. This is what
 * replaces the old "restart the gateway on every save" behaviour: most fields
 * hot-apply, and the control plane only allows one restart cycle per 30s.
 */
async function planReload(paths: string[]): Promise<{
  restartRequired: boolean;
  restartPaths: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const unique = Array.from(new Set(paths.map(normalizeArrayPath))).filter(Boolean);
  const budgeted = unique.slice(0, MAX_LOOKUP_PATHS);
  if (unique.length > budgeted.length) {
    warnings.push(
      `Reload planning inspected the first ${MAX_LOOKUP_PATHS} of ${unique.length} changed paths.`
    );
  }

  const restartPaths: string[] = [];
  let schemaUnavailable = false;

  for (let i = 0; i < budgeted.length; i += LOOKUP_CONCURRENCY) {
    const slice = budgeted.slice(i, i + LOOKUP_CONCURRENCY);
    const kinds = await Promise.all(
      slice.map(async (path) => ({ path, kind: await lookupReloadKind(path) }))
    );
    for (const { path, kind } of kinds) {
      const effective = kind ?? fallbackReloadKind(path);
      if (kind === null) schemaUnavailable = true;
      if (effective === "restart") restartPaths.push(path);
    }
  }

  if (schemaUnavailable) {
    warnings.push(
      "Some paths were not found in the config schema; restart planning fell back to the documented reload table."
    );
  }

  return { restartRequired: restartPaths.length > 0, restartPaths, warnings };
}

/** Restart delay used only when a restart is actually required. */
const RESTART_DELAY_MS = 2000;

/**
 * GET /api/config
 *
 * Returns one canonical payload:
 *   { config, meta: { baseHash, schema, uiHints, envSubstituted, warning?, degraded? } }
 *
 * `config` is the gateway's **parsed** snapshot — the authoring surface, i.e.
 * the document as written in openclaw.json. Serving `resolved` here (the
 * previous behaviour) baked every `${VAR}` into its literal expansion on the
 * first save and destroyed the indirection. `meta.envSubstituted` lists the
 * dotted paths whose authored value carries env indirection so the UI can
 * label them.
 *
 * Secret values are intentionally served unredacted — protection comes from
 * authenticating the caller, not from hiding values (product decision). The
 * client's show/hide-secrets toggle is purely cosmetic.
 *
 * Query: scope=config (default) | schema
 */
export const GET = withRoute({ name: "/api/config" }, async (request, ctx) => {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") || "config";

  try {
    if (scope === "schema") {
      try {
        const data = await gatewayCallWithRetry<Record<string, unknown>>(
          "config.schema",
          undefined,
          15000,
          1
        );
        return NextResponse.json(data);
      } catch (err) {
        return NextResponse.json({
          schema: {},
          uiHints: {},
          warning: formatGatewayError(err),
        });
      }
    }

    // Default: config first, schema best-effort.
    const configData = await gatewayCallWithRetry<Record<string, unknown>>(
      "config.get",
      undefined,
      10000,
      1
    );

    let schemaData: Record<string, unknown> | null = null;
    let warning: string | undefined;
    try {
      schemaData = await gatewayCallWithRetry<Record<string, unknown>>(
        "config.schema",
        undefined,
        15000,
        1
      );
    } catch (err) {
      warning = formatGatewayError(err);
      ctx.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Config schema unavailable, serving config without schema",
      );
    }

    // `config.get` returns { parsed, resolved, hash, ... }. `parsed` is the
    // authored document (verified live: identical to `sourceConfig`);
    // `resolved` is the same document with `${VAR}` substitution applied.
    // Author against `parsed`, fall back to `resolved` only if a gateway omits
    // it. (`configData.config` is the defaults-merged effective view — never an
    // authoring surface, it would write every default into openclaw.json.)
    const parsed = (configData.parsed || {}) as Record<string, unknown>;
    const resolved = (configData.resolved || {}) as Record<string, unknown>;
    const authored = Object.keys(parsed).length > 0 ? parsed : resolved;

    const envSubstituted = collectEnvSubstitutedPaths(authored, resolved);

    // The gateway blanks secrets to a sentinel; serve the real values.
    const diskConfig = await readDiskConfig();
    const config = diskConfig
      ? (restoreRedactedValues(authored, diskConfig) as Record<string, unknown>)
      : authored;

    return NextResponse.json({
      config,
      meta: {
        baseHash: configData.hash || "",
        schema: schemaData?.schema || {},
        uiHints: schemaData?.uiHints || {},
        configSource: Object.keys(parsed).length > 0 ? "parsed" : "resolved",
        envSubstituted,
        ...(warning ? { warning } : {}),
      },
    });
  } catch (err) {
    ctx.log.warn(
      { err: err instanceof Error ? err.message : String(err), scope },
      "config.get failed; attempting disk fallback",
    );
    try {
      const raw = await readFile(join(OPENCLAW_HOME, "openclaw.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return NextResponse.json({
        config: parsed,
        meta: {
          baseHash: "",
          schema: {},
          uiHints: {},
          configSource: "disk",
          envSubstituted: [],
          warning: formatGatewayError(err),
          degraded: true,
        },
      });
    } catch {
      return serverError(formatGatewayError(err));
    }
  }
});

/**
 * Fresh snapshot + hash for a 409 body, with secrets restored for the UI diff.
 * `error`/`currentHash`/`remoteConfig`/`message` are all read directly off
 * this body by `config-editor.tsx` (top-level fields, not nested under
 * `details`), so this stays a manually-built response rather than going
 * through an `@/lib/api-errors` builder — the builders only support
 * `{ ok, error, details? }` and have no slot for this route's established
 * extra fields. `ok: false` is added here so the body still carries the
 * canonical envelope's marker (D-01).
 */
async function buildConflictBody(message: string): Promise<Record<string, unknown>> {
  let currentHash = "";
  let remoteConfig: Record<string, unknown> = {};
  try {
    const latest = await readConfigSnapshot();
    currentHash = latest.baseHash;
    const disk = await readDiskConfig();
    remoteConfig = disk
      ? (restoreRedactedValues(latest.parsed, disk) as Record<string, unknown>)
      : latest.parsed;
  } catch {
    // Serve the conflict even if the re-read fails; the UI can refetch.
  }
  return { ok: false, error: "conflict", currentHash, remoteConfig, message };
}

/**
 * PATCH /api/config — minimal, non-clobbering config write.
 *
 * Body:
 *   {
 *     patch?: object,        // JSON merge patch; `null` leaf = delete the key
 *     raw?: string,          // JSON document (merge patch, or full config with mode:"apply")
 *     baseHash: string,      // hash from GET /api/config meta.baseHash
 *     replacePaths?: string[], // dotted array paths whose shrink/reorder is intentional
 *     mode?: "patch" | "apply"
 *   }
 *
 * Responses:
 *   200 { ok, hash, restartRequired, restartPaths?, warnings?, deletedPaths?, result }
 *   400 { error, details?, doctorOutput?, replacePathsRequired? }
 *   409 { error: "conflict", currentHash, remoteConfig, message }
 *   429 { error, retryAfterMs? }
 *
 * Three deliberate behaviours, each fixing an audited defect:
 *   - deletions are forwarded verbatim, so an explicit `null` really deletes;
 *   - a base-hash conflict is never retried with a fresh hash (that silently
 *     clobbered whoever wrote in between) — the caller gets 409 and decides;
 *   - a restart is requested only when `config.schema.lookup` says a touched
 *     path needs one.
 */
export const PATCH = withRoute(
  { name: "/api/config", bodySchema: configWriteSchema },
  async (_request, ctx) => {
  try {
    // `configWriteSchema` (src/lib/schemas/config.ts) is the Zod port of the
    // former hand-rolled raw/patch payload check — an invalid `raw`/`patch`
    // body never reaches this handler; withRoute already answered it with
    // the canonical envelope via `validationFailed()`.
    const { patchObj, baseHash, replacePaths, mode } = ctx.body;
    const raw = ctx.body.raw;

    if (replacePaths !== undefined && !Array.isArray(replacePaths)) {
      return badRequest("replacePaths must be an array of dotted config paths");
    }
    if (mode !== undefined && mode !== "patch" && mode !== "apply") {
      return badRequest('mode must be "patch" or "apply"');
    }

    const rawProvided = raw !== undefined;
    const useApply = mode === "apply";
    let workingPatchObj = patchObj;
    const requestedReplacePaths = ((replacePaths as string[] | undefined) ?? [])
      .filter((p): p is string => typeof p === "string" && p.trim().length > 0)
      .map((p) => normalizeArrayPath(p.trim()));

    let workingBaseHash = String(baseHash || "").trim();
    let unguardedWrite = false;
    if (!workingBaseHash) {
      try {
        const latest = await readConfigSnapshot();
        workingBaseHash = latest.baseHash;
        // The caller had nothing to be stale against, but say so out loud
        // rather than pretending the write was conflict-checked.
        unguardedWrite = Boolean(workingBaseHash);
      } catch {
        // Legacy gateways may not provide hash; the patch flow still works.
      }
    }

    if (typeof getByDottedPath(workingPatchObj, "gateway.auth.mode") === "string") {
      try {
        const latest = await readConfigSnapshot();
        workingPatchObj = ensureGatewayAuthPatchDefaults(workingPatchObj, latest.parsed);
      } catch {
        workingPatchObj = ensureGatewayAuthPatchDefaults(workingPatchObj, null);
      }
    }

    // Which paths does this write touch?
    //
    // A merge patch says so directly. `config.apply` carries the whole
    // document, so naming every top-level section would demand a restart on
    // every raw save (verified: an idempotent apply reported gateway, auth,
    // channels, ... as changed). Diff it against the current snapshot instead
    // and plan from the paths that genuinely differ. The write is still
    // guarded by the caller's `baseHash`, so this extra read cannot turn into
    // a clobber.
    let touchedPaths: string[];
    let deletedPaths: string[] = [];
    if (useApply) {
      const applyDiff = await (async () => {
        try {
          const latest = await readConfigSnapshot();
          const disk = await readDiskConfig();
          const base = disk
            ? (restoreRedactedValues(latest.parsed, disk) as Record<string, unknown>)
            : latest.parsed;
          return buildConfigDiff(base, workingPatchObj);
        } catch {
          return null;
        }
      })();
      touchedPaths = applyDiff ? applyDiff.changedPaths : Object.keys(workingPatchObj);
      deletedPaths = applyDiff ? applyDiff.deletedPaths : [];
    } else {
      touchedPaths = collectPatchPaths(workingPatchObj);
      deletedPaths = collectDeletedPaths(workingPatchObj);
    }
    const plan = await planReload(touchedPaths).catch(() => ({
      restartRequired: false,
      restartPaths: [] as string[],
      warnings: ["Restart planning was unavailable for this write."],
    }));

    const writeOnce = async (
      patchObj: Record<string, unknown>,
      hash: string
    ): Promise<Record<string, unknown>> => {
      const params: {
        raw: string;
        baseHash?: string;
        restartDelayMs?: number;
        replacePaths?: string[];
      } = { raw: JSON.stringify(patchObj) };
      if (hash) params.baseHash = hash;
      // Only ask for a restart when a touched path actually needs one. The
      // control plane enforces a 30s restart cooldown, so an unconditional
      // restart per save burned the budget for changes that hot-apply.
      if (plan.restartRequired) params.restartDelayMs = RESTART_DELAY_MS;
      if (!useApply && requestedReplacePaths.length > 0) {
        params.replacePaths = requestedReplacePaths;
      }
      return useApply
        ? gatewayConfigApply<Record<string, unknown>>(params, CONFIG_WRITE_TIMEOUT_MS)
        : gatewayConfigPatch<Record<string, unknown>>(params, CONFIG_WRITE_TIMEOUT_MS);
    };

    let result: Record<string, unknown> | null = null;
    let repaired = false;
    let finalWriteError: unknown = null;
    let doctorOutput: string | undefined;

    try {
      result = await writeOnce(workingPatchObj, workingBaseHash);
    } catch (firstErr) {
      if (isHashConflictError(firstErr)) {
        // NEVER re-read the hash and re-apply: that silently overwrote a
        // concurrent operator's edit. Hand the conflict back instead.
        const conflict = await buildConflictBody(
          "This config changed in another session since you loaded it. Review the current values, then re-apply your change."
        );
        return NextResponse.json(conflict, { status: 409 });
      }
      if (isReplacePathsError(firstErr)) {
        const required = parseReplacePathsFromError(firstErr);
        return NextResponse.json(
          {
            ok: false,
            error: friendlyPatchError(firstErr),
            details: String(firstErr),
            replacePathsRequired: required,
          },
          { status: 400 }
        );
      }
      if (isRateLimitError(firstErr)) {
        finalWriteError = firstErr;
      } else if (isInvalidConfigError(firstErr)) {
        const doctor = await runDoctorFixCapture();
        repaired = doctor.ok;
        doctorOutput = doctor.output || undefined;
        try {
          // `doctor --fix` rewrites the file, so the caller's baseHash is
          // legitimately stale — re-read it for this one repair retry only.
          const latest = await readConfigSnapshot();
          if (latest.baseHash) workingBaseHash = latest.baseHash;
          result = await writeOnce(workingPatchObj, workingBaseHash);
        } catch (retryErr) {
          finalWriteError = retryErr;
        }
      } else {
        finalWriteError = firstErr;
      }
    }

    if (!result) {
      // The CLI fallback bypasses the base-hash guard, so it is reserved for
      // gateways that do not implement config.patch at all — never for a
      // gateway that answered "no".
      const fallbackCandidate = isUnsupportedMethodError(finalWriteError)
        ? buildConfigSetFallbackEntries(workingPatchObj, rawProvided || useApply)
        : { entries: null, reason: "gateway rejected the write; fallback not attempted" };

      if (fallbackCandidate.entries && fallbackCandidate.entries.length > 0) {
        const fallback = await applyConfigSetFallback(fallbackCandidate.entries);
        if (fallback.failures.length === 0) {
          return NextResponse.json({
            ok: true,
            hash: (await readConfigSnapshot().catch(() => ({ baseHash: "" }))).baseHash,
            restartRequired: plan.restartRequired,
            ...(plan.restartPaths.length ? { restartPaths: plan.restartPaths } : {}),
            result: { method: "config.set", updatedPaths: fallback.updatedPaths },
            repairedConfig: repaired || undefined,
            fallbackUsed: true,
            fallbackMessage:
              "Saved using compatibility mode because the gateway rejected live patching.",
          });
        }
      }

      const details = String(finalWriteError || "Unknown config write failure");
      const responseBody: Record<string, unknown> = {
        ok: false,
        error: friendlyPatchError(finalWriteError || details),
        details,
      };
      if (doctorOutput) responseBody.doctorOutput = doctorOutput;
      if (fallbackCandidate.reason) responseBody.fallback = fallbackCandidate.reason;

      if (isRateLimitError(finalWriteError)) {
        const retryAfterMs = extractRetryAfterMs(finalWriteError);
        if (retryAfterMs) responseBody.retryAfterMs = retryAfterMs;
        ctx.log.warn(
          { err: finalWriteError instanceof Error ? finalWriteError.message : String(finalWriteError) },
          "config write rate-limited",
        );
        return NextResponse.json(responseBody, { status: 429 });
      }
      ctx.log.warn(
        { err: finalWriteError instanceof Error ? finalWriteError.message : String(finalWriteError) },
        "config write failed",
      );
      return NextResponse.json(responseBody, { status: 400 });
    }

    // config.patch/apply do not return the new hash — re-read it so the client
    // can chain another write without a round trip through GET.
    const after = await readConfigSnapshot().catch(() => null);

    // The gateway reports its own restart decision in the write sentinel;
    // trust it over our schema prediction when the two disagree.
    const sentinelStats = isRecord(result.sentinel)
      ? (isRecord((result.sentinel as Record<string, unknown>).payload)
          ? ((result.sentinel as Record<string, unknown>).payload as Record<string, unknown>)
          : {})
      : {};
    const stats = isRecord(sentinelStats.stats) ? sentinelStats.stats : {};
    const gatewaySaysRestart = stats.requiresRestart === true;

    const warnings = [...plan.warnings];
    if (unguardedWrite) {
      warnings.push(
        "This write was sent without a base hash, so it was not checked against concurrent edits."
      );
    }

    return NextResponse.json({
      ok: true,
      hash: after?.baseHash ?? "",
      restartRequired: plan.restartRequired || gatewaySaysRestart,
      ...(plan.restartPaths.length ? { restartPaths: plan.restartPaths } : {}),
      ...(deletedPaths.length ? { deletedPaths } : {}),
      ...(warnings.length ? { warnings } : {}),
      result,
      repairedConfig: repaired || undefined,
    });
  } catch (err) {
    const msg = String(err);
    ctx.log.error({ err: err instanceof Error ? err.message : msg }, "unexpected config PATCH failure");
    return badRequest(friendlyPatchError(msg), msg);
  }
  },
);

/**
 * PUT /api/config — legacy full-config save.
 *
 * Kept for backwards compatibility, now routed through `config.apply`, the
 * documented full-replace-with-validation method: the caller is handing over a
 * complete document, and `config.patch` would silently ignore every key they
 * removed. Conflicts surface as 409 like PATCH — never re-applied over a
 * concurrent edit.
 */
export const PUT = withRoute({ name: "/api/config" }, async (request, ctx) => {
  try {
    // No `bodySchema` here: PUT's own try/catch already reproduces the exact
    // pre-migration behavior for a malformed JSON body (falls through to the
    // generic catch below), and routing it through `readJsonBody` first would
    // change that message. `config object required` is a plain missing-field
    // check, kept manual per the same "required stays manual" split agents
    // route uses (src/lib/schemas/agents.ts).
    const body = await request.json();
    const { config, baseHash } = body as {
      config: Record<string, unknown>;
      baseHash?: string;
    };

    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return badRequest("config object required");
    }

    const params: { raw: string; baseHash?: string } = {
      raw: JSON.stringify(config),
    };
    if (baseHash) params.baseHash = baseHash;

    const result = await gatewayConfigApply<Record<string, unknown>>(
      params,
      CONFIG_WRITE_TIMEOUT_MS
    );
    const after = await readConfigSnapshot().catch(() => null);
    return NextResponse.json({ ok: true, hash: after?.baseHash ?? "", result });
  } catch (err) {
    if (isHashConflictError(err)) {
      const conflict = await buildConflictBody(
        "This config changed in another session since you loaded it."
      );
      return NextResponse.json(conflict, { status: 409 });
    }
    const msg = String(err);
    const validationMatch = msg.match(/invalid.*?:(.*)/i);
    ctx.log.warn({ err: msg }, "config PUT failed");
    return badRequest(validationMatch ? validationMatch[1].trim() : msg);
  }
});
