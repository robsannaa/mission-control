import { NextRequest, NextResponse } from "next/server";
import { runCli, runCliCaptureBoth, gatewayCall } from "@/lib/openclaw";
import {
  PROVIDER_ENV_KEYS,
  validateProviderToken,
  buildProviderCredentialPatch,
} from "@/lib/provider-auth";
import { patchConfig } from "@/lib/gateway-config";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/* ── Provider catalog ──
 * The no-terminal auth paths per provider. `oauthCommand` flows need a TTY,
 * so the UI surfaces them as copyable "advanced" fallbacks only. */

type ProviderCatalogEntry = {
  id: string;
  label: string;
  placeholder: string;
  keyUrl: string;
  envKey: string | null;
  authMethods: ("api-key" | "paste-token")[];
  oauthCommand: string | null;
  hint: string;
};

const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "openrouter",
    label: "OpenRouter",
    placeholder: "sk-or-...",
    keyUrl: "https://openrouter.ai/keys",
    envKey: PROVIDER_ENV_KEYS.openrouter || null,
    authMethods: ["api-key"],
    oauthCommand: null,
    hint: "One key, every major model. Pay only for what you use.",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    placeholder: "sk-ant-...",
    keyUrl: "https://console.anthropic.com/settings/keys",
    envKey: PROVIDER_ENV_KEYS.anthropic || null,
    authMethods: ["api-key", "paste-token"],
    oauthCommand: "openclaw models auth login --provider anthropic",
    hint: "Claude models straight from Anthropic.",
  },
  {
    id: "openai",
    label: "OpenAI",
    placeholder: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
    envKey: PROVIDER_ENV_KEYS.openai || null,
    authMethods: ["api-key"],
    oauthCommand: "openclaw models auth login --provider openai",
    hint: "GPT models. Requires API credits (separate from ChatGPT Plus).",
  },
];

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function findCatalogEntry(provider: string): ProviderCatalogEntry | null {
  return PROVIDER_CATALOG.find((p) => p.id === provider) || null;
}

/* ── Auth status via `openclaw models status --json` ── */

type ModelsStatusJson = {
  defaultModel?: string;
  auth?: {
    providers?: Array<{
      provider?: string;
      profiles?: { count?: number };
    }>;
  };
};

async function readAuthStatus(): Promise<{
  defaultModel: string | null;
  authenticatedProviders: string[];
}> {
  const { stdout } = await runCliCaptureBoth(["models", "status", "--json"], 45000);
  const jsonStart = stdout.indexOf("{");
  const parsed: ModelsStatusJson = JSON.parse(jsonStart >= 0 ? stdout.slice(jsonStart) : stdout);
  const providers = Array.isArray(parsed.auth?.providers) ? parsed.auth!.providers! : [];
  const authenticatedProviders = providers
    .filter((p) => (p?.profiles?.count ?? 0) > 0 && typeof p?.provider === "string")
    .map((p) => String(p.provider));
  return {
    defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : null,
    authenticatedProviders,
  };
}

/* ── GET /api/onboarding/model-auth ──
 * Returns the provider catalog plus what the live gateway already knows:
 * which providers exist in the model catalog and the configured default. */

export async function GET() {
  try {
    let gatewayProviders: string[] = [];
    let defaultModel: string | null = null;

    try {
      const listed = await gatewayCall<{ models?: Array<{ provider?: string }> }>(
        "models.list",
        { view: "all" },
        8000,
      );
      const rows = Array.isArray(listed?.models) ? listed.models : [];
      gatewayProviders = [...new Set(rows.map((m) => String(m?.provider || "")).filter(Boolean))];
    } catch {
      // Gateway offline — catalog still renders
    }

    try {
      const config = await gatewayCall<{ parsed?: Record<string, unknown> }>(
        "config.get",
        undefined,
        6000,
      );
      const agents = (config?.parsed?.agents || {}) as Record<string, unknown>;
      const defaults = (agents.defaults || {}) as Record<string, unknown>;
      const model = (defaults.model || {}) as Record<string, unknown>;
      if (typeof model.primary === "string") defaultModel = model.primary;
    } catch {
      // ignore
    }

    return json({
      ok: true,
      providers: PROVIDER_CATALOG,
      gatewayProviders,
      defaultModel,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

/* ── POST /api/onboarding/model-auth ──
 * Actions (all support dryRun: true — dry runs validate input shape only and
 * NEVER touch the gateway config, CLI, or provider APIs):
 *   validate-key  { provider, token }            — probe the provider API (read-only)
 *   save-api-key  { provider, token, model? }    — validate + write credentials via config patch
 *   paste-token   { provider, token, expiresIn?} — `openclaw models auth paste-token` via stdin
 *   status        {}                             — live-verify configured auth */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = String(body.action || "").trim();
    const dryRun = body.dryRun === true;

    switch (action) {
      case "validate-key": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        if (!provider || !PROVIDER_ID_RE.test(provider)) {
          return json({ error: "A valid provider id is required" }, 400);
        }
        if (!token) {
          return json({ error: "API key is required" }, 400);
        }
        if (!findCatalogEntry(provider)) {
          return json({ error: `Unknown provider: ${provider}` }, 400);
        }
        if (dryRun) {
          return json({ ok: true, dryRun: true, action, provider });
        }
        const result = await validateProviderToken(provider, token);
        if (!result.ok) {
          return json({ ok: false, error: result.error || "Invalid API key" }, 400);
        }
        return json({ ok: true, provider });
      }

      case "save-api-key": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        const model = String(body.model || "").trim();
        if (!provider || !PROVIDER_ID_RE.test(provider)) {
          return json({ error: "A valid provider id is required" }, 400);
        }
        if (!token) {
          return json({ error: "API key is required" }, 400);
        }
        const entry = findCatalogEntry(provider);
        if (!entry || !entry.envKey) {
          return json({ error: `Provider ${provider} does not support API-key auth here` }, 400);
        }
        if (dryRun) {
          return json({
            ok: true,
            dryRun: true,
            action,
            provider,
            wouldPatch: { env: [entry.envKey], model: model || null },
          });
        }

        const validation = await validateProviderToken(provider, token);
        if (!validation.ok) {
          return json({ ok: false, error: validation.error || "Invalid API key" }, 400);
        }

        const patch = buildProviderCredentialPatch(provider, token);
        if (model) {
          patch.agents = { defaults: { model: { primary: model } } };
        }
        await patchConfig(patch);
        return json({ ok: true, provider, modelSet: model || null });
      }

      case "paste-token": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        const expiresIn = String(body.expiresIn || "").trim();
        if (!provider || !PROVIDER_ID_RE.test(provider)) {
          return json({ error: "A valid provider id is required" }, 400);
        }
        if (!token) {
          return json({ error: "Token is required" }, 400);
        }
        if (expiresIn && !/^\d+[smhdwy]$/.test(expiresIn)) {
          return json({ error: "expiresIn must look like 365d or 12h" }, 400);
        }
        const args = ["models", "auth", "paste-token", "--provider", provider];
        if (expiresIn) args.push("--expires-in", expiresIn);
        if (dryRun) {
          return json({
            ok: true,
            dryRun: true,
            action,
            provider,
            command: `openclaw ${args.join(" ")}`,
            stdin: "<token>",
          });
        }
        // paste-token reads the token from stdin so it never hits argv.
        const output = await runCli(args, 60000, `${token}\n`);
        return json({ ok: true, provider, output: output.trim() });
      }

      case "status": {
        if (dryRun) {
          return json({ ok: true, dryRun: true, action });
        }
        try {
          const status = await readAuthStatus();
          return json({ ok: true, ...status });
        } catch (err) {
          return json({ ok: false, error: String(err) }, 500);
        }
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
