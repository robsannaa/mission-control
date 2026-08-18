import { NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { fetchConfig } from "@/lib/gateway-config";
import { runCliJson } from "@/lib/openclaw";
import { getOpenClawHome } from "@/lib/paths";
import { PROVIDER_CATALOG, AUTO_DETECT_ORDER, type ProviderMeta } from "@/components/search/providers";
import { withRoute } from "@/lib/api-route";
import { apiError, serverError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

// ── small local helpers (kept self-contained: this route owns its logic) ─

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function dig(obj: unknown, ...keys: string[]): unknown {
  let cur = obj;
  for (const k of keys) {
    if (!isRecord(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

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

function preview(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return "••••";
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

async function readTextSafe(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

// ── installed-plugin catalog (what this OpenClaw can actually run) ──────

type PluginListEntry = {
  id?: string;
  enabled?: boolean;
  webSearchProviderIds?: string[];
};

let installedCache: { at: number; ids: Set<string> } | null = null;
const INSTALLED_TTL_MS = 5 * 60_000;

/**
 * The set of `tools.web.search.provider` ids this OpenClaw can actually
 * accept right now — verified live: setting a provider whose plugin isn't
 * installed here is rejected by config validation ("invalid config"), not a
 * silent no-op. Offering it in the UI would be a promise Mission Control
 * cannot keep, so this filters the full documented catalog down to reality.
 */
async function getInstalledProviderIds(): Promise<{ ids: Set<string>; degraded: boolean }> {
  if (installedCache && Date.now() - installedCache.at < INSTALLED_TTL_MS) {
    return { ids: installedCache.ids, degraded: false };
  }
  try {
    const data = await runCliJson<{ plugins?: PluginListEntry[] }>(["plugins", "list"], 20000);
    const ids = new Set<string>();
    for (const p of data.plugins || []) {
      for (const id of p.webSearchProviderIds || []) ids.add(id);
    }
    installedCache = { at: Date.now(), ids };
    return { ids, degraded: false };
  } catch {
    // CLI probe failed — fall back to the full catalog rather than showing
    // an empty page, but say so via `degraded` so the UI can be honest.
    return { ids: new Set(PROVIDER_CATALOG.map((p) => p.id)), degraded: true };
  }
}

// ── credential resolution ────────────────────────────────────────────────

type Source = { value: string; label: string };

function resolveFirst(sources: Source[]): { found: boolean; label: string | null; value: string } {
  for (const s of sources) {
    if (s.value.trim()) return { found: true, label: s.label, value: s.value.trim() };
  }
  return { found: false, label: null, value: "" };
}

export type ProviderStatus = ProviderMeta & {
  installed: true;
  /** true = confirmed ready, false = confirmed missing a credential, null = can't tell without trying. */
  ready: boolean | null;
  keySource: string | null;
  keyPreview: string | null;
  note?: string;
};

export const GET = withRoute({ name: "/api/search/web/status" }, async () => {
  try {
    const [configData, dotEnvRaw, installedResult] = await Promise.all([
      fetchConfig(10000).catch(() => null),
      readTextSafe(join(getOpenClawHome(), ".env")),
      getInstalledProviderIds(),
    ]);

    if (!configData) {
      return apiError("Could not reach OpenClaw to read its configuration.", 503);
    }

    const dotEnv = parseDotEnv(dotEnvRaw);
    const parsed = configData.parsed;

    const searchConfig = (dig(parsed, "tools", "web", "search") || {}) as Record<string, unknown>;
    const enabled = searchConfig.enabled !== false; // default true, per OpenClaw docs
    const configuredProviderId =
      typeof searchConfig.provider === "string" && searchConfig.provider.trim()
        ? searchConfig.provider.trim()
        : null;

    // Config-block env fallback (openclaw.json → env.KEY / env.vars.KEY), same
    // precedence Mission Control's other panes already use.
    const cfgEnv = (dig(parsed, "env") || {}) as Record<string, unknown>;
    const cfgEnvVars = (dig(cfgEnv, "vars") || {}) as Record<string, unknown>;
    const envBlock: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfgEnv)) if (typeof v === "string") envBlock[k] = v;
    for (const [k, v] of Object.entries(cfgEnvVars)) if (typeof v === "string" && !envBlock[k]) envBlock[k] = v;

    const authProfiles = (dig(parsed, "auth", "profiles") || {}) as Record<string, unknown>;
    const hasOAuthProfile = (prefix: string) =>
      Object.keys(authProfiles).some((id) => id.startsWith(`${prefix}:`));

    const plugins = (dig(parsed, "plugins", "entries") || {}) as Record<string, unknown>;

    function pluginWebSearchApiKey(pluginId: string): string {
      const v = dig(plugins, pluginId, "config", "webSearch", "apiKey");
      return typeof v === "string" ? v : "";
    }
    function pluginWebSearchBaseUrl(pluginId: string): string {
      const v = dig(plugins, pluginId, "config", "webSearch", "baseUrl");
      return typeof v === "string" ? v : "";
    }

    const googleModelKey = typeof dig(parsed, "models", "providers", "google", "apiKey") === "string"
      ? String(dig(parsed, "models", "providers", "google", "apiKey"))
      : "";
    const ollamaModelKey = typeof dig(parsed, "models", "providers", "ollama", "apiKey") === "string"
      ? String(dig(parsed, "models", "providers", "ollama", "apiKey"))
      : "";

    const envSource = (name: string): Source => ({
      value: dotEnv[name] || envBlock[name] || process.env[name] || "",
      label: dotEnv[name] ? ".env" : envBlock[name] ? "openclaw.json (env block)" : process.env[name] ? "process environment" : "",
    });

    const providers: ProviderStatus[] = [];
    for (const meta of PROVIDER_CATALOG) {
      if (!installedResult.ids.has(meta.id)) continue;

      let ready: boolean | null = null;
      let keySource: string | null = null;
      let keyPreview: string | null = null;
      let note: string | undefined;

      if (meta.authKind === "keyless") {
        ready = true;
      } else if (meta.authKind === "key") {
        const pluginKey = pluginWebSearchApiKey(meta.pluginId);
        const envSources = meta.envVars.map(envSource);
        // Gemini's documented fallback chain also allows the shared chat-model key.
        const extra: Source[] = meta.id === "gemini" ? [{ value: googleModelKey, label: "models.providers.google.apiKey" }] : [];
        const resolved = resolveFirst([
          { value: pluginKey, label: "openclaw.json" },
          ...envSources.map((s, i) => ({ value: s.value, label: s.label || `${meta.envVars[i]}` })),
          ...extra,
        ]);
        ready = resolved.found;
        if (resolved.found) {
          keySource = resolved.label;
          keyPreview = preview(resolved.value);
        }
      } else if (meta.authKind === "baseUrl") {
        const baseUrl = pluginWebSearchBaseUrl(meta.pluginId) || dotEnv[meta.envVars[0]] || process.env[meta.envVars[0]] || "";
        ready = Boolean(baseUrl);
      } else if (meta.authKind === "connection") {
        if (meta.id === "ollama") {
          const key = pluginWebSearchApiKey("ollama") || ollamaModelKey || dotEnv.OLLAMA_API_KEY || process.env.OLLAMA_API_KEY || "";
          ready = key ? true : null;
          note = key
            ? "A hosted Ollama key is on file."
            : "Unknown from here — this works if you already have a local Ollama running and signed in. Try a search below to find out.";
        } else if (meta.id === "codex") {
          ready = hasOAuthProfile("openai") ? null : false;
          note = hasOAuthProfile("openai")
            ? "Reuses your existing OpenAI/ChatGPT sign-in. Try a search below to confirm it actually works — this one can't be checked from config alone."
            : "Needs a Codex/ChatGPT sign-in first (Accounts & Keys → OpenAI).";
        }
      }

      providers.push({ ...meta, installed: true, ready, keySource, keyPreview, note });
    }

    // What "Let OpenClaw choose" resolves to right now, using the documented
    // precedence order, restricted to providers actually installed here.
    let autoResolvedProviderId: string | null = null;
    for (const meta of AUTO_DETECT_ORDER) {
      const status = providers.find((p) => p.id === meta.id);
      if (status?.ready === true) {
        autoResolvedProviderId = meta.id;
        break;
      }
    }

    const uninstalledCount = PROVIDER_CATALOG.length - providers.length;

    return NextResponse.json({
      ok: true,
      enabled,
      activeProviderId: configuredProviderId,
      autoResolvedProviderId,
      providers,
      uninstalledCount,
      degraded: installedResult.degraded,
      baseHash: configData.hash,
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
});
