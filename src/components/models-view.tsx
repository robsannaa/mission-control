"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Key,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";

import { getFriendlyModelName, getProviderDisplayName } from "@/lib/model-metadata";

/* ── Provider metadata ──────────────────────────── */

type Provider = {
  id: string;
  name: string;
  hint: string;
  keyPrefix: string;
  url: string;
};

// Static setup metadata (key prefixes, console URLs). This is an enrichment
// map and OFFLINE FALLBACK only — the provider list shown in the UI is
// derived from the gateway's models.authStatus whenever it is reachable.
const FALLBACK_PROVIDERS: Provider[] = [
  { id: "anthropic", name: "Anthropic", hint: "Claude models", keyPrefix: "sk-ant-", url: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", hint: "GPT & o-series", keyPrefix: "sk-", url: "https://platform.openai.com/api-keys" },
  { id: "openrouter", name: "OpenRouter", hint: "200+ models", keyPrefix: "sk-or-", url: "https://openrouter.ai/keys" },
];

type LiveAuthProvider = {
  provider: string;
  displayName: string;
  authenticated: boolean;
};

function findProvider(id: string, providers: Provider[] = FALLBACK_PROVIDERS): Provider | undefined {
  return providers.find((p) => p.id === id) ?? FALLBACK_PROVIDERS.find((p) => p.id === id);
}

/** Gateway-reported providers merged over the static catalog. */
function buildProviderList(live: LiveAuthProvider[] | null): Provider[] {
  if (!live || live.length === 0) return FALLBACK_PROVIDERS;
  const out = [...FALLBACK_PROVIDERS];
  for (const row of live) {
    if (out.some((p) => p.id === row.provider)) continue;
    out.push({
      id: row.provider,
      name: row.displayName || row.provider,
      hint: "Reported by the gateway",
      keyPrefix: "",
      url: "",
    });
  }
  return out;
}

/* ── Types ──────────────────────────────────────── */

type SummaryResponse = {
  defaults: { primary: string; fallbacks: string[] } | null;
  configuredProviders: string[];
  status: {
    auth: {
      providers: Array<{ provider: string; effective: { kind: string; detail: string } | null }>;
    };
  };
};

type ModelItem = { id: string; name: string };

type WizardStep = "pick" | "key" | "validating" | "pick-model" | "done";

type WizardState = {
  step: WizardStep;
  providerId: string | null;
  apiKey: string;
  error: string | null;
  models: ModelItem[];
  loadingModels: boolean;
};

type AgentFull = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  fallbackModels: string[];
  isDefault: boolean;
};

type AgentsResponse = {
  agents: AgentFull[];
  defaultModel: string;
  defaultFallbacks: string[];
};

/* ── All-provider model list (grouped) ─────────── */

type GroupedModel = {
  providerId: string;
  providerLabel: string;
  models: ModelItem[];
};

/* ── Shared atoms ────────────────────────────────── */

function StatusDot({ active, className }: { active: boolean; className?: string }) {
  return (
    <span className={cn("relative flex h-2.5 w-2.5 shrink-0", className)}>
      {active && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-40" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2.5 w-2.5 rounded-full",
          active ? "bg-emerald-400" : "bg-[#3d4752]"
        )}
      />
    </span>
  );
}

function ProviderAvatar({ name }: { name: string }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[#2c343d] bg-[#20252a] text-sm font-bold text-[#a8b0ba]">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

/* ── ModelList (for wizard & picker modals) ─────── */

function ModelList({
  models,
  loading,
  currentModel,
  onSelect,
}: {
  models: ModelItem[];
  loading: boolean;
  currentModel: string | null;
  onSelect: (id: string) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? models.filter((m) => {
        const q = query.toLowerCase();
        return (
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          getFriendlyModelName(m.id).toLowerCase().includes(q)
        );
      })
    : models;

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-14">
        <Loader2 className="h-6 w-6 animate-spin text-[#34d399]" />
        <p className="text-xs text-[#7a8591]">Loading available models...</p>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-14 text-center">
        <AlertCircle className="h-8 w-8 text-[#3d4752]" />
        <p className="text-sm text-[#a8b0ba]">No models found</p>
        <p className="text-xs text-[#7a8591]">The provider may not have returned a model list.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="sticky top-0 border-b border-[#2c343d] bg-[#171a1d] px-5 py-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#3d4752]" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models..."
            className="w-full rounded-lg border border-[#2c343d] bg-[#15191d] py-2 pl-9 pr-3 text-sm text-[#f5f7fa] placeholder-[#3d4752] focus:border-[#34d399]/40 focus:outline-none focus:ring-2 focus:ring-[#34d399]/20"
          />
        </div>
        <p className="mt-1.5 text-[11px] text-[#7a8591]">
          {filtered.length} model{filtered.length !== 1 ? "s" : ""}
        </p>
      </div>
      <div className="max-h-72 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="py-8 text-center text-xs text-[#7a8591]">No models match your search</p>
        ) : (
          <div className="p-2">
            {filtered.map((m) => {
              const friendlyName = getFriendlyModelName(m.id);
              const displayName = friendlyName !== m.id ? friendlyName : (m.name || m.id);
              const isActive = m.id === currentModel;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => void onSelect(m.id)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                    isActive ? "bg-[#34d399]/10" : "hover:bg-[#20252a]"
                  )}
                >
                  <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                    {isActive ? (
                      <Check className="h-4 w-4 text-[#34d399]" strokeWidth={2.5} />
                    ) : (
                      <div className="h-1.5 w-1.5 rounded-full bg-[#3d4752] transition-colors group-hover:bg-[#7a8591]" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm font-medium",
                        isActive ? "text-[#34d399]" : "text-[#f5f7fa]"
                      )}
                    >
                      {displayName}
                    </span>
                    {displayName !== m.id && (
                      <span className="block truncate font-mono text-[11px] text-[#7a8591]">
                        {m.id}
                      </span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── ModelSelect — dropdown for choosing a model from all providers ── */

function ModelSelect({
  value,
  onChange,
  groupedModels,
  loading,
  placeholder,
  allowDefault,
  disabled,
}: {
  value: string | null;
  onChange: (modelId: string | null) => void;
  groupedModels: GroupedModel[];
  loading: boolean;
  placeholder?: string;
  allowDefault?: boolean;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 40);
  }, [open]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  const allModels = groupedModels.flatMap((g) => g.models.map((m) => ({ ...m, providerId: g.providerId, providerLabel: g.providerLabel })));

  const filtered = query.trim()
    ? allModels.filter((m) => {
        const q = query.toLowerCase();
        return (
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          getFriendlyModelName(m.id).toLowerCase().includes(q) ||
          m.providerLabel.toLowerCase().includes(q)
        );
      })
    : allModels;

  // Group filtered results by provider
  const filteredGroups: GroupedModel[] = [];
  for (const g of groupedModels) {
    const models = filtered.filter((m) => m.providerId === g.providerId);
    if (models.length > 0) filteredGroups.push({ ...g, models });
  }

  const displayValue = value
    ? getFriendlyModelName(value)
    : allowDefault
    ? "Use default"
    : (placeholder ?? "Select a model");

  function handleSelect(modelId: string | null) {
    onChange(modelId);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "flex w-full items-center gap-2 rounded-lg border border-[#2c343d] bg-[#15191d] px-3 py-2 text-sm transition-colors",
          "hover:border-[#3d4752] focus:border-[#34d399]/40 focus:outline-none focus:ring-2 focus:ring-[#34d399]/20",
          "disabled:cursor-not-allowed disabled:opacity-50",
          open && "border-[#34d399]/40 ring-2 ring-[#34d399]/20"
        )}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[#34d399]" />
        ) : value ? (
          <span className="h-2 w-2 shrink-0 rounded-full bg-[#34d399]" />
        ) : null}
        <span className={cn("flex-1 truncate text-left", value ? "text-[#f5f7fa]" : "text-[#7a8591]")}>
          {loading ? "Loading models..." : displayValue}
        </span>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-[#7a8591] transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 max-h-80 overflow-hidden rounded-xl border border-[#2c343d] bg-[#171a1d] shadow-2xl">
          <div className="border-b border-[#2c343d] px-3 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-[#3d4752]" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models..."
                className="w-full rounded-md border border-[#2c343d] bg-[#15191d] py-1.5 pl-8 pr-2 text-xs text-[#f5f7fa] placeholder-[#3d4752] focus:outline-none"
              />
            </div>
          </div>
          <div className="overflow-y-auto" style={{ maxHeight: "16rem" }}>
            {allowDefault && (
              <button
                type="button"
                onClick={() => handleSelect(null)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-[#20252a]",
                  value === null ? "bg-[#34d399]/5 text-[#34d399]" : "text-[#a8b0ba]"
                )}
              >
                <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {value === null && <Check className="h-3 w-3 text-[#34d399]" />}
                </div>
                Use default
              </button>
            )}
            {filteredGroups.length === 0 && (
              <p className="py-6 text-center text-xs text-[#7a8591]">
                {query ? "No models match your search" : "No models available"}
              </p>
            )}
            {filteredGroups.map((group) => (
              <div key={group.providerId}>
                <p className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#3d4752]">
                  {group.providerLabel}
                </p>
                {group.models.map((m) => {
                  const friendlyName = getFriendlyModelName(m.id);
                  const displayName = friendlyName !== m.id ? friendlyName : (m.name || m.id);
                  const isSelected = m.id === value;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => handleSelect(m.id)}
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors",
                        isSelected ? "bg-[#34d399]/10 text-[#34d399]" : "text-[#f5f7fa] hover:bg-[#20252a]"
                      )}
                    >
                      <div className="flex h-4 w-4 shrink-0 items-center justify-center">
                        {isSelected && <Check className="h-3 w-3 text-[#34d399]" />}
                      </div>
                      <span className="truncate">{displayName}</span>
                      {displayName !== m.id && (
                        <span className="ml-auto shrink-0 font-mono text-[10px] text-[#7a8591]">
                          {m.id.split("/").pop()}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Add Provider Wizard ─────────────────────────── */

function AddProviderWizard({
  onClose,
  onDone,
  initialProviderId,
  providers,
}: {
  onClose: () => void;
  onDone: () => void;
  initialProviderId?: string | null;
  providers: Provider[];
}) {
  const initialProvider = initialProviderId ? findProvider(initialProviderId, providers) : undefined;
  const [wizard, setWizard] = useState<WizardState>({
    step: initialProvider ? "key" : "pick",
    providerId: initialProvider?.id ?? null,
    apiKey: "",
    error: null,
    models: [],
    loadingModels: false,
  });

  const keyInputRef = useRef<HTMLInputElement>(null);
  const provider = wizard.providerId ? findProvider(wizard.providerId, providers) : null;

  const stepTitle: Record<WizardStep, string> = {
    pick: "Add an AI provider",
    key: "Enter your API key",
    validating: "Validating key...",
    "pick-model": "Choose your model",
    done: "All set!",
  };

  function pickProvider(id: string) {
    setWizard((s) => ({ ...s, step: "key", providerId: id, apiKey: "", error: null }));
    setTimeout(() => keyInputRef.current?.focus(), 80);
  }

  function goBack() {
    if (wizard.step === "validating") return;
    setWizard((s) => ({
      ...s,
      step: "pick",
      providerId: null,
      apiKey: "",
      error: null,
      models: [],
    }));
  }

  async function handleValidate() {
    if (!wizard.providerId || !wizard.apiKey.trim()) {
      setWizard((s) => ({ ...s, error: "Please paste your API key before continuing." }));
      return;
    }

    setWizard((s) => ({ ...s, step: "validating", error: null }));

    try {
      const saveRes = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "auth-provider",
          provider: wizard.providerId,
          token: wizard.apiKey.trim(),
        }),
        signal: AbortSignal.timeout(10000),
      });
      const saveData = await saveRes.json();

      if (!saveData.ok) {
        setWizard((s) => ({
          ...s,
          step: "key",
          error:
            saveData.error ??
            "API key validation failed. Double-check you copied it correctly.",
        }));
        return;
      }

      // Provider is connected — skip model step, go straight to done
      setWizard((s) => ({ ...s, step: "done" }));
      onDone();
    } catch {
      setWizard((s) => ({
        ...s,
        step: "key",
        error: "Network error or request timed out. Check your connection and try again.",
        loadingModels: false,
      }));
    }
  }

  const canGoBack =
    wizard.step === "key" || wizard.step === "pick-model" || wizard.step === "done";

  return (
    <div className="animate-backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center">
      <div className="animate-modal-in mx-0 flex w-full max-w-lg flex-col rounded-t-2xl border border-[#2c343d] bg-[#171a1d] shadow-2xl sm:mx-4 sm:rounded-2xl">
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[#2c343d] px-5 py-4">
          {canGoBack && (
            <button
              type="button"
              onClick={goBack}
              disabled={wizard.step === "validating"}
              aria-label="Go back"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#a8b0ba] transition-colors hover:bg-[#20252a] hover:text-[#f5f7fa] disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[#f5f7fa]">{stepTitle[wizard.step]}</h2>
            {wizard.step === "pick" && (
              <p className="mt-0.5 text-xs text-[#7a8591]">
                Connect an AI provider to power your assistant
              </p>
            )}
            {wizard.step === "key" && provider && (
              <p className="mt-0.5 text-xs text-[#7a8591]">
                Paste your {provider.name} API key below
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#7a8591] transition-colors hover:bg-[#20252a] hover:text-[#f5f7fa]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Step: pick provider */}
          {wizard.step === "pick" && (
            <div className="grid grid-cols-1 gap-3 p-5">
              {providers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => pickProvider(p.id)}
                  className="group flex w-full items-center gap-4 rounded-xl border border-[#2c343d] bg-[#15191d] p-4 text-left transition-all hover:border-[#3d4752] hover:bg-[#1d2227] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#34d399]/30"
                >
                  <ProviderAvatar name={p.name} />
                  <div className="min-w-0 flex-1">
                    <span className="text-sm font-semibold text-[#f5f7fa]">{p.name}</span>
                    <p className="mt-0.5 text-xs text-[#7a8591]">{p.hint}</p>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[#3d4752] transition-colors group-hover:text-[#7a8591]" />
                </button>
              ))}
            </div>
          )}

          {/* Step: enter API key */}
          {wizard.step === "key" && provider && (
            <div className="space-y-4 p-5">
              <div className="rounded-xl border border-[#2c343d] bg-[#15191d] p-4">
                <div className="mb-3 flex items-center gap-2">
                  <Key className="h-3.5 w-3.5 shrink-0 text-[#34d399]" />
                  <span className="text-xs font-semibold text-[#d6dce3]">
                    How to get your {provider.name} API key
                  </span>
                </div>
                <ol className="space-y-2.5">
                  <li className="flex items-start gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#20252a] text-[10px] font-semibold text-[#7a8591] ring-1 ring-[#2c343d]">
                      1
                    </span>
                    <p className="pt-0.5 text-xs leading-relaxed text-[#a8b0ba]">
                      Go to the{" "}
                      <a
                        href={provider.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[#34d399] underline-offset-2 hover:underline"
                      >
                        {provider.name} API keys page
                        <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    </p>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#20252a] text-[10px] font-semibold text-[#7a8591] ring-1 ring-[#2c343d]">
                      2
                    </span>
                    <p className="pt-0.5 text-xs leading-relaxed text-[#a8b0ba]">
                      Create a new API key and copy it
                    </p>
                  </li>
                  <li className="flex items-start gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#20252a] text-[10px] font-semibold text-[#7a8591] ring-1 ring-[#2c343d]">
                      3
                    </span>
                    <p className="pt-0.5 text-xs leading-relaxed text-[#a8b0ba]">
                      Paste it in the field below and click Validate
                    </p>
                  </li>
                </ol>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="models-api-key-input"
                  className="block text-xs font-medium text-[#d6dce3]"
                >
                  API Key
                  {provider.keyPrefix && (
                    <span className="ml-1.5 font-normal text-[#7a8591]">
                      (starts with{" "}
                      <code className="font-mono text-[#a8b0ba]">{provider.keyPrefix}</code>)
                    </span>
                  )}
                </label>
                <input
                  ref={keyInputRef}
                  id="models-api-key-input"
                  type="password"
                  value={wizard.apiKey}
                  onChange={(e) =>
                    setWizard((s) => ({ ...s, apiKey: e.target.value, error: null }))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleValidate();
                  }}
                  placeholder={
                    provider.keyPrefix ? `${provider.keyPrefix}...` : "Paste your API key here"
                  }
                  autoComplete="off"
                  spellCheck={false}
                  className={cn(
                    "w-full rounded-lg border bg-[#15191d] px-3 py-2.5 font-mono text-sm text-[#f5f7fa] placeholder-[#3d4752]",
                    "transition-colors focus:outline-none focus:ring-2",
                    wizard.error
                      ? "border-red-500/40 focus:border-red-500/40 focus:ring-red-500/20"
                      : "border-[#2c343d] focus:border-[#34d399]/40 focus:ring-[#34d399]/20"
                  )}
                />
                {wizard.error && (
                  <p className="flex items-center gap-1.5 text-xs text-red-400">
                    <AlertCircle className="h-3 w-3 shrink-0" />
                    {wizard.error}
                  </p>
                )}
                <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#7a8591]">
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-[#34d399]" />
                  Your key is stored only on this device and never sent to our servers.
                </p>
              </div>
            </div>
          )}

          {/* Step: validating */}
          {wizard.step === "validating" && (
            <div className="flex flex-col items-center gap-4 py-14">
              <div className="relative flex h-16 w-16 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-[#34d399]/10" />
                <Loader2 className="h-8 w-8 animate-spin text-[#34d399]" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-[#f5f7fa]">Checking your key...</p>
                <p className="mt-1 text-xs text-[#7a8591]">This only takes a moment</p>
              </div>
            </div>
          )}

          {/* Step: done */}
          {wizard.step === "done" && (
            <div className="flex flex-col items-center gap-5 px-5 py-10">
              <div className="relative flex h-16 w-16 items-center justify-center">
                <div className="absolute inset-0 rounded-full bg-emerald-500/15" />
                <Check className="h-8 w-8 text-emerald-400" strokeWidth={2.5} />
              </div>
              <div className="text-center">
                <p className="text-sm font-semibold text-[#f5f7fa]">Provider connected!</p>
                <p className="mt-1 text-xs leading-relaxed text-[#7a8591]">
                  You can now pick a model in the Default Model section.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 border-t border-[#2c343d] px-5 py-4">
          {wizard.step === "pick" && (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg border border-[#2c343d] bg-[#20252a] px-4 py-2.5 text-sm font-medium text-[#a8b0ba] transition-colors hover:border-[#3d4752] hover:text-[#f5f7fa]"
            >
              Cancel
            </button>
          )}

          {wizard.step === "key" && (
            <button
              type="button"
              onClick={() => void handleValidate()}
              disabled={!wizard.apiKey.trim()}
              className="w-full rounded-lg bg-[#34d399] px-4 py-2.5 text-sm font-semibold text-[#0d1117] transition-all hover:bg-[#2dbe8c] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Validate &amp; Connect
            </button>
          )}

          {wizard.step === "done" && (
            <button
              type="button"
              onClick={onClose}
              className="w-full rounded-lg bg-[#34d399] px-4 py-2.5 text-sm font-semibold text-[#0d1117] transition-all hover:bg-[#2dbe8c]"
            >
              Done
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Model Picker Modal ──────────────────────────── */

function ModelPickerModal({
  title,
  subtitle,
  currentModel,
  groupedModels,
  loadingModels,
  onClose,
  onSelect,
  allowDefault,
}: {
  title: string;
  subtitle?: string;
  currentModel: string | null;
  groupedModels: GroupedModel[];
  loadingModels: boolean;
  onClose: () => void;
  onSelect: (modelId: string | null) => Promise<void>;
  allowDefault?: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allModels = groupedModels.flatMap((g) => g.models);

  async function handleSelect(modelId: string | null) {
    setSaving(true);
    setError(null);
    try {
      await onSelect(modelId);
      onClose();
    } catch {
      setError("Could not save model selection. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="animate-backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center">
      <div className="animate-modal-in mx-0 flex w-full max-w-lg flex-col rounded-t-2xl border border-[#2c343d] bg-[#171a1d] shadow-2xl sm:mx-4 sm:rounded-2xl">
        <div className="flex shrink-0 items-center gap-3 border-b border-[#2c343d] px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-[#f5f7fa]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-[#7a8591]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[#7a8591] transition-colors hover:bg-[#20252a] hover:text-[#f5f7fa]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {error && (
            <div className="mx-5 mt-4 flex items-center gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2.5">
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
          {saving ? (
            <div className="flex flex-col items-center gap-3 py-14">
              <Loader2 className="h-6 w-6 animate-spin text-[#34d399]" />
              <p className="text-xs text-[#7a8591]">Saving...</p>
            </div>
          ) : (
            <div className="flex flex-col">
              {allowDefault && (
                <div className="border-b border-[#2c343d] p-2">
                  <button
                    type="button"
                    onClick={() => void handleSelect(null)}
                    className={cn(
                      "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors",
                      currentModel === null ? "bg-[#34d399]/10" : "hover:bg-[#20252a]"
                    )}
                  >
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center">
                      {currentModel === null ? (
                        <Check className="h-4 w-4 text-[#34d399]" strokeWidth={2.5} />
                      ) : (
                        <div className="h-1.5 w-1.5 rounded-full bg-[#3d4752]" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <span className={cn("block text-sm font-medium", currentModel === null ? "text-[#34d399]" : "text-[#f5f7fa]")}>
                        Use default
                      </span>
                      <span className="block text-[11px] text-[#7a8591]">
                        Inherits the primary model
                      </span>
                    </div>
                  </button>
                </div>
              )}
              <ModelList
                models={allModels}
                loading={loadingModels}
                currentModel={currentModel}
                onSelect={(id) => void handleSelect(id)}
              />
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-[#2c343d] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-lg border border-[#2c343d] bg-[#20252a] px-4 py-2.5 text-sm font-medium text-[#a8b0ba] transition-colors hover:border-[#3d4752] hover:text-[#f5f7fa]"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Remove button (double-click confirm) ───────── */

function RemoveButton({ onRemove, label = "Remove" }: { onRemove: () => void; label?: string }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function handleClick() {
    if (confirming) {
      if (timerRef.current) clearTimeout(timerRef.current);
      onRemove();
      setConfirming(false);
    } else {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-all",
        confirming
          ? "border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20"
          : "border-[#2c343d] bg-[#20252a] text-[#7a8591] hover:border-[#3d4752] hover:text-[#a8b0ba]"
      )}
    >
      <Trash2 className="h-3 w-3 shrink-0" />
      {confirming ? "Click again to confirm" : label}
    </button>
  );
}

/* ── Toast ──────────────────────────────────────── */

function Toast({ message, type = "error", onClose }: { message: string; type?: "error" | "success"; onClose: () => void }) {
  return (
    <div className="animate-modal-in fixed bottom-6 left-1/2 z-60 flex -translate-x-1/2 items-center gap-3 rounded-xl border bg-[#1d2227] px-4 py-3 shadow-2xl"
      style={{
        borderColor: type === "success" ? "rgba(52,211,153,0.2)" : "rgba(239,68,68,0.2)",
      }}
    >
      {type === "success" ? (
        <Check className="h-4 w-4 shrink-0 text-[#34d399]" />
      ) : (
        <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
      )}
      <span className="whitespace-nowrap text-sm text-[#f5f7fa]">{message}</span>
      <button
        type="button"
        onClick={onClose}
        className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#7a8591] hover:text-[#f5f7fa]"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/* ── Section card wrapper ─────────────────────────── */

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-[#2c343d] bg-[#15191d]", className)}>
      {children}
    </div>
  );
}

function CardHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-[#2c343d] px-5 py-4">
      {children}
    </div>
  );
}

/* ── Section 1: Default Model card ─────────────── */

function DefaultModelCard({
  primaryModel,
  fallbacks,
  groupedModels,
  loadingModels,
  onRefresh,
  onAddProvider,
  hasProviders,
}: {
  primaryModel: string | null;
  fallbacks: string[];
  groupedModels: GroupedModel[];
  loadingModels: boolean;
  onRefresh: () => void;
  onAddProvider: () => void;
  hasProviders: boolean;
}) {
  const [saving, setSaving] = useState(false);
  const [showFallbackPicker, setShowFallbackPicker] = useState(false);

  async function handleSetPrimary(modelId: string) {
    setSaving(true);
    try {
      await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-primary", model: modelId }),
        signal: AbortSignal.timeout(10000),
      });
      onRefresh();
    } catch {
      // Silently fail — user can retry
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveFallback(index: number) {
    const next = fallbacks.filter((_, i) => i !== index);
    try {
      await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-fallbacks", fallbacks: next }),
        signal: AbortSignal.timeout(10000),
      });
      onRefresh();
    } catch {
      // Silently fail
    }
  }

  async function handleAddFallback(modelId: string | null) {
    if (!modelId) return;
    if (fallbacks.includes(modelId)) return;
    const next = [...fallbacks, modelId];
    await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set-fallbacks", fallbacks: next }),
      signal: AbortSignal.timeout(10000),
    });
    onRefresh();
  }

  const friendlyPrimary = primaryModel ? getFriendlyModelName(primaryModel) : null;

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-[#f5f7fa]">Default Model</h2>
          <p className="mt-0.5 text-xs text-[#7a8591]">
            Used by all agents unless overridden
          </p>
        </div>
      </CardHeader>

      <div className="p-5 space-y-5">
        {/* Primary model row */}
        <div className="space-y-2">
          <label className="block text-xs font-medium text-[#d6dce3]">Primary model</label>
          {!hasProviders ? (
            <button
              type="button"
              onClick={onAddProvider}
              className="flex items-center gap-2 rounded-lg border border-dashed border-[#2c343d] bg-[#15191d] px-3 py-2.5 text-xs text-[#7a8591] transition-colors hover:border-[#3d4752] hover:text-[#a8b0ba]"
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              Connect a provider to pick a model
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <ModelSelect
                  value={primaryModel}
                  onChange={(id) => { if (id) void handleSetPrimary(id); }}
                  groupedModels={groupedModels}
                  loading={loadingModels || saving}
                  placeholder="Select a model"
                />
              </div>
            </div>
          )}

          {primaryModel && (
            <div className="flex items-center gap-2 rounded-lg border border-[#34d399]/20 bg-[#34d399]/5 px-3 py-2">
              <StatusDot active />
              <span className="text-xs font-medium text-[#34d399]">{friendlyPrimary}</span>
              <span className="ml-1 font-mono text-[10px] text-[#7a8591]">{primaryModel}</span>
            </div>
          )}

          {!primaryModel && hasProviders && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className="text-xs text-amber-300">No primary model selected</span>
            </div>
          )}
        </div>

        {/* Fallback chain */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-[#d6dce3]">Fallback chain</label>
            {hasProviders && (
              <button
                type="button"
                onClick={() => setShowFallbackPicker(true)}
                className="flex items-center gap-1 text-[11px] text-[#34d399] hover:text-[#2dbe8c] transition-colors"
              >
                <Plus className="h-3 w-3" />
                Add fallback
              </button>
            )}
          </div>
          <p className="text-[11px] text-[#7a8591]">
            Fallback models are tried in order if the primary is unavailable
          </p>

          {fallbacks.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[#2c343d] px-3 py-3 text-center">
              <p className="text-xs text-[#3d4752]">No fallbacks configured</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {fallbacks.map((fb, i) => (
                <div
                  key={fb}
                  className="flex items-center gap-2.5 rounded-lg border border-[#2c343d] bg-[#15191d] px-3 py-2"
                >
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#20252a] text-[10px] font-semibold text-[#7a8591]">
                    {i + 1}
                  </span>
                  <span className="flex-1 truncate text-xs text-[#f5f7fa]">
                    {getFriendlyModelName(fb)}
                  </span>
                  <span className="hidden truncate font-mono text-[10px] text-[#7a8591] sm:block">
                    {fb}
                  </span>
                  <button
                    type="button"
                    onClick={() => void handleRemoveFallback(i)}
                    aria-label="Remove fallback"
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#3d4752] transition-colors hover:text-red-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showFallbackPicker && (
        <ModelPickerModal
          title="Add fallback model"
          subtitle="Added to the end of the fallback chain"
          currentModel={null}
          groupedModels={groupedModels}
          loadingModels={loadingModels}
          onClose={() => setShowFallbackPicker(false)}
          onSelect={handleAddFallback}
        />
      )}
    </Card>
  );
}

/* ── Agent model row ─────────────────────────────── */

type AgentRowState = "idle" | "editing";

function AgentModelRow({
  agent,
  defaultModel,
  defaultFallbacks,
  groupedModels,
  loadingModels,
  onSave,
}: {
  agent: AgentFull;
  defaultModel: string;
  defaultFallbacks: string[];
  groupedModels: GroupedModel[];
  loadingModels: boolean;
  onSave: () => void;
}) {
  const [rowState, setRowState] = useState<AgentRowState>("idle");
  const [editModel, setEditModel] = useState<string | null>(null);
  const [editFallbacks, setEditFallbacks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showFallbackPicker, setShowFallbackPicker] = useState(false);

  // Determine if this agent has a custom model (not just inheriting default)
  const hasCustomModel = agent.model !== defaultModel;
  // Effective model for display — agent's model (may equal default)
  const effectiveModel = agent.model;
  const effectiveFriendly = getFriendlyModelName(effectiveModel);

  function startEdit() {
    // If agent has a custom model, pre-fill; else null means "use default"
    setEditModel(hasCustomModel ? agent.model : null);
    setEditFallbacks(hasCustomModel ? agent.fallbackModels : []);
    setRowState("editing");
  }

  function cancelEdit() {
    setRowState("idle");
    setEditModel(null);
    setEditFallbacks([]);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: agent.id,
          model: editModel ?? null,
          fallbacks: editModel ? editFallbacks : [],
        }),
        signal: AbortSignal.timeout(10000),
      });
      setRowState("idle");
      onSave();
    } catch {
      // Leave editing state so user can retry
    } finally {
      setSaving(false);
    }
  }

  async function handleReset() {
    setSaving(true);
    try {
      await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: agent.id,
          model: null,
          fallbacks: [],
        }),
        signal: AbortSignal.timeout(10000),
      });
      onSave();
    } catch {
      // Silently fail
    } finally {
      setSaving(false);
    }
  }

  async function handleAddFallback(modelId: string | null) {
    if (!modelId || editFallbacks.includes(modelId)) return;
    setEditFallbacks((prev) => [...prev, modelId]);
  }

  if (rowState === "editing") {
    return (
      <div className="border-b border-[#2c343d] last:border-b-0">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="shrink-0 text-base">{agent.emoji}</span>
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-[#f5f7fa]">{agent.name}</span>
          </div>
          <button
            type="button"
            onClick={cancelEdit}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#7a8591] hover:text-[#f5f7fa]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="space-y-3 border-t border-[#1d2227] bg-[#13171b] px-4 pb-4 pt-3">
          <div className="space-y-1.5">
            <label className="block text-[11px] font-medium text-[#7a8591] uppercase tracking-wide">Model</label>
            <ModelSelect
              value={editModel}
              onChange={setEditModel}
              groupedModels={groupedModels}
              loading={loadingModels}
              allowDefault
            />
          </div>

          {editModel && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="block text-[11px] font-medium text-[#7a8591] uppercase tracking-wide">
                  Fallbacks
                </label>
                <button
                  type="button"
                  onClick={() => setShowFallbackPicker(true)}
                  className="flex items-center gap-1 text-[10px] text-[#34d399] hover:text-[#2dbe8c]"
                >
                  <Plus className="h-2.5 w-2.5" />
                  Add
                </button>
              </div>
              {editFallbacks.length === 0 ? (
                <p className="text-[11px] text-[#3d4752]">No fallbacks — add one above</p>
              ) : (
                <div className="space-y-1">
                  {editFallbacks.map((fb, i) => (
                    <div key={fb} className="flex items-center gap-2 rounded-md border border-[#2c343d] bg-[#15191d] px-2 py-1.5">
                      <span className="text-[10px] text-[#7a8591]">{i + 1}</span>
                      <span className="flex-1 truncate text-[11px] text-[#f5f7fa]">
                        {getFriendlyModelName(fb)}
                      </span>
                      <button
                        type="button"
                        onClick={() => setEditFallbacks((prev) => prev.filter((_, j) => j !== i))}
                        className="flex h-4 w-4 items-center justify-center rounded text-[#3d4752] hover:text-red-400"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="flex items-center gap-1.5 rounded-lg bg-[#34d399] px-3 py-1.5 text-xs font-semibold text-[#0d1117] transition-all hover:bg-[#2dbe8c] disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Save
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="rounded-lg border border-[#2c343d] px-3 py-1.5 text-xs text-[#a8b0ba] hover:border-[#3d4752] hover:text-[#f5f7fa]"
            >
              Cancel
            </button>
          </div>
        </div>

        {showFallbackPicker && (
          <ModelPickerModal
            title="Add fallback model"
            subtitle="Tried if the agent's primary model fails"
            currentModel={null}
            groupedModels={groupedModels}
            loadingModels={loadingModels}
            onClose={() => setShowFallbackPicker(false)}
            onSelect={handleAddFallback}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border-b border-[#2c343d] px-4 py-3 last:border-b-0">
      <span className="shrink-0 text-base">{agent.emoji}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-medium text-[#f5f7fa]">{agent.name}</span>
          {agent.isDefault && (
            <span className="rounded-full bg-[#20252a] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-[#7a8591]">
              default
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className={cn("truncate text-xs", hasCustomModel ? "text-[#f5f7fa]" : "text-[#7a8591]")}>
            {effectiveFriendly}
          </span>
          {!hasCustomModel && (
            <span className="shrink-0 text-[10px] text-[#3d4752]">(default)</span>
          )}
          {hasCustomModel && agent.fallbackModels.length > 0 && (
            <span className="shrink-0 rounded border border-[#2c343d] bg-[#20252a] px-1 py-0.5 text-[9px] text-[#7a8591]">
              {agent.fallbackModels.length} fallback{agent.fallbackModels.length !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {hasCustomModel ? (
          <>
            <button
              type="button"
              onClick={startEdit}
              className="flex items-center gap-1.5 rounded-lg border border-[#2c343d] bg-[#20252a] px-2.5 py-1.5 text-xs font-medium text-[#a8b0ba] transition-all hover:border-[#34d399]/30 hover:text-[#34d399]"
            >
              <Pencil className="h-3 w-3 shrink-0" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => void handleReset()}
              disabled={saving}
              title="Reset to default"
              className="flex h-7 w-7 items-center justify-center rounded-lg border border-[#2c343d] bg-[#20252a] text-[#7a8591] transition-all hover:border-red-500/30 hover:text-red-400 disabled:opacity-50"
            >
              <RotateCcw className="h-3 w-3 shrink-0" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={startEdit}
            className="flex items-center gap-1.5 rounded-lg border border-[#2c343d] bg-[#20252a] px-2.5 py-1.5 text-xs font-medium text-[#7a8591] transition-all hover:border-[#3d4752] hover:text-[#a8b0ba]"
          >
            <Pencil className="h-3 w-3 shrink-0" />
            Override
          </button>
        )}
      </div>
    </div>
  );
}

/* ── Section 2: Agent Models card ───────────────── */

function AgentModelsCard({
  agents,
  defaultModel,
  defaultFallbacks,
  groupedModels,
  loadingModels,
  loadingAgents,
  onRefresh,
}: {
  agents: AgentFull[];
  defaultModel: string;
  defaultFallbacks: string[];
  groupedModels: GroupedModel[];
  loadingModels: boolean;
  loadingAgents: boolean;
  onRefresh: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-[#f5f7fa]">Agent Models</h2>
          <p className="mt-0.5 text-xs text-[#7a8591]">
            Override the model for individual agents
          </p>
        </div>
        {agents.length > 0 && (
          <span className="rounded-full border border-[#2c343d] bg-[#20252a] px-2 py-0.5 text-[11px] font-medium text-[#7a8591]">
            {agents.length}
          </span>
        )}
      </CardHeader>

      {loadingAgents && agents.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10">
          <Loader2 className="h-5 w-5 animate-spin text-[#34d399]" />
          <p className="text-xs text-[#7a8591]">Loading agents...</p>
        </div>
      ) : agents.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <p className="text-sm text-[#7a8591]">No agents configured</p>
          <p className="text-xs text-[#3d4752]">Create an agent to assign a specific model</p>
        </div>
      ) : (
        <div>
          {agents.map((agent) => (
            <AgentModelRow
              key={agent.id}
              agent={agent}
              defaultModel={defaultModel}
              defaultFallbacks={defaultFallbacks}
              groupedModels={groupedModels}
              loadingModels={loadingModels}
              onSave={onRefresh}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

/* ── Section 3: Providers card ──────────────────── */

function ProvidersCard({
  configuredProviders,
  agents,
  providers,
  onAddProvider,
  onManageProvider,
  onRemoveProvider,
}: {
  configuredProviders: string[];
  agents: AgentFull[];
  providers: Provider[];
  onAddProvider: (providerId?: string) => void;
  onManageProvider: (providerId: string) => void;
  onRemoveProvider: (providerId: string) => void;
}) {
  const unconnectedProviders = providers.filter((p) => !configuredProviders.includes(p.id));

  // Count how many agent models reference each provider
  function modelsInUseCount(providerId: string): number {
    return agents.filter((a) => {
      const parts = a.model.split("/");
      const providerPart = parts[0] ?? "";
      return providerPart === providerId;
    }).length;
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <h2 className="text-sm font-semibold text-[#f5f7fa]">Providers</h2>
          <p className="mt-0.5 text-xs text-[#7a8591]">
            Manage your AI provider connections
          </p>
        </div>
        <button
          type="button"
          onClick={() => onAddProvider()}
          className="flex items-center gap-1.5 rounded-lg bg-[#34d399] px-3 py-1.5 text-xs font-semibold text-[#0d1117] transition-all hover:bg-[#2dbe8c]"
        >
          <Plus className="h-3.5 w-3.5 shrink-0" />
          Add provider
        </button>
      </CardHeader>

      {configuredProviders.length === 0 && unconnectedProviders.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-12 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#2c343d] bg-[#20252a]">
            <Key className="h-6 w-6 text-[#3d4752]" />
          </div>
          <div>
            <p className="text-sm font-semibold text-[#f5f7fa]">No providers available</p>
            <p className="mt-1 text-xs text-[#7a8591]">Check back later for new integrations</p>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[#2c343d]">
          {/* Connected providers */}
          {configuredProviders.map((pid) => {
            const providerMeta = findProvider(pid, providers);
            const displayName = providerMeta?.name ?? getProviderDisplayName(pid);
            const inUse = modelsInUseCount(pid);

            return (
              <div key={pid} className="flex items-center gap-4 px-5 py-4">
                <ProviderAvatar name={displayName} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <StatusDot active />
                    <span className="text-sm font-semibold text-[#f5f7fa]">{displayName}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-[#7a8591]">
                    Connected
                    {inUse > 0 && (
                      <span className="ml-1 text-[#34d399]">
                        · {inUse} model{inUse !== 1 ? "s" : ""} in use
                      </span>
                    )}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => onManageProvider(pid)}
                    className="flex items-center gap-1.5 rounded-lg border border-[#2c343d] bg-[#20252a] px-2.5 py-1.5 text-xs font-medium text-[#a8b0ba] transition-all hover:border-[#3d4752] hover:text-[#f5f7fa]"
                  >
                    <Zap className="h-3 w-3 shrink-0" />
                    Manage
                  </button>
                  <RemoveButton onRemove={() => onRemoveProvider(pid)} />
                </div>
              </div>
            );
          })}

          {/* Empty state for connected section */}
          {configuredProviders.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-[#2c343d]">
                <Key className="h-4 w-4 text-[#3d4752]" />
              </div>
              <div>
                <p className="text-sm text-[#a8b0ba]">No providers connected yet</p>
                <p className="mt-0.5 text-xs text-[#7a8591]">
                  Add a provider below to get started
                </p>
              </div>
            </div>
          )}

          {/* Available providers */}
          {unconnectedProviders.length > 0 && (
            <div className="px-5 py-4">
              <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-[#3d4752]">
                Available
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {unconnectedProviders.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => onAddProvider(p.id)}
                    className="group flex flex-col items-start gap-2 rounded-xl border border-[#2c343d] bg-[#1d2227] p-3 text-left transition-all hover:border-[#3d4752] hover:bg-[#20252a]"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#2c343d] bg-[#20252a] text-xs font-bold text-[#a8b0ba]">
                      {p.name.charAt(0)}
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-[#d6dce3]">{p.name}</p>
                      <p className="text-[10px] text-[#7a8591]">{p.hint}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ── Main view ──────────────────────────────────── */

export function ModelsView() {
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [agentsData, setAgentsData] = useState<AgentsResponse | null>(null);
  const [groupedModels, setGroupedModels] = useState<GroupedModel[]>([]);
  const [liveAuthProviders, setLiveAuthProviders] = useState<LiveAuthProvider[] | null>(null);
  const [gatewayOffline, setGatewayOffline] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [loadingAgents, setLoadingAgents] = useState(false);

  const [showWizard, setShowWizard] = useState(false);
  const [wizardProviderId, setWizardProviderId] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [toastType, setToastType] = useState<"error" | "success">("error");

  const fetchSummary = useCallback(async () => {
    try {
      const res = await fetch("/api/models/summary", {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const data: SummaryResponse = await res.json();
      setSummary(data);
    } catch {
      // Next poll will retry
    }
  }, []);

  // Live provider/auth state from the gateway (models.authStatus via
  // /api/models). The static catalog is only used while this is unavailable.
  const fetchLiveProviders = useCallback(async () => {
    try {
      const res = await fetch("/api/models", {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const data = await res.json();
      setGatewayOffline(data?.gatewayOffline === true);
      const rows = Array.isArray(data?.authProviders) ? data.authProviders : [];
      setLiveAuthProviders(
        rows
          .filter((row: Record<string, unknown>) => typeof row?.provider === "string")
          .map((row: Record<string, unknown>): LiveAuthProvider => ({
            provider: String(row.provider),
            displayName: typeof row.displayName === "string" ? row.displayName : String(row.provider),
            authenticated: row.authenticated === true,
          }))
      );
    } catch {
      // Next poll will retry; static fallback stays in place meanwhile.
    }
  }, []);

  const fetchAgents = useCallback(async () => {
    setLoadingAgents(true);
    try {
      const res = await fetch("/api/agents", {
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return;
      const data = await res.json();
      setAgentsData({
        agents: (data.agents ?? []) as AgentFull[],
        defaultModel: (data.defaultModel ?? "") as string,
        defaultFallbacks: (data.defaultFallbacks ?? []) as string[],
      });
    } catch {
      // Silently ignore
    } finally {
      setLoadingAgents(false);
    }
  }, []);

  const fetchModelsForAllProviders = useCallback(async (providers: string[]) => {
    if (providers.length === 0) {
      setGroupedModels([]);
      return;
    }
    setLoadingModels(true);
    try {
      const results = await Promise.allSettled(
        providers.map(async (pid) => {
          const res = await fetch("/api/models", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "list-models", provider: pid }),
            signal: AbortSignal.timeout(10000),
          });
          const data = await res.json();
          const providerMeta = findProvider(pid);
          const label = providerMeta?.name ?? getProviderDisplayName(pid);
          return {
            providerId: pid,
            providerLabel: label,
            models: (data.ok ? (data.models ?? []) : []) as ModelItem[],
          };
        })
      );

      const groups: GroupedModel[] = results
        .filter((r): r is PromiseFulfilledResult<GroupedModel> => r.status === "fulfilled")
        .map((r) => r.value)
        .filter((g) => g.models.length > 0);

      setGroupedModels(groups);
    } finally {
      setLoadingModels(false);
    }
  }, []);

  // Fetch summary + live provider data on mount and poll every 30s
  useEffect(() => {
    console.log("[ModelsView] CLIENT mount effect — calling fetchSummary");
    void fetchSummary();
    void fetchLiveProviders();
    const timer = setInterval(() => {
      void fetchSummary();
      void fetchLiveProviders();
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchSummary, fetchLiveProviders]);

  // Fetch agents once on mount, then refresh on demand
  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  // When providers change, refresh model list
  const prevProviders = useRef<string>("");
  useEffect(() => {
    const providers = summary?.configuredProviders ?? [];
    const key = providers.slice().sort().join(",");
    if (key !== prevProviders.current) {
      prevProviders.current = key;
      void fetchModelsForAllProviders(providers);
    }
  }, [summary?.configuredProviders, fetchModelsForAllProviders]);

  function showToast(msg: string, type: "error" | "success" = "error") {
    setToastMessage(msg);
    setToastType(type);
    setTimeout(() => setToastMessage(null), 4000);
  }

  async function handleRemoveProvider(providerId: string) {
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove-provider", provider: providerId }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error("Failed");
      await fetchSummary();
      showToast("Provider removed", "success");
    } catch {
      showToast("Could not remove provider. Try again.");
    }
  }

  function handleWizardDone() {
    void fetchSummary();
    void fetchAgents();
  }

  function openProviderWizard(providerId?: string) {
    setWizardProviderId(providerId ?? null);
    setShowWizard(true);
  }

  function closeProviderWizard() {
    setShowWizard(false);
    setWizardProviderId(null);
  }

  function handleRefreshAll() {
    void fetchSummary();
    void fetchAgents();
  }

  const providerList = useMemo(
    () => buildProviderList(liveAuthProviders),
    [liveAuthProviders]
  );
  const configuredProviders = useMemo(() => {
    const base = summary?.configuredProviders ?? [];
    const authed = (liveAuthProviders ?? [])
      .filter((p) => p.authenticated)
      .map((p) => p.provider);
    return [...new Set([...base, ...authed])];
  }, [summary?.configuredProviders, liveAuthProviders]);
  const primaryModel = summary?.defaults?.primary ?? null;
  const fallbacks = summary?.defaults?.fallbacks ?? [];
  const agents = agentsData?.agents ?? [];
  const defaultModel = agentsData?.defaultModel ?? primaryModel ?? "";
  const defaultFallbacks = agentsData?.defaultFallbacks ?? fallbacks;

  const isLoading = summary === null;

  return (
    <>
      <SectionLayout>
        <SectionHeader
          title="AI Model"
          description="Configure which models power your agents."
          bordered
        />

        <SectionBody width="content" padding="regular">
          {isLoading ? (
            <div className="space-y-4">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-40 animate-pulse rounded-xl border border-[#2c343d] bg-[#15191d]"
                />
              ))}
            </div>
          ) : (
            <div className="space-y-5">
              {gatewayOffline && (
                <div className="flex items-center gap-2 rounded-xl border border-amber-500/25 bg-amber-500/5 px-4 py-3">
                  <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" />
                  <p className="text-xs text-amber-300">
                    The gateway is unreachable — showing cached config data. Provider and model
                    status may be stale until the gateway comes back.
                  </p>
                </div>
              )}
              {/* No providers at all — show big empty state */}
              {configuredProviders.length === 0 && (
                <div className="flex flex-col items-center gap-4 rounded-xl border border-dashed border-[#2c343d] py-16 text-center">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[#2c343d] bg-[#15191d]">
                    <Key className="h-6 w-6 text-[#3d4752]" />
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[#f5f7fa]">No providers connected yet</p>
                    <p className="mt-1 max-w-xs text-xs leading-relaxed text-[#7a8591]">
                      Add an AI provider API key to get started. Your key is stored securely on this device.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openProviderWizard()}
                    className="flex items-center gap-2 rounded-lg bg-[#34d399] px-4 py-2.5 text-sm font-semibold text-[#0d1117] transition-all hover:bg-[#2dbe8c]"
                  >
                    <Plus className="h-4 w-4 shrink-0" />
                    Add your first provider
                  </button>
                </div>
              )}

              {/* Section 1: Default Model */}
              {configuredProviders.length > 0 && (
                <DefaultModelCard
                  primaryModel={primaryModel}
                  fallbacks={fallbacks}
                  groupedModels={groupedModels}
                  loadingModels={loadingModels}
                  onRefresh={handleRefreshAll}
                  onAddProvider={() => openProviderWizard()}
                  hasProviders={configuredProviders.length > 0}
                />
              )}

              {/* Section 2: Agent Models */}
              {configuredProviders.length > 0 && (
                <AgentModelsCard
                  agents={agents}
                  defaultModel={defaultModel}
                  defaultFallbacks={defaultFallbacks}
                  groupedModels={groupedModels}
                  loadingModels={loadingModels}
                  loadingAgents={loadingAgents}
                  onRefresh={handleRefreshAll}
                />
              )}

              {/* Section 3: Providers */}
              <ProvidersCard
                configuredProviders={configuredProviders}
                agents={agents}
                providers={providerList}
                onAddProvider={(pid) => openProviderWizard(pid)}
                onManageProvider={(pid) => openProviderWizard(pid)}
                onRemoveProvider={(pid) => void handleRemoveProvider(pid)}
              />
            </div>
          )}
        </SectionBody>
      </SectionLayout>

      {/* Add provider wizard modal */}
      {showWizard && (
        <AddProviderWizard
          initialProviderId={wizardProviderId}
          providers={providerList}
          onClose={closeProviderWizard}
          onDone={handleWizardDone}
        />
      )}

      {/* Toast */}
      {toastMessage && (
        <Toast message={toastMessage} type={toastType} onClose={() => setToastMessage(null)} />
      )}
    </>
  );
}
