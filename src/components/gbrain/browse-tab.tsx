"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpRight,
  Clock,
  FileText,
  Link2,
  Loader2,
  Network,
  RotateCcw,
  Tag as TagIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { MarkdownContent } from "@/components/markdown-content";
import { runGbrainCommand } from "./api";
import {
  parseGraphQuery,
  parseHistory,
  parsePageList,
  parseTags,
  parseTimeline,
  splitFrontmatter,
  type PageListItem,
} from "./parse";
import { Disclosure, EmptyState, Panel, Pill } from "./primitives";

type Backlink = { from_slug?: string; link_type?: string; context?: string };

/* ── Lazy, fetch-on-open section used inside the page reader ────────────── */

function LazySection({
  label,
  icon,
  load,
  render,
  deps,
}: {
  label: string;
  icon: ReactNode;
  load: () => Promise<{ ok: boolean; error?: string; stdout: string }>;
  render: (stdout: string) => ReactNode;
  /** Re-fetch when these change (e.g. the selected slug). */
  deps: unknown[];
}) {
  const [state, setState] = useState<{ loading: boolean; error: string | null; stdout: string | null }>({
    loading: false,
    error: null,
    stdout: null,
  });

  const fetchOnce = useCallback(async () => {
    setState({ loading: true, error: null, stdout: null });
    const d = await load();
    setState({ loading: false, error: d.ok ? null : d.error || "Failed to load", stdout: d.ok ? d.stdout : null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Reset when the underlying page changes so re-opening fetches fresh data.
  useEffect(() => { setState({ loading: false, error: null, stdout: null }); }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Disclosure
      label={<span className="inline-flex items-center gap-1.5">{icon}{label}</span>}
      onOpenChange={(open) => { if (open && state.stdout === null && !state.loading) void fetchOnce(); }}
    >
      {state.loading && (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </div>
      )}
      {state.error && (
        <p className="flex items-start gap-1.5 py-2 text-xs text-danger-fg">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {state.error}
        </p>
      )}
      {state.stdout !== null && !state.loading && render(state.stdout)}
    </Disclosure>
  );
}

/* ── Page reader ──────────────────────────────────────────────────────── */

function PageReader({ slug, onNavigate }: { slug: string; onNavigate: (slug: string) => void }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState("");

  // The parent keys this component by `slug`, so a slug change is a fresh
  // mount — the initial `loading`/`error` state above is already correct
  // and this effect only needs to fetch, not reset anything.
  useEffect(() => {
    let cancelled = false;
    void runGbrainCommand("get", { slug }).then((d) => {
      if (cancelled) return;
      if (d.ok) setContent(d.stdout);
      else setError(d.error || "Could not read this page.");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [slug]);

  const { meta, body } = splitFrontmatter(content);

  return (
    <Panel className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border-subtle px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <FileText className="h-4 w-4 shrink-0 text-info-fg" />
          <span className="truncate font-mono text-sm font-medium text-foreground">{slug}</span>
        </div>
        {Object.keys(meta).length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {meta.type && <Pill tone="neutral">{meta.type}</Pill>}
            {meta.ingested_at && <Pill tone="unknown" title="Ingested at">{new Date(meta.ingested_at).toLocaleDateString()}</Pill>}
            {meta.aliases && <Pill tone="unknown" title="Aliases">{meta.aliases}</Pill>}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading…
          </div>
        ) : error ? (
          <p className="flex items-start gap-1.5 text-sm text-danger-fg">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
          </p>
        ) : (
          <MarkdownContent content={body} className="[&_p]:text-sm [&_p]:leading-relaxed [&_h1]:text-base [&_h2]:text-sm" />
        )}
      </div>

      {!loading && !error && (
        <div className="shrink-0 space-y-3 border-t border-border-subtle px-5 py-4">
          <LazySection
            label="Backlinks"
            icon={<Link2 className="h-3.5 w-3.5" />}
            load={() => runGbrainCommand("backlinks", { slug })}
            deps={[slug]}
            render={(stdout) => {
              let links: Backlink[] = [];
              try { links = JSON.parse(stdout); } catch { links = []; }
              if (!Array.isArray(links) || links.length === 0) return <p className="text-xs text-muted-foreground">No pages link here yet.</p>;
              return (
                <ul className="space-y-1.5">
                  {links.map((l, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <button type="button" onClick={() => l.from_slug && onNavigate(l.from_slug)} className="truncate font-mono text-fg-secondary hover:text-foreground hover:underline">
                        {l.from_slug}
                      </button>
                      {l.link_type && <span className="shrink-0 text-fg-subtle">{l.link_type}</span>}
                    </li>
                  ))}
                </ul>
              );
            }}
          />
          <LazySection
            label="Graph (1 hop)"
            icon={<Network className="h-3.5 w-3.5" />}
            load={() => runGbrainCommand("graph-query", { slug, depth: "1" })}
            deps={[slug]}
            render={(stdout) => {
              const { edges } = parseGraphQuery(stdout);
              if (edges.length === 0) return <p className="text-xs text-muted-foreground">No connections found.</p>;
              return (
                <ul className="space-y-1.5">
                  {edges.map((e, i) => (
                    <li key={i} className="flex items-center gap-2 text-xs">
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-fg-secondary">{e.relation}</span>
                      <button type="button" onClick={() => onNavigate(e.target)} className="truncate font-mono text-fg-secondary hover:text-foreground hover:underline">
                        {e.target}
                      </button>
                    </li>
                  ))}
                </ul>
              );
            }}
          />
          <LazySection
            label="Timeline"
            icon={<Clock className="h-3.5 w-3.5" />}
            load={() => runGbrainCommand("timeline", { slug })}
            deps={[slug]}
            render={(stdout) => {
              const entries = parseTimeline(stdout);
              if (entries.length === 0) return <p className="text-xs text-muted-foreground">No timeline entries.</p>;
              return (
                <ul className="space-y-2">
                  {entries.slice(0, 20).map((e, i) => (
                    <li key={i} className="flex items-start gap-2 text-xs">
                      <span className="mt-0.5 shrink-0 tabular-nums text-fg-subtle">{e.date.slice(0, 10)}</span>
                      <span className="min-w-0 text-fg-secondary">{e.text}</span>
                    </li>
                  ))}
                </ul>
              );
            }}
          />
          <LazySection
            label="Tags"
            icon={<TagIcon className="h-3.5 w-3.5" />}
            load={() => runGbrainCommand("tags", { slug })}
            deps={[slug]}
            render={(stdout) => {
              const tags = parseTags(stdout);
              if (tags.length === 0) return <p className="text-xs text-muted-foreground">No tags.</p>;
              return (
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((t) => <Pill key={t} tone="neutral">{t}</Pill>)}
                </div>
              );
            }}
          />
          <LazySection
            label="History"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            load={() => runGbrainCommand("history", { slug })}
            deps={[slug]}
            render={(stdout) => {
              const versions = parseHistory(stdout);
              if (versions.length === 0) return <p className="text-xs text-muted-foreground">No prior versions.</p>;
              return (
                <ul className="space-y-2">
                  {versions.slice(0, 10).map((v) => (
                    <li key={v.version} className="flex items-start justify-between gap-2 text-xs">
                      <span className="min-w-0">
                        <span className="font-mono text-fg-subtle">#{v.version}</span>{" "}
                        <span className="tabular-nums text-fg-subtle">{v.date.slice(0, 16).replace("T", " ")}</span>{" "}
                        <span className="text-fg-secondary">{v.preview}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              );
            }}
          />
        </div>
      )}
    </Panel>
  );
}

/* ── Browse tab ───────────────────────────────────────────────────────── */

export function BrowseTab({
  selectedSlug,
  onSelectSlug,
}: {
  selectedSlug: string | null;
  onSelectSlug: (slug: string) => void;
}) {
  const [type, setType] = useState("");
  const [tag, setTag] = useState("");
  const [items, setItems] = useState<PageListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (nextType: string, nextTag: string) => {
    setLoading(true);
    const values: Record<string, string> = { n: "200" };
    if (nextType.trim()) values.type = nextType.trim();
    if (nextTag.trim()) values.tag = nextTag.trim();
    const d = await runGbrainCommand("list", values);
    setItems(d.ok ? parsePageList(d.stdout) : []);
    setLoading(false);
  }, []);

  // Mount-only initial load (self-contained, no external deps) — filter
  // changes below trigger their own load directly from the input handlers
  // instead of a reactive effect.
  useEffect(() => {
    let cancelled = false;
    void runGbrainCommand("list", { n: "200" }).then((d) => {
      if (cancelled) return;
      setItems(d.ok ? parsePageList(d.stdout) : []);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const onFilterChange = useCallback((nextType: string, nextTag: string) => {
    setType(nextType);
    setTag(nextTag);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(nextType, nextTag), 250);
  }, [load]);

  const types = [...new Set(items.map((i) => i.type))].sort();

  return (
    <div className="flex min-h-[32rem] flex-col gap-5 lg:h-[calc(100vh-16rem)] lg:flex-row">
      {/* Left — filters + list */}
      <div className="flex min-h-0 shrink-0 flex-col gap-3 lg:w-80">
        <div className="flex gap-2">
          <Input value={type} onChange={(e) => onFilterChange(e.target.value, tag)} placeholder="type" className="h-8 text-xs" list="gbrain-types" />
          <datalist id="gbrain-types">
            {types.map((t) => <option key={t} value={t} />)}
          </datalist>
          <Input value={tag} onChange={(e) => onFilterChange(type, e.target.value)} placeholder="tag" className="h-8 text-xs" />
        </div>
        <Panel className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading pages…
            </div>
          ) : items.length === 0 ? (
            <EmptyState title="No pages found" description="Try clearing the filters." className="border-0 py-10" />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {items.map((it) => (
                <li key={it.slug}>
                  <button
                    type="button"
                    onClick={() => onSelectSlug(it.slug)}
                    className={cn(
                      "flex w-full flex-col items-start gap-0.5 px-3.5 py-2.5 text-left transition-colors hover:bg-accent",
                      selectedSlug === it.slug && "bg-accent",
                    )}
                  >
                    <span className="w-full truncate text-sm font-medium text-foreground">{it.title || it.slug}</span>
                    <span className="flex w-full items-center gap-1.5 text-xs text-fg-subtle">
                      <span className="capitalize">{it.type}</span>
                      {it.date && <><span>·</span><span>{it.date}</span></>}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <p className="px-1 text-xs text-fg-subtle">{items.length} page{items.length === 1 ? "" : "s"}</p>
      </div>

      {/* Right — reader */}
      <div className="flex min-h-0 flex-1 flex-col">
        {selectedSlug ? (
          <PageReader key={selectedSlug} slug={selectedSlug} onNavigate={onSelectSlug} />
        ) : (
          <EmptyState
            icon={<ArrowUpRight className="h-8 w-8" />}
            title="Pick a page"
            description="Choose a page on the left, or open one from Search, to read it — with its backlinks, graph, timeline, tags and history."
            className="flex-1 py-16"
          />
        )}
      </div>
    </div>
  );
}
