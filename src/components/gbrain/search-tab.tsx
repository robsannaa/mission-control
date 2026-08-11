"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, FileText, Loader2, Search as SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { runGbrainCommand } from "./api";
import { parseSearchResults, type SearchHit } from "./parse";
import { Bar, EmptyState, Panel, Pill, SegmentedControl } from "./primitives";

type Mode = "ask" | "keyword";

function SlugPath({ slug }: { slug: string }) {
  const parts = slug.split("/");
  return (
    <span className="flex min-w-0 items-baseline gap-1 truncate font-mono text-sm text-foreground">
      {parts.map((p, i) => (
        <span key={i} className="flex items-baseline gap-1">
          {i > 0 && <span className="text-fg-subtle">/</span>}
          <span className={i === parts.length - 1 ? "font-medium" : "text-muted-foreground"}>{p}</span>
        </span>
      ))}
    </span>
  );
}

function ResultCard({ hit, rank, maxScore, onOpen }: { hit: SearchHit; rank: number; maxScore: number; onOpen: (slug: string) => void }) {
  const pct = maxScore > 0 ? (hit.score / maxScore) * 100 : 0;
  return (
    <Panel className="p-4 transition-colors hover:border-border-strong">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted text-[11px] font-bold text-fg-secondary">
            {rank}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <FileText className="h-3.5 w-3.5 shrink-0 text-info-fg" />
              <SlugPath slug={hit.slug} />
              {hit.stale && <Pill tone="attention">stale</Pill>}
            </div>
            <p className="mt-1.5 line-clamp-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {hit.snippet.replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\n+/g, " ")}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => onOpen(hit.slug)}
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-accent"
        >
          Open <ArrowRight className="h-3 w-3" />
        </button>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Bar pct={pct} tone={pct > 66 ? "positive" : pct > 33 ? "attention" : "neutral"} className="w-24" />
        <span className="text-xs tabular-nums text-fg-subtle">score {hit.score.toFixed(2)}</span>
      </div>
    </Panel>
  );
}

export function SearchTab({ onOpenPage }: { onOpenPage: (slug: string) => void }) {
  const [mode, setMode] = useState<Mode>("ask");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [lastQuery, setLastQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  const doSearch = useCallback(async (q: string, searchMode: Mode) => {
    if (!q || q.trim().length < 2) {
      setResults([]);
      setLastQuery("");
      setError(null);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    setError(null);
    const d = await runGbrainCommand(searchMode === "ask" ? "query" : "search", { q: q.trim() });
    if (seq !== seqRef.current) return; // superseded by a newer search
    if (d.ok) {
      setResults(parseSearchResults(d.stdout));
      setLastQuery(q);
    } else {
      setResults([]);
      setError(d.error || "Search failed");
    }
    setSearching(false);
  }, []);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void doSearch(query, mode), 400);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, mode]);

  const maxScore = results.reduce((m, r) => Math.max(m, r.score), 0);

  return (
    <div className="space-y-5">
      <Panel className="p-4">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void doSearch(query, mode); }}
            placeholder="Ask your brain anything…"
            aria-label="Search your brain"
            className="h-11 pl-10 pr-4 text-sm"
          />
          {searching && <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-fg-subtle" />}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <SegmentedControl
            options={[
              { value: "ask" as Mode, label: "Ask (hybrid)" },
              { value: "keyword" as Mode, label: "Keyword" },
            ]}
            value={mode}
            onChange={setMode}
          />
          <p className="text-xs text-fg-subtle">
            {mode === "ask" ? "Ranked by hybrid RRF — keyword + embeddings, with query expansion." : "Ranked by keyword match (tsvector)."}
          </p>
        </div>
      </Panel>

      {lastQuery && !searching && (
        <p className="px-1 text-xs text-muted-foreground">
          {results.length} result{results.length === 1 ? "" : "s"} for <span className="font-medium text-foreground">&ldquo;{lastQuery}&rdquo;</span>
        </p>
      )}

      {results.length > 0 && (
        <div className="space-y-2.5">
          {results.map((hit, i) => (
            <ResultCard key={`${hit.slug}-${i}`} hit={hit} rank={i + 1} maxScore={maxScore} onOpen={onOpenPage} />
          ))}
        </div>
      )}

      {error && !searching && (
        <EmptyState
          icon={<SearchIcon className="h-8 w-8" />}
          title="Search failed"
          description={error}
        />
      )}

      {lastQuery && results.length === 0 && !searching && !error && (
        <EmptyState
          icon={<SearchIcon className="h-8 w-8" />}
          title={`No results for “${lastQuery}”`}
          description="Try different words, or switch modes."
        />
      )}

      {!lastQuery && !searching && (
        <EmptyState
          icon={<SearchIcon className="h-8 w-8" />}
          title="Search your brain"
          description="Hybrid search understands meaning, not just words — try a full question."
          className="py-16"
        />
      )}
    </div>
  );
}
