import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { runCli, gatewayCall } from "@/lib/openclaw";
import { invokeGatewayTool } from "@/lib/gateway-tools";
import { patchConfig } from "@/lib/gateway-config";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { webSearchPatchSchema, webSearchPostSchema } from "@/lib/schemas/search";

export const dynamic = "force-dynamic";

type ConfigGet = {
  path?: string;
  hash?: string;
  parsed?: Record<string, unknown>;
};

type WebSearchToolResult = {
  details?: {
    query?: string;
    provider?: string;
    model?: string;
    tookMs?: number;
    content?: string;
    citations?: string[];
  };
  content?: Array<{
    type?: string;
    text?: string;
  }>;
};

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;
const OPENCLAW_DIR = join(homedir(), ".openclaw");

function safeToken(raw: string, fallback = ""): string {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  if (!SAFE_TOKEN_RE.test(value)) return "";
  return value;
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

/** Parse a .env file (KEY=VALUE lines, # comments, optional quoting). */
function parseDotEnv(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

/** Drill into a nested object by keys. */
function dig(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function preview(key: string): string {
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function parseWebSearchResultText(text: string): WebSearchToolResult["details"] | null {
  try {
    return JSON.parse(text) as WebSearchToolResult["details"];
  } catch {
    return null;
  }
}

async function invokeGatewayWebSearch(query: string) {
  const result = await invokeGatewayTool<WebSearchToolResult>(
    "web_search",
    { query },
    60000,
  );

  const details =
    result.details ||
    parseWebSearchResultText(
      result.content
        ?.map((item) => (item?.type === "text" ? String(item.text || "") : ""))
        .filter(Boolean)
        .join("\n") || "",
    );

  if (!details) {
    throw new Error("Gateway web_search returned an unreadable payload");
  }

  return details;
}

/**
 * Resolve a key from multiple sources, returning the first hit.
 * Returns { value, source } or { value: "", source: null }.
 *
 * Sources are checked in the order provided (highest priority first).
 */
function resolveKey(
  sources: Array<{ value: string; label: string }>
): { value: string; source: string | null } {
  for (const s of sources) {
    if (s.value) return { value: s.value, source: s.label };
  }
  return { value: "", source: null };
}

/**
 * GET: return search provider status.
 *
 * Reads credentials from ALL sources per the docs:
 *   https://docs.openclaw.ai/tools/web
 *   https://docs.openclaw.ai/help/faq#how-does-openclaw-load-environment-variables
 *   https://docs.openclaw.ai/concepts/model-failover#auth-storage-keys-oauth
 *
 * Sources checked (highest priority first):
 *   1. openclaw.json  → tools.web.search.perplexity.apiKey / tools.web.search.apiKey
 *   2. auth-profiles.json / auth.json  → provider profiles
 *   3. ~/.openclaw/.env  → global fallback env
 *   4. openclaw.json → env block / env.vars
 *   5. process.env  (inherited from shell / launchd / systemd)
 */
export const GET = withRoute({ name: "/api/web-search" }, async () => {
  try {
    // ── Read all sources in parallel ──
    const [mainConfig, authProfiles, authJson, dotEnvRaw] = await Promise.all([
      readJsonSafe<Record<string, unknown>>(join(OPENCLAW_DIR, "openclaw.json"), {}),
      readJsonSafe<Record<string, unknown>>(join(OPENCLAW_DIR, "agents", "main", "agent", "auth-profiles.json"), {}),
      readJsonSafe<Record<string, unknown>>(join(OPENCLAW_DIR, "agents", "main", "agent", "auth.json"), {}),
      readTextSafe(join(OPENCLAW_DIR, ".env")),
    ]);

    const dotEnv = parseDotEnv(dotEnvRaw);

    // Gateway config (for hash + env block; non-blocking if gateway is down)
    const gw = await gatewayCall<ConfigGet>("config.get", undefined, 10000).catch(() => null);
    const configHash = String(gw?.hash || "");

    // Config env block: openclaw.json → env.KEY and env.vars.KEY
    const cfgEnv = (dig(mainConfig, "env") || {}) as Record<string, unknown>;
    const cfgEnvVars = (dig(cfgEnv, "vars") || {}) as Record<string, string>;
    // Flatten: top-level string values + vars sub-object
    const envBlock: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfgEnv)) {
      if (typeof v === "string") envBlock[k] = v;
    }
    for (const [k, v] of Object.entries(cfgEnvVars)) {
      if (typeof v === "string" && !envBlock[k]) envBlock[k] = v;
    }

    // ── tools.web.search config ──
    const searchConfig = (dig(mainConfig, "tools", "web", "search") || {}) as Record<string, unknown>;
    const pplxCfg = (dig(searchConfig, "perplexity") || {}) as Record<string, string>;

    // ── Perplexity key ──
    const perplexity = resolveKey([
      { value: String(pplxCfg.apiKey || "").trim(), label: "openclaw.json" },
      { value: String(dotEnv.PERPLEXITY_API_KEY || "").trim(), label: ".env" },
      { value: String(envBlock.PERPLEXITY_API_KEY || "").trim(), label: "config env" },
      { value: String(process.env.PERPLEXITY_API_KEY || "").trim(), label: "process.env" },
    ]);

    // ── OpenRouter key ──
    // Check auth-profiles.json for any openrouter:* profile
    const profiles = (dig(authProfiles, "profiles") || {}) as Record<string, Record<string, unknown>>;
    let orAuthKey = "";
    for (const [id, profile] of Object.entries(profiles)) {
      if (id.startsWith("openrouter:") && typeof profile.key === "string" && profile.key) {
        orAuthKey = profile.key;
        break;
      }
    }
    const orLegacyKey = String((dig(authJson, "openrouter", "key") as string) || "").trim();

    const openrouter = resolveKey([
      { value: orAuthKey, label: "auth-profiles.json" },
      { value: orLegacyKey, label: "auth.json" },
      { value: String(dotEnv.OPENROUTER_API_KEY || "").trim(), label: ".env" },
      { value: String(envBlock.OPENROUTER_API_KEY || "").trim(), label: "config env" },
      { value: String(process.env.OPENROUTER_API_KEY || "").trim(), label: "process.env" },
    ]);

    // ── Brave key ──
    const brave = resolveKey([
      { value: String(searchConfig.apiKey || "").trim(), label: "openclaw.json" },
      { value: String(dotEnv.BRAVE_API_KEY || "").trim(), label: ".env" },
      { value: String(envBlock.BRAVE_API_KEY || "").trim(), label: "config env" },
      { value: String(process.env.BRAVE_API_KEY || "").trim(), label: "process.env" },
    ]);

    const hasPerplexity = Boolean(perplexity.value);
    const hasOpenRouter = Boolean(openrouter.value);
    const hasBrave = Boolean(brave.value);

    // ── Active provider ──
    const configProvider = String(searchConfig.provider || "").toLowerCase();
    let activeProvider: "perplexity" | "brave" | "none" = "none";
    if (configProvider === "perplexity" && (hasPerplexity || hasOpenRouter)) {
      activeProvider = "perplexity";
    } else if (configProvider === "brave" && hasBrave) {
      activeProvider = "brave";
    } else if (hasPerplexity || hasOpenRouter) {
      activeProvider = "perplexity";
    } else if (hasBrave) {
      activeProvider = "brave";
    }

    // ── Model (Perplexity only): tools.web.search.perplexity.model ──
    const model = String(pplxCfg.model || "perplexity/sonar-pro");
    const cacheTtl = Number(searchConfig.cacheTtlMinutes || 15);

    return NextResponse.json({
      ok: true,
      activeProvider,
      configHash,
      model,
      cacheTtlMinutes: cacheTtl,
      providers: {
        perplexity: {
          configured: hasPerplexity,
          keySource: perplexity.source,
          keyPreview: perplexity.value ? preview(perplexity.value) : null,
        },
        openrouter: {
          configured: hasOpenRouter,
          keySource: openrouter.source,
          keyPreview: openrouter.value ? preview(openrouter.value) : null,
        },
        brave: {
          configured: hasBrave,
          keySource: brave.source,
          keyPreview: brave.value ? preview(brave.value) : null,
        },
      },
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
});

const VALID_MODELS = new Set([
  "perplexity/sonar",
  "perplexity/sonar-pro",
  "perplexity/sonar-reasoning-pro",
]);

const VALID_PROVIDERS = new Set(["brave", "perplexity"]);

/**
 * PATCH: update search model.
 *
 * Reads the current perplexity config first and merges the model in,
 * so we never clobber sibling keys like apiKey.
 */
export const PATCH = withRoute(
  { name: "/api/web-search", bodySchema: webSearchPatchSchema },
  async (_request: NextRequest, ctx) => {
  try {
    const body = ctx.body;

    // Read existing search config from disk so updates are additive and safe.
    const mainConfig = await readJsonSafe<Record<string, unknown>>(join(OPENCLAW_DIR, "openclaw.json"), {});
    const existingSearch = (dig(mainConfig, "tools", "web", "search") || {}) as Record<string, unknown>;

    const action = String(body.action || "").trim();
    if (action === "set-provider") {
      const provider = String(body.provider || "").trim().toLowerCase();
      if (!VALID_PROVIDERS.has(provider)) {
        return badRequest(`Invalid provider. Valid: ${[...VALID_PROVIDERS].join(", ")}`);
      }
      await patchConfig({
        tools: {
          web: {
            search: {
              ...existingSearch,
              provider,
            },
          },
        },
      });
      return NextResponse.json({ ok: true, provider });
    }

    if (action === "set-brave") {
      const apiKey = String(body.apiKey || "").trim();
      if (apiKey.length < 12) {
        return badRequest("Brave API key looks too short.");
      }
      const makeDefault = body.makeDefault !== false;
      await patchConfig({
        tools: {
          web: {
            search: {
              ...existingSearch,
              apiKey,
              provider: makeDefault ? "brave" : String(existingSearch.provider || ""),
            },
          },
        },
      });
      return NextResponse.json({ ok: true, provider: makeDefault ? "brave" : existingSearch.provider || "none" });
    }

    const model = String(body.model || "").trim();
    if (!model || !VALID_MODELS.has(model)) {
      return badRequest(`Invalid model. Valid: ${[...VALID_MODELS].join(", ")}`);
    }

    const existingPplx = (dig(existingSearch, "perplexity") || {}) as Record<string, unknown>;
    const mergedPplx = { ...existingPplx, model };
    await patchConfig({
      tools: {
        web: {
          search: {
            ...existingSearch,
            perplexity: mergedPplx,
          },
        },
      },
    });

    return NextResponse.json({ ok: true, model });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);

/** POST: run a web search via the agent */
export const POST = withRoute(
  { name: "/api/web-search", bodySchema: webSearchPostSchema },
  async (_request: NextRequest, ctx) => {
  try {
    const query = ctx.body.query;

    const agentId = safeToken(ctx.body.agentId || "", "main");
    if (!agentId) {
      return badRequest("Invalid agentId");
    }

    const startedAt = Date.now();
    const resultCount = Math.min(Math.max(Number(ctx.body.resultCount) || 5, 1), 10);

    try {
      const result = await invokeGatewayWebSearch(query);
      return NextResponse.json({
        ok: true,
        query,
        agentId,
        resultCount,
        provider: result.provider || null,
        model: result.model || null,
        output: String(result.content || "").trim(),
        citations: Array.isArray(result.citations) ? result.citations.slice(0, resultCount) : [],
        durationMs: Date.now() - startedAt,
        method: "gateway-tool",
      });
    } catch (gatewayErr) {
      const message = `Use the web_search tool to search for: ${query} (return up to ${resultCount} results). Show the results with titles, URLs, and brief snippets.`;
      const output = await runCli(
        ["agent", "--agent", agentId, "--message", message],
        60_000
      );

      return NextResponse.json({
        ok: true,
        query,
        agentId,
        resultCount,
        output: output.trim(),
        durationMs: Date.now() - startedAt,
        method: "cli-agent",
        warning: String(gatewayErr),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return serverError(message || "Web search failed");
  }
  },
);
