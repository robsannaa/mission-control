"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  ExternalLink,
  Key,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getFriendlyModelName } from "@/lib/model-metadata";
import { Celebration } from "./celebration";
import {
  cardClass,
  inputClass,
  labelClass,
  primaryBtnClass,
  secondaryBtnClass,
  type ProviderCatalogEntry,
} from "./types";

type Model = { id: string; name: string };

/** Latest recommended model per provider — auto-selected after key validation. */
const ADVISED_MODELS: Record<string, string> = {
  openai: "openai/gpt-5.4",
  anthropic: "anthropic/claude-sonnet-4-6",
  openrouter: "openrouter/anthropic/claude-sonnet-4-6",
};

function isAdvisedModel(provider: string, modelId: string): boolean {
  const advised = ADVISED_MODELS[provider];
  if (!advised) return false;
  return modelId === advised || modelId.endsWith(advised.replace(/^[^/]+\//, ""));
}

/* ── Local provider metadata (client-side mirror of src/lib/provider-auth.ts
 * LOCAL_PROVIDER_DEFAULTS — kept as plain constants here rather than
 * importing the server lib into a client component). ── */

type LocalKind = "ollama" | "lmstudio" | "custom";

const LOCAL_KIND_LABEL: Record<LocalKind, string> = {
  ollama: "Ollama",
  lmstudio: "LM Studio",
  custom: "Custom",
};

const LOCAL_KIND_DEFAULT_BASE_URL: Record<LocalKind, string> = {
  ollama: "http://127.0.0.1:11434",
  lmstudio: "http://127.0.0.1:1234/v1",
  custom: "",
};

const LOCAL_KIND_HINT: Record<LocalKind, string> = {
  ollama: "Auto-detected on this machine's default port. No key, no cloud account.",
  lmstudio: "Load a model in LM Studio, start its local server, then connect here.",
  custom: "Any OpenAI-compatible server — vLLM, LiteLLM, a proxy, or your own.",
};

/** Models with "embed" in the name are for retrieval, not chat — never the
 * default pick even when they're the only thing installed. */
function sortLocalModels(models: Model[]): Model[] {
  return [...models].sort((a, b) => {
    const aEmbed = /embed/i.test(a.id) ? 1 : 0;
    const bEmbed = /embed/i.test(b.id) ? 1 : 0;
    return aEmbed - bEmbed;
  });
}

export function StepModel({
  onDone,
  onSkip,
}: {
  onDone: (meta?: Record<string, unknown>) => void;
  onSkip: () => void;
}) {
  const [providers, setProviders] = useState<ProviderCatalogEntry[]>([]);
  const [existingDefault, setExistingDefault] = useState<string | null>(null);
  const [providerId, setProviderId] = useState("openrouter");
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validateSeq = useRef(0);

  // Top-level entry point. "subscription" is a convenience preset into the
  // same Cloud flow below (anthropic + the paste-token toggle) — Cloud and
  // Subscription behave exactly as before either way.
  const [mode, setMode] = useState<"cloud" | "local">("cloud");

  // "I have a subscription" — the paste-token path some providers support
  // instead of an API key. First-class, not buried behind a CLI disclosure:
  // it never shows a terminal command, just a token field.
  const [authMode, setAuthMode] = useState<"api-key" | "subscription">("api-key");
  const [subToken, setSubToken] = useState("");
  const [subSaving, setSubSaving] = useState(false);
  const [subVerified, setSubVerified] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  // ── Local provider state ──
  const [hasOllama, setHasOllama] = useState(false);
  const [hasLmStudio, setHasLmStudio] = useState(false);
  const [localKind, setLocalKind] = useState<LocalKind>("ollama");
  const [localBaseUrl, setLocalBaseUrl] = useState(LOCAL_KIND_DEFAULT_BASE_URL.ollama);
  const [localProviderId, setLocalProviderId] = useState("local");
  const [localApiStyle, setLocalApiStyle] = useState<"openai-completions" | "openai-responses">(
    "openai-completions",
  );
  const [localProbing, setLocalProbing] = useState(false);
  const [localProbed, setLocalProbed] = useState(false);
  const [localModels, setLocalModels] = useState<Model[]>([]);
  const [localSelectedModel, setLocalSelectedModel] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSaving, setLocalSaving] = useState(false);
  const [localVerified, setLocalVerified] = useState(false);
  const localProbeSeq = useRef(0);

  useEffect(() => {
    fetch("/api/onboarding/model-auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.providers)) setProviders(data.providers);
        if (typeof data?.defaultModel === "string") setExistingDefault(data.defaultModel);
        if (data?.hasOllama === true) setHasOllama(true);
        if (data?.hasLmStudio === true) setHasLmStudio(true);
      })
      .catch(() => {});
  }, []);

  const activeProvider = providers.find((p) => p.id === providerId);

  const resetKeyState = useCallback(() => {
    setValidated(false);
    setModels([]);
    setSelectedModel("");
    setVerified(false);
    setError(null);
  }, []);

  const resetSubscriptionState = useCallback(() => {
    setSubToken("");
    setSubSaving(false);
    setSubVerified(false);
    setSubError(null);
  }, []);

  const validateKey = useCallback(
    async (key: string) => {
      const trimmed = key.trim();
      if (!trimmed) return;
      const seq = ++validateSeq.current;
      setValidating(true);
      setError(null);
      try {
        const res = await fetch("/api/onboarding/model-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "validate-key", provider: providerId, token: trimmed }),
        });
        const data = await res.json();
        if (seq !== validateSeq.current) return;
        if (!data.ok) {
          setError(data.error || "Invalid API key.");
          return;
        }
        setValidated(true);

        // Consume the models API (owned elsewhere) for the live model list
        const modelsRes = await fetch("/api/models", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list-models", provider: providerId, token: trimmed }),
        });
        const modelsData = await modelsRes.json();
        if (seq !== validateSeq.current) return;
        if (modelsData.ok && Array.isArray(modelsData.models)) {
          const sorted = [...(modelsData.models as Model[])].sort((a, b) =>
            isAdvisedModel(providerId, a.id) ? -1 : isAdvisedModel(providerId, b.id) ? 1 : 0,
          );
          setModels(sorted);
          const preferred = sorted.find((m) => isAdvisedModel(providerId, m.id)) || sorted[0];
          if (preferred) setSelectedModel(preferred.id);
        }
      } catch {
        if (seq === validateSeq.current) setError("Network error. Please try again.");
      } finally {
        if (seq === validateSeq.current) setValidating(false);
      }
    },
    [providerId],
  );

  const handleSave = useCallback(async () => {
    if (!validated || !selectedModel || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/model-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-api-key",
          provider: providerId,
          token: apiKey.trim(),
          model: selectedModel,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to save credentials.");
        return;
      }

      // Honest verification: the route already polled `models status` after
      // saving, so `authenticated` means OpenClaw itself can use the
      // credential — not just that the write didn't throw.
      if (!data.authenticated) {
        setError(
          "The key was saved, but OpenClaw hasn't picked it up yet. The gateway may still be restarting — try again in a few seconds.",
        );
        return;
      }
      setVerified(true);
    } catch {
      setError("Network error while saving. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [validated, selectedModel, saving, providerId, apiKey]);

  const handleSubscriptionConnect = useCallback(async () => {
    const trimmed = subToken.trim();
    if (!trimmed || subSaving) return;
    setSubSaving(true);
    setSubError(null);
    try {
      const model = ADVISED_MODELS[providerId] || "";
      const res = await fetch("/api/onboarding/model-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "paste-token", provider: providerId, token: trimmed, model }),
      });
      const data = await res.json();
      if (!data.ok) {
        setSubError(data.error || "Could not save the subscription token.");
        return;
      }
      if (!data.authenticated) {
        setSubError(
          "The token was saved, but OpenClaw hasn't picked it up yet. The gateway may still be restarting — try again in a few seconds.",
        );
        return;
      }
      setSubVerified(true);
    } catch {
      setSubError("Network error while connecting. Please try again.");
    } finally {
      setSubSaving(false);
    }
  }, [subToken, subSaving, providerId]);

  // ── Local provider handlers ──

  const probeLocal = useCallback(async (kind: LocalKind, baseUrl: string) => {
    const trimmed = baseUrl.trim();
    if (!trimmed) return;
    const seq = ++localProbeSeq.current;
    setLocalProbing(true);
    setLocalProbed(false);
    setLocalError(null);
    setLocalModels([]);
    setLocalSelectedModel("");
    try {
      const res = await fetch("/api/onboarding/model-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "probe-local", kind, baseUrl: trimmed }),
      });
      const data = await res.json();
      if (seq !== localProbeSeq.current) return;
      if (!data.ok) {
        setLocalError(
          data.error ||
            `Could not reach a ${LOCAL_KIND_LABEL[kind]} server at ${trimmed}. Make sure it's running.`,
        );
        return;
      }
      setLocalProbed(true);
      const list = sortLocalModels(Array.isArray(data.models) ? data.models : []);
      setLocalModels(list);
      if (list.length > 0) setLocalSelectedModel(list[0].id);
      else if (data.listError) {
        setLocalError("Server is reachable, but no models are loaded yet.");
      }
    } catch {
      if (seq === localProbeSeq.current) {
        setLocalError("Network error while checking the server. Please try again.");
      }
    } finally {
      if (seq === localProbeSeq.current) setLocalProbing(false);
    }
  }, []);

  const selectLocalKind = useCallback(
    (kind: LocalKind) => {
      setLocalKind(kind);
      setLocalProviderId(kind === "custom" ? "local" : kind);
      setLocalApiStyle(kind === "lmstudio" ? "openai-responses" : "openai-completions");
      setLocalVerified(false);
      setLocalError(null);
      setLocalModels([]);
      setLocalSelectedModel("");
      setLocalProbed(false);
      const defaultUrl = LOCAL_KIND_DEFAULT_BASE_URL[kind];
      setLocalBaseUrl(defaultUrl);
      if (kind !== "custom" && defaultUrl) void probeLocal(kind, defaultUrl);
    },
    [probeLocal],
  );

  // Auto-probe once when the user first lands on the Local tab with Ollama
  // pre-selected — this is the "auto-detect" part of the ask.
  const autoProbedRef = useRef(false);
  useEffect(() => {
    if (mode !== "local" || autoProbedRef.current) return;
    autoProbedRef.current = true;
    void probeLocal(localKind, localBaseUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const handleConnectLocal = useCallback(async () => {
    if (!localSelectedModel || localSaving) return;
    setLocalSaving(true);
    setLocalError(null);
    try {
      const res = await fetch("/api/onboarding/model-auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-local",
          kind: localKind,
          providerId: localProviderId,
          baseUrl: localBaseUrl.trim(),
          model: localSelectedModel,
          apiStyle: localApiStyle,
          timeoutSeconds: 120,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setLocalError(data.error || "Failed to connect the local server.");
        return;
      }
      setLocalVerified(true);
    } catch {
      setLocalError("Network error while connecting. Please try again.");
    } finally {
      setLocalSaving(false);
    }
  }, [localKind, localProviderId, localBaseUrl, localSelectedModel, localApiStyle, localSaving]);

  /* Already configured? Offer the fast path. */
  const alreadyConfigured =
    Boolean(existingDefault) &&
    !verified &&
    !subVerified &&
    !localVerified &&
    !apiKey &&
    !subToken &&
    !localSaving;
  const supportsSubscription = Boolean(activeProvider?.authMethods.includes("paste-token"));

  function switchMode(next: "cloud" | "local") {
    setMode(next);
    setError(null);
  }

  function jumpToSubscription() {
    setMode("cloud");
    setProviderId("anthropic");
    setAuthMode("subscription");
    resetKeyState();
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="space-y-0.5">
        <div className="mb-1 flex items-center gap-2">
          <Key className="h-3.5 w-3.5 text-fg-subtle dark:text-muted-foreground" />
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Connect an AI model
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Paste an API key, connect a subscription, or point at a model already running on this
          machine — no paid service required.
        </p>
      </div>

      {alreadyConfigured && (
        <div className={cardClass}>
          <p className="text-xs leading-relaxed text-fg-secondary dark:text-muted-foreground">
            A model is already configured:{" "}
            <span className="font-mono text-foreground dark:text-fg-secondary">
              {getFriendlyModelName(existingDefault!)}
            </span>
          </p>
          <button
            type="button"
            onClick={() => onDone({ model: existingDefault, reused: true })}
            className={cn(primaryBtnClass, "mt-3")}
          >
            Keep it and continue
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Top-level chooser: Cloud | Subscription | Local */}
      <div className="inline-flex rounded-full border border-border bg-muted dark:bg-sidebar p-0.5">
        <button
          type="button"
          onClick={() => switchMode("cloud")}
          disabled={validating || saving || subSaving || localSaving}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200",
            mode === "cloud" && authMode === "api-key"
              ? "bg-card text-foreground shadow-sm"
              : "text-fg-subtle hover:text-fg-secondary",
          )}
        >
          Cloud
        </button>
        <button
          type="button"
          onClick={jumpToSubscription}
          disabled={validating || saving || subSaving || localSaving}
          className={cn(
            "rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200",
            mode === "cloud" && authMode === "subscription"
              ? "bg-card text-foreground shadow-sm"
              : "text-fg-subtle hover:text-fg-secondary",
          )}
        >
          Subscription
        </button>
        <button
          type="button"
          onClick={() => switchMode("local")}
          disabled={validating || saving || subSaving || localSaving}
          className={cn(
            "flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200",
            mode === "local"
              ? "bg-card text-foreground shadow-sm"
              : "text-fg-subtle hover:text-fg-secondary",
          )}
        >
          Local
          {(hasOllama || hasLmStudio) && mode !== "local" && (
            <span className="h-1.5 w-1.5 rounded-full bg-success" />
          )}
        </button>
      </div>

      {mode === "cloud" && (
        <>
          {/* Provider cards */}
          <div className="grid grid-cols-3 gap-2">
            {providers.map((p) => {
              const isSelected = providerId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    setProviderId(p.id);
                    setApiKey("");
                    resetKeyState();
                    setAuthMode("api-key");
                    resetSubscriptionState();
                  }}
                  disabled={validating || saving}
                  className={cn(
                    "group relative flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3.5 transition-all duration-200",
                    isSelected
                      ? "border-border-strong dark:border-border/60 bg-foreground/[0.04] dark:bg-muted/[0.07] shadow-sm"
                      : "border-border bg-card dark:bg-sidebar hover:border-border-strong dark:hover:border-border hover:-translate-y-px hover:shadow-sm",
                    (validating || saving) && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {isSelected && (
                    <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-success" />
                  )}
                  <span
                    className={cn(
                      "text-xs font-semibold transition-colors",
                      isSelected
                        ? "text-foreground"
                        : "text-muted-foreground dark:text-fg-subtle",
                    )}
                  >
                    {p.label}
                  </span>
                </button>
              );
            })}
          </div>

          {activeProvider && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {activeProvider.hint}{" "}
              {authMode === "api-key" && (
                <a
                  href={activeProvider.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:opacity-90"
                >
                  Get your key
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </p>
          )}

          {/* API key vs. subscription — first-class, no CLI commands either way */}
          {supportsSubscription && (
            <div className="inline-flex rounded-full border border-border bg-muted dark:bg-sidebar p-0.5">
              {(["api-key", "subscription"] as const).map((am) => (
                <button
                  key={am}
                  type="button"
                  onClick={() => setAuthMode(am)}
                  disabled={validating || saving || subSaving}
                  className={cn(
                    "rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200",
                    authMode === am
                      ? "bg-card text-foreground shadow-sm"
                      : "text-fg-subtle hover:text-fg-secondary",
                  )}
                >
                  {am === "api-key" ? "API key" : "I have a Claude subscription"}
                </button>
              ))}
            </div>
          )}

          {/* Key input with instant validation */}
          {authMode === "api-key" && (
            <div className="space-y-1.5">
              <label className={labelClass}>{activeProvider?.label || "Provider"} API key</label>
              <div className="relative flex items-center gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    resetKeyState();
                  }}
                  onPaste={(e) => {
                    const pasted = e.clipboardData.getData("text").trim();
                    if (pasted) {
                      e.preventDefault();
                      setApiKey(pasted);
                      resetKeyState();
                      setTimeout(() => void validateKey(pasted), 0);
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !validated && !validating && apiKey.trim()) {
                      void validateKey(apiKey);
                    }
                  }}
                  placeholder={activeProvider?.placeholder || "sk-..."}
                  disabled={validating || saving}
                  className={cn(inputClass, "flex-1")}
                />
                {(validating || validated) && (
                  <div
                    className={cn(
                      "flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-all duration-300",
                      validating
                        ? "bg-muted dark:bg-secondary text-muted-foreground"
                        : "bg-success-bg text-success-fg ring-1 ring-success-border",
                    )}
                  >
                    {validating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    {validating ? "Checking" : "Verified"}
                  </div>
                )}
              </div>
              {error && (
                <p className="flex items-center gap-1.5 text-xs text-danger-fg">
                  <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-danger" />
                  {error}
                </p>
              )}
            </div>
          )}

          {/* Model picker */}
          {authMode === "api-key" && validated && models.length > 0 && (
            <div className="space-y-1.5 animate-in fade-in duration-300">
              <label className={labelClass}>Model</label>
              <select
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={saving}
                className={inputClass}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {getFriendlyModelName(m.id)}
                    {isAdvisedModel(providerId, m.id) ? "  (advised)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Subscription token — no API key, no terminal on this machine */}
          {authMode === "subscription" && (
            <div className="space-y-1.5">
              <label className={labelClass}>Setup token</label>
              <p className="text-xs leading-relaxed text-muted-foreground">
                On a machine where you&apos;re signed in to Claude Code, run{" "}
                <span className="font-mono text-foreground dark:text-fg-secondary">claude setup-token</span>{" "}
                and paste the result here. Needs a Claude Pro or Max plan.{" "}
                <a
                  href="https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:opacity-90"
                >
                  How to get a token
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              </p>
              <input
                type="password"
                value={subToken}
                onChange={(e) => {
                  setSubToken(e.target.value);
                  setSubVerified(false);
                  setSubError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && subToken.trim() && !subSaving) void handleSubscriptionConnect();
                }}
                placeholder="sk-ant-oat..."
                disabled={subSaving}
                className={inputClass}
              />
              {subError && (
                <p className="flex items-center gap-1.5 text-xs text-danger-fg">
                  <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-danger" />
                  {subError}
                </p>
              )}
            </div>
          )}

          {(verified || subVerified) && (
            <Celebration message="Model connected and verified. Your agent can think now!" />
          )}
        </>
      )}

      {mode === "local" && (
        <div className="space-y-4 animate-in fade-in duration-300">
          <div className="grid grid-cols-3 gap-2">
            {(["ollama", "lmstudio", "custom"] as const).map((kind) => {
              const isSelected = localKind === kind;
              const detected = kind === "ollama" ? hasOllama : kind === "lmstudio" ? hasLmStudio : false;
              return (
                <button
                  key={kind}
                  type="button"
                  onClick={() => selectLocalKind(kind)}
                  disabled={localProbing || localSaving}
                  className={cn(
                    "group relative flex flex-col items-center gap-1.5 rounded-xl border px-3 py-3.5 transition-all duration-200",
                    isSelected
                      ? "border-border-strong dark:border-border/60 bg-foreground/[0.04] dark:bg-muted/[0.07] shadow-sm"
                      : "border-border bg-card dark:bg-sidebar hover:border-border-strong dark:hover:border-border hover:-translate-y-px hover:shadow-sm",
                    (localProbing || localSaving) && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {isSelected && (
                    <span className="absolute top-2 right-2 h-1.5 w-1.5 rounded-full bg-success" />
                  )}
                  <span
                    className={cn(
                      "text-xs font-semibold transition-colors",
                      isSelected ? "text-foreground" : "text-muted-foreground dark:text-fg-subtle",
                    )}
                  >
                    {LOCAL_KIND_LABEL[kind]}
                  </span>
                  {detected && (
                    <span className="text-[10px] font-medium text-success-fg">Detected</span>
                  )}
                </button>
              );
            })}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">{LOCAL_KIND_HINT[localKind]}</p>

          <div className="space-y-1.5">
            <label className={labelClass}>Base URL</label>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={localBaseUrl}
                onChange={(e) => {
                  setLocalBaseUrl(e.target.value);
                  setLocalProbed(false);
                  setLocalModels([]);
                  setLocalSelectedModel("");
                  setLocalVerified(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && localBaseUrl.trim() && !localProbing) {
                    void probeLocal(localKind, localBaseUrl);
                  }
                }}
                placeholder={
                  localKind === "custom" ? "http://127.0.0.1:8000/v1" : LOCAL_KIND_DEFAULT_BASE_URL[localKind]
                }
                disabled={localProbing || localSaving}
                className={cn(inputClass, "flex-1 font-mono")}
              />
              <button
                type="button"
                onClick={() => void probeLocal(localKind, localBaseUrl)}
                disabled={!localBaseUrl.trim() || localProbing || localSaving}
                className={cn(secondaryBtnClass, "flex shrink-0 items-center gap-1.5")}
              >
                {localProbing ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {localProbing ? "Checking" : "Check"}
              </button>
            </div>
          </div>

          {localKind === "custom" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={labelClass}>Provider ID</label>
                <input
                  type="text"
                  value={localProviderId}
                  onChange={(e) => setLocalProviderId(e.target.value.trim().toLowerCase())}
                  placeholder="local"
                  disabled={localSaving}
                  className={cn(inputClass, "font-mono")}
                />
              </div>
              <div className="space-y-1.5">
                <label className={labelClass}>API style</label>
                <select
                  value={localApiStyle}
                  onChange={(e) =>
                    setLocalApiStyle(e.target.value === "openai-responses" ? "openai-responses" : "openai-completions")
                  }
                  disabled={localSaving}
                  className={inputClass}
                >
                  <option value="openai-completions">Chat completions</option>
                  <option value="openai-responses">Responses API</option>
                </select>
              </div>
            </div>
          )}

          {localError && (
            <p className="flex items-center gap-1.5 text-xs text-danger-fg">
              <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-danger" />
              {localError}
            </p>
          )}

          {localProbed && localModels.length > 0 && (
            <div className="space-y-1.5 animate-in fade-in duration-300">
              <label className={labelClass}>Model</label>
              <select
                value={localSelectedModel}
                onChange={(e) => setLocalSelectedModel(e.target.value)}
                disabled={localSaving}
                className={inputClass}
              >
                {localModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {getFriendlyModelName(m.id)}
                  </option>
                ))}
              </select>
              <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                <Server className="h-3 w-3 shrink-0" />
                Runs on this machine — no key sent anywhere, no cloud account needed.
              </p>
            </div>
          )}

          {localVerified && (
            <Celebration message="Local model connected. Your agent runs entirely on this machine!" />
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onSkip} className={secondaryBtnClass}>
          Skip for now
        </button>

        {mode === "local" ? (
          localVerified ? (
            <button
              type="button"
              onClick={() =>
                onDone({
                  provider: localProviderId,
                  model: localSelectedModel,
                  via: "local",
                })
              }
              className={primaryBtnClass}
            >
              Continue
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleConnectLocal()}
              disabled={!localProbed || !localSelectedModel || localSaving}
              className={primaryBtnClass}
            >
              {localSaving ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Connecting…
                </>
              ) : (
                <>
                  <Server className="h-3.5 w-3.5" />
                  Connect local model
                </>
              )}
            </button>
          )
        ) : verified || subVerified ? (
          <button
            type="button"
            onClick={() =>
              onDone({
                provider: providerId,
                model: verified ? selectedModel : ADVISED_MODELS[providerId] || null,
                via: verified ? "api-key" : "subscription",
              })
            }
            className={primaryBtnClass}
          >
            Continue
            <ChevronRight className="h-4 w-4" />
          </button>
        ) : authMode === "subscription" ? (
          <button
            type="button"
            onClick={handleSubscriptionConnect}
            disabled={!subToken.trim() || subSaving}
            className={primaryBtnClass}
          >
            {subSaving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Connecting…
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                Connect subscription
              </>
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleSave}
            disabled={!validated || !selectedModel || saving}
            className={primaryBtnClass}
          >
            {saving ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Save &amp; verify
                <ChevronRight className="h-4 w-4" />
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
