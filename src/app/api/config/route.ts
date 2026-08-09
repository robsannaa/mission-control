import { NextRequest, NextResponse } from "next/server";
import { CONFIG_WRITE_TIMEOUT_MS, gatewayCall, runCliCaptureBoth } from "@/lib/openclaw";
import { gatewayConfigPatch, sanitizeConfigFile } from "@/lib/gateway-config";
import { readFile } from "fs/promises";
import { join } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { logRequest, logError } from "@/lib/request-log";
import { randomBytes } from "crypto";

export const dynamic = "force-dynamic";
const OPENCLAW_HOME = getOpenClawHome();

const SENSITIVE_PATTERNS = [
  /api[_-]?key/i,
  /secret/i,
  /password/i,
  /token/i,
  /credential/i,
];

function redactSensitive(obj: unknown, depth = 0): unknown {
  if (depth > 10) return obj;
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactSensitive(v, depth + 1));
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_PATTERNS.some((p) => p.test(k)) && typeof v === "string") {
        result[k] = v.length > 8 ? v.slice(0, 4) + "..." + v.slice(-4) : "••••";
      } else {
        result[k] = redactSensitive(v, depth + 1);
      }
    }
    return result;
  }
  return obj;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function isHashConflictError(err: unknown): boolean {
  const msg = lowerError(err);
  return (
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

function withDottedPathValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): Record<string, unknown> {
  if (Object.prototype.hasOwnProperty.call(obj, path)) {
    return obj;
  }
  return {
    ...obj,
    [path]: value,
  };
}

function ensureGatewayAuthPatchDefaults(
  patchObj: Record<string, unknown>,
  currentParsed: Record<string, unknown> | null
): Record<string, unknown> {
  const modeRaw = getByDottedPath(patchObj, "gateway.auth.mode");
  const mode = typeof modeRaw === "string" ? modeRaw.trim().toLowerCase() : "";
  if (!mode) return patchObj;

  let next = { ...patchObj };

  if (mode === "token") {
    const existingToken =
      (typeof getByDottedPath(next, "gateway.auth.token") === "string" &&
        String(getByDottedPath(next, "gateway.auth.token"))) ||
      (typeof getByDottedPath(currentParsed, "gateway.auth.token") === "string" &&
        String(getByDottedPath(currentParsed, "gateway.auth.token"))) ||
      "";
    if (!existingToken.trim()) {
      next = withDottedPathValue(next, "gateway.auth.token", randomBytes(24).toString("hex"));
    }
  }

  return next;
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

async function readConfigHashAndParsed(): Promise<{
  baseHash: string;
  parsed: Record<string, unknown>;
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
  if (isHashConflictError(err)) {
    return "Your config changed in another session. Please retry once.";
  }
  return raw;
}

/**
 * GET /api/config
 *
 * Returns config + schema + UI hints.
 * Query: scope=config (default) | schema
 */
export async function GET(request: NextRequest) {
  const start = Date.now();
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
      console.warn("Config schema unavailable, serving config without schema:", err);
    }

    // Gateway config.get returns { parsed, resolved, hash }. parsed = openclaw.json shape (top-level: agents, gateway, channels, tools, etc.).
    const parsed = (configData.parsed || {}) as Record<string, unknown>;
    const resolved = (configData.resolved || {}) as Record<string, unknown>;
    const redacted = redactSensitive(resolved) as Record<string, unknown>;

    logRequest("/api/config", 200, Date.now() - start, { scope });
    return NextResponse.json({
      config: redacted,
      rawConfig: parsed, // same structure as ~/.openclaw/openclaw.json for form + raw editor
      resolvedConfig: resolved,
      baseHash: configData.hash || "",
      schema: schemaData?.schema || {},
      uiHints: schemaData?.uiHints || {},
      warning,
    });
  } catch (err) {
    logError("/api/config", err, { scope });
    try {
      const raw = await readFile(join(OPENCLAW_HOME, "openclaw.json"), "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const redacted = redactSensitive(parsed) as Record<string, unknown>;
      return NextResponse.json({
        config: redacted,
        rawConfig: parsed,
        resolvedConfig: parsed,
        baseHash: "",
        schema: {},
        uiHints: {},
        warning: formatGatewayError(err),
        degraded: true,
      });
    } catch {
      return NextResponse.json({ error: formatGatewayError(err) }, { status: 500 });
    }
  }
}

/**
 * PATCH /api/config  — Safe partial update via config.patch
 *
 * Body: { patch: { "agents.defaults.workspace": "~/new" }, baseHash: "..." }
 *   OR: { raw: "{ agents: { defaults: { workspace: '~/new' } } }", baseHash: "..." }
 */
/** Validate config payload before sending to gateway. */
function validateConfigPayload(
  raw: string | undefined,
  patch: Record<string, unknown> | undefined
): { ok: true; patchObj: Record<string, unknown> } | { ok: false; error: string } {
  if (raw !== undefined) {
    if (typeof raw !== "string") {
      return { ok: false, error: "raw must be a JSON string" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Invalid JSON: ${msg}` };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "Config must be a JSON object (not array or primitive)" };
    }
    return { ok: true, patchObj: parsed as Record<string, unknown> };
  }
  if (patch !== undefined) {
    if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, error: "patch must be a JSON object" };
    }
    return { ok: true, patchObj: patch };
  }
  return { ok: false, error: "raw or patch required" };
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { raw, patch, baseHash } = body as {
      raw?: string;
      patch?: Record<string, unknown>;
      baseHash?: string;
    };

    const validated = validateConfigPayload(raw, patch);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    const rawProvided = raw !== undefined;
    let workingPatchObj = validated.patchObj;
    let workingBaseHash = String(baseHash || "").trim();
    if (!workingBaseHash) {
      try {
        const latest = await readConfigHashAndParsed();
        workingBaseHash = latest.baseHash;
      } catch {
        // Legacy gateways may not provide hash; patch flow will fall back to config.set.
      }
    }

    const applyPatch = async (
      patchObj: Record<string, unknown>,
      hash: string
    ): Promise<Record<string, unknown>> => {
      const result = await gatewayCallWithRetry<Record<string, unknown>>(
        "config.patch",
        {
          raw: JSON.stringify(patchObj),
          baseHash: hash,
          restartDelayMs: 2000,
        },
        20000,
        1
      );
      // Strip leaked RPC keys the gateway may have persisted into the config.
      await sanitizeConfigFile().catch(() => {});
      return result;
    };

    const touchesGatewayAuthMode =
      typeof getByDottedPath(workingPatchObj, "gateway.auth.mode") === "string";

    if (touchesGatewayAuthMode) {
      try {
        const latest = await readConfigHashAndParsed();
        workingPatchObj = ensureGatewayAuthPatchDefaults(
          workingPatchObj,
          latest.parsed
        );
      } catch {
        workingPatchObj = ensureGatewayAuthPatchDefaults(workingPatchObj, null);
      }
    }

    let result: Record<string, unknown> | null = null;
    let repaired = false;
    let finalPatchError: unknown = null;
    let doctorOutput: string | undefined;

    try {
      result = await applyPatch(workingPatchObj, workingBaseHash);
    } catch (firstErr) {
      if (isRateLimitError(firstErr)) {
        finalPatchError = firstErr;
      } else if (isInvalidConfigError(firstErr)) {
        const doctor = await runDoctorFixCapture();
        repaired = doctor.ok;
        doctorOutput = doctor.output || undefined;
        try {
          const latest = await readConfigHashAndParsed();
          if (latest.baseHash) {
            workingBaseHash = latest.baseHash;
          }
          workingPatchObj = ensureGatewayAuthPatchDefaults(
            workingPatchObj,
            latest.parsed
          );
          result = await applyPatch(workingPatchObj, workingBaseHash);
        } catch (retryErr) {
          finalPatchError = retryErr;
        }
      } else if (isHashConflictError(firstErr)) {
        try {
          const latest = await readConfigHashAndParsed();
          if (!latest.baseHash) {
            throw firstErr;
          }
          workingBaseHash = latest.baseHash;
          workingPatchObj = ensureGatewayAuthPatchDefaults(
            workingPatchObj,
            latest.parsed
          );
          result = await applyPatch(workingPatchObj, workingBaseHash);
        } catch (retryErr) {
          finalPatchError = retryErr;
        }
      } else {
        finalPatchError = firstErr;
      }
    }

    if (!result) {
      const fallbackCandidate = buildConfigSetFallbackEntries(workingPatchObj, rawProvided);
      if (fallbackCandidate.entries && fallbackCandidate.entries.length > 0) {
        const fallback = await applyConfigSetFallback(fallbackCandidate.entries);
        if (fallback.failures.length === 0) {
          return NextResponse.json({
            ok: true,
            result: {
              method: "config.set",
              updatedPaths: fallback.updatedPaths,
            },
            repairedConfig: repaired || undefined,
            fallbackUsed: true,
            fallbackMessage:
              "Saved using compatibility mode because the gateway rejected live patching.",
          });
        }
      }

      const details = String(finalPatchError || "Unknown config.patch failure");
      const responseBody: Record<string, unknown> = {
        error: friendlyPatchError(finalPatchError || details),
        details,
      };
      if (doctorOutput) {
        responseBody.doctorOutput = doctorOutput;
      }
      if (fallbackCandidate.reason) {
        responseBody.fallback = fallbackCandidate.reason;
      }
      return NextResponse.json(
        responseBody,
        { status: isRateLimitError(finalPatchError) ? 429 : 400 }
      );
    }

    return NextResponse.json({
      ok: true,
      result,
      repairedConfig: repaired || undefined,
    });
  } catch (err) {
    const msg = String(err);
    logError("/api/config", err, { method: "PATCH" });
    return NextResponse.json({ error: friendlyPatchError(msg), details: msg }, { status: 400 });
  }
}

/**
 * PUT /api/config  — Legacy full-config save (kept for backwards compat)
 */
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const { config, baseHash } = body as {
      config: Record<string, unknown>;
      baseHash?: string;
    };

    if (!config || typeof config !== "object") {
      return NextResponse.json(
        { error: "config object required" },
        { status: 400 }
      );
    }

    const params: { raw: string; baseHash?: string; restartDelayMs: number } = {
      raw: JSON.stringify(config),
      restartDelayMs: 2000,
    };
    if (baseHash) params.baseHash = baseHash;

    const result = await gatewayConfigPatch<Record<string, unknown>>(
      params,
      20000,
    );

    return NextResponse.json({ ok: true, result });
  } catch (err) {
    const msg = String(err);
    const validationMatch = msg.match(/invalid.*?:(.*)/i);
    return NextResponse.json(
      { error: validationMatch ? validationMatch[1].trim() : msg },
      { status: 400 }
    );
  }
}
