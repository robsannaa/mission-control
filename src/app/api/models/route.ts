import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { buildModelsSummary } from "@/lib/models-summary";
import {
  buildProviderCredentialPatch,
  buildLocalProviderConfig,
  fetchLocalModels,
  probeLocalProvider,
  protocolForLocalKind,
  isPrivateBaseUrl,
  type LocalProviderKind,
  PROVIDER_ENV_KEYS,
  validateProviderToken,
  fetchModelsFromProvider,
} from "@/lib/provider-auth";
import {
  patchConfig,
  getCurrentPrimaryModel,
  extractPrimaryModel,
  mergeModelPrimary,
  mergeModelPriority,
  normalizeModelPriority,
  shouldSetPrimary,
} from "@/lib/gateway-config";
import { CONFIG_WRITE_TIMEOUT_MS, gatewayCall, runCliCaptureBoth } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { modelsPostSchema } from "@/lib/schemas/usage";

export const dynamic = "force-dynamic";

const OPENCLAW_HOME = getOpenClawHome();

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function setModelPriorityWithCli(models: string[]): Promise<void> {
  const current = await runCliCaptureBoth(
    ["config", "get", "agents.defaults.model", "--json"],
    CONFIG_WRITE_TIMEOUT_MS,
  );
  if (current.code !== 0) {
    throw new Error(String(current.stderr || current.stdout || "Could not read current model config").trim());
  }
  let existingModel: unknown;
  try {
    existingModel = JSON.parse(current.stdout);
  } catch {
    throw new Error("OpenClaw returned an unreadable model configuration");
  }
  const modelConfig = mergeModelPriority(existingModel, models);
  const saved = await runCliCaptureBoth(
    ["config", "set", "--strict-json", "agents.defaults.model", JSON.stringify(modelConfig)],
    CONFIG_WRITE_TIMEOUT_MS,
  );
  if (saved.code !== 0) {
    throw new Error(String(saved.stderr || saved.stdout || "OpenClaw rejected the model priority").trim());
  }
}

// ── GET /api/models ─────────────────────────────
// Returns current model config + summary for the UI, enriched with the
// gateway's live model catalog (models.list) and provider auth state
// (models.authStatus). The config-derived summary is only the offline
// fallback — never the primary source when the gateway is up.

type GatewayModelRow = {
  id?: string;
  name?: string;
  provider?: string;
  contextWindow?: number;
  input?: unknown;
  available?: boolean;
};

type GatewayAuthProviderRow = {
  provider?: string;
  displayName?: string;
  status?: string;
  profiles?: Array<{ profileId?: string; type?: string; status?: string }>;
};

const LOCAL_PROVIDERS = new Set(["ollama", "vllm", "lmstudio", "local"]);

function modelKeyFor(provider: string, id: string): string {
  return id === provider || id.startsWith(`${provider}/`) ? id : `${provider}/${id}`;
}

export const GET = withRoute({ name: "/api/models" }, async () => {
  try {
    const summary = await buildModelsSummary();

    const gatewayErrors: string[] = [];
    const [liveModels, liveAuth] = await Promise.all([
      gatewayCall<{ models?: GatewayModelRow[] }>("models.list", {}, 8000).catch((err) => {
        gatewayErrors.push(`models.list: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
      gatewayCall<{ providers?: GatewayAuthProviderRow[] }>("models.authStatus", {}, 8000).catch((err) => {
        gatewayErrors.push(`models.authStatus: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }),
    ]);
    const gatewayOffline = liveModels === null && liveAuth === null;

    // Live model catalog → the ModelInfo shape the views already consume.
    const models = Array.isArray(liveModels?.models) && liveModels.models.length > 0
      ? liveModels.models
          .filter((m): m is GatewayModelRow & { id: string; provider: string } =>
            typeof m?.id === "string" && typeof m?.provider === "string")
          .map((m) => ({
            key: modelKeyFor(m.provider, m.id),
            name: m.name || m.id,
            input: Array.isArray(m.input) ? m.input.map((v) => String(v)).join(",") : "",
            contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : 0,
            local: LOCAL_PROVIDERS.has(m.provider),
            available: m.available !== false,
            tags: ["gateway"],
            missing: false,
          }))
      : summary.models;

    // Live auth state → per-provider authentication rows. Falls back to the
    // config-derived auth summary when the RPC is unavailable.
    const authProviders = Array.isArray(liveAuth?.providers)
      ? liveAuth.providers
          .filter((p): p is GatewayAuthProviderRow & { provider: string } =>
            typeof p?.provider === "string")
          .map((p) => ({
            provider: p.provider,
            displayName: p.displayName || p.provider,
            authenticated: p.status === "ok",
            authKind: p.profiles?.[0]?.type ?? null,
            status: p.status || "unknown",
          }))
      : (summary.status.auth?.providers || []).map((p) => ({
          provider: p.provider,
          displayName: p.provider,
          authenticated: Boolean(p.effective),
          authKind: p.effective?.kind ?? null,
          status: p.effective ? "ok" : "missing",
        }));

    return json({
      ...summary,
      models,
      authProviders,
      gatewayOffline,
      ...(gatewayErrors.length > 0 ? { gatewayErrors } : {}),
      degraded: Boolean(summary.degraded) || gatewayOffline,
    });
  } catch (err) {
    return serverError(String(err));
  }
});

// ── POST /api/models ────────────────────────────
// Actions: auth-provider, remove-provider, set-primary, set-model-chain, set-fallbacks,
// list-models, test-key, probe-local, connect-local

export const POST = withRoute(
  { name: "/api/models", bodySchema: modelsPostSchema },
  async (_request: NextRequest, ctx) => {
  try {
    const body = ctx.body as Record<string, unknown>;
    const action = String(body.action || "");

    switch (action) {
      // ── Connect a provider (save API key + optionally set default model) ──
      //
      // FOOTGUN FIX (issue #70): connecting a new provider must never silently
      // change the primary model — that's how a user pasting an OpenRouter key
      // "just to get past the wizard" ended up with their local model replaced
      // and no way back. `model` is still accepted (it's what makes the
      // "connect + immediately pick a model" flows work), but it's only
      // written to `agents.defaults.model.primary` when there's no primary
      // configured yet, or the caller explicitly opts in with `makePrimary`.
      case "auth-provider": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        const modelToSet = String(body.model || "").trim();
        const makePrimary = body.makePrimary === true;

        if (!provider || !token) {
          return badRequest("Provider and API key are required");
        }

        // Validate the key against the provider's API
        const validation = await validateProviderToken(provider, token);
        if (!validation.ok) {
          return badRequest(validation.error || "Invalid API key");
        }

        const envKey = PROVIDER_ENV_KEYS[provider];
        let method = "";
        let gatewayError: string | null = null;
        let primarySet = false;
        let existingPrimary: string | null = null;

        // Layer 1: Gateway RPC (preferred — triggers live reload)
        if (envKey) {
          try {
            const patch = buildProviderCredentialPatch(provider, token);
            if (modelToSet) {
              existingPrimary = await getCurrentPrimaryModel();
              if (shouldSetPrimary(existingPrimary, makePrimary)) {
                // Merge only the `primary` key — config.patch is an RFC 7386
                // JSON merge patch, so this preserves `fallbacks` and any
                // other keys already on `agents.defaults.model`.
                patch.agents = { defaults: { model: { primary: modelToSet } } };
                primarySet = true;
              }
            }
            await patchConfig(patch);
            method = "gateway";
          } catch (err) {
            // Surface why the live path failed instead of silently degrading —
            // the disk fallback works, but the gateway won't hot-reload it.
            gatewayError = err instanceof Error ? err.message : String(err);
            ctx.log.warn(
              { err: gatewayError },
              "[auth-provider] gateway config patch failed, using disk fallback",
            );
          }
        }

        // Layer 2: Direct disk write (fallback)
        if (!method) {
          try {
            const configPath = join(OPENCLAW_HOME, "openclaw.json");
            const authPath = join(OPENCLAW_HOME, "agents", "main", "agent", "auth-profiles.json");

            // Write to openclaw.json
            let config: Record<string, unknown> = {};
            try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* fresh */ }

            if (envKey) {
              const env = (config.env || {}) as Record<string, unknown>;
              env[envKey] = token;
              config.env = env;
            }
            const auth = (config.auth || {}) as Record<string, unknown>;
            const profiles = (auth.profiles || {}) as Record<string, unknown>;
            profiles[`${provider}:default`] = { provider, mode: "api_key" };
            auth.profiles = profiles;
            config.auth = auth;

            if (modelToSet) {
              existingPrimary = extractPrimaryModel(config);
              if (shouldSetPrimary(existingPrimary, makePrimary)) {
                const agents = (config.agents || {}) as Record<string, unknown>;
                const defaults = (agents.defaults || {}) as Record<string, unknown>;
                // Merge into the existing model object instead of replacing
                // it wholesale — a raw `defaults.model = { primary }` here
                // would silently drop `fallbacks`.
                defaults.model = mergeModelPrimary(defaults.model, modelToSet);
                agents.defaults = defaults;
                config.agents = agents;
                primarySet = true;
              }
            }

            await mkdir(dirname(configPath), { recursive: true });
            await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

            // Write to auth-profiles.json
            let authData: { profiles: Record<string, unknown> } = { profiles: {} };
            try {
              authData = JSON.parse(await readFile(authPath, "utf-8"));
              if (!authData.profiles) authData.profiles = {};
            } catch { /* fresh */ }
            authData.profiles[`${provider}:default`] = { provider, type: "api_key", key: token };
            await mkdir(dirname(authPath), { recursive: true });
            await writeFile(authPath, JSON.stringify(authData, null, 2) + "\n", "utf-8");

            method = "disk";
          } catch (err) {
            return serverError(`Failed to save credentials: ${err}`);
          }
        }

        return json({
          ok: true,
          provider,
          method,
          modelSet: primarySet ? modelToSet : null,
          primarySet,
          // Told to the caller so the UI can say "kept your existing model"
          // instead of silently doing nothing with the requested `model`.
          ...(modelToSet && !primarySet ? { existingPrimaryKept: existingPrimary } : {}),
          ...(gatewayError ? { gatewayError } : {}),
        });
      }

      // ── Probe a local/loopback provider (no key needed) ──
      case "probe-local": {
        const kind = String(body.kind || "").trim().toLowerCase() as LocalProviderKind;
        const baseUrl = String(body.baseUrl || "").trim();
        if (!["ollama", "lmstudio", "custom"].includes(kind)) {
          return badRequest("kind must be one of: ollama, lmstudio, custom");
        }
        if (!baseUrl) return badRequest("baseUrl is required");

        const result = await probeLocalProvider(protocolForLocalKind(kind), baseUrl);
        if (!result.ok) return json(result, 200);

        try {
          const models = await fetchLocalModels(
            protocolForLocalKind(kind),
            baseUrl,
            kind === "ollama" ? "ollama" : kind === "lmstudio" ? "lmstudio" : "local",
          );
          return json({ ok: true, models });
        } catch (err) {
          // Reachable, but listing failed — still "ok" (server is there),
          // just no models to show yet.
          return json({ ok: true, models: [], listError: String(err) });
        }
      }

      // ── Connect a local/loopback provider — no key, no validation call ──
      case "connect-local": {
        const kind = String(body.kind || "").trim().toLowerCase() as LocalProviderKind;
        const baseUrl = String(body.baseUrl || "").trim();
        const providerId = String(
          body.providerId || (kind === "custom" ? "local" : kind) || "",
        ).trim().toLowerCase();
        const modelToSet = String(body.model || "").trim();
        const makePrimary = body.makePrimary === true;
        const apiStyle = body.apiStyle === "openai-responses" ? "openai-responses" : "openai-completions";
        const timeoutSeconds =
          typeof body.timeoutSeconds === "number" && Number.isFinite(body.timeoutSeconds)
            ? body.timeoutSeconds
            : undefined;

        if (!["ollama", "lmstudio", "custom"].includes(kind)) {
          return badRequest("kind must be one of: ollama, lmstudio, custom");
        }
        if (!baseUrl || !providerId) {
          return badRequest("baseUrl and providerId are required");
        }

        const patch = buildLocalProviderConfig(kind, providerId, baseUrl, {
          apiStyle,
          timeoutSeconds,
          // Only "custom" ids need this (see buildLocalProviderConfig) — the
          // gateway rejects a non-bundled provider with no declared models.
          declareModel: kind === "custom" && modelToSet ? { ref: modelToSet } : undefined,
        });
        if (!Object.keys(patch).length) {
          return badRequest("Could not build a config patch for this provider");
        }
        if (kind === "custom" && !modelToSet) {
          return badRequest(
            "Pick a model before connecting a custom provider — the gateway requires at least one.",
          );
        }

        let primarySet = false;
        let existingPrimary: string | null = null;
        if (modelToSet) {
          existingPrimary = await getCurrentPrimaryModel();
          if (shouldSetPrimary(existingPrimary, makePrimary)) {
            patch.agents = { defaults: { model: { primary: modelToSet } } };
            primarySet = true;
          }
        }

        try {
          await patchConfig(patch);
        } catch (err) {
          return serverError(`Failed to save local provider: ${err instanceof Error ? err.message : err}`);
        }

        return json({
          ok: true,
          provider: providerId,
          modelSet: primarySet ? modelToSet : null,
          primarySet,
          ...(modelToSet && !primarySet ? { existingPrimaryKept: existingPrimary } : {}),
        });
      }

      // ── Remove a provider's credentials ──
      case "remove-provider": {
        const provider = String(body.provider || "").trim().toLowerCase();
        if (!provider) return badRequest("Provider is required");

        const envKey = PROVIDER_ENV_KEYS[provider];

        // Try gateway RPC first
        try {
          const patch: Record<string, unknown> = {};
          if (envKey) {
            patch.env = { [envKey]: "" };
          }
          patch.auth = { profiles: { [`${provider}:default`]: null } };
          await patchConfig(patch);
          return json({ ok: true, provider });
        } catch { /* fallback to disk */ }

        // Disk fallback
        try {
          const configPath = join(OPENCLAW_HOME, "openclaw.json");
          let config: Record<string, unknown> = {};
          try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* */ }

          if (envKey) {
            const env = (config.env || {}) as Record<string, unknown>;
            delete env[envKey];
            config.env = env;
          }
          const auth = (config.auth || {}) as Record<string, unknown>;
          const profiles = (auth.profiles || {}) as Record<string, unknown>;
          delete profiles[`${provider}:default`];
          auth.profiles = profiles;
          config.auth = auth;
          await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

          // Also clean auth-profiles.json
          const authPath = join(OPENCLAW_HOME, "agents", "main", "agent", "auth-profiles.json");
          try {
            const authData = JSON.parse(await readFile(authPath, "utf-8"));
            if (authData.profiles) {
              delete authData.profiles[`${provider}:default`];
              await writeFile(authPath, JSON.stringify(authData, null, 2) + "\n", "utf-8");
            }
          } catch { /* */ }

          return json({ ok: true, provider });
        } catch (err) {
          return serverError(`Failed to remove provider: ${err}`);
        }
      }

      // ── Set the default model ──
      case "set-primary": {
        const model = String(body.model || "").trim();
        if (!model) return badRequest("Model is required");

        try {
          await patchConfig({ agents: { defaults: { model: { primary: model } } } });
          return json({ ok: true, model });
        } catch (patchErr) {
          ctx.log.warn(
            { err: patchErr instanceof Error ? patchErr.message : String(patchErr) },
            "[set-primary] patchConfig failed, trying disk fallback",
          );
          // Disk fallback — write to the main config file
          try {
            const configPath = join(OPENCLAW_HOME, "openclaw.json");
            let config: Record<string, unknown> = {};
            try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* */ }
            const agents = (config.agents || {}) as Record<string, unknown>;
            const defaults = (agents.defaults || {}) as Record<string, unknown>;
            // Merge into the existing model object — `set-primary` is an
            // explicit user choice to change the primary, but it must not
            // discard `fallbacks` (or any other key) as a side effect.
            defaults.model = mergeModelPrimary(defaults.model, model);
            agents.defaults = defaults;
            config.agents = agents;
            await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
            return json({ ok: true, model });
          } catch (err) {
            return serverError(`Failed to set model: ${err}`);
          }
        }
      }

      // ── Atomically replace the ordered model priority chain ──
      // The first model is primary; every subsequent model is a fallback in
      // failover order. One write prevents drag-and-drop from briefly leaving
      // primary and fallbacks inconsistent with each other.
      case "set-model-chain": {
        const models = normalizeModelPriority(
          Array.isArray(body.models) ? (body.models as unknown[]) : []
        );
        if (models.length === 0) {
          return badRequest("At least one model is required");
        }
        const primary = models[0];
        const fallbacks = models.slice(1);

        try {
          await patchConfig(
            { agents: { defaults: { model: { primary, fallbacks } } } },
            { replacePaths: ["agents.defaults.model.fallbacks"] }
          );
          return json({ ok: true, primary, fallbacks });
        } catch (patchErr) {
          ctx.log.warn(
            { err: patchErr instanceof Error ? patchErr.message : String(patchErr) },
            "[set-model-chain] patchConfig failed, trying OpenClaw CLI fallback",
          );
          try {
            // Use OpenClaw's own config command so unknown refs are rejected
            // and schema validation still runs while the Gateway is offline.
            await setModelPriorityWithCli(models);
            return json({ ok: true, primary, fallbacks });
          } catch (err) {
            return serverError(`Failed to set model priority: ${err}`);
          }
        }
      }

      // ── Set fallback models ──
      case "set-fallbacks": {
        const fallbacks = Array.isArray(body.fallbacks)
          ? (body.fallbacks as unknown[]).map((f) => String(f).trim()).filter(Boolean)
          : [];

        try {
          await patchConfig(
            { agents: { defaults: { model: { fallbacks } } } },
            { replacePaths: ["agents.defaults.model.fallbacks"] }
          );
          return json({ ok: true, fallbacks });
        } catch (patchErr) {
          ctx.log.warn(
            { err: patchErr instanceof Error ? patchErr.message : String(patchErr) },
            "[set-fallbacks] patchConfig failed, trying disk fallback",
          );
          try {
            const configPath = join(OPENCLAW_HOME, "openclaw.json");
            let config: Record<string, unknown> = {};
            try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* */ }
            const agents = (config.agents || {}) as Record<string, unknown>;
            const defaults = (agents.defaults || {}) as Record<string, unknown>;
            const model = (defaults.model && typeof defaults.model === "object" && !Array.isArray(defaults.model)
              ? { ...(defaults.model as Record<string, unknown>) }
              : {}) as Record<string, unknown>;
            model.fallbacks = fallbacks;
            defaults.model = model;
            agents.defaults = defaults;
            config.agents = agents;
            await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
            return json({ ok: true, fallbacks });
          } catch (err) {
            return serverError(`Failed to set fallbacks: ${err}`);
          }
        }
      }

      // ── List models from a provider ──
      // Accepts explicit token OR reads stored key from disk
      case "list-models": {
        const provider = String(body.provider || "").trim().toLowerCase();
        let token = String(body.token || "").trim();
        if (!provider) return badRequest("Provider is required");

        // Local/loopback providers have no token to fetch — their catalog
        // comes straight from the server itself, keyed off the `baseUrl`
        // already written into `models.providers.<id>`.
        try {
          const configPath = join(OPENCLAW_HOME, "openclaw.json");
          const config = JSON.parse(await readFile(configPath, "utf-8"));
          const providerCfg = config?.models?.providers?.[provider];
          const baseUrl = typeof providerCfg?.baseUrl === "string" ? providerCfg.baseUrl : "";
          if (baseUrl && (LOCAL_PROVIDERS.has(provider) || isPrivateBaseUrl(baseUrl))) {
            const models = await fetchLocalModels(protocolForLocalKind(
              provider === "ollama" ? "ollama" : "custom",
            ), baseUrl, provider);
            return json({ ok: true, models });
          }
        } catch { /* fall through to the token-based lookup below */ }

        // If no token passed, try to read stored key
        if (!token) {
          try {
            const authPath = join(OPENCLAW_HOME, "agents", "main", "agent", "auth-profiles.json");
            const authData = JSON.parse(await readFile(authPath, "utf-8"));
            const profile = authData?.profiles?.[`${provider}:default`];
            if (profile?.key) token = profile.key;
          } catch { /* */ }

          // Also try env block in openclaw.json
          if (!token) {
            try {
              const configPath = join(OPENCLAW_HOME, "openclaw.json");
              const config = JSON.parse(await readFile(configPath, "utf-8"));
              const envKey = PROVIDER_ENV_KEYS[provider];
              if (envKey && config?.env?.[envKey]) token = config.env[envKey];
            } catch { /* */ }
          }
        }

        if (!token) return badRequest("No API key found for this provider");

        try {
          const models = await fetchModelsFromProvider(provider, token);
          return json({ ok: true, models });
        } catch (err) {
          return serverError(`Failed to fetch models: ${err}`);
        }
      }

      // ── Validate an API key without saving ──
      case "test-key": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        if (!provider || !token) return badRequest("Provider and token required");

        const result = await validateProviderToken(provider, token);
        return json(result);
      }

      default:
        // Unreachable in practice — `modelsPostSchema` (a discriminated
        // union keyed on `action`) already rejects an unrecognized action
        // before this handler runs (400, Zod `details` tree). Kept as a
        // defensive fallback for a body that reached here some other way.
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (err) {
    return serverError(String(err));
  }
  },
);
