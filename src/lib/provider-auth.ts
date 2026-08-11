type ProviderProbe = {
  url: string;
  method: "GET" | "POST";
  buildHeaders: (token: string) => Record<string, string>;
  buildBody?: () => string;
  authErrorStatuses?: number[];
  treatClientErrorAsReachable?: boolean;
};

type ModelListConfig = {
  url: string;
  buildHeaders: (token: string) => Record<string, string>;
  buildUrl?: (token: string) => string;
  fallbackModels?: ProviderModelItem[];
};

export type ProviderModelItem = { id: string; name: string };

export const PROVIDER_ENV_KEYS: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  // Gemini/Google. Config namespace is `models.providers.google`, but the
  // resolved env var OpenClaw actually reads is GEMINI_API_KEY (GOOGLE_API_KEY
  // is only a fallback) — see docs/concepts/model-providers.md.
  google: "GEMINI_API_KEY",
};

const PROVIDER_PROBES: Record<string, ProviderProbe> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    method: "GET",
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/messages",
    method: "POST",
    buildHeaders: (token) => ({
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    }),
    buildBody: () =>
      JSON.stringify({
        model: "claude-haiku-3-5-20241022",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    authErrorStatuses: [401, 403],
    treatClientErrorAsReachable: true,
  },
  openrouter: {
    // `/api/v1/models` is a public catalog endpoint — it returns 200 for ANY
    // Authorization header, including garbage, so it never actually checks the
    // key. `/api/v1/key` is the authenticated "who am I" endpoint: it 401s on
    // a bad/missing key and 200s only for a real one. Verified live against
    // OpenRouter — a garbage key gets `{"error":{"code":401}}` from this URL.
    url: "https://openrouter.ai/api/v1/key",
    method: "GET",
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  },
  google: {
    url: "https://generativelanguage.googleapis.com/v1beta/models",
    method: "GET",
    buildHeaders: (token) => ({ "x-goog-api-key": token }),
  },
};

const MODEL_LIST_CONFIG: Record<string, ModelListConfig> = {
  openai: {
    url: "https://api.openai.com/v1/models",
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  },
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    buildHeaders: (token) => ({
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    buildHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  },
};

/**
 * Allowlists for providers that return many non-chat models (embeddings, tts,
 * deprecated, fine-tuned, etc.). Only models matching at least one pattern are
 * kept. Patterns are tested against the raw model id (without provider prefix).
 */
const PROVIDER_MODEL_ALLOWLIST: Record<string, RegExp[]> = {
  openai: [
    /^gpt-5/,              // GPT-5 family (5.3-codex, 5.4, 5.4-pro)
    /^gpt-4\.5/,           // GPT-4.5
    /^gpt-4\.1(?!-turbo)/,  // GPT-4.1 (still in API, exclude deprecated turbo)
    /^gpt-4o-mini/,        // GPT-4o mini (budget option, still available)
    /^o[1-9]/,             // o1, o3, o4-mini reasoning models
  ],
  anthropic: [
    /^claude-opus-4/,      // Claude Opus 4.x (4, 4.1, 4.5, 4.6)
    /^claude-sonnet-4/,    // Claude Sonnet 4.x (4, 4.5, 4.6)
    /^claude-haiku-4/,     // Claude Haiku 4.5
  ],
  openrouter: [
    // OpenRouter lists thousands — keep well-known chat families
    /claude/i,
    /gpt-4/i,
    /gpt-5/i,
    /gemini/i,
    /llama/i,
    /mistral/i,
    /command/i,
    /deepseek/i,
    /qwen/i,
    /kimi/i,     // Moonshot AI (e.g. Kimi 2.5 — moonshotai/kimi-k2.5)
    /moonshot/i,
  ],
};

/** Deny patterns applied after allowlist (blocks fine-tuned, deprecated suffixes, etc.) */
const PROVIDER_MODEL_DENYLIST: RegExp[] = [
  /^ft:/,                  // fine-tuned
  /:(ft-|finetuned)/,
  /-\d{4}-\d{2}-\d{2}/,  // dated snapshots like gpt-5.4-pro-2026-03-05
  /-\d{8}$/,              // dated snapshots like claude-opus-4-5-20251101
  /-\d{4,6}$/,            // old dated suffixes like gpt-4-0613
  /instruct$/i,           // instruct-only variants
];

function filterProviderModels(provider: string, models: ProviderModelItem[]): ProviderModelItem[] {
  const allow = PROVIDER_MODEL_ALLOWLIST[provider];
  if (!allow) return models; // no allowlist = keep all

  return models.filter((m) => {
    const rawId = m.id.replace(`${provider}/`, "");
    const allowed = allow.some((re) => re.test(rawId));
    if (!allowed) return false;
    const denied = PROVIDER_MODEL_DENYLIST.some((re) => re.test(rawId));
    return !denied;
  });
}

function parseStandardDataModels(provider: string, data: unknown): ProviderModelItem[] {
  const rows =
    data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: Array<{ id?: string; name?: string }> }).data
      : [];

  return rows
    .map((row) => {
      const rawId = String(row?.id || "").trim();
      if (!rawId) return null;
      return {
        id: rawId.startsWith(`${provider}/`) ? rawId : `${provider}/${rawId}`,
        name: String(row?.name || rawId),
      };
    })
    .filter((row): row is ProviderModelItem => row !== null);
}

/**
 * The URL `validateProviderToken` probes for a given provider — exported so
 * this choice (an authenticated endpoint that genuinely rejects a bad key,
 * not a public catalog that returns 200 for anything) is unit-testable
 * without a network call. See the openrouter entry in PROVIDER_PROBES for
 * the live-verified reasoning.
 */
export function getProviderProbeUrl(provider: string): string | null {
  const probe = PROVIDER_PROBES[String(provider || "").trim().toLowerCase()];
  return probe?.url ?? null;
}

function truncateProviderError(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}...` : trimmed;
}

export async function validateProviderToken(
  provider: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const providerId = String(provider || "").trim().toLowerCase();
  const apiKey = String(token || "").trim();
  const probe = PROVIDER_PROBES[providerId];

  if (!providerId || !apiKey) {
    return { ok: false, error: "Provider and token are required" };
  }
  if (!probe) {
    return { ok: false, error: `Unknown provider: ${providerId}` };
  }

  const url = probe.url;

  try {
    const res = await fetch(url, {
      method: probe.method,
      headers: probe.buildHeaders(apiKey),
      body: probe.buildBody?.(),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok) {
      return { ok: true };
    }

    if (
      probe.treatClientErrorAsReachable &&
      !probe.authErrorStatuses?.includes(res.status) &&
      res.status < 500
    ) {
      return { ok: true };
    }

    const errBody = truncateProviderError(await res.text().catch(() => ""));
    return {
      ok: false,
      error: `Invalid API key — ${providerId} returned ${res.status}${errBody ? `: ${errBody}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Key validation failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function fetchModelsFromProvider(
  provider: string,
  token: string,
): Promise<ProviderModelItem[]> {
  const providerId = String(provider || "").trim().toLowerCase();
  const apiKey = String(token || "").trim();
  const config = MODEL_LIST_CONFIG[providerId];

  if (!providerId || !apiKey) {
    throw new Error("Provider and token are required");
  }
  if (!config) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  const url = config.buildUrl ? config.buildUrl(apiKey) : config.url;
  const res = await fetch(url, {
    method: "GET",
    headers: config.buildHeaders(apiKey),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    if (config.fallbackModels) {
      return config.fallbackModels;
    }
    throw new Error(`Provider returned ${res.status}`);
  }

  const data = await res.json();

  switch (providerId) {
    case "anthropic": {
      const rows =
        data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
          ? (data as { data: Array<{ id?: string; display_name?: string; name?: string }> }).data
          : [];
      return filterProviderModels(providerId, rows
        .map((row) => {
          const rawId = String(row?.id || "").trim();
          if (!rawId) return null;
          return {
            id: rawId.startsWith("anthropic/") ? rawId : `anthropic/${rawId}`,
            name: String(row?.display_name || row?.name || rawId),
          };
        })
        .filter((row): row is ProviderModelItem => row !== null));
    }
    default:
      return filterProviderModels(providerId, parseStandardDataModels(providerId, data));
  }
}

export function buildProviderCredentialPatch(
  provider: string,
  token: string,
): Record<string, unknown> {
  const providerId = String(provider || "").trim().toLowerCase();
  const envKey = PROVIDER_ENV_KEYS[providerId];
  if (!envKey) return {};

  const patch: Record<string, unknown> = {
    env: { [envKey]: token },
    auth: {
      profiles: {
        [`${providerId}:default`]: {
          provider: providerId,
          mode: "api_key",
        },
      },
    },
  };

  return patch;
}

/** 构建企业自建 / 自定义 provider 的 headers（用于验证或请求） */
function buildCustomHeaders(apiKeyHeader: string, token: string): Record<string, string> {
  const header = String(apiKeyHeader || "Authorization").trim() || "Authorization";
  if (header.toLowerCase() === "authorization" && !token.toLowerCase().startsWith("bearer ")) {
    return { [header]: `Bearer ${token}` };
  }
  return { [header]: token };
}

/** 校验企业自建 API 的 baseUrl 和密钥 */
export async function validateCustomProviderToken(
  baseUrl: string,
  apiKeyHeader: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(token || "").trim();
  if (!url || !apiKey) {
    return { ok: false, error: "Base URL and API key are required" };
  }
  const modelsUrl = `${url}/v1/models`;
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: buildCustomHeaders(apiKeyHeader, apiKey),
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) return { ok: true };
    const errBody = truncateProviderError(await res.text().catch(() => ""));
    return {
      ok: false,
      error: `API returned ${res.status}${errBody ? `: ${errBody}` : ""}`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Connection failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** 从企业自建 API 获取模型列表 */
export async function fetchModelsFromCustomProvider(
  baseUrl: string,
  apiKeyHeader: string,
  token: string,
): Promise<ProviderModelItem[]> {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(token || "").trim();
  if (!url || !apiKey) throw new Error("Base URL and API key are required");
  const modelsUrl = `${url}/v1/models`;
  const res = await fetch(modelsUrl, {
    method: "GET",
    headers: buildCustomHeaders(apiKeyHeader, apiKey),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`API returned ${res.status}`);
  const data = await res.json();
  const rows =
    data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: Array<{ id?: string; name?: string }> }).data
      : [];
  return rows
    .map((row) => {
      const rawId = String(row?.id || "").trim();
      if (!rawId) return null;
      return {
        id: `custom/${rawId}`,
        name: String(row?.name || rawId),
      };
    })
    .filter((row): row is ProviderModelItem => row !== null);
}

/* ── Local / loopback providers (Ollama, LM Studio, custom OpenAI-compatible) ──
 *
 * OpenClaw's own docs (docs.openclaw.ai/gateway/local-models,
 * docs.openclaw.ai/providers/ollama) document a keyless path for these: when
 * `baseUrl` resolves to loopback, a private LAN address, `.local`, or a bare
 * hostname, a non-secret marker string in `apiKey` (e.g. `"ollama-local"`)
 * satisfies OpenClaw's credential check instead of a real key. This section
 * never asks for or validates a paid API key — reachability + a model list
 * is the whole "auth" story for a local backend. */

export type LocalProviderKind = "ollama" | "lmstudio" | "custom";

/** Wire protocol used to discover models — Ollama's native API vs. an
 * OpenAI-compatible `/v1/models` catalog (LM Studio, vLLM, custom proxies). */
export type LocalProviderProtocol = "ollama" | "openai-compatible";

export function protocolForLocalKind(kind: LocalProviderKind): LocalProviderProtocol {
  return kind === "ollama" ? "ollama" : "openai-compatible";
}

/** Readable, non-secret marker per kind — any non-empty string works once
 * `baseUrl` is recognized as private; these just read well in config. */
export const LOCAL_PROVIDER_MARKERS: Record<LocalProviderKind, string> = {
  ollama: "ollama-local",
  lmstudio: "lmstudio",
  custom: "sk-local",
};

export const LOCAL_PROVIDER_DEFAULTS: Record<
  "ollama" | "lmstudio",
  { providerId: string; baseUrl: string }
> = {
  ollama: { providerId: "ollama", baseUrl: "http://127.0.0.1:11434" },
  lmstudio: { providerId: "lmstudio", baseUrl: "http://127.0.0.1:1234/v1" },
};

const BARE_LOOPBACK_RE = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0)$/i;
// RFC 1918 ranges — note each alternative consumes a different number of
// leading octets before the fixed prefix (10.0.0.0/8 leaves three trailing
// octets to match; 172.16.0.0/12 and 192.168.0.0/16 leave two), so the
// trailing `\d{1,3}` groups can't be shared across all three the way a
// simpler-looking single trailing pattern would suggest.
const PRIVATE_IPV4_RE =
  /^(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})$/;

/**
 * Mirrors the trust rule OpenClaw itself documents for local markers: loopback,
 * private-LAN, `.local`, and bare (dot-less) hostnames. This is only used to
 * decide what Mission Control *suggests* in the UI (marker vs. asking for a
 * real key) — the gateway makes the actual trust decision when the config is
 * loaded, this never grants network access on its own.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return false;
  if (BARE_LOOPBACK_RE.test(h)) return true;
  if (PRIVATE_IPV4_RE.test(h)) return true;
  if (h.endsWith(".local")) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // bare hostname
  return false;
}

export function isPrivateBaseUrl(baseUrl: string): boolean {
  try {
    return isPrivateHost(new URL(String(baseUrl || "").trim()).hostname);
  } catch {
    return false;
  }
}

function stripTrailingSlash(url: string): string {
  return String(url || "").trim().replace(/\/+$/, "");
}

function parseOllamaTags(data: unknown, providerId: string): ProviderModelItem[] {
  const rows =
    data && typeof data === "object" && Array.isArray((data as { models?: unknown[] }).models)
      ? (data as { models: Array<{ name?: string; model?: string }> }).models
      : [];
  return rows
    .map((row) => {
      const name = String(row?.name || row?.model || "").trim();
      if (!name) return null;
      return { id: `${providerId}/${name}`, name };
    })
    .filter((row): row is ProviderModelItem => row !== null);
}

function parseOpenAiCompatModels(data: unknown, providerId: string): ProviderModelItem[] {
  const rows =
    data && typeof data === "object" && Array.isArray((data as { data?: unknown[] }).data)
      ? (data as { data: Array<{ id?: string }> }).data
      : [];
  return rows
    .map((row) => {
      const id = String(row?.id || "").trim();
      if (!id) return null;
      return { id: `${providerId}/${id}`, name: id };
    })
    .filter((row): row is ProviderModelItem => row !== null);
}

function localListUrl(protocol: LocalProviderProtocol, baseUrl: string): string {
  const url = stripTrailingSlash(baseUrl);
  // OpenClaw's own convention (see docs/gateway/local-models) already puts
  // `/v1` in `baseUrl` for OpenAI-compatible backends — e.g.
  // "http://127.0.0.1:1234/v1" — so the catalog endpoint is `${baseUrl}/models`,
  // never `${baseUrl}/v1/models`. Ollama's native API has no `/v1` at all.
  return protocol === "ollama" ? `${url}/api/tags` : `${url}/models`;
}

/** Probe a local/loopback model server for reachability — no API key sent or
 * required. Used for the onboarding wizard's "Ollama detected" / "Connect"
 * flows and the Models page's local-provider card. */
export async function probeLocalProvider(
  protocol: LocalProviderProtocol,
  baseUrl: string,
  timeoutMs = 4000,
): Promise<{ ok: boolean; error?: string }> {
  const url = stripTrailingSlash(baseUrl);
  if (!url) return { ok: false, error: "Base URL is required" };
  const listUrl = localListUrl(protocol, url);
  try {
    const res = await fetch(listUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      return { ok: false, error: `Server returned ${res.status} at ${listUrl}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach ${listUrl}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** List models from a local/loopback server — no API key needed. Returned ids
 * carry the provider prefix (e.g. `ollama/llama3.2:latest`), matching the
 * `ProviderModelItem` shape every other model list in this file returns. */
export async function fetchLocalModels(
  protocol: LocalProviderProtocol,
  baseUrl: string,
  providerId: string,
  timeoutMs = 6000,
): Promise<ProviderModelItem[]> {
  const url = stripTrailingSlash(baseUrl);
  if (!url) throw new Error("Base URL is required");
  const listUrl = localListUrl(protocol, url);
  const res = await fetch(listUrl, { method: "GET", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Server returned ${res.status} at ${listUrl}`);
  const data = await res.json();
  return protocol === "ollama"
    ? parseOllamaTags(data, providerId)
    : parseOpenAiCompatModels(data, providerId);
}

/**
 * Build the `config.patch` payload that connects a local/loopback provider —
 * writes the non-secret marker key into `models.providers.<id>.apiKey`
 * instead of a real credential. Deliberately never touches
 * `agents.defaults.model` — the caller decides whether/what to set as
 * primary (see the "never clobber the primary" fix in the models routes).
 */
export function buildLocalProviderConfig(
  kind: LocalProviderKind,
  providerId: string,
  baseUrl: string,
  opts?: {
    apiStyle?: "openai-completions" | "openai-responses";
    timeoutSeconds?: number;
    /**
     * A model to declare in `models.providers.<id>.models` — verified live
     * against a sandboxed gateway: `ollama` and `lmstudio` are bundled
     * provider ids and auto-discover their catalog from the running server,
     * but any other ("custom") provider id is rejected by the gateway's
     * config schema ("custom model providers must declare models") unless
     * at least one model is declared here. `ref` is the full
     * `<providerId>/<rawId>` form everywhere else in this file uses; the
     * provider-local id written into `models[].id` has the prefix stripped,
     * per docs/gateway/local-models.
     */
    declareModel?: { ref: string; name?: string; contextWindow?: number; maxTokens?: number };
  },
): Record<string, unknown> {
  const url = stripTrailingSlash(baseUrl);
  const id = String(providerId || "").trim().toLowerCase();
  if (!url || !id) return {};

  const providerEntry: Record<string, unknown> = {
    baseUrl: url,
    apiKey: LOCAL_PROVIDER_MARKERS[kind],
  };
  // Ollama speaks its own native protocol (implied by the `ollama` provider
  // id); an explicit `api` only applies to OpenAI-compatible backends.
  if (kind !== "ollama") {
    providerEntry.api = opts?.apiStyle || "openai-completions";
  }
  if (opts?.timeoutSeconds && Number.isFinite(opts.timeoutSeconds) && opts.timeoutSeconds > 0) {
    providerEntry.timeoutSeconds = Math.round(opts.timeoutSeconds);
  }
  if (kind === "custom" && opts?.declareModel?.ref) {
    const ref = opts.declareModel.ref.trim();
    const rawId = ref.startsWith(`${id}/`) ? ref.slice(id.length + 1) : ref;
    if (rawId) {
      providerEntry.models = [
        {
          id: rawId,
          name: opts.declareModel.name || rawId,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          // Conservative defaults — accurate values need `/api/show` (Ollama)
          // or similar, which a generic OpenAI-compatible `/v1/models` doesn't
          // provide. The user (or a future doctor check) can raise these in
          // Settings once real limits are known.
          contextWindow: opts.declareModel.contextWindow ?? 32768,
          maxTokens: opts.declareModel.maxTokens ?? 8192,
        },
      ];
    }
  }

  return {
    models: {
      providers: {
        [id]: providerEntry,
      },
    },
    auth: {
      profiles: {
        [`${id}:default`]: {
          provider: id,
          mode: "api_key",
        },
      },
    },
  };
}

/** 构建企业自建 provider 的 config patch */
export function buildCustomProviderConfig(
  baseUrl: string,
  apiKeyHeader: string,
  token: string,
): Record<string, unknown> {
  const url = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!url || !String(token || "").trim()) return {};
  const headers = buildCustomHeaders(apiKeyHeader, token.trim());
  return {
    models: {
      providers: {
        custom: {
          baseUrl: url,
          headers,
        },
      },
    },
    auth: {
      profiles: {
        "custom:default": {
          provider: "custom",
          mode: "api_key",
        },
      },
    },
  };
}
