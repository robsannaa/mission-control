/**
 * Onboarding API
 *
 * GET  /api/onboard
 *   Returns setup status including hasModel, hasChannel, hasApiKey, etc.
 *
 * POST /api/onboard
 *   { action: "validate-key", provider, token [, customBaseUrl, customApiKeyHeader ] }
 *   { action: "list-models",  provider, token [, customBaseUrl, customApiKeyHeader ] }
 *   { action: "save-and-restart", provider, apiKey, model, telegramToken?, discordToken? [, customBaseUrl, customApiKeyHeader ] }
 */

import {NextResponse} from "next/server";
import {access, mkdir, readFile, writeFile} from "fs/promises";
import {dirname, join} from "path";
import {gatewayCall, runCli, runCliCaptureBoth} from "@/lib/openclaw";
import {getGatewayUrl, getOpenClawBin, getOpenClawHome} from "@/lib/paths";
import {patchConfig, mergeModelPrimary} from "@/lib/gateway-config";
import {
  buildCustomProviderConfig,
  buildProviderCredentialPatch,
  fetchModelsFromCustomProvider,
  fetchModelsFromProvider,
  PROVIDER_ENV_KEYS,
  validateCustomProviderToken,
  validateProviderToken,
} from "@/lib/provider-auth";
import {withRoute} from "@/lib/api-route";
import {onboardPostSchema} from "@/lib/schemas/onboarding";
import {badRequest, serverError} from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/* ── Helpers ───────────────────────────────────────── */

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe<T>(p: string): Promise<T | null> {
  try {
    const raw = await readFile(p, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function checkGatewayHealth(
  gatewayUrl: string,
): Promise<{ running: boolean; version?: string }> {
  try {
    const res = await fetch(gatewayUrl, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { running: false };
    const data = await res.json().catch(() => ({}));
    return {
      running: true,
      version: typeof data.version === "string" ? data.version : undefined,
    };
  } catch {
    return { running: false };
  }
}

function getDotPath(obj: Record<string, unknown>, dotPath: string): unknown {
  const parts = dotPath.split(".");
  let cur: unknown = obj;
  for (const key of parts) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/* ── GET /api/onboard ──────────────────────────────── */

export const GET = withRoute({ name: "/api/onboard" }, async (_request, ctx) => {
  try {
    const home = getOpenClawHome();
    const configPath = join(home, "openclaw.json");
    // `auth-profiles.json` is legacy — current OpenClaw stores per-agent auth
    // profiles (paste-token, OAuth login) in `openclaw-agent.sqlite` instead
    // (verified live: `models status --json`'s `auth.storePath` points at the
    // sqlite file, and a fresh agent has neither file until a profile-store
    // credential is actually saved). Check both so a subscription-token auth
    // that never touches config.auth.profiles isn't reported as unconfigured.
    const authJsonPath = join(home, "agents", "main", "agent", "auth-profiles.json");
    const authSqlitePath = join(home, "agents", "main", "agent", "openclaw-agent.sqlite");

    const [binPath, configExists, authJsonExists, authSqliteExists, gatewayUrl] = await Promise.all([
      getOpenClawBin().catch(() => null),
      fileExists(configPath),
      fileExists(authJsonPath),
      fileExists(authSqlitePath),
      getGatewayUrl(),
    ]);

    const installed = binPath !== null;

    let version: string | null = null;
    if (installed) {
      try {
        const out = await runCli(["--version"], 5000);
        version = out.trim().split("\n").pop()?.trim() || null;
      } catch {
        // binary found but --version failed
      }
    }

    const gateway = await checkGatewayHealth(gatewayUrl);

    let hasModel = false;
    let hasApiKey = false;
    let hasLocalProvider = false;
    let hasChannel = false;

    if (configExists) {
      try {
        const config = await readJsonSafe<Record<string, unknown>>(configPath);
        if (config) {
          // Check model
          const model = getDotPath(config, "agents.defaults.model");
          hasModel = Boolean(
            typeof model === "string" ? model : (model as Record<string, unknown>)?.primary,
          );

          // Check API keys in config.env
          const env = getDotPath(config, "env");
          if (env && typeof env === "object") {
            hasApiKey = Object.values(PROVIDER_ENV_KEYS).some((key) => {
              const value = (env as Record<string, unknown>)[key];
              return typeof value === "string" && value.trim().length > 0;
            });
          }

          // Check auth.profiles
          const authProfiles = getDotPath(config, "auth.profiles");
          if (!hasApiKey && authProfiles && typeof authProfiles === "object") {
            hasApiKey = Object.keys(authProfiles as Record<string, unknown>).length > 0;
          }

          // Check local/custom providers
          const providers = getDotPath(config, "models.providers");
          if (providers && typeof providers === "object") {
            hasLocalProvider = Object.keys(providers as Record<string, unknown>).some((k) => {
              const p = (providers as Record<string, unknown>)[k];
              if (!p || typeof p !== "object") return false;
              const baseUrl = (p as Record<string, unknown>).baseUrl;
              return typeof baseUrl === "string" && baseUrl.trim().length > 0;
            });
          }

          // Check channels — any key under channels with a non-empty object counts
          const channels = getDotPath(config, "channels");
          if (channels && typeof channels === "object") {
            hasChannel = Object.keys(channels as Record<string, unknown>).some((k) => {
              const ch = (channels as Record<string, unknown>)[k];
              return ch && typeof ch === "object" && Object.keys(ch as Record<string, unknown>).length > 0;
            });
          }
        }
      } catch {
        // config unreadable
      }
    }

    // Tier 3: per-agent auth store (legacy JSON, or the sqlite file that
    // replaced it — see the comment above where these paths are resolved).
    if (!hasApiKey && authJsonExists) {
      try {
        const auth = await readJsonSafe<{ profiles?: Record<string, unknown> }>(authJsonPath);
        hasApiKey = Boolean(auth?.profiles && Object.keys(auth.profiles).length > 0);
      } catch {
        // auth unreadable
      }
    }
    // The sqlite store is created lazily — it only exists once a real
    // profile-store credential (paste-token, OAuth login) has been saved, so
    // its mere presence is already a reliable signal without needing a
    // sqlite driver to count rows.
    if (!hasApiKey && authSqliteExists) {
      hasApiKey = true;
    }

    // Tier 4: process.env
    if (!hasApiKey) {
      hasApiKey = Object.values(PROVIDER_ENV_KEYS).some(
        (key) => typeof process.env[key] === "string" && process.env[key]!.trim().length > 0,
      );
    }

    // Ambient Ollama detection — informational only. This probes the host's
    // default Ollama port directly; it says nothing about whether OpenClaw's
    // config actually points at it, so it must never feed a "configured"
    // decision. A machine with Ollama running for something unrelated would
    // otherwise report setup as complete with zero real agent configuration.
    let hasOllama = false;
    try {
      const ollamaRes = await fetch("http://127.0.0.1:11434/api/tags", {
        signal: AbortSignal.timeout(2000),
      });
      hasOllama = ollamaRes.ok;
    } catch {
      // not running
    }

    const hasCredentials = hasApiKey || hasLocalProvider;

    return NextResponse.json({
      installed,
      configured: hasCredentials && hasModel,
      configExists,
      hasModel,
      hasApiKey,
      hasLocalProvider,
      hasOllama,
      hasChannel,
      gatewayRunning: gateway.running,
      version: version || gateway.version || null,
      gatewayUrl,
      home,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err: message }, "Onboard GET error");
    return serverError(message);
  }
});

/* ── POST /api/onboard ─────────────────────────────── */

export const POST = withRoute(
  { name: "/api/onboard", bodySchema: onboardPostSchema },
  async (_request, ctx) => {
  try {
    const body = ctx.body;
    const action = body.action as string;

    switch (action) {
      /* ── validate-key ──────────────────────────────── */
      case "validate-key": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        if (!provider || !token) {
          return badRequest("Provider and token are required");
        }
        if (provider === "custom") {
          const baseUrl = String(body.customBaseUrl || "").trim();
          const apiKeyHeader = String(body.customApiKeyHeader || "Authorization").trim() || "Authorization";
          const result = await validateCustomProviderToken(baseUrl, apiKeyHeader, token);
          return NextResponse.json(result);
        }
        const result = await validateProviderToken(provider, token);
        return NextResponse.json(result);
      }

      /* ── list-models ───────────────────────────────── */
      case "list-models": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const token = String(body.token || "").trim();
        if (!provider || !token) {
          return badRequest("Provider and token are required");
        }
        try {
          let models: Array<{ id: string; name: string }>;
          if (provider === "custom") {
            const baseUrl = String(body.customBaseUrl || "").trim();
            const apiKeyHeader = String(body.customApiKeyHeader || "Authorization").trim() || "Authorization";
            models = await fetchModelsFromCustomProvider(baseUrl, apiKeyHeader, token);
          } else {
            models = await fetchModelsFromProvider(provider, token);
          }
          return NextResponse.json({ ok: true, models });
        } catch (err) {
          return NextResponse.json({
            ok: false,
            error: `Failed to fetch models: ${err}`,
            models: [],
          });
        }
      }

      /* ── save-and-restart ──────────────────────────── */
      case "save-and-restart": {
        const provider = String(body.provider || "").trim().toLowerCase();
        const apiKeyValue = String(body.apiKey || "").trim();
        const model = String(body.model || "").trim();
        const telegramToken = String(body.telegramToken || "").trim();
        const discordToken = String(body.discordToken || "").trim();

        if (!provider || !apiKeyValue || !model) {
          return badRequest("Provider, API key, and model are required");
        }

        const isCustom = provider === "custom";
        const customBaseUrl = String(body.customBaseUrl || "").trim();
        const customApiKeyHeader = String(body.customApiKeyHeader || "Authorization").trim() || "Authorization";

        if (isCustom && !customBaseUrl) {
          return badRequest("Custom provider requires baseUrl");
        }

        const envKey = PROVIDER_ENV_KEYS[provider];
        if (!isCustom && !envKey) {
          return badRequest(`Unsupported provider: ${provider}`);
        }

        const home = getOpenClawHome();
        const configPath = join(home, "openclaw.json");
        const configExists = await fileExists(configPath);
        const isHosted =
          process.env.AGENTBAY_HOSTED === "true" ||
          process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";
        const hasChannels = Boolean(telegramToken || discordToken);

        // ── Step 1: Bootstrap config/workspace/daemon (only when no config yet) ──
        if (!configExists) {
          const onboardArgs = [
            "onboard",
            "--non-interactive",
            "--accept-risk",
            "--mode", "local",
            "--auth-choice", "skip",
            "--skip-channels",
            "--skip-skills",
            "--skip-search",  
            "--skip-ui",
          ];
          if (isHosted) {
            onboardArgs.push("--skip-health");
          } else {
            onboardArgs.push("--install-daemon", "--daemon-runtime", "node");
          }

          try {
            const onboardResult = await runCliCaptureBoth(onboardArgs, 60000);
            if (onboardResult.code !== 0) {
              const detail = String(onboardResult.stderr || onboardResult.stdout || "").trim();
              return serverError(`Bootstrap failed: ${detail || `exit code ${onboardResult.code}`}`);
            }
          } catch (err) {
            return serverError(`Bootstrap failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        // ── Step 2: Wait for gateway to be healthy ──
        const gatewayUrl = await getGatewayUrl();
        let gatewayReady = false;
        for (let i = 0; i < 15; i++) {
          const health = await checkGatewayHealth(gatewayUrl);
          if (health.running) { gatewayReady = true; break; }
          await new Promise((r) => setTimeout(r, 1500));
        }

        // ── Step 3: Build unified config patch ──
        const patch: Record<string, unknown> = isCustom
          ? buildCustomProviderConfig(customBaseUrl, customApiKeyHeader, apiKeyValue)
          : buildProviderCredentialPatch(provider, apiKeyValue);

        // Only set the primary model if one isn't already configured —
        // avoids silently overwriting a user's existing model choice.
        let existingPrimaryModel = "";
        try {
          const existing = JSON.parse(await readFile(configPath, "utf-8"));
          const m = existing?.agents?.defaults?.model;
          existingPrimaryModel = (typeof m === "string" ? m : m?.primary) || "";
        } catch { /* no config yet — will set model */ }
        if (!existingPrimaryModel) {
          patch.agents = { defaults: { model: { primary: model } } };
        }

        if (telegramToken) {
          const channels = (patch.channels ?? {}) as Record<string, unknown>;
          channels.telegram = { enabled: true, botToken: telegramToken, dmPolicy: "pairing" };
          patch.channels = channels;
        }
        if (discordToken) {
          const channels = (patch.channels ?? {}) as Record<string, unknown>;
          channels.discord = { enabled: true, token: discordToken, dmPolicy: "pairing" };
          patch.channels = channels;
        }

        // ── Step 3: ALWAYS write to disk first (guaranteed to work) ──
        let patchMethod = "";
        try {
          let config: Record<string, unknown> = {};
          try { config = JSON.parse(await readFile(configPath, "utf-8")); } catch { /* fresh */ }

          if (isCustom) {
            const models = (config.models || {}) as Record<string, unknown>;
            const providers = (models.providers || {}) as Record<string, unknown>;
            const headers = customApiKeyHeader.toLowerCase() === "authorization" && !apiKeyValue.toLowerCase().startsWith("bearer ")
              ? { [customApiKeyHeader]: `Bearer ${apiKeyValue}` }
              : { [customApiKeyHeader]: apiKeyValue };
            providers.custom = {
              baseUrl: customBaseUrl.replace(/\/+$/, ""),
              headers,
            };
            models.providers = providers;
            config.models = models;

            const auth = (config.auth || {}) as Record<string, unknown>;
            const profiles = (auth.profiles || {}) as Record<string, unknown>;
            profiles["custom:default"] = { provider: "custom", mode: "api_key" };
            auth.profiles = profiles;
            config.auth = auth;
          } else {
            const env = (config.env || {}) as Record<string, unknown>;
            env[envKey] = apiKeyValue;
            config.env = env;

            const auth = (config.auth || {}) as Record<string, unknown>;
            const profiles = (auth.profiles || {}) as Record<string, unknown>;
            profiles[`${provider}:default`] = { provider, mode: "api_key" };
            auth.profiles = profiles;
            config.auth = auth;
          }

          const agents = (config.agents || {}) as Record<string, unknown>;
          const defaults = (agents.defaults || {}) as Record<string, unknown>;
          const existingModel = defaults.model as Record<string, unknown> | string | undefined;
          const hasPrimary = typeof existingModel === "string"
            ? existingModel
            : existingModel?.primary;
          if (!hasPrimary) {
            // Merge into whatever's already on `model` (e.g. `fallbacks` with
            // no `primary` yet) instead of replacing the object outright.
            defaults.model = mergeModelPrimary(existingModel, model);
          }
          agents.defaults = defaults;
          config.agents = agents;

          if (telegramToken) {
            const channels = (config.channels || {}) as Record<string, unknown>;
            channels.telegram = { enabled: true, botToken: telegramToken, dmPolicy: "pairing" };
            config.channels = channels;
          }
          if (discordToken) {
            const channels = (config.channels || {}) as Record<string, unknown>;
            channels.discord = { enabled: true, token: discordToken, dmPolicy: "pairing" };
            config.channels = channels;
          }

          await mkdir(dirname(configPath), { recursive: true });
          await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
          patchMethod = "disk";
        } catch (err) {
          return serverError(`Config save failed: ${err instanceof Error ? err.message : err}`);
        }

        // ── Step 4: Notify gateway of config change (best-effort) ──
        // Gateway has hybrid reload — it watches the config file. But we also try
        // RPC to trigger an immediate reload, especially for channels that need a restart.
        if (gatewayReady) {
          try {
            await patchConfig(patch, { restartDelayMs: hasChannels ? 2000 : 0 });
            patchMethod = "gateway";
          } catch {
            // Gateway RPC failed — that's fine, config is on disk.
            // Gateway's file watcher will pick it up, or we restart below.
          }
        }

        // ── Step 5: If channels configured, restart gateway and wait for channel ──
        if (hasChannels) {
          // If RPC patch didn't work, restart gateway via CLI so it picks up channels
          if (patchMethod !== "gateway") {
            try {
              await runCliCaptureBoth(["gateway", "restart"], 25000);
            } catch {
              // restart may fail if gateway isn't managed by daemon — that's ok
            }
          }

          // Poll until target channel is running (up to 18s)
          const targetChannel = telegramToken ? "telegram" : "discord";
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 1500));
            try {
              const status = await gatewayCall<Record<string, unknown>>("channels.status", {}, 8000);
              const channels = status && typeof status === "object"
                ? (status as Record<string, unknown>).channels : null;
              if (channels && typeof channels === "object") {
                const ch = (channels as Record<string, unknown>)[targetChannel];
                if (ch && typeof ch === "object" && (ch as Record<string, unknown>).running === true) break;
              }
            } catch {
              // gateway may still be restarting
            }
          }
        }

        return NextResponse.json({ ok: true, method: patchMethod });
      }

      /* ── get-bot-info ─────────────────────────────── */
      case "get-bot-info": {
        const botToken = String(body.token || "").trim();
        const channel = String(body.channel || "").trim();
        if (!botToken || !channel) {
          return NextResponse.json({ ok: false });
        }
        try {
          if (channel === "telegram") {
            const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const data = await res.json();
              const bot = data.result;
              return NextResponse.json({
                ok: true,
                username: bot?.username ? `@${bot.username}` : null,
                name: bot?.first_name || null,
              });
            }
          }
          if (channel === "discord") {
            const res = await fetch("https://discord.com/api/v10/users/@me", {
              headers: { Authorization: `Bot ${botToken}` },
              signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
              const bot = await res.json();
              return NextResponse.json({
                ok: true,
                username: bot?.username || null,
                name: bot?.global_name || bot?.username || null,
              });
            }
          }
        } catch { /* silent */ }
        return NextResponse.json({ ok: false });
      }

      default:
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err: message }, "Onboard POST error");
    return serverError(message);
  }
  },
);
