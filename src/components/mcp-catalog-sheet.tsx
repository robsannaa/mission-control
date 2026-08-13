"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Loader2, Search, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  domainFromUrl,
  faviconUrl,
  FEATURED_CONNECTORS,
  monogram,
  recipeToPreset,
  type CatalogConnector,
  type ConnectorBadge,
  type FormPreset,
  type RegistryConnector,
} from "@/lib/mcp-catalog";

const BADGE_TONE: Record<ConnectorBadge, "success" | "info" | "secondary" | "outline"> = {
  managed: "success",
  official: "info",
  verified: "secondary",
  community: "outline",
};

const BADGE_LABEL: Record<ConnectorBadge, string> = {
  managed: "Managed",
  official: "Official",
  verified: "Verified",
  community: "Community",
};

export function McpCatalogSheet({
  open,
  installedNames,
  isHosted = false,
  onClose,
  onPick,
  onPickManaged,
}: {
  open: boolean;
  installedNames: Set<string>;
  /** AgentBay hosted (VPC) mode — hides connectors that need a self-hosted surface. */
  isHosted?: boolean;
  onClose: () => void;
  onPick: (preset: FormPreset) => void;
  onPickManaged: (provider: "google-calendar") => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RegistryConnector[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setResults(null);
      setSearchErr(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounce.current) clearTimeout(debounce.current);
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/mcp/registry?search=${encodeURIComponent(q)}`, { cache: "no-store" });
        const body = await res.json();
        setResults(Array.isArray(body.connectors) ? body.connectors : []);
        setSearchErr(body.error || null);
      } catch (e) {
        setSearchErr(e instanceof Error ? e.message : String(e));
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [query, open]);

  const featured = useMemo(
    () =>
      FEATURED_CONNECTORS.filter((c) => !(isHosted && c.selfHostedOnly)).filter(
        (c) => !query.trim() || matchesQuery(c, query),
      ),
    [query, isHosted],
  );
  const isSearching = query.trim().length >= 2;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="size-4 text-fg-subtle" /> Browse connectors
          </SheetTitle>
          <SheetDescription>
            Add a ready-to-use tool in one step, or search the official MCP registry for thousands more.
          </SheetDescription>
          <div className="relative mt-3">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connectors — e.g. calendar, github, database…"
              className="pl-9"
              autoFocus
            />
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          {/* Featured */}
          {featured.length > 0 && (
            <section className="space-y-3">
              {!isSearching && (
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">Featured</h3>
              )}
              <div className="grid gap-2.5 sm:grid-cols-2">
                {featured.map((c) => (
                  <FeaturedCard
                    key={c.id}
                    connector={c}
                    installed={installedNames.has(c.name)}
                    onAdd={() => {
                      if (c.recipe.kind === "managed") onPickManaged(c.recipe.provider);
                      else {
                        const preset = recipeToPreset(c.name, c.title, c.recipe);
                        if (preset) onPick(preset);
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Registry search results */}
          {isSearching && (
            <section className="mt-6 space-y-3">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                  From the MCP registry
                </h3>
                {searching && <Loader2 className="size-3 animate-spin text-fg-subtle" />}
              </div>
              {searchErr && !results?.length && (
                <p className="text-xs text-muted-foreground">Registry unavailable right now — featured connectors still work.</p>
              )}
              {results && results.length === 0 && !searching && (
                <p className="text-xs text-muted-foreground">No installable servers matched “{query.trim()}”.</p>
              )}
              <div className="grid gap-2.5 sm:grid-cols-2">
                {(results || []).map((c) => (
                  <RegistryCard
                    key={c.id}
                    connector={c}
                    installed={installedNames.has(c.id)}
                    onAdd={() => {
                      if (c.recipe) onPick({ title: c.title, name: c.id, ...presetFromRegistry(c) });
                    }}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function presetFromRegistry(c: RegistryConnector): Omit<FormPreset, "title" | "name"> {
  const r = c.recipe;
  if (!r || r.kind === "managed") return { transport: "stdio" };
  if (r.kind === "stdio") return { transport: "stdio", command: r.command, args: r.args, secrets: r.env };
  return { transport: r.transport, url: r.url, secrets: r.headers, oauth: r.oauth };
}

/** Real brand favicon with a monogram fallback if it fails to load. */
export function ConnectorIcon({
  domain,
  accent,
  title,
}: {
  domain?: string;
  accent: string;
  title: string;
}) {
  const [errored, setErrored] = useState(false);
  const url = faviconUrl(domain);
  if (url && !errored) {
    return (
      <div className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-card">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt=""
          className="size-5 object-contain"
          loading="lazy"
          onError={() => setErrored(true)}
        />
      </div>
    );
  }
  return (
    <div
      className="flex size-9 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
      style={{ backgroundColor: accent }}
      aria-hidden
    >
      {monogram(title)}
    </div>
  );
}

function FeaturedCard({
  connector,
  installed,
  onAdd,
}: {
  connector: CatalogConnector;
  installed: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 transition-colors hover:border-border-strong">
      <div className="flex items-start gap-3">
        <ConnectorIcon
          domain={connector.icon || domainFromUrl(connector.homepage)}
          accent={connector.accent}
          title={connector.title}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold text-foreground">{connector.title}</span>
            {connector.badge && (
              <Badge variant={BADGE_TONE[connector.badge]} className="shrink-0">
                {BADGE_LABEL[connector.badge]}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{connector.description}</p>
        </div>
      </div>
      <div className="flex justify-end">
        {installed ? (
          <span className="text-xs font-medium text-success-fg">Added</span>
        ) : (
          <Button size="xs" variant="secondary" onClick={onAdd}>
            {connector.recipe.kind === "managed" ? "Connect" : "Add"}
            <ArrowRight className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function RegistryCard({
  connector,
  installed,
  onAdd,
}: {
  connector: RegistryConnector;
  installed: boolean;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5 transition-colors hover:border-border-strong">
      <div className="flex items-start gap-3">
        <ConnectorIcon domain={domainFromUrl(connector.homepage)} accent="#64748B" title={connector.title} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground">{connector.title}</span>
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {connector.description || "No description provided."}
          </p>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <Badge variant="outline" className="capitalize">
          {connector.recipe?.kind === "http" ? "HTTP" : "Local"}
        </Badge>
        {installed ? (
          <span className="text-xs font-medium text-success-fg">Added</span>
        ) : (
          <Button size="xs" variant="secondary" onClick={onAdd}>
            Add
            <ArrowRight className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function matchesQuery(c: CatalogConnector, q: string): boolean {
  const t = q.toLowerCase();
  return (
    c.title.toLowerCase().includes(t) ||
    c.description.toLowerCase().includes(t) ||
    c.category.includes(t)
  );
}
