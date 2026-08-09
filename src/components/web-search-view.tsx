"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Search,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Play,
  Copy,
  ExternalLink,
  Globe,
  Zap,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ScreenLoadingState } from "@/components/ui/loading-state";

/* ── Types ──────────────────────────────────────── */

type ProviderInfo = {
  configured: boolean;
  keySource: string | null;
  keyPreview: string | null;
};

type SearchStatus = {
  ok: boolean;
  activeProvider: "perplexity" | "brave" | "none";
  model: string;
  cacheTtlMinutes: number;
  providers: {
    perplexity: ProviderInfo;
    openrouter: ProviderInfo;
    brave: ProviderInfo;
  };
};

type SearchResult = {
  ok: boolean;
  query: string;
  agentId: string;
  resultCount: number;
  output: string;
  durationMs: number;
};

type AgentOption = { id: string; name: string };

const PERPLEXITY_MODELS = [
  { id: "perplexity/sonar", label: "Sonar", description: "Quick Q&A lookups" },
  { id: "perplexity/sonar-pro", label: "Sonar Pro", description: "Complex multi-step reasoning (default)" },
  { id: "perplexity/sonar-reasoning-pro", label: "Sonar Reasoning Pro", description: "Deep chain-of-thought analysis" },
] as const;

/* ── Provider Card ──────────────────────────────── */

function ProviderCard({
  name,
  icon,
  description,
  configured,
  keySource,
  keyPreview,
  isActive,
  envKey,
  onActivate,
  activating,
}: {
  name: string;
  icon: React.ReactNode;
  description: string;
  configured: boolean;
  keySource: string | null;
  keyPreview: string | null;
  isActive: boolean;
  envKey: string;
  onActivate?: () => void;
  activating?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3.5 transition-all",
        isActive
          ? "border-success-border bg-success-bg"
          : configured
            ? "border-foreground/10 bg-foreground/5"
            : "border-foreground/5 bg-foreground/5 opacity-60"
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5">
          {icon}
          <div>
            <div className="flex items-center gap-2">
              <p className="text-xs font-semibold text-foreground">{name}</p>
              {isActive && (
                <span className="rounded-full border border-success-border bg-success-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-success-fg">
                  Active
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          </div>
        </div>
        {configured ? (
          <CheckCircle className="h-4 w-4 shrink-0 text-success-fg" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-fg-subtle" />
        )}
      </div>
      <div className="mt-2.5 rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <code className="text-xs font-medium text-muted-foreground">{envKey}</code>
          {configured ? (
            <span className="text-xs text-muted-foreground">{keySource}</span>
          ) : (
            <span className="text-xs text-danger-fg">Not set</span>
          )}
        </div>
        {configured && keyPreview && (
          <p className="mt-1 font-mono text-xs text-fg-secondary">{keyPreview}</p>
        )}
        {!configured && (
          <p className="mt-1 text-xs text-fg-subtle">
            Set via <code className="text-xs">openclaw.json</code> config, env block, or system environment
          </p>
        )}
      </div>
      {configured && !isActive && onActivate && (
        <div className="mt-2">
          <button
            type="button"
            onClick={onActivate}
            disabled={Boolean(activating)}
            className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-foreground/10 disabled:opacity-60"
          >
            {activating ? (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            ) : null}
            Make active
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Search Playground ──────────────────────────── */

function SearchPlayground({
  activeProvider,
  disabled,
}: {
  activeProvider: string;
  disabled: boolean;
}) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("main");
  const [query, setQuery] = useState("");
  const [resultCount, setResultCount] = useState(5);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const commandPreview = useMemo(() => {
    const q = query.trim() || "<your query>";
    return `openclaw agent --agent ${agentId} --message "web_search: ${q}"`;
  }, [agentId, query]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/agents", { cache: "no-store" });
        const data = await res.json();
        if (!mounted) return;
        const rows = Array.isArray(data?.agents) ? data.agents : [];
        const options: AgentOption[] = rows
          .map((row: { id?: string; name?: string }) => ({
            id: String(row?.id || "").trim(),
            name: String(row?.name || row?.id || "").trim(),
          }))
          .filter((row: AgentOption) => row.id.length > 0);
        if (options.length === 0) {
          setAgents([{ id: "main", name: "main" }]);
          setAgentId("main");
          return;
        }
        setAgents(options);
        if (!options.some((opt) => opt.id === "main")) {
          setAgentId(options[0].id);
        }
      } catch {
        if (!mounted) return;
        setAgents([{ id: "main", name: "main" }]);
        setAgentId("main");
      }
    })();
    return () => { mounted = false; };
  }, []);

  const runSearch = useCallback(async () => {
    if (!query.trim()) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/web-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query.trim(), agentId, resultCount }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        setError(String(data?.error || "Search failed"));
        return;
      }
      setResult(data as SearchResult);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(false);
    }
  }, [agentId, query, resultCount]);

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(commandPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [commandPreview]);

  return (
    <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold text-foreground">
          <Search className="h-4 w-4 text-info-fg" />
          Search Playground
        </h3>
        <span className="rounded border border-info-border bg-info-bg px-2 py-0.5 text-xs font-medium text-info-fg">
          Browser test runner
        </span>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Run a live web search through your configured provider. Results come from the agent&apos;s web_search tool.
      </p>

      {disabled && (
        <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
          <div className="flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            No search provider configured. Set an API key above to enable web search.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Agent</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={running || disabled}
            className="w-full rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:border-info-border disabled:opacity-50"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Search query</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !running && !disabled && query.trim()) void runSearch(); }}
            placeholder="e.g. latest Next.js 16 features"
            disabled={running || disabled}
            className="w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs text-foreground outline-none transition-colors focus:border-info-border disabled:opacity-50"
          />
        </label>

        <label className="space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Results</span>
          <select
            value={resultCount}
            onChange={(e) => setResultCount(Number(e.target.value))}
            disabled={running || disabled}
            className="w-full rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:border-info-border disabled:opacity-50"
          >
            {[3, 5, 7, 10].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </label>
      </div>

      {/* Command preview */}
      <div className="rounded-lg border border-foreground/10 bg-foreground/5 p-2.5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Command preview</p>
        <div className="mt-1 flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all rounded bg-foreground/5 px-2 py-1 text-xs text-foreground">
            {commandPreview}
          </code>
          <button
            type="button"
            onClick={() => void copyCommand()}
            className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-foreground/5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Copy className="h-3 w-3" />
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void runSearch()}
          disabled={running || disabled || !query.trim()}
          className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          {running ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : <Play className="h-3.5 w-3.5" />}
          {running ? "Searching..." : "Run Search"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-success-border bg-success-bg px-1.5 py-0.5 text-success-fg">
              completed
            </span>
            <span>provider: {activeProvider}</span>
            <span>agent: {result.agentId}</span>
            <span>duration: {(result.durationMs / 1000).toFixed(1)}s</span>
          </div>
          <pre className="max-h-96 overflow-auto rounded-lg border border-foreground/10 bg-surface-inset p-3 text-xs leading-relaxed text-info-fg whitespace-pre-wrap wrap-break-word">
            {result.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Main View ──────────────────────────────────── */

export function WebSearchView() {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const [savingBraveKey, setSavingBraveKey] = useState(false);
  const [braveApiKeyDraft, setBraveApiKeyDraft] = useState("");
  const [configMessage, setConfigMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/web-search", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setStatus(data as SearchStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchModel = useCallback(async (modelId: string) => {
    setSwitchingModel(true);
    try {
      const res = await fetch("/api/web-search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelId }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Failed to switch model");
      // Refresh status to reflect the change
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitchingModel(false);
    }
  }, [load]);

  const setProvider = useCallback(
    async (provider: "brave" | "perplexity") => {
      setSavingProvider(true);
      setError(null);
      setConfigMessage(null);
      try {
        const res = await fetch("/api/web-search", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "set-provider", provider }),
        });
        const data = await res.json();
        if (!res.ok || !data?.ok) throw new Error(data?.error || "Failed to set provider");
        setConfigMessage({
          type: "success",
          text: `Active provider set to ${provider === "brave" ? "Brave" : "Perplexity"}.`,
        });
        await load();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setConfigMessage({ type: "error", text: msg });
      } finally {
        setSavingProvider(false);
      }
    },
    [load]
  );

  const saveBraveKey = useCallback(async () => {
    const apiKey = braveApiKeyDraft.trim();
    if (!apiKey) {
      setConfigMessage({ type: "error", text: "Please paste a Brave API key first." });
      return;
    }
    setSavingBraveKey(true);
    setError(null);
    setConfigMessage(null);
    try {
      const res = await fetch("/api/web-search", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set-brave",
          apiKey,
          makeDefault: true,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || "Failed to save Brave API key");
      setBraveApiKeyDraft("");
      setConfigMessage({
        type: "success",
        text: "Brave key saved and Brave is now the active web search provider.",
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      setConfigMessage({ type: "error", text: msg });
    } finally {
      setSavingBraveKey(false);
    }
  }, [braveApiKeyDraft, load]);

  const activeModel = useMemo(() => {
    if (!status) return null;
    return PERPLEXITY_MODELS.find((m) => m.id === status.model) || null;
  }, [status]);

  const anyConfigured = status
    ? status.providers.perplexity.configured || status.providers.openrouter.configured || status.providers.brave.configured
    : false;

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Search className="h-5 w-5 text-fg-secondary dark:text-foreground" />
            Web Search
          </span>
        }
        description="Configure and test real-time web search providers for your agents."
        meta={null}
        actions={
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-card"
          >
            {loading ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            Refresh
          </button>
        }
      />

      <SectionBody width="wide" padding="regular" innerClassName="space-y-4">
        {loading && !status ? (
          <ScreenLoadingState />
        ) : error && !status ? (
          <div className="rounded-xl border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg">
            {error}
          </div>
        ) : status ? (
          <>
            {/* Status overview */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              <div className={cn(
                "rounded-lg border px-2.5 py-1.5",
                anyConfigured
                  ? "border-success-border bg-success-bg"
                  : "border-danger-border bg-danger-bg"
              )}>
                <p className={cn("text-xs font-semibold leading-tight", anyConfigured ? "text-success-fg" : "text-danger-fg")}>
                  {status.activeProvider === "none" ? "None" : status.activeProvider === "perplexity" ? "Perplexity" : "Brave"}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Active provider</p>
              </div>
              <div className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5">
                <p className="text-xs font-semibold leading-tight text-foreground">
                  {activeModel?.label || status.model}
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Model</p>
              </div>
              <div className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5">
                <p className="text-xs font-semibold leading-tight text-foreground">{status.cacheTtlMinutes}m</p>
                <p className="text-xs text-muted-foreground mt-0.5">Cache TTL</p>
              </div>
              <div className="rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5">
                <p className="text-xs font-semibold leading-tight text-foreground">
                  {[status.providers.perplexity.configured, status.providers.openrouter.configured, status.providers.brave.configured].filter(Boolean).length}/3
                </p>
                <p className="text-xs text-muted-foreground mt-0.5">Keys configured</p>
              </div>
            </div>

            {/* Provider cards */}
            <div>
              <h2 className="text-xs font-semibold text-foreground mb-2">Search Providers</h2>
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-3">
                <ProviderCard
                  name="Perplexity (Direct)"
                  icon={<Zap className="h-5 w-5 text-fg-secondary" />}
                  description="AI-synthesized answers with citations from real-time web search"
                  configured={status.providers.perplexity.configured}
                  keySource={status.providers.perplexity.keySource}
                  keyPreview={status.providers.perplexity.keyPreview}
                  isActive={status.activeProvider === "perplexity" && status.providers.perplexity.configured}
                  envKey="PERPLEXITY_API_KEY"
                  onActivate={
                    status.providers.perplexity.configured
                      ? () => {
                          void setProvider("perplexity");
                        }
                      : undefined
                  }
                  activating={savingProvider}
                />
                <ProviderCard
                  name="OpenRouter"
                  icon={<Globe className="h-5 w-5 text-info-fg" />}
                  description="Access Perplexity models via OpenRouter (alternative billing)"
                  configured={status.providers.openrouter.configured}
                  keySource={status.providers.openrouter.keySource}
                  keyPreview={status.providers.openrouter.keyPreview}
                  isActive={status.activeProvider === "perplexity" && !status.providers.perplexity.configured && status.providers.openrouter.configured}
                  envKey="OPENROUTER_API_KEY"
                />
                <ProviderCard
                  name="Brave Search"
                  icon={<Shield className="h-5 w-5 text-warning-fg" />}
                  description="Structured search results (default fallback provider)"
                  configured={status.providers.brave.configured}
                  keySource={status.providers.brave.keySource}
                  keyPreview={status.providers.brave.keyPreview}
                  isActive={status.activeProvider === "brave"}
                  envKey="BRAVE_API_KEY"
                  onActivate={
                    status.providers.brave.configured
                      ? () => {
                          void setProvider("brave");
                        }
                      : undefined
                  }
                  activating={savingProvider}
                />
              </div>
            </div>

            <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-2">
              <h3 className="text-xs font-semibold text-foreground">Quick setup: Brave (recommended fallback)</h3>
              <p className="text-xs text-muted-foreground">
                Paste a Brave API key to save it in <code className="text-xs">openclaw.json</code> and make Brave the default search provider.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={braveApiKeyDraft}
                  onChange={(e) => setBraveApiKeyDraft(e.target.value)}
                  placeholder="BSA... (Brave API key)"
                  disabled={savingBraveKey || loading}
                  className="min-w-0 flex-1 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs text-foreground outline-none transition-colors focus:border-info-border disabled:opacity-60"
                />
                <button
                  type="button"
                  onClick={() => {
                    void saveBraveKey();
                  }}
                  disabled={savingBraveKey || loading}
                  className="inline-flex items-center justify-center gap-1.5 rounded-full bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-60"
                >
                  {savingBraveKey ? "Saving..." : "Save key + Use Brave"}
                </button>
              </div>
            </div>

            {configMessage && (
              <div
                className={cn(
                  "rounded-xl border p-3 text-xs",
                  configMessage.type === "success"
                    ? "border-success-border bg-success-bg text-success-fg"
                    : "border-danger-border bg-danger-bg text-danger-fg"
                )}
              >
                {configMessage.text}
              </div>
            )}

            {/* Model selector (perplexity only) */}
            {status.activeProvider === "perplexity" && (
              <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-2">
                <h3 className="text-xs font-semibold text-foreground">Perplexity Models</h3>
                <p className="text-xs text-muted-foreground">
                  Select a model below. Currently using{" "}
                  <code className="rounded bg-foreground/10 px-1 text-fg-secondary">{status.model}</code>.
                  {switchingModel && (
                    <span className="ml-1.5 inline-flex items-center gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
                    </span>
                  )}
                </p>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                  {PERPLEXITY_MODELS.map((m) => {
                    const isSelected = status.model === m.id;
                    return (
                      <button
                        key={m.id}
                        type="button"
                        disabled={switchingModel || isSelected}
                        onClick={() => void switchModel(m.id)}
                        className={cn(
                          "rounded-lg border px-2.5 py-2 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          isSelected
                            ? "border-border-strong bg-muted-foreground/10"
                            : "border-foreground/5 bg-foreground/5 hover:border-border-strong hover:bg-muted-foreground/5 cursor-pointer",
                          switchingModel && !isSelected && "opacity-50"
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <p className={cn("text-xs font-medium", isSelected ? "text-fg-secondary" : "text-fg-secondary")}>
                            {m.label}
                          </p>
                          {isSelected && (
                            <CheckCircle className="h-3 w-3 text-fg-secondary" />
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{m.description}</p>
                        <code className="mt-1 block text-xs text-fg-subtle">{m.id}</code>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* No provider warning */}
            {!anyConfigured && (
              <div className="rounded-xl border border-warning-border bg-warning-bg p-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="h-5 w-5 shrink-0 text-warning-fg mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-warning-fg">No search provider configured</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      To enable web search, set at least one API key. Go to{" "}
                      <Link href="/accounts" className="text-foreground hover:underline">Keys & Access</Link>{" "}
                      to add <code className="text-xs">PERPLEXITY_API_KEY</code>, <code className="text-xs">OPENROUTER_API_KEY</code>,
                      or <code className="text-xs">BRAVE_API_KEY</code>.
                    </p>
                    <p className="mt-2 text-xs text-muted-foreground">
                      <a
                        href="https://docs.openclaw.ai/tools/web#setting-up-perplexity-search"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-foreground hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Setup guide
                      </a>
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Search playground */}
            <SearchPlayground
              activeProvider={status.activeProvider}
              disabled={!anyConfigured}
            />

            {/* Docs link */}
            <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4">
              <h3 className="text-xs font-semibold text-foreground">Documentation</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                For full setup instructions, supported parameters (query, country, language, freshness filters), and
                configuration details:
              </p>
              <a
                href="https://docs.openclaw.ai/tools/web#setting-up-perplexity-search"
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs font-medium text-info-fg transition-colors hover:bg-foreground/10"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                OpenClaw Web Search Docs
              </a>
            </div>
          </>
        ) : null}
      </SectionBody>
    </SectionLayout>
  );
}
