import { NextRequest, NextResponse } from "next/server";
import { runCli, runCliCaptureBoth, gatewayCall } from "@/lib/openclaw";
import {
  PROVIDER_ENV_KEYS,
  validateProviderToken,
  buildProviderCredentialPatch,
  buildLocalProviderConfig,
  fetchLocalModels,
  probeLocalProvider,
  protocolForLocalKind,
  LOCAL_PROVIDER_DEFAULTS,
  LOCAL_PROVIDER_MARKERS,
  type LocalProviderKind,
} from "@/lib/provider-auth";
import { patchConfig, getCurrentPrimaryModel, shouldSetPrimary } from "@/lib/gateway-config";
import { bootstrapFreshMachine, configFileExists } from "../_lib/bootstrap";

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
      // Non-null exactly when the provider currently resolves a usable
      // credential — via env var, profile store, or OAuth. This is the
      // signal that matters: `profiles.count` only tracks credentials saved
      // through the profile store (paste-token, OAuth login), and stays 0
      // for the env-var + auth.profiles-metadata shape the wizard's plain
      // "paste an API key" flow writes. Verified live against a sandbox
      // gateway: an env-only credential shows `effective.kind: "env"` with
      // `profiles.count: 0` — filtering on count alone would report it as
      // unauthenticated even though `runtimeAuthRoutes[].status` is "usable".
      effective?: { kind?: string } | null;
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
    .filter(
      (p) =>
        typeof p?.provider === "string" &&
        (Boolean(p?.effective?.kind) || (p?.profiles?.count ?? 0) > 0),
    )
    .map((p) => String(p.provider));
  return {
    defaultModel: typeof parsed.defaultModel === "string" ? parsed.defaultModel : null,
    authenticatedProviders,
  };
}

/**
 * Live-verify a saved credential: the gateway restarts itself in-process when
 * env/auth config changes (confirmed live in a sandboxed gateway — no
 * `restartDelayMs` needed to trigger it, and the brief WS close that happens
 * during that restart is already retried by `patchConfig`'s transient-error
 * handling). Poll `models status` until OpenClaw itself reports the
 * credential usable, so "Verified" means the agent can actually use it —
 * never just "the write didn't throw".
 */
async function pollProviderAuthenticated(provider: string, budgetMs = 20_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    try {
      const status = await readAuthStatus();
      if (status.authenticatedProviders.includes(provider)) return true;
    } catch {
      // Gateway may be mid-restart — keep polling within budget.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
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

    // Ambient local-server detection — informational only, same caveat as
    // /api/onboard's hasOllama: this probes the host's default ports
    // directly, so it says nothing about whether OpenClaw's config actually
    // points at them yet. It just lets the wizard suggest "Ollama detected"
    // instead of asking the user to know their own port.
    const [hasOllama, hasLmStudio] = await Promise.all([
      probeLocalProvider("ollama", LOCAL_PROVIDER_DEFAULTS.ollama.baseUrl, 1500)
        .then((r) => r.ok)
        .catch(() => false),
      probeLocalProvider("openai-compatible", LOCAL_PROVIDER_DEFAULTS.lmstudio.baseUrl, 1500)
        .then((r) => r.ok)
        .catch(() => false),
    ]);

    return json({
      ok: true,
      providers: PROVIDER_CATALOG,
      gatewayProviders,
      defaultModel,
      hasOllama,
      hasLmStudio,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

/* ── POST /api/onboarding/model-auth ──
 * Actions (all support dryRun: true — dry runs validate input shape only and
 * NEVER touch the gateway config, CLI, or provider APIs):
 *   validate-key  { provider, token }                          — probe the provider API (read-only)
 *   save-api-key  { provider, token, model?, makePrimary? }     — validate + write credentials via config patch
 *   paste-token   { provider, token, expiresIn?, makePrimary? } — `openclaw models auth paste-token` via stdin
 *   probe-local   { kind, baseUrl }                             — reachability + model list, no key
 *   save-local    { kind, providerId?, baseUrl, model?, apiStyle?, timeoutSeconds?, makePrimary? }
 *   status        {}                                            — live-verify configured auth
 *
 * `model`/`makePrimary` on save-api-key, paste-token, and save-local never
 * silently overwrite an existing primary model — see the Part A footgun fix
 * in src/lib/gateway-config.ts (getCurrentPrimaryModel) and the models
 * routes. A fresh machine with nothing configured still gets `model` set
 * automatically, exactly as before. */

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
        const makePrimary = body.makePrimary === true;
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

        // A truly fresh machine has no gateway config to patch yet — bootstrap
        // creates one (and, outside hosted containers, installs + starts the
        // local service) before we try to write credentials into it.
        if (!(await configFileExists())) {
          const bootstrap = await bootstrapFreshMachine();
          if (!bootstrap.ok) {
            return json({ ok: false, error: `Could not set up OpenClaw: ${bootstrap.error}` }, 500);
          }
        }

        const patch = buildProviderCredentialPatch(provider, token);
        let primarySet = false;
        let existingPrimary: string | null = null;
        if (model) {
          existingPrimary = await getCurrentPrimaryModel();
          if (shouldSetPrimary(existingPrimary, makePrimary)) {
            patch.agents = { defaults: { model: { primary: model } } };
            primarySet = true;
          }
        }
        await patchConfig(patch);

        const authenticated = await pollProviderAuthenticated(provider);
        return json({
          ok: true,
          provider,
          modelSet: primarySet ? model : null,
          primarySet,
          ...(model && !primarySet ? { existingPrimaryKept: existingPrimary } : {}),
          authenticated,
        });
      }

      case "paste-token": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        const expiresIn = String(body.expiresIn || "").trim();
        const model = String(body.model || "").trim();
        const makePrimary = body.makePrimary === true;
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

        // Same fresh-machine gap as save-api-key: a subscription token still
        // needs somewhere to land.
        if (!(await configFileExists())) {
          const bootstrap = await bootstrapFreshMachine();
          if (!bootstrap.ok) {
            return json({ ok: false, error: `Could not set up OpenClaw: ${bootstrap.error}` }, 500);
          }
        }

        // paste-token reads the token from stdin so it never hits argv.
        let output: string;
        try {
          output = await runCli(args, 60000, `${token}\n`);
        } catch (err) {
          return json(
            { ok: false, error: err instanceof Error ? err.message : "Could not save the subscription token." },
            400,
          );
        }

        // paste-token writes credentials to the profile store, not env/auth
        // config — no gateway restart needed for the credential itself. The
        // default model, if requested, still goes through a config patch —
        // guarded the same way as save-api-key so this never clobbers an
        // existing primary as a side effect of connecting a subscription.
        let primarySet = false;
        let existingPrimary: string | null = null;
        if (model) {
          existingPrimary = await getCurrentPrimaryModel();
          if (shouldSetPrimary(existingPrimary, makePrimary)) {
            await patchConfig({ agents: { defaults: { model: { primary: model } } } });
            primarySet = true;
          }
        }

        const authenticated = await pollProviderAuthenticated(provider);
        return json({
          ok: true,
          provider,
          modelSet: primarySet ? model : null,
          primarySet,
          ...(model && !primarySet ? { existingPrimaryKept: existingPrimary } : {}),
          authenticated,
          output: output.trim(),
        });
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

      // ── Probe a local/loopback server for reachability + a model list ──
      // No API key, no `validateProviderToken` call, no config write — this
      // is a pure read so the wizard can show "Ollama detected" or list
      // models before the user commits to connecting anything.
      case "probe-local": {
        const kind = String(body.kind || "").trim().toLowerCase() as LocalProviderKind;
        const baseUrl = String(body.baseUrl || "").trim();
        if (!["ollama", "lmstudio", "custom"].includes(kind)) {
          return json({ error: "kind must be one of: ollama, lmstudio, custom" }, 400);
        }
        if (!baseUrl) return json({ error: "baseUrl is required" }, 400);
        if (dryRun) {
          return json({ ok: true, dryRun: true, action, kind, baseUrl });
        }

        const protocol = protocolForLocalKind(kind);
        const reach = await probeLocalProvider(protocol, baseUrl);
        if (!reach.ok) {
          return json({ ok: false, error: reach.error || "Server unreachable" }, 200);
        }
        const providerId = kind === "ollama" ? "ollama" : kind === "lmstudio" ? "lmstudio" : "local";
        try {
          const models = await fetchLocalModels(protocol, baseUrl, providerId);
          return json({ ok: true, models });
        } catch (err) {
          return json({ ok: true, models: [], listError: String(err) });
        }
      }

      // ── Connect a local/loopback provider — writes the non-secret marker
      // key instead of a real credential, finishes onboarding with no token
      // at all (issue #70). Same fresh-machine bootstrap and same
      // never-clobber-primary guard as the cloud paths above. ──
      case "save-local": {
        const kind = String(body.kind || "").trim().toLowerCase() as LocalProviderKind;
        const baseUrl = String(body.baseUrl || "").trim();
        const providerId = String(
          body.providerId || (kind === "ollama" ? "ollama" : kind === "lmstudio" ? "lmstudio" : "local"),
        ).trim().toLowerCase();
        const model = String(body.model || "").trim();
        const makePrimary = body.makePrimary === true;
        const apiStyle = body.apiStyle === "openai-responses" ? "openai-responses" : "openai-completions";
        const timeoutSeconds =
          typeof body.timeoutSeconds === "number" && Number.isFinite(body.timeoutSeconds)
            ? body.timeoutSeconds
            : undefined;

        if (!["ollama", "lmstudio", "custom"].includes(kind)) {
          return json({ error: "kind must be one of: ollama, lmstudio, custom" }, 400);
        }
        if (!baseUrl || !providerId) {
          return json({ error: "baseUrl and providerId are required" }, 400);
        }
        if (!PROVIDER_ID_RE.test(providerId)) {
          return json({ error: "A valid providerId is required" }, 400);
        }
        // "custom" is the one kind that isn't a bundled provider id — the
        // gateway's config schema rejects it with no declared models
        // (verified live against a sandboxed gateway), so it needs a model
        // chosen up front rather than relying on auto-discovery.
        if (kind === "custom" && !model) {
          return json(
            { error: "Pick a model before connecting a custom provider — the gateway requires at least one." },
            400,
          );
        }

        const patch = buildLocalProviderConfig(kind, providerId, baseUrl, {
          apiStyle,
          timeoutSeconds,
          declareModel: kind === "custom" && model ? { ref: model } : undefined,
        });
        if (dryRun) {
          return json({
            ok: true,
            dryRun: true,
            action,
            providerId,
            // The marker is not a secret — safe to echo in the dry-run plan.
            wouldPatch: { baseUrl, apiKey: LOCAL_PROVIDER_MARKERS[kind], model: model || null },
          });
        }
        if (!Object.keys(patch).length) {
          return json({ error: "Could not build a config patch for this provider" }, 400);
        }

        if (!(await configFileExists())) {
          const bootstrap = await bootstrapFreshMachine();
          if (!bootstrap.ok) {
            return json({ ok: false, error: `Could not set up OpenClaw: ${bootstrap.error}` }, 500);
          }
        }

        let primarySet = false;
        let existingPrimary: string | null = null;
        if (model) {
          existingPrimary = await getCurrentPrimaryModel();
          if (shouldSetPrimary(existingPrimary, makePrimary)) {
            patch.agents = { defaults: { model: { primary: model } } };
            primarySet = true;
          }
        }

        try {
          await patchConfig(patch);
        } catch (err) {
          return json(
            { ok: false, error: `Could not save local provider: ${err instanceof Error ? err.message : err}` },
            500,
          );
        }

        return json({
          ok: true,
          provider: providerId,
          modelSet: primarySet ? model : null,
          primarySet,
          ...(model && !primarySet ? { existingPrimaryKept: existingPrimary } : {}),
        });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
