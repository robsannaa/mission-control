"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  type Edge,
  type Node,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { ArrowRight, FileText, Focus, Network, Search } from "lucide-react";
import { useTheme } from "next-themes";
import { MarkdownContent } from "@/components/markdown-content";
import { Input } from "@/components/ui/input";
import { ContentLoadingState, InlineSpinner } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import { runGbrainCommand } from "./api";
import {
  parseGraphQuery,
  parseHealth,
  parsePageList,
  splitFrontmatter,
  type GraphEdge,
  type PageListItem,
} from "./parse";
import { EmptyState, Panel, Pill, Stat } from "./primitives";
import type { Overview } from "./types";

const NODE_WIDTH = 216;
const NODE_HEIGHT = 66;

function titleFor(page: PageListItem | undefined, slug: string): string {
  return page?.title || slug.split("/").pop()?.replace(/[-_]+/g, " ") || slug;
}

function relationLabel(value: string): string {
  return value.replace(/[_-]+/g, " ");
}

function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length < 2) return nodes;
  const Graph = dagre.graphlib?.Graph;
  if (!Graph || !dagre.layout) return nodes;
  const graph = new Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 82, marginx: 32, marginy: 32 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  return nodes.map((node) => {
    const point = graph.node(node.id);
    return point
      ? { ...node, position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 } }
      : node;
  });
}

function uniqueEdges(edges: GraphEdge[]): GraphEdge[] {
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.source}\u0000${edge.relation}\u0000${edge.target}`;
    if (seen.has(key) || edge.source === edge.target) return false;
    seen.add(key);
    return true;
  });
}

export function GraphTab({
  overview,
  onOpenPage,
}: {
  overview: Overview | null;
  onOpenPage: (slug: string) => void;
}) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";
  const [pages, setPages] = useState<PageListItem[]>([]);
  const [root, setRoot] = useState("");
  const [rootDraft, setRootDraft] = useState("");
  const [depth, setDepth] = useState(2);
  const [graphEdges, setGraphEdges] = useState<GraphEdge[]>([]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [pagePreview, setPagePreview] = useState<{ slug: string; body: string } | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const health = useMemo(() => parseHealth(overview?.health), [overview?.health]);
  const pageBySlug = useMemo(() => new Map(pages.map((page) => [page.slug, page])), [pages]);

  const loadNeighborhood = useCallback(async (nextRoot: string, nextDepth: number) => {
    if (!nextRoot.trim()) return;
    setLoading(true);
    setError(null);
    const result = await runGbrainCommand("graph-query", {
      slug: nextRoot.trim(),
      depth: String(nextDepth),
    });
    if (!result.ok) {
      setGraphEdges([]);
      setError(result.error || "Could not read this part of the graph.");
    } else {
      const parsed = parseGraphQuery(result.stdout);
      setGraphEdges(uniqueEdges(parsed.edges));
      setRoot(parsed.root || nextRoot.trim());
      setRootDraft(parsed.root || nextRoot.trim());
      setSelectedSlug(parsed.root || nextRoot.trim());
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void runGbrainCommand("list", { n: "200" }).then(async (result) => {
      if (cancelled) return;
      const nextPages = result.ok ? parsePageList(result.stdout) : [];
      setPages(nextPages);
      const suggested =
        parseHealth(overview?.health)?.mostConnected[0]?.slug ||
        nextPages.find((page) => ["person", "company", "project"].includes(page.type))?.slug ||
        nextPages[0]?.slug ||
        "";
      if (!suggested) {
        setLoading(false);
        return;
      }
      setRoot(suggested);
      setRootDraft(suggested);
      await loadNeighborhood(suggested, 2);
    });
    return () => { cancelled = true; };
  }, [loadNeighborhood, overview?.health]);

  useEffect(() => {
    if (!selectedSlug) return;
    let cancelled = false;
    const slug = selectedSlug;
    void runGbrainCommand("get", { slug: selectedSlug }).then((result) => {
      if (cancelled) return;
      setPagePreview({ slug, body: result.ok ? splitFrontmatter(result.stdout).body.trim() : "" });
    });
    return () => { cancelled = true; };
  }, [selectedSlug]);

  const relationTypes = useMemo(
    () => [...new Set(graphEdges.map((edge) => edge.relation))].sort(),
    [graphEdges],
  );

  const flow = useMemo(() => {
    const ids = new Set<string>();
    if (root) ids.add(root);
    for (const edge of graphEdges) {
      ids.add(edge.source);
      ids.add(edge.target);
    }
    const nodes: Node[] = [...ids].map((id) => {
      const page = pageBySlug.get(id);
      const focused = id === root;
      const selected = id === selectedSlug;
      return {
        id,
        position: { x: 0, y: 0 },
        data: {
          label: (
            <div className="min-w-0 px-1 text-left">
              <div className="truncate text-sm font-semibold">{titleFor(page, id)}</div>
              <div className={cn("mt-1 truncate text-[10px] uppercase tracking-[0.14em]", focused ? "opacity-65" : "text-fg-subtle")}>
                {page?.type || "page"}
              </div>
            </div>
          ),
        },
        style: {
          width: NODE_WIDTH,
          minHeight: NODE_HEIGHT,
          borderRadius: 14,
          border: selected ? "1px solid var(--foreground)" : "1px solid var(--border)",
          boxShadow: selected ? "0 0 0 3px var(--accent)" : "0 1px 2px rgba(0,0,0,.04)",
          background: focused ? "var(--foreground)" : "var(--card)",
          color: focused ? "var(--background)" : "var(--foreground)",
          padding: "12px 14px",
        },
      };
    });
    const edges: Edge[] = graphEdges.map((edge, index) => ({
      id: `${edge.source}-${edge.relation}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      label: relationLabel(edge.relation),
      markerEnd: { type: MarkerType.ArrowClosed, color: "var(--border-strong)" },
      style: { stroke: "var(--border-strong)", strokeWidth: edge.depth === 1 ? 1.5 : 1 },
      labelStyle: { fill: "var(--muted-foreground)", fontSize: 10, fontWeight: 500 },
      labelBgStyle: { fill: "var(--card)", fillOpacity: 0.92 },
      labelBgPadding: [5, 3],
      labelBgBorderRadius: 4,
    }));
    return { nodes: layoutGraph(nodes, edges), edges };
  }, [graphEdges, pageBySlug, root, selectedSlug]);

  const selectedPage = selectedSlug ? pageBySlug.get(selectedSlug) : undefined;
  const selectedBody = pagePreview?.slug === selectedSlug ? pagePreview.body : "";
  const loadingPage = Boolean(selectedSlug && pagePreview?.slug !== selectedSlug);
  const selectedEdges = selectedSlug
    ? graphEdges.filter((edge) => edge.source === selectedSlug || edge.target === selectedSlug)
    : [];

  useEffect(() => {
    if (!flowInstance || flow.nodes.length === 0) return;
    // Wait until React Flow has measured the styled nodes, then fit the actual
    // neighborhood rather than the empty initial viewport.
    const timer = window.setTimeout(() => {
      void flowInstance.fitView({ padding: 0.16, maxZoom: 1, duration: 250 });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [depth, flow.edges.length, flow.nodes.length, flowInstance, root]);

  if (loading && pages.length === 0) {
    return <ContentLoadingState className="min-h-[32rem]" size="lg" />;
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-foreground">Knowledge graph</h2>
            <Pill tone="neutral">G-Brain source</Pill>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
            Explore the pages and typed relationships stored in G-Brain. This is intentionally separate from OpenClaw Memory; only knowledge ingested into G-Brain appears here.
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 sm:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-fg-subtle" />
            <Input
              value={rootDraft}
              onChange={(event) => setRootDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void loadNeighborhood(rootDraft, depth);
              }}
              placeholder="Focus a page"
              aria-label="Focus a G-Brain page"
              className="h-9 pl-9 font-mono text-xs"
              list="gbrain-graph-pages"
            />
            <datalist id="gbrain-graph-pages">
              {pages.map((page) => <option key={page.slug} value={page.slug}>{page.title}</option>)}
            </datalist>
          </div>
          <button
            type="button"
            onClick={() => void loadNeighborhood(rootDraft, depth)}
            disabled={!rootDraft.trim() || loading}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-control border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {loading ? <InlineSpinner /> : <Focus className="h-3.5 w-3.5" />}
            Focus
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Panel className="p-4"><Stat label="Pages in view" value={flow.nodes.length} sub={`${pages.length} in G-Brain`} /></Panel>
        <Panel className="p-4"><Stat label="Relationships" value={flow.edges.length} sub={`${overview?.stats?.match(/Links:\s*(\d+)/i)?.[1] || "—"} total`} /></Panel>
        <Panel className="p-4"><Stat label="Relationship types" value={relationTypes.length} sub={relationTypes.slice(0, 2).map(relationLabel).join(", ") || "No links"} /></Panel>
        <Panel className="p-4"><Stat label="Graph health" value={health?.healthScore != null ? `${health.healthScore}/${health.healthMax || 10}` : "—"} sub={health?.linkCoveragePct != null ? `${health.linkCoveragePct}% entity coverage` : "G-Brain local"} /></Panel>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Network className="h-3.5 w-3.5" />
          <span className="font-mono text-fg-secondary">{root}</span>
          <span>·</span>
          <span>{depth} hop{depth === 1 ? "" : "s"}</span>
        </div>
        <div className="inline-flex rounded-full border border-border bg-muted p-1">
          {[1, 2, 3].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setDepth(value);
                void loadNeighborhood(root, value);
              }}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition-colors",
                depth === value ? "bg-card text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {value} hop{value === 1 ? "" : "s"}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <EmptyState icon={<Network className="h-8 w-8" />} title="Graph unavailable" description={error} className="min-h-[30rem]" />
      ) : flow.nodes.length === 0 ? (
        <EmptyState icon={<Network className="h-8 w-8" />} title="No relationships yet" description="Choose another page, or create links in G-Brain first." className="min-h-[30rem]" />
      ) : (
        <div className="grid gap-4 lg:h-[38rem] lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel className="relative h-[32rem] overflow-hidden bg-surface-inset lg:h-full">
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              minZoom={0.2}
              maxZoom={1.7}
              colorMode={isDark ? "dark" : "light"}
              proOptions={{ hideAttribution: true }}
              onInit={setFlowInstance}
              onNodeClick={(_, node) => setSelectedSlug(node.id)}
              nodesDraggable
              nodesConnectable={false}
              elementsSelectable
            >
              <Background color="var(--border-subtle)" gap={22} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </Panel>

          <Panel className="flex max-h-[38rem] min-h-0 flex-col overflow-hidden lg:h-full">
            {selectedSlug ? (
              <>
                <div className="border-b border-border-subtle p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-foreground">{titleFor(selectedPage, selectedSlug)}</p>
                      <p className="mt-1 truncate font-mono text-[11px] text-fg-subtle">{selectedSlug}</p>
                    </div>
                    <Pill tone="unknown" className="shrink-0 capitalize">{selectedPage?.type || "page"}</Pill>
                  </div>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {loadingPage ? (
                    <div className="flex min-h-28 items-center justify-center"><InlineSpinner size="md" /></div>
                  ) : (
                    selectedBody ? (
                      <MarkdownContent
                        content={selectedBody}
                        className="text-xs text-muted-foreground [&_h1]:mb-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-xs [&_li]:leading-relaxed [&_p]:leading-relaxed"
                      />
                    ) : (
                      <p className="text-xs text-fg-subtle">No page preview is available.</p>
                    )
                  )}
                  <div className="mt-5">
                    <p className="eyebrow">Connections in view</p>
                    <div className="mt-2 space-y-2">
                      {selectedEdges.length === 0 ? (
                        <p className="text-xs text-fg-subtle">No visible connections.</p>
                      ) : selectedEdges.slice(0, 12).map((edge, index) => {
                        const outgoing = edge.source === selectedSlug;
                        const other = outgoing ? edge.target : edge.source;
                        return (
                          <button
                            key={`${edge.source}-${edge.target}-${index}`}
                            type="button"
                            onClick={() => setSelectedSlug(other)}
                            className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <span className="min-w-0 flex-1 truncate">{titleFor(pageBySlug.get(other), other)}</span>
                            <span className="shrink-0 text-[10px] text-fg-subtle">{relationLabel(edge.relation)}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div className="space-y-2 border-t border-border-subtle p-3">
                  <button
                    type="button"
                    onClick={() => void loadNeighborhood(selectedSlug, depth)}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-control bg-foreground px-3 text-xs font-medium text-background transition-opacity hover:opacity-90"
                  >
                    <Focus className="h-3.5 w-3.5" /> Explore connections
                  </button>
                  <button
                    type="button"
                    onClick={() => onOpenPage(selectedSlug)}
                    className="inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-control border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
                  >
                    <FileText className="h-3.5 w-3.5" /> Open page <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </>
            ) : (
              <EmptyState title="Select a node" description="Choose a node to inspect its source and relationships." className="h-full border-0" />
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
