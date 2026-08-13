/**
 * Shared Gateway config helpers.
 *
 * Consolidates the duplicated `gatewayCallWithRetry`, `applyConfigPatchWithRetry`,
 * and `isGatewayTransientError` patterns that existed identically in
 * agents/route.ts and models-summary.ts.
 */

import { CONFIG_WRITE_TIMEOUT_MS, gatewayCall, runCliCaptureBoth } from "./openclaw";
import { getOpenClawHome } from "./paths";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { normalizeModelPriority } from "./model-priority";

export { normalizeModelPriority, moveModelPriority } from "./model-priority";

// ── Helpers ──────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Top-level keys that are RPC parameters for `config.patch`/`config.apply`,
 * NOT valid config keys. Some gateway versions accidentally persist these into
 * openclaw.json, where they then fail schema validation on the next load.
 *
 * Each entry also carries a shape test, because "narrow" matters here: this is
 * the one place in Mission Control that writes openclaw.json directly from
 * Node, bypassing gateway validation entirely.
 */
const LEAKED_RPC_KEYS: Array<{
  key: string;
  looksLikeLeak: (value: unknown) => boolean;
}> = [
  {
    // The RPC `raw` is always a serialized JSON document.
    key: "raw",
    looksLikeLeak: (value) => typeof value === "string" && /^\s*[{[]/.test(value),
  },
  {
    // Config hashes are 64 lowercase hex characters (sha256).
    key: "baseHash",
    looksLikeLeak: (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value),
  },
  {
    key: "restartDelayMs",
    looksLikeLeak: (value) => typeof value === "number" && Number.isFinite(value),
  },
  {
    key: "replacePaths",
    looksLikeLeak: (value) =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string"),
  },
];

/**
 * Strip leaked RPC parameters from the config file on disk.
 * Returns true if the file was modified.
 *
 * RISK — read before widening this. Rewriting openclaw.json from Node:
 *   1. skips the gateway's schema gate, so a bug here can persist an invalid
 *      config the gateway will then refuse to reload;
 *   2. reserializes the document, discarding JSON5 comments and formatting;
 *   3. races the gateway's own writes and its file watcher.
 *
 * It is therefore deliberately conservative and bails out unless every
 * condition holds: the file is strict JSON, it uses no `$include` (whose
 * layout a flat rewrite would destroy), and the offending key both sits at the
 * top level and matches the RPC parameter's shape. A future config key legally
 * named `raw` with a non-JSON string value is left alone.
 */
export async function sanitizeConfigFile(): Promise<boolean> {
  const configPath = join(getOpenClawHome(), "openclaw.json");
  let content: string;
  try {
    content = await readFile(configPath, "utf-8");
  } catch {
    return false;
  }
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(content) as Record<string, unknown>;
  } catch {
    // JSON5/comments/trailing commas: not safely rewritable from here.
    return false;
  }
  if (!isRecord(config)) {
    return false;
  }
  // A `$include` layout must never be flattened by this helper.
  if (content.includes("$include")) {
    return false;
  }
  let changed = false;
  for (const { key, looksLikeLeak } of LEAKED_RPC_KEYS) {
    if (key in config && looksLikeLeak(config[key])) {
      delete config[key];
      changed = true;
    }
  }
  if (changed) {
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  }
  return changed;
}

/** Parameters shared by `config.patch` and `config.apply`. */
export type ConfigWriteParams = {
  /** Serialized JSON document: a merge patch for patch, a full config for apply. */
  raw: string;
  /** Hash from `config.get`; required by the gateway once a config file exists. */
  baseHash?: string;
  /** Delay before the restart the gateway schedules, when one is needed. */
  restartDelayMs?: number;
  /**
   * Dotted array paths whose shrink/reorder is intentional. `config.patch`
   * refuses a destructive array replacement unless the exact path is listed
   * here; nested arrays under array entries use `agents.list[].skills`.
   * Ignored by `config.apply`, which is a full replacement by definition.
   */
  replacePaths?: string[];
  /** Free-text audit note recorded with the write. */
  note?: string;
};

/**
 * Central wrapper for `config.patch` that always sanitizes the config file
 * afterward — even if the gateway call throws (keys can leak before erroring).
 */
export async function gatewayConfigPatch<T = void>(
  params: ConfigWriteParams,
  timeout = 15000,
): Promise<T> {
  try {
    return await gatewayCall<T>("config.patch", params as Record<string, unknown>, timeout);
  } finally {
    await sanitizeConfigFile().catch(() => {});
  }
}

/**
 * `config.apply` — validate and replace the WHOLE config document.
 *
 * Use it when the caller genuinely owns the entire document (the raw JSON
 * editor, or a whole-section delete): a full replacement deletes removed keys
 * and shrinks arrays without needing `replacePaths`, which is exactly what a
 * merge patch cannot express. Everything absent from `raw` is gone, so only
 * call this with a document derived from the snapshot named by `baseHash`.
 */
export async function gatewayConfigApply<T = void>(
  params: ConfigWriteParams,
  timeout = 15000,
): Promise<T> {
  const { replacePaths: _ignored, ...applyParams } = params;
  try {
    return await gatewayCall<T>("config.apply", applyParams as Record<string, unknown>, timeout);
  } finally {
    await sanitizeConfigFile().catch(() => {});
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRetryAfterMs(error: unknown): number | null {
  const msg = String(error || "");
  const match = msg.match(/retry after\s+(\d+(?:\.\d+)?)s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds * 1000);
}

type ConfigSetEntry = {
  path: string;
  value: unknown;
};

const MAX_CONFIG_SET_FALLBACK_ENTRIES = 24;

function collectConfigSetEntries(
  patchObj: Record<string, unknown>,
  prefix = "",
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
): { entries: ConfigSetEntry[] | null; reason?: string } {
  const entries = collectConfigSetEntries(patchObj).filter(
    (entry) => entry.path.trim().length > 0,
  );
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
  failures: Array<{ path: string; error: string }>;
}> {
  const failures: Array<{ path: string; error: string }> = [];

  for (const entry of entries) {
    try {
      const encoded = JSON.stringify(entry.value);
      if (encoded === undefined) {
        throw new Error("Value cannot be encoded as JSON");
      }
      const setResult = await runCliCaptureBoth(
        ["config", "set", "--strict-json", entry.path, encoded],
        CONFIG_WRITE_TIMEOUT_MS,
      );
      if (setResult.code !== 0) {
        const details = String(setResult.stderr || setResult.stdout || "").trim();
        throw new Error(details || `config set exited with code ${String(setResult.code)}`);
      }
    } catch (err) {
      failures.push({ path: entry.path, error: String(err || "unknown error") });
    }
  }

  return { failures };
}

// ── Transient error detection ────────────────────

export function isGatewayTransientError(error: unknown): boolean {
  const parts = [String(error || "")];
  if (isRecord(error)) {
    if (typeof error.message === "string") parts.push(error.message);
    if (typeof error.stderr === "string") parts.push(error.stderr);
  }
  const msg = parts.join(" ").toLowerCase();

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
    msg.includes("gateway call failed") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("timed out")
  );
}

// ── Resilient RPC ────────────────────────────────

export async function gatewayCallWithRetry<T>(
  method: string,
  params?: Record<string, unknown>,
  timeout = 15000,
  maxAttempts = 3,
): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await gatewayCall<T>(method, params, timeout);
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      const transient = isGatewayTransientError(error);
      const baseDelay = transient ? 300 : 150;
      await sleep(Math.min(baseDelay * attempt, transient ? 1200 : 600));
    }
  }
  throw lastError || new Error("Unknown gateway error");
}

// ── Config data types ────────────────────────────

export type ConfigData = {
  parsed: Record<string, unknown>;
  resolved: Record<string, unknown>;
  hash: string;
};

export type AgentEntry = {
  id: string;
  name?: string;
  model?: unknown;
  workspace?: string;
  identity?: Record<string, unknown>;
  subagents?: Record<string, unknown>;
  heartbeat?: unknown;
  default?: boolean;
  [key: string]: unknown;
};

export type BindingEntry = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: {
      kind: string;
      id: string;
    };
    guildId?: string;
    teamId?: string;
    roles?: string[];
  };
  [key: string]: unknown;
};

// ── Typed config.get wrapper ─────────────────────

export async function fetchConfig(timeout = 10000): Promise<ConfigData> {
  const raw = await gatewayCallWithRetry<Record<string, unknown>>(
    "config.get",
    undefined,
    timeout,
  );
  return {
    parsed: isRecord(raw.parsed) ? raw.parsed : {},
    resolved: isRecord(raw.resolved) ? raw.resolved : {},
    hash: String(raw.hash || ""),
  };
}

// ── Primary-model read (footgun-fix guard) ───────
//
// Connecting a provider (a cloud key, a local server) must never silently
// change which model is primary — see the Part A fix in the models routes.
// Callers use this to decide whether setting `agents.defaults.model.primary`
// is safe (nothing configured yet) or requires an explicit opt-in from the
// user (something is already configured).

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read the currently configured primary model, live from the gateway. Returns
 * `null` both when nothing is configured yet AND when the gateway can't be
 * reached — callers that need to distinguish "truly nothing configured" from
 * "couldn't check" should fall back to reading `openclaw.json` directly
 * (the disk-fallback code paths in the models routes already do this).
 */
export async function getCurrentPrimaryModel(): Promise<string | null> {
  try {
    const configData = await fetchConfig(6000);
    const agents = isRecord(configData.parsed.agents) ? configData.parsed.agents : {};
    const defaults = isPlainObject(agents.defaults) ? agents.defaults : {};
    const model = defaults.model;
    if (typeof model === "string") return model.trim() || null;
    if (isPlainObject(model) && typeof model.primary === "string") {
      return model.primary.trim() || null;
    }
  } catch {
    // Gateway offline or config.get failed — caller decides how to proceed.
  }
  return null;
}

/** Same extraction, applied to an already-parsed `openclaw.json` document —
 * for the disk-fallback code paths that read the file directly. */
export function extractPrimaryModel(config: Record<string, unknown> | null | undefined): string | null {
  if (!isPlainObject(config)) return null;
  const agents = isPlainObject(config.agents) ? config.agents : {};
  const defaults = isPlainObject(agents.defaults) ? agents.defaults : {};
  const model = defaults.model;
  if (typeof model === "string") return model.trim() || null;
  if (isPlainObject(model) && typeof model.primary === "string") {
    return model.primary.trim() || null;
  }
  return null;
}

/**
 * Merge a new `primary` into an existing `agents.defaults.model` value
 * without discarding `fallbacks` or any other key — the Part A footgun fix
 * for issue #70. A raw `defaults.model = { primary }` assignment (what every
 * disk-fallback code path used to do) silently drops `fallbacks`; this is
 * the one correct way to change just the primary.
 *
 * `existingModel` may be a bare string (legacy shorthand for `{ primary }`,
 * carries no fallbacks to preserve), an object, or absent — every shape
 * `agents.defaults.model` can legally have in `openclaw.json`.
 */
export function mergeModelPrimary(
  existingModel: unknown,
  primary: string,
): Record<string, unknown> {
  const existingObj = isPlainObject(existingModel) ? existingModel : {};
  return { ...existingObj, primary };
}

/** Preserve future model keys while atomically replacing primary + fallbacks. */
export function mergeModelPriority(
  existingModel: unknown,
  models: unknown[],
): Record<string, unknown> {
  const normalized = normalizeModelPriority(models);
  if (normalized.length === 0) {
    throw new Error("At least one model is required");
  }
  const existingObj = isPlainObject(existingModel) ? existingModel : {};
  return {
    ...existingObj,
    primary: normalized[0],
    fallbacks: normalized.slice(1),
  };
}

/**
 * Decide whether it's safe to write `primary` as a side effect of connecting
 * a provider. `true` only when nothing is configured yet, or the caller
 * explicitly opted in — never as an automatic consequence of adding a key or
 * a local server. See issue #70: pasting an OpenRouter key silently switched
 * a user off their local model with no opt-out.
 */
export function shouldSetPrimary(existingPrimary: string | null, makePrimary: boolean): boolean {
  return !existingPrimary || makePrimary;
}

// ── Atomic config.patch with retry ───────────────

export async function patchConfig(
  patch: Record<string, unknown>,
  opts?: { maxAttempts?: number; restartDelayMs?: number; replacePaths?: string[] },
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 8;
  const raw = JSON.stringify(patch);
  const fallback = buildConfigSetFallbackEntries(patch);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const configData = await gatewayCall<Record<string, unknown>>(
        "config.get",
        undefined,
        6000,
      );
      const hash = String(configData?.hash || "").trim();
      if (!hash) {
        // Legacy gateway compatibility: some builds omit hash on config.get.
        // First try config.patch without baseHash; if rejected, use CLI config.set fallback.
        try {
          const patchParams: ConfigWriteParams = { raw };
          if (opts?.restartDelayMs) {
            patchParams.restartDelayMs = opts.restartDelayMs;
          }
          if (opts?.replacePaths?.length) {
            patchParams.replacePaths = opts.replacePaths;
          }
          await gatewayConfigPatch(patchParams, CONFIG_WRITE_TIMEOUT_MS);
          return;
        } catch {
          if (!fallback.entries) {
            throw new Error(
              `Compatibility patch unavailable: ${fallback.reason || "unsupported patch"}`,
            );
          }
          const fallbackResult = await applyConfigSetFallback(fallback.entries);
          if (fallbackResult.failures.length > 0) {
            const first = fallbackResult.failures[0];
            throw new Error(
              `Compatibility patch failed at ${first.path}: ${first.error}`,
            );
          }
          return;
        }
      }
      const patchParams: ConfigWriteParams = { raw, baseHash: hash };
      if (opts?.restartDelayMs) {
        patchParams.restartDelayMs = opts.restartDelayMs;
      }
      if (opts?.replacePaths?.length) {
        patchParams.replacePaths = opts.replacePaths;
      }
      await gatewayConfigPatch(patchParams, CONFIG_WRITE_TIMEOUT_MS);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        throw error;
      }
      const retryAfterMs = parseRetryAfterMs(error);
      const backoffMs = Math.min(400 * attempt, 2500);
      await sleep(
        retryAfterMs ? Math.max(backoffMs, retryAfterMs + 150) : backoffMs,
      );
    }
  }
  throw lastError || new Error("Unknown config.patch error");
}

// ── Config data extractors ───────────────────────

export function extractAgentsList(configData: ConfigData): AgentEntry[] {
  const agents = isRecord(configData.parsed.agents) ? configData.parsed.agents : {};
  const list = Array.isArray(agents.list) ? agents.list : [];
  return list.filter(isRecord).map((entry) => ({
    ...entry,
    id: String(entry.id || ""),
  })) as AgentEntry[];
}

export function extractBindings(configData: ConfigData): BindingEntry[] {
  const bindings = Array.isArray(configData.parsed.bindings)
    ? configData.parsed.bindings
    : [];
  return bindings.filter(isRecord).map((b) => {
    const match = isRecord(b.match) ? b.match : {};
    const peer = isRecord(match.peer) ? match.peer : {};
    const peerKind = typeof peer.kind === "string" ? peer.kind.trim() : "";
    const peerId = typeof peer.id === "string" ? peer.id.trim() : "";
    return {
      ...b,
      agentId: String(b.agentId || ""),
      match: {
        channel: String(match.channel || ""),
        accountId: typeof match.accountId === "string" ? match.accountId : undefined,
        peer: peerKind && peerId ? { kind: peerKind, id: peerId } : undefined,
        guildId: typeof match.guildId === "string" ? match.guildId : undefined,
        teamId: typeof match.teamId === "string" ? match.teamId : undefined,
        roles: Array.isArray(match.roles)
          ? match.roles.map((role) => String(role || "").trim()).filter(Boolean)
          : undefined,
      },
    };
  }) as BindingEntry[];
}
