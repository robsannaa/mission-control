"use client";
/* eslint-disable @typescript-eslint/no-unused-vars */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  MarkerType,
  useNodesState,
  type Edge,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  Eye,
  EyeOff,
  Filter,
  GitBranch,
  Layers,
  Pin,
  PinOff,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Table2,
  UploadCloud,
} from "lucide-react";
import dagre from "dagre";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { InlineSpinner, ScreenLoadingState } from "@/components/ui/loading-state";

const DAGRE_NODE_WIDTH = 200;
const DAGRE_NODE_HEIGHT = 72;

/** Saved positions outside this range are treated as outliers (e.g. from old grid) and ignored so dagre keeps the graph compact. */
const LAYOUT_SAVED_POSITION_MAX = 1800;

function isSavedPositionReasonable(x: number, y: number): boolean {
  return (
    Math.abs(x) <= LAYOUT_SAVED_POSITION_MAX &&
    Math.abs(y) <= LAYOUT_SAVED_POSITION_MAX
  );
}

function getDagreLayout(
  nodeIds: string[],
  edges: Array<{ source: string; target: string }>
): Map<string, { x: number; y: number }> {
  const result = new Map<string, { x: number; y: number }>();
  if (nodeIds.length === 0) return result;
  const Graph = dagre.graphlib?.Graph;
  const layoutFn = dagre.layout;
  if (!Graph || !layoutFn) return result;
  const g = new Graph();
  g.setGraph({
    rankdir: "LR",
    nodesep: 22,
    ranksep: 36,
    marginx: 16,
    marginy: 16,
  });
  for (const id of nodeIds) {
    g.setNode(id, { width: DAGRE_NODE_WIDTH, height: DAGRE_NODE_HEIGHT });
  }
  for (const edge of edges) {
    if (nodeIds.includes(edge.source) && nodeIds.includes(edge.target)) {
      g.setEdge(edge.source, edge.target);
    }
  }
  try {
    layoutFn(g);
    for (const id of nodeIds) {
      const node = g.node(id);
      if (node && typeof node.x === "number" && typeof node.y === "number") {
        result.set(id, {
          x: node.x - (node.width ?? DAGRE_NODE_WIDTH) / 2,
          y: node.y - (node.height ?? DAGRE_NODE_HEIGHT) / 2,
        });
      }
    }
  } catch {
    /* fallback to grid below */
  }
  return result;
}

type GraphNodePayload = {
  id: string;
  label: string;
  kind: string;
  summary: string;
  /** Absent for LLM-extracted nodes — models produce no calibrated number. */
  confidence?: number;
  /** Where the confidence value came from: explicit | heuristic | user. */
  confidenceSource?: string;
  source: string;
  tags: string[];
  x: number;
  y: number;
};

type GraphEdgePayload = {
  id: string;
  source: string;
  target: string;
  relation: string;
  /** Present only for deterministic (1.0) or user-weighted edges. */
  weight?: number;
  evidence: string;
  fact?: string;
};

type GraphPayload = {
  version: number;
  updatedAt: string;
  nodes: GraphNodePayload[];
  edges: GraphEdgePayload[];
};

type SourceChunk = {
  id: string;
  topic: string;
  kind: "heading" | "bullet" | "paragraph";
  text: string;
  startLine: number;
  endLine: number;
};

type SourceFact = {
  id: string;
  topic: string;
  statement: string;
  canonical: string;
  line: number;
  confidenceHint: number;
};

type SourceDocument = {
  id: string;
  name: string;
  path: string;
  source: "workspace" | "memory";
  mtimeMs: number;
  size: number;
  chunks: SourceChunk[];
  facts: SourceFact[];
};

type RecentChatMessage = {
  sessionKey: string;
  role: string;
  timestampMs: number;
  text: string;
};

type GraphTelemetry = {
  generatedAt: string;
  sourceDocuments: SourceDocument[];
  recentChatMessages: RecentChatMessage[];
};

type ExtractionInfo = {
  mode: "gateway" | "openai" | "off";
  model: string;
  configured: boolean;
};

type ExtractionSettingsPayload = {
  mode: "gateway" | "openai" | "off";
  model: string;
  openaiApiKey: string;
};

type GraphApiResponse = {
  graph?: GraphPayload;
  telemetry?: GraphTelemetry;
  bootstrap?: { source: "indexed" | "filesystem"; files: string[]; error?: string };
  extraction?: ExtractionInfo;
  warning?: string;
  error?: string;
};

type LensMode = "topic" | "entity" | "decision" | "file";
type LayerMode = "overview" | "topic" | "forensics";
type TimeRange = "7d" | "30d" | "90d" | "all";

type AggregatedEdge = {
  id: string;
  source: string;
  target: string;
  relation: string;
  count: number;
  confidence: number;
  maxConfidence: number;
  /** True when at least one contributing edge carried a real weight. */
  scored: boolean;
  evidence: string[];
  lastSeenMs: number;
  fact?: string;
};

type NodeInsight = {
  usefulness: number;
  retrievalFrequency: number;
  retrievalInWindow: number;
  recencyMs: number;
  recencyScore: number;
  conflictRate: number;
  conflicts: number;
  provenanceQuality: number;
  taskRelevance: number;
  breadth: number;
  sources: string[];
  lowProvenance: boolean;
  stale: boolean;
};

type FlowNodeData = {
  label: ReactNode;
};

type FlowEdgeData = {
  relation: string;
  count: number;
  confidence: number;
  lastSeenMs: number;
};

type Notice = { kind: "success" | "error"; text: string } | null;

type TopicRow = {
  topicId: string;
  topic: string;
  factsCount: number;
  lastUpdatedMs: number;
  usageCount: number;
  conflictsCount: number;
  topSource: string;
};

const MAX_VISIBLE_NODES = 20;
const MAX_VISIBLE_EDGES = 40;
const EMPTY_NODES: GraphNodePayload[] = [];
const EMPTY_EDGES: GraphEdgePayload[] = [];
const DEFAULT_CONFIDENCE_THRESHOLD = 0.25;
const DEFAULT_TIME_RANGE: TimeRange = "all";
const DEFAULT_USED_IN_LAST_N_CHATS = 0;

const RELATION_NODE_HINTS = new Set([
  "mentions_topic",
  "contains_topic",
  "supports",
  "captures_preference",
  "action_item",
  "about_entity",
  "project_signal",
  "related_to",
]);

const LENS_OPTIONS: Array<{ value: LensMode; label: string }> = [
  { value: "topic", label: "Topic lens" },
  { value: "entity", label: "Entity lens" },
  { value: "decision", label: "Decision lens" },
  { value: "file", label: "File lens" },
];

const LAYER_OPTIONS: Array<{ value: LayerMode; label: string }> = [
  { value: "overview", label: "Layer A · Overview" },
  { value: "topic", label: "Layer B · Topic" },
  { value: "forensics", label: "Layer C · Forensics" },
];

const TIME_OPTIONS: Array<{ value: TimeRange; label: string }> = [
  { value: "7d", label: "Last 7d" },
  { value: "30d", label: "Last 30d" },
  { value: "90d", label: "Last 90d" },
  { value: "all", label: "All time" },
];

function normalizeRelation(value: string): string {
  return String(value || "related_to")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "related_to";
}

function relationLabel(value: string): string {
  return normalizeRelation(value)
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const RELATION_COLORS: ReadonlyArray<{ dark: string; light: string }> = [
  { dark: "rgba(126,162,231,0.88)", light: "rgba(43,76,126,0.88)" },
  { dark: "rgba(82,183,169,0.88)", light: "rgba(42,157,143,0.88)" },
  { dark: "rgba(241,179,85,0.88)", light: "rgba(233,160,59,0.88)" },
  { dark: "rgba(143,184,255,0.88)", light: "rgba(76,110,245,0.88)" },
  { dark: "rgba(240,106,117,0.88)", light: "rgba(214,69,80,0.88)" },
  { dark: "rgba(194,209,229,0.82)", light: "rgba(100,116,139,0.82)" },
];

function relationToColor(relation: string, isDark: boolean): string {
  const norm = normalizeRelation(relation);
  let h = 0;
  for (let i = 0; i < norm.length; i++) h = (h * 31 + norm.charCodeAt(i)) >>> 0;
  const entry = RELATION_COLORS[h % RELATION_COLORS.length];
  return isDark ? entry.dark : entry.light;
}

function canonicalText(input: string): string {
  return String(input || "")
    .toLowerCase()
    .replace(/\b(a|an|the|to|for|and|or|of|in|on|at|by|with)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Honest confidence display: shows the number only when one exists, always
 * with its provenance. LLM-extracted nodes are labeled unscored instead of
 * being given a fake percentage.
 */
function confidenceLabel(node: GraphNodePayload): string {
  if (typeof node.confidence !== "number") return "unscored (LLM-extracted)";
  const pct = Math.round(node.confidence * 100);
  const src =
    node.confidenceSource === "explicit"
      ? "explicit"
      : node.confidenceSource === "user"
        ? "set by you"
        : "heuristic";
  return `confidence ${pct}% (${src})`;
}

function formatAgo(timestampMs: number): string {
  if (!timestampMs || !Number.isFinite(timestampMs)) return "unknown";
  const diff = Date.now() - timestampMs;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.max(1, Math.floor(diff / 60_000))}m ago`;
  if (diff < 86_400_000) return `${Math.max(1, Math.floor(diff / 3_600_000))}h ago`;
  return `${Math.max(1, Math.floor(diff / 86_400_000))}d ago`;
}

function timeRangeMs(range: TimeRange): number {
  if (range === "7d") return 7 * 86_400_000;
  if (range === "30d") return 30 * 86_400_000;
  if (range === "90d") return 90 * 86_400_000;
  return Number.POSITIVE_INFINITY;
}

function nodeKindColor(kind: string, isDark: boolean): string {
  const normalized = String(kind || "").toLowerCase();
  const tint = (light: string, dark: string) => (isDark ? dark : light);
  // New LLM-extracted entity types
  if (normalized === "concept") return tint("rgba(43,76,126,0.2)", "rgba(126,162,231,0.34)");
  if (normalized === "preference") return tint("rgba(76,110,245,0.18)", "rgba(143,184,255,0.32)");
  if (normalized === "tool") return tint("rgba(233,160,59,0.18)", "rgba(241,179,85,0.32)");
  if (normalized === "organization") return tint("rgba(214,69,80,0.16)", "rgba(240,106,117,0.3)");
  if (normalized === "event") return tint("rgba(42,157,143,0.18)", "rgba(82,183,169,0.3)");
  // Unchanged entity types
  if (normalized === "person") return tint("rgba(42,157,143,0.16)", "rgba(82,183,169,0.28)");
  if (normalized === "project") return tint("rgba(76,110,245,0.16)", "rgba(143,184,255,0.3)");
  // Legacy types (backward compat with saved graphs)
  if (normalized === "topic") return tint("rgba(43,76,126,0.2)", "rgba(126,162,231,0.34)");
  if (normalized === "fact") return tint("rgba(76,110,245,0.16)", "rgba(143,184,255,0.28)");
  if (normalized === "profile") return tint("rgba(82,183,169,0.18)", "rgba(82,183,169,0.3)");
  if (normalized === "task") return tint("rgba(233,160,59,0.18)", "rgba(241,179,85,0.32)");
  return tint("rgba(100,116,139,0.14)", "rgba(149,163,184,0.26)");
}

function kindLabel(kind: string): string {
  const k = String(kind || "").toLowerCase();
  // New types
  if (k === "concept") return "Concept";
  if (k === "preference") return "Preference";
  if (k === "tool") return "Tool";
  if (k === "organization") return "Organization";
  if (k === "event") return "Event";
  // Unchanged
  if (k === "person") return "Person";
  if (k === "project") return "Project";
  // Legacy
  if (k === "topic") return "Topic";
  if (k === "fact") return "Fact";
  if (k === "task") return "Task";
  if (k === "profile") return "Profile";
  return kind || "Node";
}

const SUMMARY_TRUNCATE = 72;
const TITLE_TRUNCATE = 42;

function truncate(str: string, max: number): string {
  const s = String(str || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + "…";
}

function scoreRecency(ts: number): number {
  if (!ts) return 0.25;
  const ageDays = (Date.now() - ts) / 86_400_000;
  if (ageDays <= 3) return 1;
  if (ageDays <= 14) return 0.82;
  if (ageDays <= 30) return 0.64;
  if (ageDays <= 90) return 0.38;
  return 0.16;
}

function isRelationInstanceNode(
  node: GraphNodePayload,
  inDegree: number,
  outDegree: number
): boolean {
  if (inDegree === 0 || outDegree === 0) return false;
  const kind = String(node.kind || "").toLowerCase();
  const label = normalizeRelation(node.label || node.id || "");
  if (kind === "relation") return true;
  return RELATION_NODE_HINTS.has(label);
}

function collectNodeSourceHints(node: GraphNodePayload): string[] {
  const hints = new Set<string>();
  const source = String(node.source || "").trim();
  if (
    source &&
    !["bootstrap", "manual", "template", "filesystem"].includes(source.toLowerCase())
  ) {
    hints.add(source.toLowerCase());
  }
  for (const tag of node.tags || []) {
    if (!tag.startsWith("file:")) continue;
    const parsed = String(tag.slice("file:".length)).trim().toLowerCase();
    if (parsed) hints.add(parsed);
  }
  return [...hints];
}

function shortestPath(
  start: string,
  goal: string,
  adjacency: Map<string, string[]>
): string[] | null {
  if (start === goal) return [start];
  const queue: string[] = [start];
  const prev = new Map<string, string | null>([[start, null]]);

  while (queue.length > 0) {
    const curr = queue.shift();
    if (!curr) break;
    for (const next of adjacency.get(curr) || []) {
      if (prev.has(next)) continue;
      prev.set(next, curr);
      if (next === goal) {
        const path: string[] = [goal];
        let cursor: string | null = curr;
        while (cursor) {
          path.push(cursor);
          cursor = prev.get(cursor) || null;
        }
        return path.reverse();
      }
      queue.push(next);
    }
  }
  return null;
}

function withinLens(node: GraphNodePayload, lens: LensMode, conflictCount: number): boolean {
  const kind = String(node.kind || "fact").toLowerCase();
  if (lens === "topic") return ["concept", "preference", "tool", "topic", "fact", "task", "profile", "project", "system"].includes(kind);
  if (lens === "entity") return ["person", "organization", "tool", "profile", "project", "topic", "system"].includes(kind);
  if (lens === "decision") {
    if (["preference", "concept", "task", "profile", "fact", "project"].includes(kind)) return true;
    return conflictCount > 0;
  }
  if (kind === "project" && node.label.toLowerCase().endsWith(".md")) return true;
  return ["concept", "project", "tool", "topic", "system"].includes(kind);
}

function cmpNumberDesc(a: number, b: number): number {
  return b - a;
}

function pickWithCap(
  sortedIds: string[],
  cap: number,
  mustInclude: string[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of mustInclude) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of sortedIds) {
    if (out.length >= cap) break;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.slice(0, cap);
}

export function MemoryGraphView() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== "light";

  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [telemetry, setTelemetry] = useState<GraphTelemetry>({
    generatedAt: "",
    sourceDocuments: [],
    recentChatMessages: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [extractionInfo, setExtractionInfo] = useState<ExtractionInfo | null>(null);

  // ── Extraction settings (mode / model / key) ──
  const [showExtraction, setShowExtraction] = useState(false);
  const [extractionSettings, setExtractionSettings] = useState<ExtractionSettingsPayload | null>(null);
  const [legacyKeyDetected, setLegacyKeyDetected] = useState(false);
  const [gatewayModels, setGatewayModels] = useState<string[]>([]);
  const [gatewayDefaultModel, setGatewayDefaultModel] = useState("");
  const [extractionSaving, setExtractionSaving] = useState(false);

  const [layer, setLayer] = useState<LayerMode>("topic");
  const [lens, setLens] = useState<LensMode>("topic");
  const [showTopicTable, setShowTopicTable] = useState(true);
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(260);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const isResizing = useRef(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    const handleMove = (ev: MouseEvent) => {
      if (!isResizing.current) return;
      const next = Math.max(180, Math.min(480, resizeStartWidth.current + ev.clientX - resizeStartX.current));
      setSidebarWidth(next);
    };
    const handleUp = () => {
      isResizing.current = false;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [sidebarWidth]);
  const [query, setQuery] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);

  const [confidenceThreshold, setConfidenceThreshold] = useState(DEFAULT_CONFIDENCE_THRESHOLD);
  const [timeRange, setTimeRange] = useState<TimeRange>(DEFAULT_TIME_RANGE);
  const [usedInLastNChats, setUsedInLastNChats] = useState(DEFAULT_USED_IN_LAST_N_CHATS);
  const [conflictsOnly, setConflictsOnly] = useState(false);
  const [lowProvenanceOnly, setLowProvenanceOnly] = useState(false);
  const [showThreeHops, setShowThreeHops] = useState(false);

  const [overlayConflicts, setOverlayConflicts] = useState(true);
  const [overlayStaleness, setOverlayStaleness] = useState(true);
  const [overlayLowProvenance, setOverlayLowProvenance] = useState(true);
  const [overlayDupes, setOverlayDupes] = useState(false);
  const [overlayMergeSuggestions, setOverlayMergeSuggestions] = useState(false);

  const [enabledRelations, setEnabledRelations] = useState<Record<string, boolean>>({});
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const loadGraph = useCallback(async (mode?: "bootstrap") => {
    setLoading(true);
    try {
      const endpoint = mode === "bootstrap" ? "/api/memory/graph?mode=bootstrap" : "/api/memory/graph";
      const res = await fetch(endpoint, { cache: "no-store" });
      const data = (await res.json()) as GraphApiResponse;
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

      const nextGraph = data.graph || { version: 1, updatedAt: new Date().toISOString(), nodes: [], edges: [] };
      setGraph(nextGraph);
      setTelemetry(
        data.telemetry || {
          generatedAt: new Date().toISOString(),
          sourceDocuments: [],
          recentChatMessages: [],
        }
      );
      setApiWarning(data.warning || null);
      setExtractionInfo(data.extraction || null);
      setDirty(mode === "bootstrap");

      if (mode === "bootstrap") {
        const source = data.bootstrap?.source === "indexed" ? "indexed vectors" : "filesystem markdown";
        const files = data.bootstrap?.files?.length || 0;
        const via = data.extraction?.mode === "off" ? "links only" : `${data.extraction?.mode || "gateway"} extraction`;
        setNotice({ kind: "success", text: `Graph rebuilt from ${source} (${files} files, ${via}).` });
      } else {
        setNotice(null);
      }
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to load memory graph." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGraph();
  }, [loadGraph]);

  // Load extraction settings + the gateway's model catalog for the picker.
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/memory/extraction", { cache: "no-store" });
        const data = await res.json();
        if (data?.settings) setExtractionSettings(data.settings as ExtractionSettingsPayload);
        setLegacyKeyDetected(Boolean(data?.legacyOpenAiKeyDetected));
      } catch {
        // Settings panel simply stays hidden-config until reload.
      }
      try {
        const res = await fetch("/api/models", { cache: "no-store" });
        const data = await res.json();
        const allowed = Array.isArray(data?.status?.allowed)
          ? (data.status.allowed as unknown[]).map((m) => String(m)).filter(Boolean)
          : [];
        setGatewayModels(allowed);
        setGatewayDefaultModel(String(data?.status?.defaultModel || ""));
      } catch {
        // Model list is a convenience; free-text input still works.
      }
    })();
  }, []);

  const updateExtractionSettings = useCallback((patch: Partial<ExtractionSettingsPayload>) => {
    setExtractionSettings((prev) => ({
      ...(prev || { mode: "gateway", model: "", openaiApiKey: "" }),
      ...patch,
    }));
  }, []);

  const saveExtractionSettings = useCallback(async () => {
    if (!extractionSettings) return;
    setExtractionSaving(true);
    try {
      const res = await fetch("/api/memory/extraction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", settings: extractionSettings }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setExtractionSettings(data.settings as ExtractionSettingsPayload);
      setNotice({ kind: "success", text: "Extraction settings saved. Rebuild to apply." });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to save extraction settings." });
    } finally {
      setExtractionSaving(false);
    }
  }, [extractionSettings]);

  const importLegacyKey = useCallback(async () => {
    try {
      const res = await fetch("/api/memory/extraction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import-legacy-key" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setExtractionSettings(data.settings as ExtractionSettingsPayload);
      setLegacyKeyDetected(false);
      setNotice({ kind: "success", text: "OpenAI key imported from ~/.openclaw/.env." });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to import key." });
    }
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3600);
    return () => clearTimeout(timer);
  }, [notice]);

  const nodes = useMemo(() => graph?.nodes || EMPTY_NODES, [graph?.nodes]);
  const rawEdges = useMemo(() => graph?.edges || EMPTY_EDGES, [graph?.edges]);

  const sourceDocByName = useMemo(() => {
    const map = new Map<string, SourceDocument>();
    for (const doc of telemetry.sourceDocuments || []) {
      map.set(doc.name.toLowerCase(), doc);
    }
    return map;
  }, [telemetry.sourceDocuments]);

  const collapsed = useMemo(() => {
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const inDegree = new Map<string, number>();
    const outDegree = new Map<string, number>();
    for (const edge of rawEdges) {
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
      outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1);
    }

    const relationNodeIds = new Set<string>();
    for (const node of nodes) {
      if (isRelationInstanceNode(node, inDegree.get(node.id) || 0, outDegree.get(node.id) || 0)) {
        relationNodeIds.add(node.id);
      }
    }

    const incoming = new Map<string, GraphEdgePayload[]>();
    const outgoing = new Map<string, GraphEdgePayload[]>();
    for (const edge of rawEdges) {
      if (!incoming.has(edge.target)) incoming.set(edge.target, []);
      if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
      incoming.get(edge.target)!.push(edge);
      outgoing.get(edge.source)!.push(edge);
    }

    const typedEdges: Array<{
      source: string;
      target: string;
      relation: string;
      confidence: number;
      scored: boolean;
      evidence: string;
      fact?: string;
    }> = [];

    for (const edge of rawEdges) {
      if (relationNodeIds.has(edge.source) || relationNodeIds.has(edge.target)) continue;
      typedEdges.push({
        source: edge.source,
        target: edge.target,
        relation: normalizeRelation(edge.relation),
        // Unscored edges get a neutral value for layout math only — the UI
        // never displays it as a percentage (see `scored`).
        confidence: clamp01(Number(edge.weight ?? 0.6)),
        scored: typeof edge.weight === "number",
        evidence: String(edge.evidence || "").trim(),
        fact: edge.fact,
      });
    }

    for (const relationNodeId of relationNodeIds) {
      const relationNode = nodeById.get(relationNodeId);
      const relation = normalizeRelation(relationNode?.label || relationNode?.id || "related_to");
      const ins = incoming.get(relationNodeId) || [];
      const outs = outgoing.get(relationNodeId) || [];

      for (const edgeIn of ins) {
        for (const edgeOut of outs) {
          if (!edgeIn.source || !edgeOut.target || edgeIn.source === edgeOut.target) continue;
          typedEdges.push({
            source: edgeIn.source,
            target: edgeOut.target,
            relation,
            confidence: clamp01((Number(edgeIn.weight ?? 0.6) + Number(edgeOut.weight ?? 0.6)) / 2),
            scored: typeof edgeIn.weight === "number" && typeof edgeOut.weight === "number",
            evidence: [edgeIn.evidence, edgeOut.evidence, relationNode?.label]
              .map((v) => String(v || "").trim())
              .filter(Boolean)
              .join(" | "),
          });
        }
      }
    }

    const aggregatedMap = new Map<string, AggregatedEdge>();

    const resolveRecency = (source: string, target: string, evidence: string): number => {
      const candidates = new Set<string>();
      if (evidence) {
        for (const token of evidence.split(/[|,;]+/g)) {
          const t = token.trim().toLowerCase();
          if (t.endsWith(".md")) candidates.add(t);
        }
      }
      const sourceNode = nodeById.get(source);
      const targetNode = nodeById.get(target);
      for (const hint of sourceNode ? collectNodeSourceHints(sourceNode) : []) candidates.add(hint);
      for (const hint of targetNode ? collectNodeSourceHints(targetNode) : []) candidates.add(hint);

      let best = 0;
      for (const key of candidates) {
        const hit = sourceDocByName.get(key);
        if (hit?.mtimeMs && hit.mtimeMs > best) best = hit.mtimeMs;
      }
      return best;
    };

    for (const edge of typedEdges) {
      const key = `${edge.source}::${edge.target}::${edge.relation}`;
      const recency = resolveRecency(edge.source, edge.target, edge.evidence);
      const existing = aggregatedMap.get(key);
      if (!existing) {
        aggregatedMap.set(key, {
          id: key,
          source: edge.source,
          target: edge.target,
          relation: edge.relation,
          count: 1,
          confidence: edge.confidence,
          maxConfidence: edge.confidence,
          scored: edge.scored,
          evidence: edge.evidence ? [edge.evidence] : [],
          lastSeenMs: recency,
          fact: edge.fact,
        });
      } else {
        existing.count += 1;
        existing.confidence = clamp01((existing.confidence * (existing.count - 1) + edge.confidence) / existing.count);
        existing.maxConfidence = Math.max(existing.maxConfidence, edge.confidence);
        existing.scored = existing.scored || edge.scored;
        if (edge.evidence) existing.evidence.push(edge.evidence);
        if (recency > existing.lastSeenMs) existing.lastSeenMs = recency;
        if (edge.fact && !existing.fact) existing.fact = edge.fact;
      }
    }

    const keptNodes = nodes.filter((node) => !relationNodeIds.has(node.id));
    const keptNodeIds = new Set(keptNodes.map((node) => node.id));
    const aggregatedEdges = [...aggregatedMap.values()].filter(
      (edge) => keptNodeIds.has(edge.source) && keptNodeIds.has(edge.target)
    );

    return {
      nodes: keptNodes,
      edges: aggregatedEdges,
      nodeById: new Map(keptNodes.map((node) => [node.id, node])),
    };
  }, [nodes, rawEdges, sourceDocByName]);

  const relationTypes = useMemo(() => {
    return [...new Set(collapsed.edges.map((edge) => edge.relation))].sort((a, b) => a.localeCompare(b));
  }, [collapsed.edges]);

  useEffect(() => {
    setEnabledRelations((prev) => {
      const next: Record<string, boolean> = { ...prev };
      for (const relation of relationTypes) {
        if (typeof next[relation] !== "boolean") next[relation] = true;
      }
      for (const key of Object.keys(next)) {
        if (!relationTypes.includes(key)) delete next[key];
      }
      return next;
    });
  }, [relationTypes]);

  const resetFilters = useCallback(() => {
    setLayer("topic");
    setLens("topic");
    setQuery("");
    setConfidenceThreshold(DEFAULT_CONFIDENCE_THRESHOLD);
    setTimeRange(DEFAULT_TIME_RANGE);
    setUsedInLastNChats(DEFAULT_USED_IN_LAST_N_CHATS);
    setConflictsOnly(false);
    setLowProvenanceOnly(false);
    setShowThreeHops(false);
    setEnabledRelations(() => {
      const next: Record<string, boolean> = {};
      for (const relation of relationTypes) next[relation] = true;
      return next;
    });
  }, [relationTypes]);

  const diagnostics = useMemo(() => {
    const conflictByCanonical = new Map<string, { statements: Set<string>; refs: Array<{ doc: string; line: number }> }>();
    for (const doc of telemetry.sourceDocuments || []) {
      for (const fact of doc.facts || []) {
        const canonical = canonicalText(fact.canonical || fact.statement);
        if (!canonical) continue;
        if (!conflictByCanonical.has(canonical)) {
          conflictByCanonical.set(canonical, { statements: new Set<string>(), refs: [] });
        }
        const entry = conflictByCanonical.get(canonical)!;
        entry.statements.add(String(fact.statement || ""));
        entry.refs.push({ doc: doc.name, line: Number(fact.line || 0) });
      }
    }

    const conflicts = [...conflictByCanonical.entries()]
      .filter(([, entry]) => entry.statements.size > 1)
      .map(([canonical, entry]) => ({
        canonical,
        statements: [...entry.statements],
        refs: entry.refs,
      }));

    const labelGroups = new Map<string, GraphNodePayload[]>();
    for (const node of collapsed.nodes) {
      const key = canonicalText(node.label);
      if (!key) continue;
      if (!labelGroups.has(key)) labelGroups.set(key, []);
      labelGroups.get(key)!.push(node);
    }
    const duplicates = [...labelGroups.entries()]
      .filter(([, grouped]) => grouped.length > 1)
      .map(([labelKey, grouped]) => ({ labelKey, ids: grouped.map((node) => node.id), labels: grouped.map((node) => node.label) }));

    const mergeSuggestions: Array<{ a: GraphNodePayload; b: GraphNodePayload; similarity: number }> = [];
    const allNodes = collapsed.nodes;
    for (let i = 0; i < allNodes.length; i += 1) {
      const a = allNodes[i];
      const aKey = canonicalText(a.label);
      if (!aKey) continue;
      const aSet = new Set(aKey.split(" ").filter(Boolean));
      for (let j = i + 1; j < allNodes.length; j += 1) {
        const b = allNodes[j];
        if (a.kind !== b.kind) continue;
        const bKey = canonicalText(b.label);
        if (!bKey) continue;
        const bSet = new Set(bKey.split(" ").filter(Boolean));
        let overlap = 0;
        for (const token of aSet) {
          if (bSet.has(token)) overlap += 1;
        }
        const denom = Math.max(1, aSet.size + bSet.size - overlap);
        const similarity = overlap / denom;
        if (similarity >= 0.74) {
          mergeSuggestions.push({ a, b, similarity });
        }
      }
    }

    return { conflicts, duplicates, mergeSuggestions };
  }, [collapsed.nodes, telemetry.sourceDocuments]);

  const nodeInsights = useMemo(() => {
    const conflictMap = new Map<string, number>();
    const conflictByCanonical = new Map<string, number>();
    for (const conflict of diagnostics.conflicts) {
      conflictByCanonical.set(conflict.canonical, conflict.statements.length - 1);
    }

    const incident = new Map<string, AggregatedEdge[]>();
    for (const edge of collapsed.edges) {
      if (!incident.has(edge.source)) incident.set(edge.source, []);
      if (!incident.has(edge.target)) incident.set(edge.target, []);
      incident.get(edge.source)!.push(edge);
      incident.get(edge.target)!.push(edge);
    }

    const sourceTimes = new Map<string, number>();
    for (const doc of telemetry.sourceDocuments || []) {
      sourceTimes.set(doc.name.toLowerCase(), Number(doc.mtimeMs || 0));
    }

    const chatTexts = (telemetry.recentChatMessages || []).map((msg) => String(msg.text || "").toLowerCase());

    const provisional = new Map<string, Omit<NodeInsight, "usefulness"> & { retrievalRaw: number }>();
    let maxRetrieval = 1;

    for (const node of collapsed.nodes) {
      const edges = incident.get(node.id) || [];
      const relationSet = new Set<string>();
      const neighborSet = new Set<string>();
      const sourceSet = new Set<string>();

      for (const source of collectNodeSourceHints(node)) sourceSet.add(source);

      for (const edge of edges) {
        relationSet.add(edge.relation);
        neighborSet.add(edge.source === node.id ? edge.target : edge.source);
        for (const evidence of edge.evidence) {
          const tokenized = evidence.toLowerCase().split(/[|,;]+/g).map((x) => x.trim());
          for (const token of tokenized) {
            if (token.endsWith(".md")) sourceSet.add(token);
          }
        }
      }

      let recencyMs = 0;
      for (const source of sourceSet) {
        const ts = sourceTimes.get(source);
        if (ts && ts > recencyMs) recencyMs = ts;
      }
      for (const edge of edges) {
        if (edge.lastSeenMs > recencyMs) recencyMs = edge.lastSeenMs;
      }

      const q = canonicalText(node.label);
      const summaryQ = canonicalText(node.summary || "");
      let retrievalRaw = 0;
      for (let i = 0; i < chatTexts.length; i += 1) {
        const text = chatTexts[i];
        if (!text) continue;
        if ((q && text.includes(q)) || (summaryQ && summaryQ.length >= 5 && text.includes(summaryQ))) {
          retrievalRaw += 1;
        }
      }
      if (retrievalRaw > maxRetrieval) maxRetrieval = retrievalRaw;

      const canonical = canonicalText(node.summary || node.label);
      const conflicts = conflictByCanonical.get(canonical) || 0;
      conflictMap.set(node.id, conflicts);

      const hasProvenance = sourceSet.size > 0;
      const provenanceQuality = clamp01(
        (hasProvenance ? 0.35 : 0) +
        Math.min(0.45, sourceSet.size * 0.18) +
        Math.min(0.2, edges.length * 0.05)
      );

      let taskRelevance = 0.4;
      const kind = node.kind.toLowerCase();
      if (kind === "task") taskRelevance = 1;
      else if (kind === "project") taskRelevance = 0.84;
      else if (kind === "preference" || kind === "profile") taskRelevance = 0.76;
      else if (edges.some((edge) => edge.relation === "action_item")) taskRelevance = 0.88;
      else if (kind === "concept" || kind === "tool") taskRelevance = 0.65;
      else if (kind === "fact") taskRelevance = 0.62;
      else if (kind === "topic") taskRelevance = 0.58;

      const breadth = clamp01(relationSet.size / 6 + neighborSet.size / 10);
      const recencyScore = scoreRecency(recencyMs);
      const conflictRate = clamp01(conflicts / 4);

      provisional.set(node.id, {
        retrievalRaw,
        retrievalFrequency: 0,
        retrievalInWindow: 0,
        recencyMs,
        recencyScore,
        conflictRate,
        conflicts,
        provenanceQuality,
        taskRelevance,
        breadth,
        sources: [...sourceSet],
        lowProvenance: provenanceQuality < 0.42,
        stale: recencyMs > 0 ? Date.now() - recencyMs > 45 * 86_400_000 : true,
      });
    }

    const windowSize = Math.max(0, Math.trunc(usedInLastNChats));
    const windowTexts = chatTexts.slice(0, windowSize);

    const out = new Map<string, NodeInsight>();
    for (const node of collapsed.nodes) {
      const partial = provisional.get(node.id);
      if (!partial) continue;
      const retrievalFrequency = clamp01(partial.retrievalRaw / maxRetrieval);
      const q = canonicalText(node.label);
      const summaryQ = canonicalText(node.summary || "");
      let retrievalInWindow = 0;
      for (const text of windowTexts) {
        if ((q && text.includes(q)) || (summaryQ && summaryQ.length >= 5 && text.includes(summaryQ))) {
          retrievalInWindow += 1;
        }
      }

      const usefulness = clamp01(
        0.28 * retrievalFrequency +
        0.2 * partial.recencyScore +
        0.18 * (1 - partial.conflictRate) +
        0.16 * partial.provenanceQuality +
        0.1 * partial.taskRelevance +
        0.08 * partial.breadth
      );

      out.set(node.id, {
        usefulness,
        retrievalFrequency,
        retrievalInWindow,
        recencyMs: partial.recencyMs,
        recencyScore: partial.recencyScore,
        conflictRate: partial.conflictRate,
        conflicts: partial.conflicts,
        provenanceQuality: partial.provenanceQuality,
        taskRelevance: partial.taskRelevance,
        breadth: partial.breadth,
        sources: partial.sources,
        lowProvenance: partial.lowProvenance,
        stale: partial.stale,
      });
    }

    return out;
  }, [collapsed.edges, collapsed.nodes, diagnostics.conflicts, telemetry.recentChatMessages, telemetry.sourceDocuments, usedInLastNChats]);

  const topicRows = useMemo(() => {
    const topicNodes = collapsed.nodes.filter((node) => ["topic", "concept"].includes(node.kind.toLowerCase()));
    const edgesByNode = new Map<string, AggregatedEdge[]>();
    for (const edge of collapsed.edges) {
      if (!edgesByNode.has(edge.source)) edgesByNode.set(edge.source, []);
      if (!edgesByNode.has(edge.target)) edgesByNode.set(edge.target, []);
      edgesByNode.get(edge.source)!.push(edge);
      edgesByNode.get(edge.target)!.push(edge);
    }

    const rows: TopicRow[] = topicNodes.map((topic) => {
      const incident = edgesByNode.get(topic.id) || [];
      const neighborIds = incident.map((edge) => (edge.source === topic.id ? edge.target : edge.source));
      const factNeighbors = neighborIds.filter((id) => {
        const node = collapsed.nodeById.get(id);
        return node ? ["fact", "profile", "task", "project", "tool", "preference", "person"].includes(node.kind.toLowerCase()) : false;
      });

      let usageCount = 0;
      let conflictCount = 0;
      let topSource = "n/a";
      let lastUpdatedMs = 0;

      const sourceCounter = new Map<string, number>();
      for (const id of [topic.id, ...factNeighbors]) {
        const insight = nodeInsights.get(id);
        if (!insight) continue;
        usageCount += insight.retrievalInWindow;
        conflictCount += insight.conflicts;
        if (insight.recencyMs > lastUpdatedMs) lastUpdatedMs = insight.recencyMs;
        for (const source of insight.sources) {
          sourceCounter.set(source, (sourceCounter.get(source) || 0) + 1);
        }
      }

      if (sourceCounter.size > 0) {
        topSource = [...sourceCounter.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }

      return {
        topicId: topic.id,
        topic: topic.label,
        factsCount: factNeighbors.length,
        lastUpdatedMs,
        usageCount,
        conflictsCount: conflictCount,
        topSource,
      };
    });

    rows.sort((a, b) => {
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      if (b.conflictsCount !== a.conflictsCount) return b.conflictsCount - a.conflictsCount;
      return b.factsCount - a.factsCount;
    });

    return rows;
  }, [collapsed.edges, collapsed.nodeById, collapsed.nodes, nodeInsights]);

  const adjacency = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of collapsed.edges) {
      if (!map.has(edge.source)) map.set(edge.source, []);
      if (!map.has(edge.target)) map.set(edge.target, []);
      map.get(edge.source)!.push(edge.target);
      map.get(edge.target)!.push(edge.source);
    }
    return map;
  }, [collapsed.edges]);

  const selectedNode = selectedNodeId ? collapsed.nodeById.get(selectedNodeId) || null : null;

  useEffect(() => {
    if (!selectedNodeId && collapsed.nodes.length > 0) {
      setSelectedNodeId(collapsed.nodes[0].id);
    }
  }, [collapsed.nodes, selectedNodeId]);

  useEffect(() => {
    if (selectedNode && ["topic", "concept"].includes(selectedNode.kind.toLowerCase())) {
      setSelectedTopicId(selectedNode.id);
    }
  }, [selectedNode]);

  const selectedTopic = useMemo(() => {
    const explicit = selectedTopicId ? collapsed.nodeById.get(selectedTopicId) : null;
    if (explicit && ["topic", "concept"].includes(explicit.kind.toLowerCase())) return explicit;
    const fallbackId = topicRows[0]?.topicId;
    return fallbackId ? collapsed.nodeById.get(fallbackId) || null : null;
  }, [collapsed.nodeById, selectedTopicId, topicRows]);

  const filteredScope = useMemo(() => {
    const allNodeIds = collapsed.nodes.map((node) => node.id);
    const scoreById = new Map<string, number>();
    for (const nodeId of allNodeIds) {
      scoreById.set(nodeId, nodeInsights.get(nodeId)?.usefulness || 0);
    }

    const queryLower = query.trim().toLowerCase();
    const timeLimit = timeRangeMs(timeRange);

    const layerBase = (() => {
      if (layer === "overview") {
        return new Set(
          collapsed.nodes
            .filter((node) => ["topic", "concept", "system"].includes(node.kind.toLowerCase()))
            .map((node) => node.id)
        );
      }
      if (layer === "topic") {
        if (!selectedTopic) return new Set(allNodeIds);
        const ids = new Set<string>([selectedTopic.id]);
        for (const edge of collapsed.edges) {
          if (edge.source === selectedTopic.id) ids.add(edge.target);
          if (edge.target === selectedTopic.id) ids.add(edge.source);
        }
        return ids;
      }
      const focus = selectedNode?.id || selectedTopic?.id;
      if (!focus) return new Set(allNodeIds);
      const ids = new Set<string>([focus]);
      let frontier = [focus];
      for (let hop = 0; hop < 2; hop += 1) {
        const next: string[] = [];
        for (const curr of frontier) {
          for (const neigh of adjacency.get(curr) || []) {
            if (ids.has(neigh)) continue;
            ids.add(neigh);
            next.push(neigh);
          }
        }
        frontier = next;
      }
      return ids;
    })();

    const conflictById = new Map<string, number>();
    for (const [nodeId, insight] of nodeInsights.entries()) {
      conflictById.set(nodeId, insight.conflicts);
    }

    const eligible = collapsed.nodes.filter((node) => {
      if (!layerBase.has(node.id)) return false;
      const insight = nodeInsights.get(node.id);
      if (!insight) return false;
      if (!withinLens(node, lens, conflictById.get(node.id) || 0)) return false;
      if (queryLower) {
        const hay = `${node.label} ${node.summary} ${node.kind} ${(node.tags || []).join(" ")}`.toLowerCase();
        if (!hay.includes(queryLower)) return false;
      }
      // Threshold applies only to nodes that actually carry a confidence
      // value — LLM-extracted nodes are unscored, not "low confidence".
      if (typeof node.confidence === "number" && node.confidence < confidenceThreshold) return false;
      if (timeLimit < Number.POSITIVE_INFINITY && insight.recencyMs > 0 && Date.now() - insight.recencyMs > timeLimit) {
        return false;
      }
      if (usedInLastNChats > 0 && insight.retrievalInWindow <= 0) return false;
      if (conflictsOnly && insight.conflicts <= 0) return false;
      if (lowProvenanceOnly && !insight.lowProvenance) return false;
      return true;
    });

    const sortedEligible = [...eligible].sort((a, b) => cmpNumberDesc(scoreById.get(a.id) || 0, scoreById.get(b.id) || 0));

    const mustInclude = [selectedNode?.id || "", selectedTopic?.id || "", ...pinnedIds].filter(Boolean);

    let selectedIds = pickWithCap(sortedEligible.map((node) => node.id), MAX_VISIBLE_NODES, mustInclude);

    // If strict filters hide everything, relax to show useful defaults instead of blank canvas.
    if (selectedIds.length === 0) {
      const relaxed = collapsed.nodes
        .filter((node) => layerBase.has(node.id) && withinLens(node, lens, conflictById.get(node.id) || 0))
        .sort((a, b) => cmpNumberDesc(scoreById.get(a.id) || 0, scoreById.get(b.id) || 0));
      const fallback = relaxed.length > 0 ? relaxed : [...collapsed.nodes];
      selectedIds = pickWithCap(fallback.map((node) => node.id), MAX_VISIBLE_NODES, mustInclude);
    }

    if (pinnedIds.length >= 2) {
      const pinnedSet = new Set<string>(pinnedIds);
      const connecting = new Set<string>([...pinnedSet]);
      for (let i = 0; i < pinnedIds.length; i += 1) {
        for (let j = i + 1; j < pinnedIds.length; j += 1) {
          const path = shortestPath(pinnedIds[i], pinnedIds[j], adjacency);
          if (!path) continue;
          for (const id of path) connecting.add(id);
        }
      }
      const scored = [...connecting].sort((a, b) => cmpNumberDesc(scoreById.get(a) || 0, scoreById.get(b) || 0));
      selectedIds = pickWithCap(scored, MAX_VISIBLE_NODES, mustInclude);
    }

    const selectedSet = new Set(selectedIds);

    const edgeCandidates = collapsed.edges.filter((edge) => {
      if (!selectedSet.has(edge.source) || !selectedSet.has(edge.target)) return false;
      if (!enabledRelations[edge.relation]) return false;
      if (edge.scored && edge.confidence < confidenceThreshold) return false;
      if (timeLimit < Number.POSITIVE_INFINITY && edge.lastSeenMs > 0 && Date.now() - edge.lastSeenMs > timeLimit) {
        return false;
      }
      return true;
    });

    const scoredEdges = edgeCandidates
      .map((edge) => {
        const recency = scoreRecency(edge.lastSeenMs);
        const score = clamp01(0.45 * edge.confidence + 0.3 * Math.min(1, Math.log2(edge.count + 1) / 3) + 0.25 * recency);
        return { edge, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_VISIBLE_EDGES)
      .map((entry) => entry.edge);

    const edgeSet = new Set(scoredEdges.map((edge) => edge.id));
    const scopedNodeSet = new Set<string>();
    for (const edge of scoredEdges) {
      scopedNodeSet.add(edge.source);
      scopedNodeSet.add(edge.target);
    }
    for (const id of selectedSet) scopedNodeSet.add(id);

    let hopDistance = new Map<string, number>();
    const focusId = selectedNode?.id || selectedTopic?.id || null;

    if (focusId && scopedNodeSet.has(focusId)) {
      hopDistance = new Map<string, number>([[focusId, 0]]);
      const queue = [focusId];
      while (queue.length > 0) {
        const curr = queue.shift();
        if (!curr) break;
        const dist = hopDistance.get(curr) || 0;
        for (const neigh of adjacency.get(curr) || []) {
          if (!scopedNodeSet.has(neigh)) continue;
          if (hopDistance.has(neigh)) continue;
          hopDistance.set(neigh, dist + 1);
          queue.push(neigh);
        }
      }
    }

    if (focusId && !showThreeHops) {
      for (const nodeId of [...scopedNodeSet]) {
        const dist = hopDistance.get(nodeId);
        if (typeof dist === "number" && dist >= 3) scopedNodeSet.delete(nodeId);
      }
    }

    return {
      nodeIds: scopedNodeSet,
      edges: scoredEdges.filter((edge) => edgeSet.has(edge.id) && scopedNodeSet.has(edge.source) && scopedNodeSet.has(edge.target)),
      hopDistance,
      scoreById,
    };
  }, [
    adjacency,
    collapsed.edges,
    collapsed.nodes,
    confidenceThreshold,
    conflictsOnly,
    enabledRelations,
    layer,
    lens,
    lowProvenanceOnly,
    nodeInsights,
    pinnedIds,
    query,
    selectedNode,
    selectedTopic,
    showThreeHops,
    timeRange,
    usedInLastNChats,
  ]);

  const flowNodes = useMemo(() => {
    const visible = collapsed.nodes.filter((node) => filteredScope.nodeIds.has(node.id));
    const count = Math.max(1, visible.length);
    const nodeIds = visible.map((n) => n.id);
    const layoutPositions =
      layer === "overview"
        ? new Map<string, { x: number; y: number }>()
        : getDagreLayout(nodeIds, filteredScope.edges);

    const edgeCountByNode = new Map<string, number>();
    for (const e of filteredScope.edges) {
      edgeCountByNode.set(e.source, (edgeCountByNode.get(e.source) ?? 0) + 1);
      edgeCountByNode.set(e.target, (edgeCountByNode.get(e.target) ?? 0) + 1);
    }

    return visible.map((node, idx) => {
      const insight = nodeInsights.get(node.id);
      const dist = filteredScope.hopDistance.get(node.id);
      const selected = selectedNodeId === node.id;
      const pinned = pinnedIds.includes(node.id);
      const edgeCount = edgeCountByNode.get(node.id) ?? 0;

      let opacity = 1;
      if (typeof dist === "number" && dist === 2) opacity = 0.42;
      if (selected) opacity = 1;

      const ringTone = insight?.conflicts
        ? "ring-danger-border"
        : insight?.lowProvenance
          ? "ring-warning-border"
          : "ring-info-border";

      const hasReasonableSavedPosition =
        Number.isFinite(node.x) &&
        Number.isFinite(node.y) &&
        isSavedPositionReasonable(node.x, node.y);
      const layoutPos = layoutPositions.get(node.id);
      const gridFallback = {
        x: 200 + (idx % 5) * 220,
        y: 100 + Math.floor(idx / 5) * 140,
      };
      const baseX = hasReasonableSavedPosition ? node.x! : (layoutPos?.x ?? gridFallback.x);
      const baseY = hasReasonableSavedPosition ? node.y! : (layoutPos?.y ?? gridFallback.y);
      const position =
        layer === "overview"
          ? {
            x: 200 + Math.cos((idx / count) * Math.PI * 2) * 280,
            y: 200 + Math.sin((idx / count) * Math.PI * 2) * 180,
          }
          : { x: baseX, y: baseY };

      const summary = (node.summary || "").trim();
      const labelTrim = (node.label || "").trim();
      const summaryIsDifferent =
        summary.length > 10 &&
        labelTrim.length > 0 &&
        !labelTrim.toLowerCase().startsWith(summary.toLowerCase().slice(0, Math.min(15, summary.length)));
      const primarySource = insight?.sources?.[0];
      const isFileLike = node.kind?.toLowerCase() === "project" || (primarySource?.endsWith(".md") ?? false);

      let subtitle: string;
      if (summaryIsDifferent && summary) {
        subtitle = truncate(summary, SUMMARY_TRUNCATE);
      } else if (isFileLike && primarySource) {
        subtitle = `From ${primarySource}`;
      } else if ((insight?.retrievalInWindow ?? 0) > 0) {
        const n = insight!.retrievalInWindow;
        subtitle = n === 1 ? "Used in 1 recent chat" : `Used in ${n} recent chats`;
      } else if (insight?.recencyMs && insight.recencyMs > 0) {
        subtitle = `Updated ${formatAgo(insight.recencyMs)}`;
      } else if (edgeCount > 0) {
        subtitle = edgeCount === 1 ? "1 connection" : `${edgeCount} connections`;
      } else {
        subtitle = kindLabel(node.kind);
      }

      return {
        id: node.id,
        position,
        draggable: layer !== "overview",
        data: {
          label: (
            <div className={cn("rounded-xl border border-border/80 bg-background/80 px-3 py-2.5 text-left text-xs shadow-sm backdrop-blur-sm", selected && `ring-2 ${ringTone}`)}>
              <p className="line-clamp-1 font-semibold leading-snug text-foreground" title={labelTrim}>
                {truncate(labelTrim || node.id, TITLE_TRUNCATE)}
              </p>
              <p className="mt-1 line-clamp-2 min-h-0 text-[11px] leading-snug text-muted-foreground" title={subtitle}>
                {subtitle}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="rounded-md bg-muted/80 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {kindLabel(node.kind)}
                </span>
                {(insight?.conflicts ?? 0) > 0 && (
                  <span className="rounded-md bg-danger-bg px-1.5 py-0.5 text-[10px] text-danger-fg">
                    {insight!.conflicts} conflict{(insight!.conflicts ?? 0) === 1 ? "" : "s"}
                  </span>
                )}
                {insight?.lowProvenance && (
                  <span className="rounded-md bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning-fg">
                    Unverified
                  </span>
                )}
                {pinned && (
                  <span className="rounded-md bg-muted-foreground/25 px-1.5 py-0.5 text-[10px] text-muted-foreground dark:text-fg-secondary">
                    Pinned
                  </span>
                )}
              </div>
            </div>
          ),
        },
        style: {
          borderRadius: 14,
          border: isDark ? "1px solid rgba(255,255,255,0.12)" : "1px solid rgba(15,23,42,0.14)",
          background: `linear-gradient(140deg, ${nodeKindColor(node.kind, isDark)} 0%, ${isDark ? "rgba(12,12,16,0.72)" : "rgba(255,255,255,0.94)"
            } 100%)`,
          color: "var(--foreground)",
          opacity,
          minWidth: 200,
          boxShadow: selected
            ? isDark
              ? "0 0 0 1px rgba(255,255,255,0.20), 0 12px 28px rgba(0,0,0,0.36)"
              : "0 0 0 1px rgba(30,41,59,0.18), 0 10px 24px rgba(15,23,42,0.16)"
            : isDark
              ? "0 10px 24px rgba(0,0,0,0.30)"
              : "0 8px 20px rgba(15,23,42,0.12)",
          padding: 0,
        },
      } as Node<FlowNodeData>;
    });
  }, [collapsed.nodes, filteredScope.edges, filteredScope.hopDistance, filteredScope.nodeIds, isDark, layer, nodeInsights, pinnedIds, selectedNodeId]);

  const flowNodesStructureKey = useMemo(
    () => `${flowNodes.length}\n${flowNodes.map((n) => n.id).join(",")}`,
    [flowNodes]
  );
  const prevFlowNodesStructureKey = useRef<string | null>(null);
  const isDraggingRef = useRef(false);

  const [displayNodes, setDisplayNodes, onNodesChangeFromHook] = useNodesState(flowNodes);

  useEffect(() => {
    if (isDraggingRef.current) return;
    if (prevFlowNodesStructureKey.current !== flowNodesStructureKey) {
      prevFlowNodesStructureKey.current = flowNodesStructureKey;
      setDisplayNodes(flowNodes);
    }
  }, [flowNodesStructureKey, flowNodes, setDisplayNodes]);

  const flowEdges = useMemo(() => {
    return filteredScope.edges.map((edge) => {
      const distSource = filteredScope.hopDistance.get(edge.source);
      const distTarget = filteredScope.hopDistance.get(edge.target);
      const faint = (distSource === 2 || distTarget === 2) && !showThreeHops;
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        data: {
          relation: edge.relation,
          count: edge.count,
          confidence: edge.confidence,
          lastSeenMs: edge.lastSeenMs,
        },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        style: {
          stroke: relationToColor(edge.relation, isDark),
          strokeWidth: Math.max(1.4, Math.min(4.2, 1 + edge.confidence * 2.4 + Math.log2(edge.count + 1) * 0.45)),
          opacity: faint ? 0.32 : 0.85,
        },
      } as Edge<FlowEdgeData>;
    });
  }, [filteredScope.edges, filteredScope.hopDistance, isDark, showThreeHops]);

  const visibleRelationTypes = useMemo(() => {
    return [...new Set(filteredScope.edges.map((e) => e.relation))].sort((a, b) => a.localeCompare(b));
  }, [filteredScope.edges]);

  const forensics = useMemo(() => {
    const anchor = selectedNode || selectedTopic;
    if (!anchor) {
      return { docs: [] as SourceDocument[], facts: [] as Array<SourceFact & { doc: string }>, diffs: [] as Array<{ canonical: string; statements: string[] }> };
    }

    const terms = [anchor.label, anchor.summary, selectedTopic?.label || ""]
      .map((value) => canonicalText(value))
      .filter((value) => value.length >= 3);

    const docs: SourceDocument[] = [];
    const facts: Array<SourceFact & { doc: string }> = [];

    for (const doc of telemetry.sourceDocuments || []) {
      const hit = doc.chunks.some((chunk) => {
        const hay = canonicalText(`${chunk.topic} ${chunk.text}`);
        return terms.some((term) => hay.includes(term));
      });
      if (!hit) continue;
      docs.push(doc);
      for (const fact of doc.facts || []) {
        const hay = canonicalText(`${fact.topic} ${fact.statement} ${fact.canonical}`);
        if (terms.some((term) => hay.includes(term))) {
          facts.push({ ...fact, doc: doc.name });
        }
      }
    }

    const byCanonical = new Map<string, Set<string>>();
    for (const fact of facts) {
      const canonical = canonicalText(fact.canonical || fact.statement);
      if (!canonical) continue;
      if (!byCanonical.has(canonical)) byCanonical.set(canonical, new Set<string>());
      byCanonical.get(canonical)!.add(fact.statement);
    }

    const diffs = [...byCanonical.entries()]
      .filter(([, statements]) => statements.size > 1)
      .map(([canonical, statements]) => ({ canonical, statements: [...statements] }));

    return { docs, facts, diffs };
  }, [selectedNode, selectedTopic, telemetry.sourceDocuments]);

  const applyNodePatch = useCallback((nodeId: string, patch: Partial<GraphNodePayload>) => {
    setGraph((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: prev.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
      };
    });
    setDirty(true);
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const positionChanges = changes.filter((c) => c.type === "position") as Array<
        NodeChange & { id: string; dragging?: boolean; position?: { x: number; y: number } }
      >;
      for (const c of positionChanges) {
        if (c.dragging === true) isDraggingRef.current = true;
        if (c.dragging === false) isDraggingRef.current = false;
      }
      onNodesChangeFromHook(changes as Parameters<typeof onNodesChangeFromHook>[0]);
      const toPersist = positionChanges.filter(
        (c) => c.dragging === false && c.position != null && typeof c.position.x === "number"
      );
      if (toPersist.length > 0) {
        setGraph((prev) => {
          if (!prev) return prev;
          const byId = new Map(toPersist.map((c) => [c.id, c.position!]));
          return {
            ...prev,
            nodes: prev.nodes.map((node) => {
              const pos = byId.get(node.id);
              if (!pos) return node;
              return { ...node, x: pos.x, y: pos.y };
            }),
          };
        });
        setDirty(true);
      }
    },
    [onNodesChangeFromHook]
  );

  const togglePin = useCallback((nodeId: string) => {
    setPinnedIds((prev) => {
      if (prev.includes(nodeId)) return prev.filter((id) => id !== nodeId);
      if (prev.length >= 5) return [...prev.slice(1), nodeId];
      return [...prev, nodeId];
    });
  }, []);

  const handleConfirm = useCallback(() => {
    if (!selectedNode) return;
    const tags = new Set(selectedNode.tags || []);
    tags.add("confirmed");
    // A user confirmation is an explicit signal — record it as such instead
    // of nudging a fabricated number.
    applyNodePatch(selectedNode.id, {
      confidence: 1,
      confidenceSource: "user",
      tags: [...tags],
    });
    setNotice({ kind: "success", text: `Confirmed: ${selectedNode.label}` });
  }, [applyNodePatch, selectedNode]);

  const handleDeprecate = useCallback(() => {
    if (!selectedNode) return;
    const tags = new Set(selectedNode.tags || []);
    tags.add("deprecated");
    applyNodePatch(selectedNode.id, {
      confidence: 0.2,
      confidenceSource: "user",
      tags: [...tags],
    });
    setNotice({ kind: "success", text: `Deprecated: ${selectedNode.label}` });
  }, [applyNodePatch, selectedNode]);

  const startEditing = useCallback(() => {
    if (!selectedNode) return;
    setEditingNodeId(selectedNode.id);
    setEditDraft(selectedNode.summary || "");
  }, [selectedNode]);

  const saveEdit = useCallback(() => {
    if (!selectedNode || editingNodeId !== selectedNode.id) return;
    applyNodePatch(selectedNode.id, { summary: editDraft.trim() });
    setEditingNodeId(null);
    setNotice({ kind: "success", text: `Updated summary for ${selectedNode.label}` });
  }, [applyNodePatch, editDraft, editingNodeId, selectedNode]);

  const saveGraph = useCallback(async () => {
    if (!graph) return;
    setSaving(true);
    try {
      const res = await fetch("/api/memory/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", graph, reindex: true }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      if (data.graph) setGraph(data.graph as GraphPayload);
      setDirty(false);
      setNotice({ kind: "success", text: data.indexed ? "Graph saved and indexed." : "Graph saved." });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to save graph." });
    } finally {
      setSaving(false);
    }
  }, [graph]);

  const publishSnapshot = useCallback(async () => {
    if (!graph) return;
    setPublishing(true);
    try {
      const res = await fetch("/api/memory/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "publish-memory-md", graph, reindex: true }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setNotice({
        kind: "success",
        text: data.indexed ? "Snapshot published to MEMORY.md and indexed." : "Snapshot published to MEMORY.md.",
      });
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : "Failed to publish snapshot." });
    } finally {
      setPublishing(false);
    }
  }, [graph]);

  const rebuildFromMemory = useCallback(async () => {
    setRebuilding(true);
    try {
      await loadGraph("bootstrap");
    } finally {
      setRebuilding(false);
    }
  }, [loadGraph]);

  const onNodeClick = useCallback<NodeMouseHandler<Node<FlowNodeData>>>((_, node) => {
    if (inspectorCollapsed) setInspectorCollapsed(false);
    setSelectedNodeId(node.id);
    if (layer === "overview") setShowTopicTable(false);
    const selected = collapsed.nodeById.get(node.id);
    if (selected && ["topic", "concept"].includes(selected.kind.toLowerCase())) {
      setSelectedTopicId(node.id);
      if (layer === "overview") setLayer("topic");
    }
  }, [collapsed.nodeById, inspectorCollapsed, layer]);

  if (loading || !graph) {
    return (
      <div className="flex flex-1 flex-col">
        <ScreenLoadingState />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* Collapsed tab — shown only when sidebar is hidden */}
      {sidebarCollapsed && (
        <button
          type="button"
          onClick={() => setSidebarCollapsed(false)}
          className="flex h-full w-6 shrink-0 flex-col items-center justify-center gap-1 border-r border-foreground/10 bg-card/60 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
          title="Expand sidebar"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}

      <aside
        style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
        className="flex shrink-0 flex-col overflow-hidden border-r border-foreground/10 bg-card/60"
        aria-hidden={sidebarCollapsed}
      >
        {/* Inner wrapper keeps content at full sidebarWidth even while aside animates */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto" style={{ width: sidebarWidth }}>
          {/* Action bar */}
          <div className="flex items-center gap-1 border-b border-foreground/10 px-2 py-1.5">
            <button
              type="button"
              onClick={() => void loadGraph()}
              title="Refresh"
              className="inline-flex items-center gap-1 rounded border border-foreground/10 bg-muted/40 px-1.5 py-1 text-xs text-foreground hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
            <button
              type="button"
              onClick={() => void rebuildFromMemory()}
              disabled={rebuilding || saving || publishing}
              title="Rebuild from memory"
              className="inline-flex items-center gap-1 rounded border border-info-border bg-info-bg px-1.5 py-1 text-xs text-info-fg hover:bg-info-bg disabled:opacity-50"
            >
              {rebuilding ? <span className="inline-flex items-center gap-0.5"><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" /></span> : <GitBranch className="h-3 w-3" />} Rebuild
            </button>
            <button
              type="button"
              onClick={saveGraph}
              disabled={!dirty || saving}
              title="Save graph"
              className="inline-flex items-center gap-1 rounded border border-border-strong bg-muted-foreground/15 px-1.5 py-1 text-xs text-muted-foreground hover:bg-muted-foreground/25 dark:text-fg-secondary disabled:opacity-50"
            >
              {saving ? <span className="inline-flex items-center gap-0.5"><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" /></span> : <Save className="h-3 w-3" />} Save
            </button>
            <button
              type="button"
              onClick={publishSnapshot}
              disabled={publishing}
              title="Publish snapshot to memory"
              className="inline-flex items-center gap-1 rounded border border-success-border bg-success-bg px-1.5 py-1 text-xs text-success-fg hover:bg-success-bg disabled:opacity-50"
            >
              {publishing ? <span className="inline-flex items-center gap-0.5"><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" /><span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" /></span> : <UploadCloud className="h-3 w-3" />} Publish
            </button>
            <button
              type="button"
              onClick={() => setSidebarCollapsed(true)}
              title="Collapse sidebar"
              className="ml-auto inline-flex items-center justify-center rounded border border-foreground/10 bg-transparent p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
          </div>

          {/* Search + layer controls */}
          <div className="space-y-1.5 p-2">
            <div className="flex items-center gap-1.5 rounded border border-foreground/10 bg-card px-2 py-1">
              <Search className="h-3 w-3 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="What matters now?"
                className="w-full bg-transparent text-xs text-foreground outline-none placeholder:text-fg-subtle"
              />
            </div>
            <div className="flex items-center gap-1">
              <select
                value={layer}
                onChange={(e) => setLayer(e.target.value as LayerMode)}
                className="flex-1 rounded border border-foreground/10 bg-card px-1.5 py-1 text-xs text-foreground"
              >
                {LAYER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={resetFilters}
                className="rounded border border-foreground/10 bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
              >
                Reset
              </button>
            </div>
          </div>

          {/* Extraction settings — where LLM extraction prompts go */}
          <div className="border-t border-foreground/10 p-2">
            <button
              type="button"
              onClick={() => setShowExtraction((prev) => !prev)}
              className="flex w-full items-center justify-between rounded border border-foreground/10 bg-card px-2 py-1 text-xs text-foreground hover:bg-muted"
            >
              <span className="inline-flex items-center gap-1.5">
                <SlidersHorizontal className="h-3 w-3" />
                Extraction
              </span>
              <span className="text-muted-foreground">
                {extractionSettings?.mode === "off"
                  ? "off"
                  : extractionSettings?.mode === "openai"
                    ? `openai · ${extractionSettings.model || "gpt-4o-mini"}`
                    : `gateway · ${extractionSettings?.model || gatewayDefaultModel || "agent default"}`}
              </span>
            </button>

            {showExtraction && extractionSettings ? (
              <div className="mt-2 space-y-2 rounded border border-foreground/10 bg-card/60 p-2">
                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Mode</p>
                  <select
                    value={extractionSettings.mode}
                    onChange={(e) => updateExtractionSettings({ mode: e.target.value as ExtractionSettingsPayload["mode"] })}
                    className="w-full rounded border border-foreground/10 bg-card px-1.5 py-1 text-xs text-foreground"
                  >
                    <option value="gateway">Gateway model (local endpoint)</option>
                    <option value="openai">OpenAI API (direct)</option>
                    <option value="off">Off — links only</option>
                  </select>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {extractionSettings.mode === "gateway"
                      ? "Prompts go through your local gateway and its configured providers."
                      : extractionSettings.mode === "openai"
                        ? "Memory content is sent to api.openai.com with the key below."
                        : "No LLM calls. The graph builds from wikilinks and headings only."}
                  </p>
                </div>

                {extractionSettings.mode === "gateway" ? (
                  <div className="space-y-1">
                    <p className="text-xs font-medium text-foreground">Model</p>
                    <select
                      value={extractionSettings.model}
                      onChange={(e) => updateExtractionSettings({ model: e.target.value })}
                      className="w-full rounded border border-foreground/10 bg-card px-1.5 py-1 text-xs text-foreground"
                    >
                      <option value="">
                        Agent default{gatewayDefaultModel ? ` (${gatewayDefaultModel})` : ""}
                      </option>
                      {gatewayModels.map((model) => (
                        <option key={model} value={model}>{model}</option>
                      ))}
                    </select>
                  </div>
                ) : null}

                {extractionSettings.mode === "openai" ? (
                  <>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-foreground">Model</p>
                      <input
                        value={extractionSettings.model}
                        onChange={(e) => updateExtractionSettings({ model: e.target.value })}
                        placeholder="gpt-4o-mini"
                        className="w-full rounded border border-foreground/10 bg-card px-1.5 py-1 text-xs text-foreground outline-none placeholder:text-fg-subtle"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-foreground">API key</p>
                      <input
                        value={extractionSettings.openaiApiKey}
                        onChange={(e) => updateExtractionSettings({ openaiApiKey: e.target.value })}
                        placeholder="sk-..."
                        className="w-full rounded border border-foreground/10 bg-card px-1.5 py-1 font-mono text-xs text-foreground outline-none placeholder:text-fg-subtle"
                      />
                      {legacyKeyDetected && !extractionSettings.openaiApiKey ? (
                        <button
                          type="button"
                          onClick={() => void importLegacyKey()}
                          className="w-full rounded border border-warning-border bg-warning-bg px-1.5 py-1 text-left text-[11px] leading-snug text-warning-fg hover:bg-warning-bg"
                        >
                          A key was found in ~/.openclaw/.env. It is never used automatically — click to import it.
                        </button>
                      ) : null}
                    </div>
                  </>
                ) : null}

                <button
                  type="button"
                  onClick={() => void saveExtractionSettings()}
                  disabled={extractionSaving}
                  className="w-full rounded border border-border-strong bg-muted-foreground/15 px-2 py-1 text-xs text-muted-foreground hover:bg-muted-foreground/25 dark:text-fg-secondary disabled:opacity-50"
                >
                  {extractionSaving ? "Saving..." : "Save extraction settings"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      {/* Resize handle — lives outside <aside> so overflow:hidden never clips it */}
      {!sidebarCollapsed && (
        <div
          onMouseDown={handleResizeStart}
          className="absolute top-0 z-20 h-full w-2 cursor-col-resize transition-colors hover:bg-muted-foreground/30 active:bg-muted-foreground/50"
          style={{ left: sidebarWidth - 4 }}
          title="Drag to resize"
        />
      )}

      <main
        className={cn(
          "relative min-h-0 flex-1",
          isDark
            ? "bg-[radial-gradient(circle_at_20%_0%,rgba(82,183,169,0.12),transparent_45%),radial-gradient(circle_at_88%_100%,rgba(126,162,231,0.16),transparent_44%)]"
            : "bg-[radial-gradient(circle_at_20%_0%,rgba(42,157,143,0.09),transparent_42%),radial-gradient(circle_at_88%_100%,rgba(43,76,126,0.12),transparent_42%)]"
        )}
      >
        <ReactFlow
          nodes={displayNodes}
          edges={flowEdges}
          onNodeClick={onNodeClick}
          onNodesChange={onNodesChange}
          onPaneClick={() => setSelectedNodeId(null)}
          fitView
          fitViewOptions={{ padding: 0.24 }}
          nodesDraggable={true}
          nodesConnectable={false}
          elementsSelectable
          colorMode={isDark ? "dark" : "light"}
          className="h-full w-full"
        >
          <Background gap={20} size={1} color="var(--chart-grid)" />
          <MiniMap pannable zoomable />
          <Controls />
        </ReactFlow>

        <div className="pointer-events-none absolute left-3 top-3 z-20 flex flex-col gap-2">
          {apiWarning ? (
            <div className="inline-flex max-w-xl items-start gap-2 rounded-md border border-warning-border bg-warning-bg px-2.5 py-1.5 text-xs text-warning-fg shadow-sm backdrop-blur">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{apiWarning}</span>
            </div>
          ) : null}
          {extractionInfo?.mode === "off" ? (
            <div className="inline-flex items-center gap-2 rounded-md border border-foreground/15 bg-card/80 px-2.5 py-1 text-xs text-foreground shadow-sm backdrop-blur">
              <EyeOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>LLM extraction is off — showing link-based graph.</span>
            </div>
          ) : null}
          <div className="inline-flex items-center gap-2 rounded-md border border-foreground/15 bg-card/80 px-2.5 py-1 text-xs text-foreground shadow-sm backdrop-blur">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-success-fg" />
            <span>
              Top {MAX_VISIBLE_NODES} nodes / {MAX_VISIBLE_EDGES} edges by expected usefulness.
            </span>
          </div>
          {visibleRelationTypes.length > 0 ? (
            <div className="rounded-md border border-foreground/15 bg-card/80 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur">
              <p className="mb-1.5 font-semibold text-foreground">Relations</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {visibleRelationTypes.map((relation) => (
                  <span key={relation} className="inline-flex items-center gap-1.5">
                    <span
                      className="h-2 w-3 shrink-0 rounded-sm border border-foreground/20"
                      style={{ backgroundColor: relationToColor(relation, isDark) }}
                      aria-hidden
                    />
                    <span className="text-foreground">{relationLabel(relation)}</span>
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </main>

      <aside
        className={cn(
          "flex shrink-0 flex-col border-l border-foreground/10 bg-card/60 transition-all duration-200",
          inspectorCollapsed ? "w-11" : "w-80"
        )}
      >
        <div className="space-y-2 border-b border-foreground/10 p-3">
          <div className={cn("flex items-start", inspectorCollapsed ? "justify-center" : "justify-between")}>
            {!inspectorCollapsed ? (
              <div>
                <p className="text-xs font-semibold text-foreground">Decision Inspector</p>
                <p className="text-xs text-muted-foreground">
                  Layer {layer === "overview" ? "A" : layer === "topic" ? "B" : "C"} · {lens} lens ·
                  visible nodes {flowNodes.length}
                </p>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setInspectorCollapsed((prev) => !prev)}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-foreground/10 bg-card text-muted-foreground transition-colors hover:text-foreground"
              title={inspectorCollapsed ? "Expand inspector" : "Collapse inspector"}
              aria-label={inspectorCollapsed ? "Expand inspector" : "Collapse inspector"}
            >
              {inspectorCollapsed ? (
                <ChevronLeft className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        {inspectorCollapsed ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-1">
            <span className="select-none text-xs tracking-wide text-muted-foreground [writing-mode:vertical-rl]">
              Inspector
            </span>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
            {selectedNode ? (
              <div className="space-y-2 rounded-lg border border-foreground/10 bg-card/45 p-3">
                <p className="text-xs font-semibold text-foreground">{selectedNode.label}</p>
                <p className="text-xs text-muted-foreground">
                  {selectedNode.kind} · {confidenceLabel(selectedNode)} · updated {formatAgo(nodeInsights.get(selectedNode.id)?.recencyMs || 0)}
                </p>

                <div className="flex flex-wrap gap-1 text-xs">
                  <span className="rounded bg-muted px-1.5 py-0.5">usefulness {Math.round((nodeInsights.get(selectedNode.id)?.usefulness || 0) * 100)}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">provenance {Math.round((nodeInsights.get(selectedNode.id)?.provenanceQuality || 0) * 100)}%</span>
                  <span className="rounded bg-muted px-1.5 py-0.5">retrieval {nodeInsights.get(selectedNode.id)?.retrievalInWindow || 0}</span>
                  {(overlayConflicts && (nodeInsights.get(selectedNode.id)?.conflicts || 0) > 0) ? (
                    <span className="rounded bg-danger-bg px-1.5 py-0.5 text-danger-fg">conflicts {nodeInsights.get(selectedNode.id)?.conflicts}</span>
                  ) : null}
                  {(overlayStaleness && nodeInsights.get(selectedNode.id)?.stale) ? (
                    <span className="rounded bg-warning-bg px-1.5 py-0.5 text-warning-fg">stale</span>
                  ) : null}
                  {(overlayLowProvenance && nodeInsights.get(selectedNode.id)?.lowProvenance) ? (
                    <span className="rounded bg-warning-bg px-1.5 py-0.5 text-warning-fg">low provenance</span>
                  ) : null}
                </div>

                {editingNodeId === selectedNode.id ? (
                  <div className="space-y-1">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-foreground/10 bg-background px-2 py-1.5 text-xs text-foreground outline-none"
                    />
                    <div className="flex gap-1">
                      <button type="button" onClick={saveEdit} className="rounded bg-primary text-primary-foreground px-2 py-1 text-xs hover:bg-primary/90">Save edit</button>
                      <button type="button" onClick={() => setEditingNodeId(null)} className="rounded border border-foreground/10 px-2 py-1 text-xs text-muted-foreground hover:bg-muted">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">{selectedNode.summary || "No summary yet."}</p>
                )}

                <div className="grid grid-cols-2 gap-1 text-xs">
                  <button type="button" onClick={handleConfirm} className="inline-flex items-center justify-center gap-1 rounded border border-success-border bg-success-bg px-2 py-1 text-success-fg hover:bg-success-bg"><CheckCircle2 className="h-3 w-3" />confirm</button>
                  <button type="button" onClick={startEditing} className="inline-flex items-center justify-center gap-1 rounded border border-foreground/10 bg-card px-2 py-1 text-foreground hover:bg-muted">edit</button>
                  <button type="button" onClick={handleDeprecate} className="inline-flex items-center justify-center gap-1 rounded border border-warning-border bg-warning-bg px-2 py-1 text-warning-fg hover:bg-warning-bg">deprecate</button>
                  <button type="button" onClick={() => togglePin(selectedNode.id)} className="inline-flex items-center justify-center gap-1 rounded border border-border bg-card px-2 py-1 text-foreground hover:bg-muted">{pinnedIds.includes(selectedNode.id) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}{pinnedIds.includes(selectedNode.id) ? "unpin" : "pin"}</button>
                </div>

                <div className="rounded border border-foreground/10 bg-background/30 p-2 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Provenance</p>
                  {(nodeInsights.get(selectedNode.id)?.sources || []).length === 0 ? (
                    <p className="mt-1">No explicit provenance source.</p>
                  ) : (
                    <div className="mt-1 space-y-0.5">
                      {(nodeInsights.get(selectedNode.id)?.sources || []).slice(0, 8).map((source) => (
                        <p key={source} className="truncate">{source}</p>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-foreground/15 bg-card/30 p-3 text-xs text-muted-foreground">
                Select a node to inspect what is wrong and what to do next.
              </div>
            )}

            {(layer === "topic" || layer === "forensics") && selectedTopic ? (
              <div className="space-y-2 rounded-lg border border-foreground/10 bg-card/45 p-3">
                <p className="text-xs font-semibold text-foreground">Topic focus: {selectedTopic.label}</p>
                <div className="space-y-1 text-xs">
                  {collapsed.edges
                    .filter((edge) => edge.source === selectedTopic.id || edge.target === selectedTopic.id)
                    .sort((a, b) => b.confidence - a.confidence)
                    .slice(0, 8)
                    .map((edge) => {
                      const otherId = edge.source === selectedTopic.id ? edge.target : edge.source;
                      const other = collapsed.nodeById.get(otherId);
                      return (
                        <button
                          key={edge.id}
                          type="button"
                          onClick={() => setSelectedNodeId(otherId)}
                          className="w-full rounded border border-foreground/10 bg-card px-2 py-1 text-left text-foreground hover:bg-muted"
                        >
                          <p className="truncate">{other?.label || otherId}</p>
                          {edge.fact ? (
                            <p className="truncate text-muted-foreground italic">{edge.fact}</p>
                          ) : (
                            <p className="truncate text-muted-foreground">
                              {relationLabel(edge.relation)} · {edge.scored ? `conf ${Math.round(edge.confidence * 100)}%` : "unscored"} · {formatAgo(edge.lastSeenMs)}
                            </p>
                          )}
                        </button>
                      );
                    })}
                </div>
              </div>
            ) : null}

            {layer === "forensics" ? (
              <div className="space-y-2 rounded-lg border border-foreground/10 bg-card/45 p-3">
                <p className="text-xs font-semibold text-foreground">Forensics</p>
                <p className="text-xs text-muted-foreground">
                  Raw chunks, provenance, and diffs for current focus.
                </p>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Raw chunks</p>
                  {forensics.docs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No matching chunks for this focus.</p>
                  ) : (
                    forensics.docs.slice(0, 4).map((doc) => (
                      <div key={doc.id} className="rounded border border-foreground/10 bg-card px-2 py-1.5">
                        <p className="truncate text-xs font-medium text-foreground">{doc.name}</p>
                        <p className="text-xs text-muted-foreground">{doc.path}</p>
                        <div className="mt-1 max-h-24 space-y-1 overflow-y-auto">
                          {doc.chunks.slice(0, 4).map((chunk) => (
                            <p key={chunk.id} className="rounded bg-background/60 px-1.5 py-1 text-xs text-muted-foreground">
                              L{chunk.startLine}: {chunk.text}
                            </p>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Provenance facts</p>
                  <div className="max-h-28 space-y-1 overflow-y-auto">
                    {forensics.facts.slice(0, 12).map((fact) => (
                      <p key={`${fact.doc}:${fact.id}`} className="rounded border border-foreground/10 bg-background/40 px-1.5 py-1 text-xs text-muted-foreground">
                        {fact.doc}:L{fact.line} · {fact.statement}
                      </p>
                    ))}
                    {forensics.facts.length === 0 ? <p className="text-xs text-muted-foreground">No matched facts.</p> : null}
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs font-medium text-foreground">Diffs / contradictions</p>
                  {forensics.diffs.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No contradictions detected in current forensics scope.</p>
                  ) : (
                    forensics.diffs.slice(0, 6).map((diff) => (
                      <div key={diff.canonical} className="rounded border border-danger-border bg-danger-bg px-2 py-1 text-xs text-danger-fg">
                        {diff.statements.map((statement, idx) => (
                          <p key={`${diff.canonical}:${idx}`}>• {statement}</p>
                        ))}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : null}

            {(overlayDupes || overlayMergeSuggestions) ? (
              <div className="space-y-2 rounded-lg border border-foreground/10 bg-card/45 p-3">
                {overlayDupes ? (
                  <div>
                    <p className="text-xs font-medium text-foreground">Duplication</p>
                    <div className="mt-1 max-h-20 space-y-1 overflow-y-auto">
                      {diagnostics.duplicates.slice(0, 8).map((group) => (
                        <p key={group.labelKey} className="text-xs text-muted-foreground">
                          {group.labels.join(" | ")}
                        </p>
                      ))}
                      {diagnostics.duplicates.length === 0 ? <p className="text-xs text-muted-foreground">No duplicate labels.</p> : null}
                    </div>
                  </div>
                ) : null}

                {overlayMergeSuggestions ? (
                  <div>
                    <p className="text-xs font-medium text-foreground">Merge suggestions</p>
                    <div className="mt-1 max-h-20 space-y-1 overflow-y-auto">
                      {diagnostics.mergeSuggestions.slice(0, 8).map((pair) => (
                        <p key={`${pair.a.id}:${pair.b.id}`} className="text-xs text-muted-foreground">
                          {pair.a.label} ↔ {pair.b.label} ({Math.round(pair.similarity * 100)}%)
                        </p>
                      ))}
                      {diagnostics.mergeSuggestions.length === 0 ? <p className="text-xs text-muted-foreground">No merge candidates.</p> : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className="rounded-lg border border-foreground/10 bg-card/40 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Current defaults</p>
              <p>Focus + context: 1-hop full, 2-hop faint, 3-hop hidden unless expanded.</p>
              <p>Render caps: top {MAX_VISIBLE_NODES} nodes, top {MAX_VISIBLE_EDGES} edges in scope.</p>
              <p>Ranking signals: retrieval frequency, recency, conflict rate, provenance, task relevance, breadth.</p>
            </div>
          </div>
        )}
      </aside>

      {notice ? (
        <div
          className={cn(
            "pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border px-3 py-2 text-xs shadow-lg backdrop-blur-sm",
            notice.kind === "success"
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-danger-border bg-danger-bg text-danger-fg"
          )}
        >
          <span className="inline-flex items-center gap-1.5">
            {notice.kind === "success" ? <Sparkles className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            {notice.text}
          </span>
        </div>
      ) : null}

      {(saving || publishing) ? (
        <div className="pointer-events-none absolute right-4 top-4 z-30 inline-flex items-center gap-1.5 rounded-md border border-foreground/15 bg-card/90 px-2 py-1 text-xs text-foreground">
          <InlineSpinner size="sm" />
          {saving ? "Saving graph..." : "Publishing snapshot..."}
        </div>
      ) : null}
    </div>
  );
}
