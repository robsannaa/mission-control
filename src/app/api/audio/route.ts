import { NextRequest, NextResponse } from "next/server";
import { gatewayCall, runCli } from "@/lib/openclaw";
import { runOpenResponsesText } from "@/lib/openresponses";
import { readFile, stat } from "fs/promises";
import { extname, join } from "path";
import { getDefaultAgentId, getOpenClawHome } from "@/lib/paths";
import { fetchConfig, patchConfig, gatewayConfigPatch } from "@/lib/gateway-config";

/* ── Gather personal context for TTS test phrase generation ── */

async function gatherContext(): Promise<string> {
  const home = getOpenClawHome();
  const contextParts: string[] = [];

  // Try to read USER.md (human's profile)
  for (const wsDir of ["workspace", "workspace-gilfoyle"]) {
    try {
      const userMd = await readFile(join(home, wsDir, "USER.md"), "utf-8");
      if (userMd.trim()) {
        contextParts.push(`USER PROFILE:\n${userMd.trim()}`);
        break; // Only need one
      }
    } catch { /* file not found — skip */ }
  }

  // Try to read IDENTITY.md (agent's personality)
  try {
    const identityMd = await readFile(join(home, "workspace", "IDENTITY.md"), "utf-8");
    if (identityMd.trim()) {
      contextParts.push(`AGENT IDENTITY:\n${identityMd.trim()}`);
    }
  } catch { /* skip */ }

  // Try to read openclaw.json for agent names, model info
  try {
    const configRaw = await readFile(join(home, "openclaw.json"), "utf-8");
    const config = JSON.parse(configRaw);
    const agents = config?.agents?.list;
    if (Array.isArray(agents) && agents.length > 0) {
      const agentNames = agents.map((a: Record<string, unknown>) => a.name || a.id).join(", ");
      contextParts.push(`AGENTS: ${agentNames}`);
    }
    const model = config?.agents?.defaults?.model?.primary;
    if (model) contextParts.push(`MODEL: ${model}`);
  } catch { /* skip */ }

  // Current time for temporal awareness
  const now = new Date();
  const hour = now.getHours();
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
  contextParts.push(`TIME: ${dayName} ${timeOfDay}, ${now.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`);

  return contextParts.join("\n\n");
}

/**
 * Ask the OpenClaw agent to generate a personalized TTS test phrase.
 * Uses USER.md, IDENTITY.md, and config context to make it unique.
 * Falls back to personalized templates if the agent is unavailable.
 */
async function generateTestPhrase(): Promise<string> {
  const context = await gatherContext();

  // Try agent-generated phrase first
  try {
    const prompt = [
      "You are generating a single short TTS demo sentence (15-25 words).",
      "This sentence will be spoken out loud to test text-to-speech.",
      "Make it DEEPLY PERSONAL to the user and the moment. Reference their name,",
      "the time of day, their projects, or something specific from their profile.",
      "Be warm, witty, and natural — like a friend greeting them.",
      "Speak AS the AI assistant (use the agent's name if you know it).",
      "Do NOT add quotes, labels, or explanation. Just output the sentence.",
      "",
      "CONTEXT:",
      context,
    ].join("\n");

    // "main" is `agents.list`'s mainKey, not an agent id. The RPC rejects it as
    // unknown, and the CLI silently resolves `--agent main` to a workspace
    // *inside* the real one, so it targets the wrong place instead of failing.
    // Ask which agent is actually the default; when the gateway cannot be
    // reached there is no safe guess, so fall through to the template phrase.
    const agentId = await getDefaultAgentId();
    if (!agentId) {
      throw new Error("Could not resolve the default agent from the gateway");
    }

    let output = "";
    try {
      const result = await runOpenResponsesText({
        input: prompt,
        agentId,
        timeoutMs: 15000,
      });
      if (!result.ok) {
        throw new Error(result.text || `Gateway returned ${result.status}`);
      }
      output = result.text;
    } catch {
      output = await runCli(
        ["agent", "--agent", agentId, "--message", prompt],
        30000
      );
    }
    const phrase = output.trim().replace(/^["']|["']$/g, ""); // strip wrapping quotes
    if (phrase && phrase.length > 10 && phrase.length < 300) {
      return phrase;
    }
  } catch {
    // Agent unavailable — fall through to personalized template
  }

  // Fallback: build a personalized phrase from gathered context
  // Extract user name from context
  const nameMatch = context.match(/\*\*(?:What to call them|Name):\*\*\s*(\w+)/i);
  const userName = nameMatch?.[1] || "boss";

  const agentMatch = context.match(/\*\*Name:\*\*\s*(\w+)/);
  const agentName = agentMatch?.[1] || "OpenClaw";

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  const phrases = [
    `${greeting}, ${userName}! It's ${agentName}. Voice systems are online — how do I sound?`,
    `Hey ${userName}, ${agentName} here. Just wanted to say — your AI setup is looking sharp today.`,
    `${userName}, it's your assistant ${agentName}. If you can hear this, we're officially talking.`,
    `${greeting}, ${userName}. ${agentName} speaking. Ready to help with whatever you need today.`,
    `This is ${agentName}, checking in with you, ${userName}. Voice is live and I'm here for you.`,
    `Hey ${userName}! ${agentName} just found its voice. Pretty cool, right?`,
    `${greeting}, ${userName}. It's ${agentName} on the mic. Let's get things done today.`,
    `${userName}, your AI assistant ${agentName} is now speaking. How's that for a personal touch?`,
  ];
  return phrases[Math.floor(Math.random() * phrases.length)];
}

const MIME_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
};

type AudioProviderKeyTarget = "openai" | "elevenlabs";

type AudioProviderKeyState = {
  configured: boolean;
  authState: "ready" | "missing" | "builtin" | "external";
  authLabel: string;
  authSource: string | null;
  authNote: string | null;
  authLocation: "config-tts" | "config-env" | "process-env" | "runtime" | "builtin" | "missing";
  canManageKey: boolean;
  canRemoveKey: boolean;
  removeMode?: "config-tts" | "config-env";
  envKey?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function getNestedString(obj: Record<string, unknown> | undefined, path: string[]): string | null {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isNonEmptyString(current) ? current.trim() : null;
}

function getConfigEnv(parsed: Record<string, unknown>): Record<string, string> {
  const envBlock = isRecord(parsed.env) ? parsed.env : {};
  const varsBlock = isRecord(envBlock.vars) ? envBlock.vars : {};
  const entries: Record<string, string> = {};

  for (const [key, value] of Object.entries(envBlock)) {
    if (key === "vars") continue;
    if (isNonEmptyString(value)) {
      entries[key] = value.trim();
    }
  }

  for (const [key, value] of Object.entries(varsBlock)) {
    if (isNonEmptyString(value)) {
      entries[key] = value.trim();
    }
  }

  return entries;
}

function buildProviderKeyState(
  providerId: string,
  status: Record<string, unknown>,
  parsedRoot: Record<string, unknown>,
  parsedTts: Record<string, unknown> | undefined,
  resolvedTts: Record<string, unknown>,
  parsedTalk: Record<string, unknown> | undefined,
): AudioProviderKeyState {
  if (providerId === "edge") {
    return {
      configured: true,
      authState: "builtin",
      authLabel: "Built in",
      authSource: "Edge TTS does not require an API key.",
      authNote: null,
      authLocation: "builtin",
      canManageKey: false,
      canRemoveKey: false,
    };
  }

  if (providerId !== "openai" && providerId !== "elevenlabs") {
    return {
      configured: false,
      authState: "missing",
      authLabel: "Unknown auth",
      authSource: null,
      authNote: null,
      authLocation: "missing",
      canManageKey: false,
      canRemoveKey: false,
    };
  }

  const envKeys = providerId === "openai"
    ? ["OPENAI_API_KEY"]
    : ["ELEVENLABS_API_KEY", "XI_API_KEY"];
  const parsedApiKey = getNestedString(parsedTts, [providerId, "apiKey"]);
  const resolvedApiKey = getNestedString(resolvedTts, [providerId, "apiKey"]);
  const configEnv = getConfigEnv(parsedRoot);
  const envKey = envKeys.find((key) => isNonEmptyString(configEnv[key]));
  const processEnvKey = envKeys.find((key) => isNonEmptyString(process.env[key]));
  const talkApiKey = providerId === "elevenlabs"
    ? getNestedString(parsedTalk, ["apiKey"])
    : null;
  const runtimeDetected = providerId === "openai"
    ? status.hasOpenAIKey === true
    : status.hasElevenLabsKey === true;

  if (parsedApiKey || resolvedApiKey) {
    return {
      configured: true,
      authState: "ready",
      authLabel: "Ready",
      authSource: "Using a key saved in TTS config.",
      authNote: providerId === "elevenlabs" && talkApiKey
        ? "Talk Mode also has its own ElevenLabs key."
        : null,
      authLocation: "config-tts",
      canManageKey: true,
      canRemoveKey: true,
      removeMode: "config-tts",
    };
  }

  if (envKey) {
    return {
      configured: true,
      authState: "ready",
      authLabel: "Ready",
      authSource: `Using ${envKey} from Mission Control config.`,
      authNote: providerId === "elevenlabs" && talkApiKey
        ? "Talk Mode also has its own ElevenLabs key."
        : null,
      authLocation: "config-env",
      canManageKey: true,
      canRemoveKey: true,
      removeMode: "config-env",
      envKey,
    };
  }

  if (processEnvKey) {
    return {
      configured: true,
      authState: "external",
      authLabel: "Runtime key",
      authSource: `Detected ${processEnvKey} from the server environment.`,
      authNote: "This key is managed outside Mission Control. Saving a key here will override TTS locally.",
      authLocation: "process-env",
      canManageKey: true,
      canRemoveKey: false,
      envKey: processEnvKey,
    };
  }

  if (runtimeDetected) {
    return {
      configured: true,
      authState: "external",
      authLabel: "Gateway detected",
      authSource: "The gateway reports that this provider already has a usable key.",
      authNote: providerId === "elevenlabs" && talkApiKey
        ? "Talk Mode also has its own ElevenLabs key."
        : "The source was not exposed to Mission Control.",
      authLocation: "runtime",
      canManageKey: true,
      canRemoveKey: false,
    };
  }

  if (providerId === "elevenlabs" && talkApiKey) {
    return {
      configured: false,
      authState: "missing",
      authLabel: "Needs TTS key",
      authSource: "Talk Mode has an ElevenLabs key, but TTS is not using it.",
      authNote: "Save a TTS key below if you want ElevenLabs available in the TTS provider list.",
      authLocation: "missing",
      canManageKey: true,
      canRemoveKey: false,
    };
  }

  return {
    configured: false,
    authState: "missing",
    authLabel: "Needs TTS key",
    authSource: null,
    authNote: null,
    authLocation: "missing",
    canManageKey: true,
    canRemoveKey: false,
  };
}

function buildAudioProviderPatch(
  provider: AudioProviderKeyTarget,
  apiKey: string,
): Record<string, unknown> {
  return {
    messages: {
      tts: {
        [provider]: {
          apiKey,
        },
      },
    },
  };
}

function removeEnvKeyFromConfig(
  parsedRoot: Record<string, unknown>,
  envKey: string,
): Record<string, unknown> {
  const envBlock = isRecord(parsedRoot.env)
    ? { ...(parsedRoot.env as Record<string, unknown>) }
    : {};
  const varsBlock = isRecord(envBlock.vars)
    ? { ...(envBlock.vars as Record<string, unknown>) }
    : null;

  delete envBlock[envKey];
  if (varsBlock) {
    delete varsBlock[envKey];
    if (Object.keys(varsBlock).length > 0) {
      envBlock.vars = varsBlock;
    } else {
      delete envBlock.vars;
    }
  }

  return { env: envBlock };
}

function sanitizeRecord(record: Record<string, unknown> | undefined): Record<string, unknown> {
  return record ? { ...record } : {};
}

function sanitizeTtsConfig(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = sanitizeRecord(record);
  for (const provider of ["openai", "elevenlabs"]) {
    const providerConfig = isRecord(next[provider]) ? { ...next[provider] } : null;
    if (providerConfig && "apiKey" in providerConfig) {
      delete providerConfig.apiKey;
      next[provider] = providerConfig;
    }
  }
  return next;
}

function sanitizeTalkConfig(record: Record<string, unknown> | undefined): Record<string, unknown> {
  const next = sanitizeRecord(record);
  if ("apiKey" in next) {
    delete next.apiKey;
  }
  return next;
}

function emptyAudioPayload(warning: string) {
  return {
    status: {
      enabled: false,
      auto: "off",
      provider: "",
    },
    providers: {
      providers: [],
      active: "",
    },
    config: {
      tts: { resolved: {}, parsed: null },
      talk: { resolved: {}, parsed: null },
      audioUnderstanding: { resolved: {}, parsed: null },
    },
    prefs: null,
    configHash: null,
    warning,
    degraded: true,
  };
}

/**
 * GET /api/audio - Returns TTS status, providers, and config.
 *
 * Query: scope=status (default) | providers | stream
 *        path=<filepath>  (required for scope=stream)
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") || "status";

  try {
    // Stream an audio file for playback
    if (scope === "stream") {
      const filePath = searchParams.get("path") || "";
      if (!filePath) {
        return NextResponse.json({ error: "path required" }, { status: 400 });
      }
      // Security: only allow temp directory audio files
      if (!filePath.startsWith("/tmp/") && !filePath.includes("/T/tts-") && !filePath.includes("/tmp/")) {
        return NextResponse.json({ error: "Path not allowed" }, { status: 403 });
      }
      try {
        const info = await stat(filePath);
        const ext = extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || "audio/mpeg";
        const buffer = await readFile(filePath);
        return new NextResponse(buffer, {
          status: 200,
          headers: {
            "Content-Type": contentType,
            "Content-Length": info.size.toString(),
            "Cache-Control": "no-cache",
          },
        });
      } catch {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
    }

    if (scope === "providers") {
      const providers = await gatewayCall<Record<string, unknown>>(
        "tts.providers",
        undefined,
        10000
      );
      return NextResponse.json(providers);
    }

    // Default: full status + providers + config
    const [status, providers, configData] = await Promise.all([
      gatewayCall<Record<string, unknown>>("tts.status", undefined, 10000),
      gatewayCall<Record<string, unknown>>("tts.providers", undefined, 10000),
      fetchConfig(10000),
    ]);

    // Extract relevant config sections
    const resolved = configData.resolved || {};
    const parsed = configData.parsed || {};

    const resolvedMessages = (resolved.messages || {}) as Record<string, unknown>;
    const resolvedTts = (resolvedMessages.tts || {}) as Record<string, unknown>;
    const resolvedTalk = (resolved.talk || {}) as Record<string, unknown>;
    const resolvedTools = (resolved.tools || {}) as Record<string, unknown>;
    const resolvedMedia = (resolvedTools.media || {}) as Record<string, unknown>;
    const resolvedAudio = (resolvedMedia.audio || {}) as Record<string, unknown>;

    const parsedMessages = (parsed.messages || {}) as Record<string, unknown>;
    const parsedTts = parsedMessages.tts as Record<string, unknown> | undefined;
    const parsedTalk = parsed.talk as Record<string, unknown> | undefined;
    const parsedMedia = ((parsed.tools || {}) as Record<string, unknown>).media as
      | Record<string, unknown>
      | undefined;
    const providerList = Array.isArray(providers.providers)
      ? providers.providers
      : [];
    const enrichedProviders = providerList
      .filter(isRecord)
      .map((provider) => {
        const id = String(provider.id || "");
        const auth = buildProviderKeyState(
          id,
          status,
          parsed,
          parsedTts,
          resolvedTts,
          parsedTalk,
        );
        const effectiveAuth = !auth.configured && provider.configured === true
          ? {
              ...auth,
              configured: true,
              authState: "external" as const,
              authLabel: "Gateway detected",
              authSource: "The gateway reports that this provider is ready, but did not expose the key source.",
              authNote: auth.authNote,
              authLocation: "runtime" as const,
            }
          : auth;
        const models = Array.isArray(provider.models)
          ? provider.models.map((entry) => String(entry))
          : [];
        const voices = Array.isArray(provider.voices)
          ? provider.voices.map((entry) => String(entry))
          : undefined;
        return {
          ...provider,
          id,
          name: String(provider.name || id),
          configured: effectiveAuth.configured,
          models,
          voices,
          supportsApiKey: effectiveAuth.canManageKey,
          authState: effectiveAuth.authState,
          authLabel: effectiveAuth.authLabel,
          authSource: effectiveAuth.authSource,
          authNote: effectiveAuth.authNote,
          authLocation: effectiveAuth.authLocation,
          canManageKey: effectiveAuth.canManageKey,
          canRemoveKey: effectiveAuth.canRemoveKey,
          removeMode: effectiveAuth.removeMode || null,
          envKey: effectiveAuth.envKey || null,
        };
      });

    // Read TTS user preferences if available
    let prefs: Record<string, unknown> | null = null;
    const prefsPath = (status.prefsPath as string) || "";
    if (prefsPath) {
      try {
        const raw = await readFile(prefsPath, "utf-8");
        prefs = JSON.parse(raw);
      } catch {
        // prefs file may not exist
      }
    }

    return NextResponse.json({
      status,
      providers: {
        ...providers,
        providers: enrichedProviders,
      },
      config: {
        tts: {
          resolved: sanitizeTtsConfig(resolvedTts),
          parsed: parsedTts ? sanitizeTtsConfig(parsedTts) : null,
        },
        talk: {
          resolved: sanitizeTalkConfig(resolvedTalk),
          parsed: parsedTalk ? sanitizeTalkConfig(parsedTalk) : null,
        },
        audioUnderstanding: {
          resolved: resolvedAudio,
          parsed: parsedMedia || null,
        },
      },
      prefs,
      configHash: configData.hash || null,
    });
  } catch (err) {
    console.error("Audio API GET error:", err);
    return NextResponse.json(emptyAudioPayload(String(err)));
  }
}

/**
 * POST /api/audio - Audio/TTS management actions.
 *
 * Body:
 *   { action: "enable" }
 *   { action: "disable" }
 *   { action: "set-provider", provider: "openai" | "elevenlabs" | "edge" }
 *   { action: "set-provider-key", provider: "openai" | "elevenlabs", apiKey: "..." }
 *   { action: "remove-provider-key", provider: "openai" | "elevenlabs", mode?: "config-tts" | "config-env", envKey?: "..." }
 *   { action: "test", text: "Hello world" }
 *   { action: "update-config", section: "tts" | "talk", config: { ... } }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      case "set-auto-mode": {
        // Set auto-TTS mode via config patch (most reliable method)
        const mode = body.mode as string;
        if (!["off", "always", "inbound", "tagged"].includes(mode)) {
          return NextResponse.json(
            { error: `Invalid mode: ${mode}. Use off, always, inbound, or tagged.` },
            { status: 400 }
          );
        }
        try {
          const configData = await gatewayCall<Record<string, unknown>>(
            "config.get", undefined, 10000
          );
          const hash = configData.hash as string;
          await gatewayConfigPatch(
            { raw: JSON.stringify({ messages: { tts: { auto: mode } } }), baseHash: hash },
            15000,
          );
          return NextResponse.json({ ok: true, action, mode });
        } catch {
          return NextResponse.json(
            { ok: false, error: "Could not update auto-TTS mode. Is the gateway running?" },
            { status: 502 }
          );
        }
      }

      case "enable":
      case "disable": {
        // Try RPC first, fall back to config patch
        try {
          const result = await gatewayCall<Record<string, unknown>>(
            action === "enable" ? "tts.enable" : "tts.disable",
            undefined,
            8000
          );
          return NextResponse.json({ ok: true, action, ...result });
        } catch {
          // Fallback: patch config directly
          try {
            const configData = await gatewayCall<Record<string, unknown>>(
              "config.get", undefined, 10000
            );
            const hash = configData.hash as string;
            const auto = action === "enable" ? "always" : "off";
            await gatewayConfigPatch(
              { raw: JSON.stringify({ messages: { tts: { auto } } }), baseHash: hash },
              15000,
            );
            return NextResponse.json({ ok: true, action, fallback: true });
          } catch {
            return NextResponse.json(
              { ok: false, error: "Could not reach the gateway. Make sure it is running." },
              { status: 502 }
            );
          }
        }
      }

      case "set-provider": {
        const provider = body.provider as string;
        if (!provider) {
          return NextResponse.json(
            { error: "provider is required" },
            { status: 400 }
          );
        }
        try {
          const result = await gatewayCall<Record<string, unknown>>(
            "tts.setProvider",
            { provider },
            10000
          );
          return NextResponse.json({ ok: true, action, provider, ...result });
        } catch {
          // Fallback: patch config
          try {
            const configData = await gatewayCall<Record<string, unknown>>(
              "config.get", undefined, 10000
            );
            const hash = configData.hash as string;
            await gatewayConfigPatch(
              { raw: JSON.stringify({ messages: { tts: { provider } } }), baseHash: hash },
              15000,
            );
            return NextResponse.json({ ok: true, action, provider, fallback: true });
          } catch {
            return NextResponse.json(
              { ok: false, error: "Could not set provider. Is the gateway running?" },
              { status: 502 }
            );
          }
        }
      }

      case "generate-phrase": {
        // Just generate a personalized phrase (no TTS conversion)
        const phrase = await generateTestPhrase();
        return NextResponse.json({ ok: true, phrase });
      }

      case "set-provider-key": {
        const provider = String(body.provider || "").trim().toLowerCase() as AudioProviderKeyTarget;
        const apiKey = String(body.apiKey || "").trim();
        if (provider !== "openai" && provider !== "elevenlabs") {
          return NextResponse.json(
            { error: "provider must be openai or elevenlabs" },
            { status: 400 }
          );
        }
        if (!apiKey) {
          return NextResponse.json(
            { error: "apiKey is required" },
            { status: 400 }
          );
        }

        try {
          await patchConfig(buildAudioProviderPatch(provider, apiKey));
          return NextResponse.json({ ok: true, action, provider, location: "config-tts" });
        } catch {
          return NextResponse.json(
            { ok: false, error: `Could not save ${provider} API key. Is the gateway running?` },
            { status: 502 }
          );
        }
      }

      case "remove-provider-key": {
        const provider = String(body.provider || "").trim().toLowerCase() as AudioProviderKeyTarget;
        const mode = String(body.mode || "").trim().toLowerCase();
        const envKey = String(body.envKey || "").trim();
        if (provider !== "openai" && provider !== "elevenlabs") {
          return NextResponse.json(
            { error: "provider must be openai or elevenlabs" },
            { status: 400 }
          );
        }
        if (mode !== "config-tts" && mode !== "config-env") {
          return NextResponse.json(
            { error: "mode must be config-tts or config-env" },
            { status: 400 }
          );
        }

        try {
          if (mode === "config-tts") {
            await patchConfig({
              messages: {
                tts: {
                  [provider]: {
                    apiKey: null,
                  },
                },
              },
            });
          } else {
            if (!envKey) {
              return NextResponse.json(
                { error: "envKey is required when removing a config env key" },
                { status: 400 }
              );
            }
            const configData = await fetchConfig(10000);
            await patchConfig(removeEnvKeyFromConfig(configData.parsed, envKey));
          }
          return NextResponse.json({ ok: true, action, provider, mode });
        } catch {
          return NextResponse.json(
            { ok: false, error: `Could not remove the saved ${provider} key. Is the gateway running?` },
            { status: 502 }
          );
        }
      }

      case "test": {
        // Keep voice testing fast and deterministic; avoid agent round-trips here.
        const textRaw = typeof body.text === "string" ? body.text : "";
        const text = textRaw.trim() || "This is a voice sample for OpenClaw.";
        const providerRaw = typeof body.provider === "string" ? body.provider.trim().toLowerCase() : "";
        const voiceRaw = typeof body.voice === "string" ? body.voice.trim() : "";
        const modelRaw = typeof body.model === "string" ? body.model.trim() : "";

        // Gateway tts.convert currently reads provider/voice/model overrides from [[tts:...]] directives in text.
        const directiveParts: string[] = [];
        if (providerRaw === "openai" || providerRaw === "elevenlabs" || providerRaw === "edge") {
          directiveParts.push(`provider=${providerRaw}`);
        }
        if (voiceRaw) {
          // ElevenLabs expects voiceId; OpenAI/Edge use voice.
          directiveParts.push(
            providerRaw === "elevenlabs" ? `voiceId=${voiceRaw}` : `voice=${voiceRaw}`
          );
        }
        if (modelRaw) {
          directiveParts.push(`model=${modelRaw}`);
        }
        const textWithOverrides = directiveParts.length > 0
          ? `[[tts:${directiveParts.join(" ")}]] ${text}`
          : text;
        const params: Record<string, unknown> = { text: textWithOverrides };

        try {
          const result = await gatewayCall<Record<string, unknown>>(
            "tts.convert",
            params,
            30000
          );
          return NextResponse.json({ ok: true, action, text, ...result });
        } catch {
          return NextResponse.json(
            { ok: false, error: "TTS generation failed. Check that the gateway is running and the provider has a valid API key." },
            { status: 502 }
          );
        }
      }

      case "update-config": {
        const section = body.section as string;
        const config = body.config as Record<string, unknown>;
        if (!section || !config) {
          return NextResponse.json(
            { error: "section and config required" },
            { status: 400 }
          );
        }

        try {
          const configData = await gatewayCall<Record<string, unknown>>(
            "config.get", undefined, 10000
          );
          const hash = configData.hash as string;

          let patchRaw: string;
          if (section === "tts") {
            patchRaw = JSON.stringify({ messages: { tts: config } });
          } else if (section === "talk") {
            patchRaw = JSON.stringify({ talk: config });
          } else if (section === "audio") {
            patchRaw = JSON.stringify({ tools: { media: { audio: config } } });
          } else {
            return NextResponse.json(
              { error: `Unknown section: ${section}` },
              { status: 400 }
            );
          }

          await gatewayConfigPatch(
            { raw: patchRaw, baseHash: hash },
            15000,
          );
          return NextResponse.json({ ok: true, action, section });
        } catch {
          return NextResponse.json(
            { ok: false, error: `Could not update ${section} config. Is the gateway running?` },
            { status: 502 }
          );
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("Audio API POST error:", err);
    // Bug fix 2026-08-16: a malformed/empty JSON body throws a SyntaxError from
    // `request.json()`. That is a client error, not an internal failure.
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${err.message}` },
        { status: 400 },
      );
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
