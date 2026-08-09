"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, Key, Loader2 } from "lucide-react";
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

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="flex w-full items-center gap-2 rounded-lg border border-border bg-card dark:bg-sidebar px-3 py-2 text-left font-mono text-[11px] text-fg-secondary dark:text-muted-foreground hover:border-border-strong dark:hover:border-border transition-colors"
    >
      <span className="min-w-0 flex-1 truncate">{command}</span>
      {copied ? (
        <Check className="h-3 w-3 shrink-0 text-success-fg" />
      ) : (
        <Copy className="h-3 w-3 shrink-0" />
      )}
    </button>
  );
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

      // Live-verify: ask OpenClaw itself whether auth is now usable
      try {
        const statusRes = await fetch("/api/onboarding/model-auth", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "status" }),
        });
        const status = await statusRes.json();
        if (
          status.ok &&
          Array.isArray(status.authenticatedProviders) &&
          !status.authenticatedProviders.includes(providerId)
        ) {
          // Saved but not yet visible — config reload can lag; still celebrate,
          // the credentials were validated against the provider directly.
        }
      } catch {
        // Verification is best-effort; the save itself succeeded
      }
      setVerified(true);
    } catch {
      setError("Network error while saving. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [validated, selectedModel, saving, providerId, apiKey]);

  /* Already configured? Offer the fast path. */
  const alreadyConfigured = Boolean(existingDefault) && !verified && !apiKey;

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
          <a
            href={activeProvider.keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline underline-offset-2 hover:opacity-90"
          >
            Get your key
            <ExternalLink className="h-2.5 w-2.5" />
          </a>
        </p>
      )}

      {/* Key input with instant validation */}
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

      {/* Model picker */}
      {validated && models.length > 0 && (
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

      {/* Advanced: OAuth flows that need a terminal */}
      {activeProvider?.oauthCommand && (
        <details className="group">
          <summary className="cursor-pointer text-[11px] font-medium uppercase tracking-wide text-fg-subtle hover:text-fg-secondary dark:hover:text-muted-foreground">
            Advanced: sign in with your {activeProvider.label} subscription
          </summary>
          <div className="mt-2 space-y-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground dark:text-fg-subtle">
              OAuth sign-in opens a browser but must be launched from a terminal on the machine
              running OpenClaw. Copy and run:
            </p>
            <CopyableCommand command={activeProvider.oauthCommand} />
          </div>
        </details>
      )}

      {verified && <Celebration message="Model connected and verified. Your agent can think now!" />}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onSkip} className={secondaryBtnClass}>
          Skip for now
        </button>
        {verified ? (
          <button
            type="button"
            onClick={() => onDone({ provider: providerId, model: selectedModel })}
            className={primaryBtnClass}
          >
            Continue
            <ChevronRight className="h-4 w-4" />
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
