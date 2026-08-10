"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, ExternalLink, Key, Loader2, Sparkles } from "lucide-react";
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

  // "I have a subscription" — the paste-token path some providers support
  // instead of an API key. First-class, not buried behind a CLI disclosure:
  // it never shows a terminal command, just a token field.
  const [authMode, setAuthMode] = useState<"api-key" | "subscription">("api-key");
  const [subToken, setSubToken] = useState("");
  const [subSaving, setSubSaving] = useState(false);
  const [subVerified, setSubVerified] = useState(false);
  const [subError, setSubError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/onboarding/model-auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.providers)) setProviders(data.providers);
        if (typeof data?.defaultModel === "string") setExistingDefault(data.defaultModel);
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

  /* Already configured? Offer the fast path. */
  const alreadyConfigured =
    Boolean(existingDefault) && !verified && !subVerified && !apiKey && !subToken;
  const supportsSubscription = Boolean(activeProvider?.authMethods.includes("paste-token"));

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
          Paste an API key — no terminal needed. We validate it live and pick a great default model.
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
          {(["api-key", "subscription"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setAuthMode(mode)}
              disabled={validating || saving || subSaving}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-all duration-200",
                authMode === mode
                  ? "bg-card text-foreground shadow-sm"
                  : "text-fg-subtle hover:text-fg-secondary",
              )}
            >
              {mode === "api-key" ? "API key" : "I have a Claude subscription"}
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

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onSkip} className={secondaryBtnClass}>
          Skip for now
        </button>
        {verified || subVerified ? (
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
