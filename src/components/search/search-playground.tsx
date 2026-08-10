"use client";

/**
 * The "Try it" search box: types a query, runs the real agent `web_search`
 * tool through the live gateway, and lists what comes back. Each result can
 * be expanded to read the whole page and save it into memory — see
 * `ResultItem`.
 */

import { useCallback, useRef, useState } from "react";
import { Search, Loader2, CircleAlert, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ResultItem } from "@/components/search/result-item";
import type { NormalizedSearchResult } from "@/components/search/providers";

export function SearchPlayground({ disabled, disabledReason }: { disabled: boolean; disabledReason: string | null }) {
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<NormalizedSearchResult[] | null>(null);
  const [meta, setMeta] = useState<{ provider: string; tookMs: number | null; cached: boolean } | null>(null);
  const [error, setError] = useState<{ reason: string; technical?: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const run = useCallback(async () => {
    const q = query.trim();
    if (!q || running) return;
    setRunning(true);
    setError(null);
    setResults(null);
    setMeta(null);
    try {
      const res = await fetch("/api/search/web/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: q, count: 6 }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError({ reason: data.reason || "Search failed.", technical: data.technical });
        return;
      }
      setResults(data.results || []);
      setMeta({ provider: data.provider, tookMs: data.tookMs, cached: data.cached });
    } catch (err) {
      setError({ reason: "Mission Control couldn't reach OpenClaw to run this search.", technical: String(err) });
    } finally {
      setRunning(false);
    }
  }, [query, running]);

  return (
    <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-fg-secondary" />
        <h2 className="text-sm font-semibold text-foreground">Try it</h2>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
        Search the web the same way your agent does. This is the real thing — if results come back, web search
        works; if it fails, you&rsquo;ll see the actual reason below.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled) void run();
            }}
            placeholder={disabled ? "Set up a provider first" : "Ask anything — try “weather in Lisbon this week”"}
            disabled={disabled || running}
            className="h-11 w-full rounded-full border border-border bg-card pl-10 pr-4 text-sm text-foreground outline-none transition-colors placeholder:text-fg-placeholder focus-visible:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          />
        </div>
        <Button
          type="button"
          size="lg"
          onClick={() => void run()}
          disabled={disabled || running || !query.trim()}
          className="rounded-full sm:w-auto"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          {running ? "Searching…" : "Search"}
        </Button>
      </div>

      {disabled && disabledReason && (
        <p className="mt-3 text-xs leading-relaxed text-fg-subtle">{disabledReason}</p>
      )}

      {error && (
        <div className="mt-4 rounded-xl border border-danger-border bg-danger-bg px-4 py-3">
          <p className="flex items-start gap-2 text-sm text-danger-fg">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            {error.reason}
          </p>
          {error.technical && (
            <p className="mt-1.5 pl-6 font-mono text-xs leading-relaxed text-danger-fg/70">{error.technical}</p>
          )}
        </div>
      )}

      {results && (
        <div className="mt-4">
          {meta && (
            <p className="text-xs text-fg-subtle">
              Answered by <span className="font-medium text-fg-secondary">{meta.provider}</span>
              {typeof meta.tookMs === "number" ? ` in ${(meta.tookMs / 1000).toFixed(1)}s` : ""}
              {meta.cached ? " · from cache" : ""}
            </p>
          )}
          {results.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">No results for that search. Try different words.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border-subtle">
              {results.map((r, i) => (
                <ResultItem key={`${r.url}-${i}`} result={r} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
