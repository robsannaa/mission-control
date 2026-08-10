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
    url: "https://openrouter.ai/api/v1/models",
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
