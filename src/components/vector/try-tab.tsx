"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown, ChevronUp, Copy, Eye, FileText, RefreshCw, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMemory, SearchResult, VectorDocOption } from "./types";
import { Disclosure, Panel, StatusDot } from "./primitives";
import { formatMatchPercent, matchTone, pluralize } from "./format";

function Dots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}

/* ── Result card ───────────────────────────────────── */

function ResultCard({ result, rank }: { result: SearchResult; rank: number }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  return (
    <Panel className="shadow-sm transition-colors hover:border-border-strong">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-bold text-fg-secondary dark:bg-secondary">
          {rank}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-info-fg" />
            <span className="truncate text-sm font-medium text-foreground">{result.path}</span>
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
              L{result.startLine}-{result.endLine}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 rounded-full bg-foreground/10">
            <div
              className={cn(
                "h-1.5 rounded-full transition-all",
                matchTone(result.score) === "positive"
                  ? "bg-success"
                  : matchTone(result.score) === "attention"
                    ? "bg-warning"
                    : "bg-fg-subtle"
              )}
              style={{ width: `${Math.round(Math.max(0, Math.min(1, result.score)) * 100)}%` }}
            />
          </div>
          <span className="w-10 text-right text-xs font-medium text-fg-secondary">{formatMatchPercent(result.score)}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              navigator.clipboard.writeText(result.snippet);
              setCopied(true);
              if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
              copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
            title="Copy text"
            aria-label="Copy snippet"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-success-fg" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
            aria-label={expanded ? "Collapse" : "Show full text"}
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
      {!expanded && (
        <div className="border-t border-border px-4 py-2">
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {result.snippet.replace(/\n+/g, " ").substring(0, 200)}
          </p>
        </div>
      )}
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-3 text-xs leading-5 text-muted-foreground whitespace-pre-wrap break-words">
            {result.snippet}
          </pre>
        </div>
      )}
    </Panel>
  );
}

/* ── Try it tab ────────────────────────────────────── */

type TryTabProps = {
  agents: AgentMemory[];
  isConfigured: boolean;
  providerLabel: string;
  modelLabel: string;
  totalFiles: number;
  totalChunks: number;
  anyDirty: boolean;
  onGoToSettings: () => void;
  onReindexAll: () => void;
  reindexingAll: boolean;
};

export function TryTab({
  agents,
  isConfigured,
  providerLabel,
  modelLabel,
  totalFiles,
  totalChunks,
  anyDirty,
  onGoToSettings,
  onReindexAll,
  reindexingAll,
}: TryTabProps) {
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [maxResults, setMaxResults] = useState("10");
  const [minScore, setMinScore] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchAbortRef = useRef<AbortController | null>(null);

  const [docs, setDocs] = useState<VectorDocOption[] | null>(null);
  const [docsLoading, setDocsLoading] = useState(false);

  const doSearch = useCallback(
    async (q: string) => {
      if (!q || q.trim().length < 2) {
        setResults([]);
        setLastQuery("");
        setSearchError(null);
        return;
      }
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearching(true);
      setSearchError(null);
      try {
        const p = new URLSearchParams({ scope: "search", q: q.trim(), max: maxResults });
        if (namespace) p.set("agent", namespace);
        if (minScore) p.set("minScore", minScore);
        const res = await fetch("/api/vector?" + p, { signal: controller.signal });
        if (!res.ok) throw new Error(`Search failed (${res.status})`);
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setResults(data.results || []);
        setLastQuery(q);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setResults([]);
        setSearchError(err instanceof Error ? err.message : "Search failed");
      } finally {
        setSearching(false);
      }
    },
    [namespace, maxResults, minScore]
  );

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => doSearch(query), 400);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [query, doSearch]);

  const fetchDocsOnce = useCallback(() => {
    if (docs !== null || docsLoading) return;
    setDocsLoading(true);
    fetch("/api/vector?scope=documents")
      .then((res) => res.json())
      .then((data) => setDocs(Array.isArray(data.docs) ? data.docs : []))
      .catch(() => setDocs([]))
      .finally(() => setDocsLoading(false));
  }, [docs, docsLoading]);

  const dbSummary = useMemo(() => {
    if (totalFiles === 0) return "Nothing indexed yet.";
    return `Searching ${pluralize(totalChunks, "piece")} of memory from ${pluralize(totalFiles, "file")}.`;
  }, [totalFiles, totalChunks]);

  return (
    <div className="space-y-5">
      {/* Status line — quiet by default; colour only where something needs attention. */}
      {!isConfigured ? (
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2.5">
            <StatusDot tone="neutral" />
            <p className="text-sm text-foreground">Semantic search isn&apos;t set up yet.</p>
          </div>
          <button
            type="button"
            data-control-radius="pill"
            onClick={onGoToSettings}
            className="rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-accent"
          >
            Set it up
          </button>
        </Panel>
      ) : anyDirty ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-center gap-2.5">
            <StatusDot tone="attention" />
            <p className="text-sm text-foreground">
              A little behind — some new content hasn&apos;t been searched yet.
            </p>
          </div>
          <button
            type="button"
            data-control-radius="pill"
            onClick={onReindexAll}
            disabled={reindexingAll}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-accent disabled:opacity-50"
          >
            {reindexingAll ? <><Dots />Updating…</> : <><RefreshCw className="h-3 w-3" />Update now</>}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 px-1">
          <StatusDot tone="positive" />
          <p className="text-sm text-muted-foreground">
            Semantic search is on, using <span className="text-foreground">{providerLabel}</span>. {dbSummary}
          </p>
        </div>
      )}

      {/* Search box */}
      <Panel className="p-4 shadow-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") doSearch(query); }}
            placeholder={isConfigured ? "Search your memory…" : "Set up search below to try it here…"}
            disabled={!isConfigured}
            aria-label="Search your memory"
            className="w-full rounded-lg border border-border bg-muted py-2.5 pl-10 pr-4 text-sm text-foreground placeholder-fg-placeholder outline-none focus:border-border-strong disabled:opacity-60 dark:placeholder:text-fg-subtle"
          />
          {searching && (
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-fg-subtle"><Dots /></span>
          )}
        </div>

        {isConfigured && (
          <Disclosure label="Search options" className="mt-3">
            <div className="flex flex-wrap items-center gap-3">
              {agents.length > 1 && (
                <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
                  Where:
                  <select
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    aria-label="Limit search to one agent"
                    className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none"
                  >
                    <option value="">Everywhere</option>
                    {agents.map((a) => (
                      <option key={a.agentId} value={a.agentId}>{a.agentId}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
                Results:
                <select
                  value={maxResults}
                  onChange={(e) => setMaxResults(e.target.value)}
                  aria-label="Number of results"
                  className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none"
                >
                  {["3", "5", "10", "20", "50"].map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-xs text-fg-subtle">
                Minimum match:
                <input
                  type="number"
                  step="0.05"
                  min="0"
                  max="1"
                  value={minScore}
                  onChange={(e) => setMinScore(e.target.value)}
                  placeholder="any"
                  aria-label="Minimum match strength, 0 to 1"
                  className="w-16 rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none"
                />
              </label>
            </div>
          </Disclosure>
        )}
      </Panel>

      {lastQuery && !searching && (
        <p className="px-1 text-xs text-muted-foreground">
          {pluralize(results.length, "result")} for <span className="font-medium text-foreground">&ldquo;{lastQuery}&rdquo;</span>
        </p>
      )}

      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <ResultCard key={r.path + "-" + r.startLine + "-" + i} result={r} rank={i + 1} />
          ))}
        </div>
      )}

      {searchError && !searching && (
        <Panel className="border-dashed p-8 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-danger-fg mb-3" />
          <p className="text-sm text-danger-fg">{searchError}</p>
        </Panel>
      )}

      {lastQuery && results.length === 0 && !searching && !searchError && (
        <Panel className="border-dashed p-8 text-center">
          <Search className="mx-auto h-8 w-8 text-fg-subtle mb-3" />
          <p className="text-sm text-muted-foreground">
            No results for <span className="text-foreground">&ldquo;{lastQuery}&rdquo;</span>
          </p>
          <p className="text-xs text-fg-subtle mt-1">Try different words, or widen the minimum match.</p>
        </Panel>
      )}

      {/* Browse — what's actually indexed, read-only. Managing it lives in Settings. */}
      {isConfigured && !lastQuery && (
        <Disclosure
          label={`Browse indexed files (${totalFiles})`}
          onOpenChange={(open) => { if (open) fetchDocsOnce(); }}
          className="px-1"
        >
          <div className="max-h-64 overflow-auto rounded-lg border border-border bg-card">
            {docsLoading || docs === null ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
            ) : docs.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">Nothing indexed yet.</div>
            ) : (
              docs
                .filter((d) => d.selected || d.source === "workspace")
                .slice(0, 500)
                .map((d) => (
                  <div key={d.path} className="border-b border-border px-3 py-2 last:border-b-0">
                    <span className="truncate font-mono text-xs text-fg-secondary" title={d.path}>{d.path}</span>
                  </div>
                ))
            )}
          </div>
        </Disclosure>
      )}
    </div>
  );
}
