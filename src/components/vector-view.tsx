"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  Database, Search, RefreshCw, ChevronDown, ChevronUp, Check,
  AlertTriangle, X, FileText, Hash, Cpu, HardDrive,
  Layers, RotateCcw, Activity, Filter, ArrowUpDown, Eye, Copy,
  Box, BarChart3, CircleDot, Lock, KeyRound,
  Trash2, ExternalLink, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";

type SourceCount = { source: string; files: number; chunks: number };

type AgentMemory = {
  agentId: string;
  dbSizeBytes: number;
  status: {
    backend: string; files: number; chunks: number; dirty: boolean;
    workspaceDir: string; dbPath: string; provider: string; model: string;
    requestedProvider: string; sources: string[]; extraPaths: string[];
    sourceCounts: SourceCount[];
    cache: { enabled: boolean; entries: number };
    fts: { enabled: boolean; available: boolean };
    vector: { enabled: boolean; available: boolean; extensionPath?: string; dims?: number };
    batch: { enabled: boolean; failures: number; limit: number; wait: boolean; concurrency: number; pollIntervalMs: number; timeoutMs: number };
  };
  scan: { sources: { source: string; totalFiles: number; issues: string[] }[]; totalFiles: number; issues: string[] };
};

type SearchResult = { path: string; startLine: number; endLine: number; score: number; snippet: string; source: string };
type VectorDocOption = { path: string; selected: boolean; source: "workspace" | "custom" };
type Toast = { message: string; type: "success" | "error" };

/** Default local embedding model (auto-downloads on first use, ~0.6 GB). */
const DEFAULT_LOCAL_MODEL_PATH = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

type ProviderCard = {
  id: string;
  provider: string;
  model: string;
  dims: number;
  label: string;
  sublabel: string;
  description: string;
  requiresKey: string | null;
  icon: string;
};

const PROVIDER_CARDS: ProviderCard[] = [
  {
    id: "openai",
    provider: "openai",
    model: "text-embedding-3-small",
    dims: 1536,
    label: "OpenAI",
    sublabel: "text-embedding-3-small · 1536d",
    description: "Best quality. Uses your OpenAI API key.",
    requiresKey: "openai",
    icon: "circle",
  },
  {
    id: "openai-large",
    provider: "openai",
    model: "text-embedding-3-large",
    dims: 3072,
    label: "OpenAI (Large)",
    sublabel: "text-embedding-3-large · 3072d",
    description: "Higher quality, more expensive.",
    requiresKey: "openai",
    icon: "circle",
  },
  {
    id: "local",
    provider: "local",
    model: "auto",
    dims: 0,
    label: "Local (Offline)",
    sublabel: "EmbeddingGemma · Runs on device",
    description: "Free, no API key. Downloads ~600MB model on first use.",
    requiresKey: null,
    icon: "laptop",
  },
  {
    id: "google",
    provider: "google",
    model: "text-embedding-004",
    dims: 768,
    label: "Google Gemini",
    sublabel: "text-embedding-004 · 768d",
    description: "Free tier available.",
    requiresKey: "google",
    icon: "circle-blue",
  },
];

function formatBytes(b: number): string {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}
function scoreColor(s: number) { return s >= 0.7 ? "text-success-fg" : s >= 0.5 ? "text-warning-fg" : s >= 0.3 ? "text-warning-fg" : "text-danger-fg"; }
function scoreBarColor(s: number) { return s >= 0.7 ? "bg-success" : s >= 0.5 ? "bg-warning" : s >= 0.3 ? "bg-warning" : "bg-danger"; }

function ToastBar({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={cn("fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-xl backdrop-blur-sm", toast.type === "success" ? "border-success-border bg-success-bg text-success-fg" : "border-danger-border bg-danger-bg text-danger-fg")}>
      <div className="flex items-center gap-2">{toast.type === "success" ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{toast.message}</div>
    </div>
  );
}

function Dots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}

function ScoreBar({ score }: { score: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-foreground/10"><div className={cn("h-1.5 rounded-full transition-all", scoreBarColor(score))} style={{ width: Math.round(score * 100) + "%" }} /></div>
      <span className={cn("text-xs font-mono font-semibold", scoreColor(score))}>{score.toFixed(4)}</span>
    </div>
  );
}

function ResultCard({ result, rank }: { result: SearchResult; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);
  return (
    <div className="rounded-xl border border-border bg-card shadow-sm transition-colors hover:border-border-strong">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold text-fg-secondary dark:bg-secondary">#{rank}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-info-fg" />
            <span className="truncate text-sm font-medium text-foreground">{result.path}</span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">L{result.startLine}-{result.endLine}</span>
            <span className="shrink-0 rounded border border-info-border bg-info-bg px-1.5 py-0.5 text-xs text-info-fg">{result.source}</span>
          </div>
        </div>
        <ScoreBar score={result.score} />
        <div className="flex items-center gap-1">
          <button onClick={() => { navigator.clipboard.writeText(result.snippet); setCopied(true); if (copyTimerRef.current) clearTimeout(copyTimerRef.current); copyTimerRef.current = setTimeout(() => setCopied(false), 1500); }} className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary" title="Copy" aria-label="Copy snippet">
            {copied ? <Check className="h-3.5 w-3.5 text-success-fg" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button onClick={() => setExpanded(!expanded)} className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {!expanded && <div className="border-t border-border px-4 py-2"><p className="line-clamp-2 text-xs leading-5 text-muted-foreground">{result.snippet.replace(/\n+/g, " ").substring(0, 200)}</p></div>}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <div className="flex items-center gap-2 mb-2"><Hash className="h-3 w-3 text-fg-subtle" /><span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Vector Match - Chunk Content</span></div>
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground whitespace-pre-wrap break-words">{result.snippet}</pre>
          <div className="mt-2 flex items-center gap-4 text-xs text-fg-subtle">
            <span>Lines {result.startLine}-{result.endLine}</span><span>{result.snippet.length} chars</span><span>~{Math.ceil(result.snippet.split(/\s+/).length)} tokens (est.)</span>
          </div>
        </div>
      )}
    </div>
  );
}

function MiniStat({ icon: Icon, label, value }: { icon: React.ComponentType<{ className?: string }>; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle mb-0.5"><Icon className="h-3 w-3" />{label}</div>
      <p className="text-xs font-mono text-fg-secondary truncate" title={value}>{value}</p>
    </div>
  );
}

function AgentIndexCard({
  agent,
  onReindex,
  onDelete,
  reindexing,
  deleting,
}: {
  agent: AgentMemory;
  onReindex: (id: string, force: boolean) => void;
  onDelete: (id: string) => void;
  reindexing: boolean;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const st = agent.status; const vec = st.vector;
  return (
    <div className={cn("rounded-xl border transition-all shadow-sm", agent.scan.issues.length > 0 ? "border-warning-border bg-warning-bg" : "border-border bg-card")}>
      <div className="flex items-center gap-3 px-4 py-3.5">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-sm dark:bg-secondary">{agent.agentId === "main" ? "\u{1F99E}" : "\u{1F480}"}</div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-foreground capitalize">{agent.agentId}</span>
            {st.dirty && <span className="rounded-full bg-warning-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-warning-fg">Dirty</span>}
            {vec.available && <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-success-fg">Vector</span>}
            {st.fts.available && <span className="rounded-full bg-info-bg px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-info-fg">FTS</span>}
          </div>
          <div className="mt-0.5 flex items-center gap-3 text-xs text-muted-foreground">
            <span>{st.files} files</span><span>{st.chunks} chunks</span>{vec.dims && <span>{vec.dims}d vectors</span>}<span>{formatBytes(agent.dbSizeBytes)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => onReindex(agent.agentId, false)} disabled={reindexing || deleting} className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-muted disabled:opacity-50 dark:bg-secondary dark:hover:bg-secondary">
            {reindexing ? <Dots /> : <RefreshCw className="h-3 w-3" />}Reindex
          </button>
          <button
            onClick={() => onDelete(agent.agentId)}
            disabled={reindexing || deleting}
            className="flex items-center gap-1.5 rounded-lg border border-danger-border bg-danger-bg px-3 py-1.5 text-xs font-medium text-danger-fg hover:bg-danger-bg disabled:opacity-50"
          >
            {deleting ? <Dots /> : <Trash2 className="h-3 w-3" />}
            Delete
          </button>
          <button onClick={() => setExpanded(!expanded)} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground dark:hover:bg-secondary">
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <MiniStat icon={Layers} label="Backend" value={st.backend} />
            <MiniStat icon={Cpu} label="Provider" value={st.provider} />
            <MiniStat icon={Box} label="Model" value={st.model} />
            <MiniStat icon={Hash} label="Dimensions" value={vec.dims ? String(vec.dims) : "\u2014"} />
          </div>
          {st.sourceCounts.length > 0 && (
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle mb-1.5">Sources</p>
              <div className="space-y-1">{st.sourceCounts.map((sc) => (
                <div key={sc.source} className="flex items-center justify-between rounded-lg border border-border bg-muted px-3 py-2">
                  <div className="flex items-center gap-2"><CircleDot className="h-3 w-3 text-success-fg" /><span className="text-xs text-fg-secondary">{sc.source}</span></div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground"><span>{sc.files} files</span><span>{sc.chunks} chunks</span></div>
                </div>
              ))}</div>
            </div>
          )}
          <div className="flex items-center gap-4 text-xs">
            <span className="text-fg-subtle">Cache: <span className={st.cache.enabled ? "text-success-fg" : "text-fg-subtle"}>{st.cache.enabled ? st.cache.entries + " entries" : "disabled"}</span></span>
            <span className="text-fg-subtle">FTS: <span className={st.fts.available ? "text-success-fg" : "text-danger-fg"}>{st.fts.available ? "available" : "unavailable"}</span></span>
            <span className="text-fg-subtle">Vector: <span className={vec.available ? "text-success-fg" : "text-danger-fg"}>{vec.available ? "available" : "unavailable"}</span></span>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2"><p className="text-xs text-fg-subtle mb-0.5">Database Path</p><code className="text-xs text-muted-foreground break-all">{st.dbPath}</code></div>
          {agent.scan.issues.length > 0 && (
            <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 space-y-1">
              <p className="flex items-center gap-1.5 text-xs font-medium text-warning-fg"><AlertTriangle className="h-3 w-3" />Issues</p>
              {agent.scan.issues.map((issue, i) => <p key={i} className="text-xs text-warning-fg pl-5">{issue}</p>)}
            </div>
          )}
          <button onClick={() => onReindex(agent.agentId, true)} disabled={reindexing || deleting} className="flex items-center gap-1.5 rounded-lg border border-danger-border bg-danger-bg px-3 py-1.5 text-xs text-danger-fg hover:bg-danger-bg disabled:opacity-50">
            <RotateCcw className="h-3 w-3" />Force Full Reindex
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Provider Icon ───────────────────────────────── */

function ProviderIcon({ icon, isAuth }: { icon: string; isAuth: boolean }) {
  if (icon === "laptop") {
    return <span className="text-base" title="Runs on device">💻</span>;
  }
  if (icon === "circle-blue") {
    return (
      <span className={cn("flex h-3 w-3 rounded-full shrink-0", isAuth ? "bg-info" : "bg-foreground/20")} />
    );
  }
  // default green circle
  return (
    <span className={cn("flex h-3 w-3 rounded-full shrink-0", isAuth ? "bg-success" : "bg-foreground/20")} />
  );
}

/* ── Provider Cards Section ──────────────────────── */

function ProviderCards({
  authProviders,
  activeProvider,
  activeModel,
  onEnable,
  onSaveGoogleKey,
  busy,
  busyId,
}: {
  authProviders: string[];
  activeProvider: string;
  activeModel: string;
  onEnable: (card: ProviderCard, apiKey?: string) => void;
  onSaveGoogleKey: (key: string) => Promise<boolean>;
  busy: boolean;
  busyId: string | null;
}) {
  const [googleKey, setGoogleKey] = useState("");
  const [savingGoogleKey, setSavingGoogleKey] = useState(false);

  return (
    <div className="space-y-2">
      {PROVIDER_CARDS.map((card) => {
        const isActive =
          card.provider === activeProvider && card.model === activeModel;
        const isAuth =
          card.requiresKey === null || authProviders.includes(card.requiresKey);
        const isThisBusy = busyId === card.id && busy;
        const needsInlineKey = card.requiresKey === "google" && !authProviders.includes("google");

        return (
          <div
            key={card.id}
            className={cn(
              "rounded-xl border p-4 transition-all",
              isActive
                ? "border-success-border bg-success-bg"
                : "border-border bg-card"
            )}
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">
                <ProviderIcon icon={card.icon} isAuth={isAuth} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-0.5">
                  <span className={cn("text-sm font-semibold", isActive ? "text-success-fg" : "text-foreground")}>
                    {card.label}
                  </span>
                  {isActive && (
                    <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success-fg">
                      Active
                    </span>
                  )}
                  {!isAuth && !needsInlineKey && (
                    <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      <Lock className="h-2.5 w-2.5" />No API key
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground font-mono">{card.sublabel}</p>
                <p className="text-xs text-muted-foreground mt-1">{card.description}</p>

                {/* Inline Google key input */}
                {needsInlineKey && (
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <input
                      type="password"
                      value={googleKey}
                      onChange={(e) => setGoogleKey(e.target.value)}
                      placeholder="Paste Gemini API key..."
                      aria-label="Gemini API key"
                      className="flex-1 rounded-lg border border-border bg-muted px-3 py-1.5 font-mono text-xs text-foreground outline-none focus:border-success-border"
                    />
                    <button
                      type="button"
                      disabled={savingGoogleKey || !googleKey.trim() || busy}
                      onClick={async () => {
                        setSavingGoogleKey(true);
                        const ok = await onSaveGoogleKey(googleKey.trim());
                        setSavingGoogleKey(false);
                        if (ok) {
                          setGoogleKey("");
                          onEnable(card);
                        }
                      }}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap"
                    >
                      {savingGoogleKey ? <><Dots />Saving...</> : <><Zap className="h-3 w-3" />Enable</>}
                    </button>
                  </div>
                )}
              </div>

              {/* Enable button (right side, for cards that don't need inline key) */}
              {!needsInlineKey && (
                <button
                  type="button"
                  disabled={busy || !isAuth || isActive}
                  onClick={() => onEnable(card)}
                  className={cn(
                    "shrink-0 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all disabled:opacity-50",
                    isActive
                      ? "border border-success-border bg-success-bg text-success-fg cursor-default"
                      : isAuth
                        ? "bg-primary text-primary-foreground hover:bg-primary/90"
                        : "border border-border bg-muted text-fg-subtle dark:bg-secondary cursor-not-allowed"
                  )}
                >
                  {isThisBusy ? (
                    <><Dots />Enabling...</>
                  ) : isActive ? (
                    <><Check className="h-3 w-3" />Active</>
                  ) : (
                    <><Zap className="h-3 w-3" />Enable</>
                  )}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Current Status Card ─────────────────────────── */

function CurrentStatusCard({
  provider,
  model,
  dims,
  totalFiles,
  onDisable,
  onReindex,
  disabling,
  reindexing,
}: {
  provider: string;
  model: string;
  dims: number | null;
  totalFiles: number;
  onDisable: () => void;
  onReindex: () => void;
  disabling: boolean;
  reindexing: boolean;
}) {
  const card = PROVIDER_CARDS.find((c) => c.provider === provider && c.model === model);
  const label = card?.label ?? provider;

  return (
    <div className="rounded-xl border border-success-border bg-success-bg p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="mt-0.5">
            <span className="flex h-3 w-3 rounded-full bg-success shrink-0" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-success-fg">Vector Memory Active</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{label}</span>
              <span className="font-mono text-muted-foreground">{model}</span>
              {dims && <span>{dims}d vectors</span>}
              <span>{totalFiles} file{totalFiles !== 1 ? "s" : ""} indexed</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onReindex}
            disabled={reindexing || disabling}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-1.5 text-xs font-medium text-fg-secondary hover:bg-muted disabled:opacity-50 dark:bg-secondary dark:hover:bg-secondary"
          >
            {reindexing ? <><Dots />Reindexing...</> : <><RefreshCw className="h-3 w-3" />Reindex</>}
          </button>
          <button
            type="button"
            onClick={onDisable}
            disabled={disabling || reindexing}
            className="flex items-center gap-1.5 rounded-lg border border-danger-border bg-danger-bg px-3 py-1.5 text-xs font-medium text-danger-fg hover:bg-danger-bg disabled:opacity-50"
          >
            {disabling ? <><Dots />Disabling...</> : <><X className="h-3 w-3" />Disable</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Overview Stats ──────────────────────────────── */

function OverviewStat({ icon: Icon, value, label, sub, color }: { icon: React.ComponentType<{ className?: string }>; value: string; label: string; sub?: string; color: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-sm">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground mb-1"><Icon className={cn("h-3.5 w-3.5", color)} />{label}</div>
      <p className="text-xs font-semibold text-foreground">{value}</p>
      {sub && <p className="text-xs text-fg-subtle mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

/* ── Main Component ──────────────────────────────── */

export function VectorView() {
  const [agents, setAgents] = useState<AgentMemory[]>([]);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reindexingAgents, setReindexingAgents] = useState<Set<string>>(new Set());
  const [deletingNamespace, setDeletingNamespace] = useState<string | null>(null);
  const [savingDocSelection, setSavingDocSelection] = useState(false);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docFilter, setDocFilter] = useState("");
  const [vectorDocs, setVectorDocs] = useState<VectorDocOption[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const [settingUpId, setSettingUpId] = useState<string | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [reindexingAll, setReindexingAll] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [query, setQuery] = useState("");
  const [searchAgent, setSearchAgent] = useState("");
  const [maxResults, setMaxResults] = useState("10");
  const [minScore, setMinScore] = useState("");
  const [sortBy, setSortBy] = useState<"score" | "path">("score");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [searchTime, setSearchTime] = useState(0);
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  const [authProviders, setAuthProviders] = useState<string[]>([]);
  const [memorySearch, setMemorySearch] = useState<Record<string, unknown> | null>(null);

  const fetchDocuments = useCallback(async () => {
    setDocsLoading(true);
    try {
      const res = await fetch("/api/vector?scope=documents");
      if (!res.ok) throw new Error(`Documents fetch failed (${res.status})`);
      const data = await res.json();
      setVectorDocs(Array.isArray(data.docs) ? data.docs : []);
    } catch (err) {
      console.error("Vector docs fetch:", err);
      setVectorDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/vector?scope=status");
      if (!res.ok) throw new Error(`Status fetch failed (${res.status})`);
      const data = await res.json();
      setApiWarning(
        typeof data.warning === "string" && data.warning.trim()
          ? data.warning.trim()
          : null
      );
      setApiDegraded(Boolean(data.degraded));
      setAgents(data.agents || []);
      setAuthProviders(data.authProviders || []);
      setMemorySearch(data.memorySearch || null);
      await fetchDocuments();
    } catch (err) {
      console.error("Vector fetch:", err);
      setApiWarning(err instanceof Error ? err.message : String(err));
      setApiDegraded(true);
    } finally {
      setLoading(false);
    }
  }, [fetchDocuments]);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const doSearch = useCallback(async (q: string) => {
    if (!q || q.trim().length < 2) { setResults([]); setLastQuery(""); setSearchError(null); return; }
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true); setSearchError(null);
    const start = performance.now();
    try {
      const p = new URLSearchParams({ scope: "search", q: q.trim(), max: maxResults });
      if (searchAgent) p.set("agent", searchAgent);
      if (minScore) p.set("minScore", minScore);
      const res = await fetch("/api/vector?" + p, { signal: controller.signal });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results || []); setLastQuery(q); setSearchTime(Math.round(performance.now() - start));
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setResults([]);
      setSearchError(err instanceof Error ? err.message : "Search failed");
    } finally { setSearching(false); }
  }, [searchAgent, maxResults, minScore]);

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(query), 400);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [query, doSearch]);

  const handleReindex = useCallback(async (agentId: string, force: boolean) => {
    setReindexingAgents((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch("/api/vector", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reindex", agent: agentId, force }) });
      if (!res.ok) throw new Error(`Reindex failed (${res.status})`);
      const d = await res.json();
      if (d.ok) { setToast({ message: agentId + (force ? " force" : "") + " reindexed", type: "success" }); await fetchStatus(); }
      else setToast({ message: typeof d.error === "string" ? d.error : "Reindex failed", type: "error" });
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "Reindex failed", type: "error" }); } finally {
      setReindexingAgents((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }, [fetchStatus]);

  const handleReindexAll = useCallback(async () => {
    setReindexingAll(true);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex" }),
      });
      if (!res.ok) throw new Error(`Reindex failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: "Reindex complete", type: "success" });
        await fetchStatus();
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Reindex failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Reindex failed", type: "error" });
    } finally {
      setReindexingAll(false);
    }
  }, [fetchStatus]);

  const handleDeleteNamespace = useCallback(async (agentId: string) => {
    const confirmed = window.confirm(
      `Delete the vector namespace for "${agentId}"?\n\nThis removes the current SQLite memory index files for that namespace. You can rebuild it later with Reindex.`
    );
    if (!confirmed) return;
    setDeletingNamespace(agentId);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-namespace", agent: agentId }),
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: `${agentId} namespace deleted`, type: "success" });
        await fetchStatus();
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Namespace delete failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Delete failed", type: "error" });
    } finally {
      setDeletingNamespace(null);
    }
  }, [fetchStatus]);

  const handleSaveDocSelection = useCallback(async (paths: string[]) => {
    setSavingDocSelection(true);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-extra-paths", extraPaths: paths, reindex: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) {
        throw new Error(typeof d.error === "string" ? d.error : `Save failed (${res.status})`);
      }
      if (Array.isArray(d.skippedPaths) && d.skippedPaths.length > 0) {
        setToast({ message: `Saved with ${d.skippedPaths.length} skipped path(s)`, type: "error" });
      } else if (d.warning) {
        setToast({ message: String(d.warning), type: "error" });
      } else {
        setToast({ message: `Saved ${paths.length} document path(s) and reindexed`, type: "success" });
      }
      await fetchStatus();
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to save document selection", type: "error" });
    } finally {
      setSavingDocSelection(false);
    }
  }, [fetchStatus]);

  const handleSaveProviderKey = useCallback(async (provider: string, apiKey: string): Promise<boolean> => {
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "auth-provider", provider, token: apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(typeof data.error === "string" ? data.error : `${provider} key validation failed`);
      }
      setToast({ message: `${provider} key saved.`, type: "success" });
      await fetchStatus();
      return true;
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : `Failed to save ${provider} key`, type: "error" });
      return false;
    }
  }, [fetchStatus]);

  const handleEnable = useCallback(async (card: ProviderCard, _apiKey?: string) => {
    setSettingUp(true);
    setSettingUpId(card.id);
    try {
      const body: Record<string, unknown> = {
        action: "setup-memory",
        provider: card.provider,
        model: card.model,
      };
      if (card.provider === "local") {
        body.localModelPath = DEFAULT_LOCAL_MODEL_PATH;
      }
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Setup failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: `Vector memory enabled with ${card.label}`, type: "success" });
        setLoading(true);
        await fetchStatus();
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Setup failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Setup failed", type: "error" });
    } finally {
      setSettingUp(false);
      setSettingUpId(null);
    }
  }, [fetchStatus]);

  const handleDisable = useCallback(async () => {
    const confirmed = window.confirm("Disable vector memory? This turns off semantic search. Your index data is kept and can be re-enabled.");
    if (!confirmed) return;
    setDisabling(true);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable-memory" }),
      });
      if (!res.ok) throw new Error(`Disable failed (${res.status})`);
      const d = await res.json();
      if (!d.ok) throw new Error(typeof d.error === "string" ? d.error : "Disable failed");
      setToast({ message: "Vector memory disabled. Re-enable anytime by choosing a provider.", type: "success" });
      await fetchStatus();
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Disable failed", type: "error" });
    } finally {
      setDisabling(false);
    }
  }, [fetchStatus]);

  const sorted = useMemo(() => { const r = [...results]; if (sortBy === "path") r.sort((a, b) => a.path.localeCompare(b.path)); return r; }, [results, sortBy]);

  const totalChunks = agents.reduce((s, a) => s + a.status.chunks, 0);
  const totalFiles = agents.reduce((s, a) => s + a.status.files, 0);
  const totalDb = agents.reduce((s, a) => s + a.dbSizeBytes, 0);
  const dirtyNamespaces = agents.filter((a) => a.status.dirty).length;
  const vectorReadyNamespaces = agents.filter((a) => a.status.vector.available).length;
  const ftsReadyNamespaces = agents.filter((a) => a.status.fts.available).length;
  const primary = agents.find((a) => a.agentId === "main") || agents[0];
  const curProv = (memorySearch?.provider as string) || primary?.status.provider || "";
  const curModel = (memorySearch?.model as string) || primary?.status.model || "";
  const curDims = primary?.status.vector.dims || null;
  const isConfigured = Boolean(
    memorySearch &&
    (memorySearch as Record<string, unknown>).provider &&
    (memorySearch as Record<string, unknown>).enabled !== false
  );

  const selectedDocPaths = useMemo(
    () => vectorDocs.filter((doc) => doc.selected).map((doc) => doc.path),
    [vectorDocs],
  );
  const filteredDocs = useMemo(() => {
    const q = docFilter.trim().toLowerCase();
    if (!q) return vectorDocs;
    return vectorDocs.filter((doc) => doc.path.toLowerCase().includes(q));
  }, [vectorDocs, docFilter]);
  const workspaceDocs = useMemo(
    () => vectorDocs.filter((doc) => doc.source === "workspace"),
    [vectorDocs],
  );

  if (loading) {
    return (
      <SectionLayout>
        <ScreenLoadingState size="lg" />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <Database className="h-5 w-5 text-fg-secondary" />
            Vector Memory
          </span>
        }
        description="Semantic search across your documents and memory"
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <button
              onClick={() => { setLoading(true); fetchStatus(); }}
              className="rounded-lg p-2 text-muted-foreground hover:bg-foreground/10 hover:text-fg-secondary"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <SectionBody width="content" padding="regular" innerClassName="space-y-6">

        {/* Section 1: Current Status (only when configured) */}
        {isConfigured && (
          <CurrentStatusCard
            provider={curProv}
            model={curModel}
            dims={curDims}
            totalFiles={totalFiles}
            onDisable={handleDisable}
            onReindex={handleReindexAll}
            disabling={disabling}
            reindexing={reindexingAll}
          />
        )}

        {/* Section 2: Choose Provider */}
        <div>
          <div className="mb-3">
            <h2 className="text-sm font-semibold text-foreground">
              {isConfigured ? "Change Provider" : "Choose a Provider"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {isConfigured
                ? "Switch to a different embedding provider. This will reindex your memory."
                : "Pick an embedding provider to enable semantic search. One click to get started."}
            </p>
          </div>

          {/* OpenAI key prompt (if not authenticated, show before the cards) */}
          {!authProviders.includes("openai") && (
            <div className="mb-3 rounded-xl border border-border bg-card p-3.5 shadow-sm">
              <p className="flex items-center gap-2 text-xs font-medium text-foreground">
                <KeyRound className="h-3.5 w-3.5 shrink-0 text-success-fg" />
                Add OpenAI key to unlock the best quality embeddings
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Get a key at{" "}
                <a
                  href="https://platform.openai.com/api-keys"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-foreground underline hover:text-foreground"
                >
                  platform.openai.com
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
                . ChatGPT Plus does not include API credits.
              </p>
              <OpenAiKeyInline onSave={(key) => handleSaveProviderKey("openai", key)} />
            </div>
          )}

          <ProviderCards
            authProviders={authProviders}
            activeProvider={curProv}
            activeModel={curModel}
            onEnable={handleEnable}
            onSaveGoogleKey={(key) => handleSaveProviderKey("google", key)}
            busy={settingUp}
            busyId={settingUpId}
          />
        </div>

        {/* Stats overview (only when configured and have data) */}
        {isConfigured && agents.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <OverviewStat icon={Layers} value={String(totalChunks)} label="Total Chunks" color="text-fg-secondary dark:text-fg-subtle" />
            <OverviewStat icon={FileText} value={String(totalFiles)} label="Indexed Files" color="text-info-fg" />
            <OverviewStat icon={HardDrive} value={formatBytes(totalDb)} label="DB Size" color="text-success-fg" />
            <OverviewStat icon={Activity} value={`${agents.length - dirtyNamespaces}/${agents.length}`} label="Index Health" sub={dirtyNamespaces > 0 ? `${dirtyNamespaces} namespace${dirtyNamespaces > 1 ? "s" : ""} need reindex` : "All namespaces clean"} color={dirtyNamespaces > 0 ? "text-warning-fg" : "text-success-fg"} />
            <OverviewStat icon={Hash} value={`${vectorReadyNamespaces}/${agents.length}`} label="Vector Ready" sub={`FTS ${ftsReadyNamespaces}/${agents.length}`} color="text-success-fg" />
          </div>
        )}

        {/* Search console (only when configured) */}
        {isConfigured && (
          <>
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground"><Search className="h-4 w-4 text-fg-secondary" />Query Console</div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
                <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doSearch(query); }} placeholder="Semantic search across your vector memory..." aria-label="Semantic search query" className="w-full rounded-lg border border-border bg-muted py-2.5 pl-10 pr-4 text-sm text-foreground placeholder-fg-placeholder outline-none focus:border-success-border dark:placeholder:text-fg-subtle" />
                {searching && <span className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-0.5"><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:0ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:150ms]" /><span className="h-1.5 w-1.5 animate-bounce rounded-full bg-success [animation-delay:300ms]" /></span>}
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5"><Filter className="h-3 w-3 text-fg-subtle" /><span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Filters</span></div>
                <select value={searchAgent} onChange={(e) => setSearchAgent(e.target.value)} aria-label="Filter by namespace" className="rounded-md border border-foreground/10 bg-muted px-2.5 py-1.5 text-xs text-fg-secondary outline-none"><option value="">All namespaces</option>{agents.map((a) => <option key={a.agentId} value={a.agentId}>{a.agentId}</option>)}</select>
                <div className="flex items-center gap-1.5"><span className="text-xs text-fg-subtle">Top-K:</span><select value={maxResults} onChange={(e) => setMaxResults(e.target.value)} aria-label="Top-K results" className="rounded-md border border-foreground/10 bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none">{["3", "5", "10", "20", "50"].map((v) => <option key={v} value={v}>{v}</option>)}</select></div>
                <div className="flex items-center gap-1.5"><span className="text-xs text-fg-subtle">Min score:</span><input type="number" step="0.05" min="0" max="1" value={minScore} onChange={(e) => setMinScore(e.target.value)} placeholder="0.0" aria-label="Minimum score threshold" className="w-16 rounded-md border border-foreground/10 bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none" /></div>
                <div className="flex items-center gap-1.5"><ArrowUpDown className="h-3 w-3 text-fg-subtle" /><select value={sortBy} onChange={(e) => setSortBy(e.target.value as "score" | "path")} aria-label="Sort results by" className="rounded-md border border-foreground/10 bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none"><option value="score">By score</option><option value="path">By path</option></select></div>
              </div>
              {lastQuery && <div className="flex items-center gap-3 text-xs text-muted-foreground"><span>{results.length} result{results.length !== 1 ? "s" : ""} for <span className="font-medium text-success-fg">{"\u201C"}{lastQuery}{"\u201D"}</span></span><span className="text-fg-subtle">&middot;</span><span>{searchTime}ms</span>{results.length > 0 && <><span className="text-fg-subtle">&middot;</span><span>top: <span className={cn("font-mono", scoreColor(results[0].score))}>{results[0].score.toFixed(4)}</span></span></>}</div>}
            </div>

            {sorted.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><BarChart3 className="h-3.5 w-3.5" />Results<span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{sorted.length}</span></div>
                {sorted.map((r, i) => <ResultCard key={r.path + "-" + r.startLine + "-" + i} result={r} rank={i + 1} />)}
              </div>
            )}

            {searchError && !searching && (
              <div className="rounded-xl border border-dashed border-danger-border bg-danger-bg p-8 text-center">
                <AlertTriangle className="mx-auto h-8 w-8 text-danger-fg mb-3" />
                <p className="text-sm text-danger-fg">{searchError}</p>
                <p className="text-xs text-fg-subtle mt-1">Check that the gateway is running and memory is indexed.</p>
              </div>
            )}

            {lastQuery && results.length === 0 && !searching && !searchError && (
              <div className="rounded-xl border border-dashed border-foreground/10 bg-muted/50 p-8 text-center">
                <Search className="mx-auto h-8 w-8 text-fg-subtle mb-3" />
                <p className="text-sm text-muted-foreground">No results for <span className="text-success-fg">{"\u201C"}{lastQuery}{"\u201D"}</span></p>
                <p className="text-xs text-fg-subtle mt-1">Try different keywords or lower the minimum score.</p>
              </div>
            )}

            <div>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold text-foreground"><Database className="h-4 w-4 text-fg-secondary" />Namespaces<span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">{agents.length}</span></h2>
              <div className="space-y-2">{agents.map((a) => <AgentIndexCard key={a.agentId} agent={a} onReindex={handleReindex} onDelete={handleDeleteNamespace} reindexing={reindexingAgents.has(a.agentId)} deleting={deletingNamespace === a.agentId} />)}</div>
            </div>

            <div className="rounded-xl border border-foreground/10 bg-foreground/5 p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileText className="h-4 w-4 text-fg-secondary" />
                    Document indexing
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Select which documents to include in the vector index.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={workspaceDocs.length === 0}
                    onClick={() => {
                      setVectorDocs((prev) =>
                        prev.map((doc) =>
                          doc.source === "workspace" ? { ...doc, selected: true } : { ...doc }
                        )
                      );
                    }}
                    className="rounded-lg border border-border bg-muted px-3 py-2 text-xs font-medium text-fg-secondary hover:bg-muted disabled:opacity-50 dark:bg-secondary dark:hover:bg-secondary"
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    disabled={selectedDocPaths.length === 0}
                    onClick={() => {
                      setVectorDocs((prev) => prev.map((doc) => ({ ...doc, selected: false })));
                    }}
                    className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs font-medium text-danger-fg hover:bg-danger-bg disabled:opacity-50"
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    disabled={savingDocSelection}
                    onClick={() => void handleSaveDocSelection(selectedDocPaths)}
                    className="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {savingDocSelection ? "Saving..." : "Save selection"}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={docFilter}
                  onChange={(e) => setDocFilter(e.target.value)}
                  placeholder="Filter docs..."
                  aria-label="Filter indexable docs"
                  className="min-w-56 flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-success-border"
                />
                <span className="text-xs text-muted-foreground">
                  {selectedDocPaths.length} selected / {vectorDocs.length} total
                </span>
              </div>

              <div className="max-h-64 overflow-auto rounded-lg border border-border bg-card">
                {docsLoading ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">Loading documents...</div>
                ) : filteredDocs.length === 0 ? (
                  <div className="px-3 py-3 text-xs text-muted-foreground">No indexable documents found.</div>
                ) : (
                  filteredDocs.map((doc) => (
                    <label
                      key={doc.path}
                      className="flex cursor-pointer items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted dark:hover:bg-secondary"
                    >
                      <div className="min-w-0 flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={doc.selected}
                          onChange={(e) => {
                            const checked = e.target.checked;
                            setVectorDocs((prev) =>
                              prev.map((row) =>
                                row.path === doc.path ? { ...row, selected: checked } : row
                              )
                            );
                          }}
                          className="rounded border-foreground/20"
                        />
                        <span className="truncate font-mono text-xs text-foreground" title={doc.path}>
                          {doc.path}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {doc.source === "custom" && (
                          <span className="rounded bg-warning-bg px-1.5 py-0.5 text-[10px] font-medium text-warning-fg">
                            Custom
                          </span>
                        )}
                        {doc.selected && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              setVectorDocs((prev) =>
                                prev.map((row) =>
                                  row.path === doc.path ? { ...row, selected: false } : row
                                )
                              );
                            }}
                            className="rounded border border-danger-border bg-danger-bg px-2 py-1 text-[10px] font-medium text-danger-fg hover:bg-danger-bg"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </label>
                  ))
                )}
              </div>
            </div>
          </>
        )}

      </SectionBody>
      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
  );
}

/* ── OpenAI key inline widget ────────────────────── */

function OpenAiKeyInline({ onSave }: { onSave: (key: string) => Promise<boolean> }) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
      <input
        type="password"
        value={key}
        onChange={(e) => setKey(e.target.value)}
        placeholder="sk-..."
        aria-label="OpenAI API key"
        className="flex-1 rounded-lg border border-border bg-muted px-3 py-1.5 font-mono text-xs text-foreground outline-none focus:border-success-border"
      />
      <button
        type="button"
        disabled={saving || !key.trim()}
        onClick={async () => {
          setSaving(true);
          const ok = await onSave(key.trim());
          setSaving(false);
          if (ok) setKey("");
        }}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 whitespace-nowrap"
      >
        {saving ? "Saving..." : "Save key"}
      </button>
    </div>
  );
}
