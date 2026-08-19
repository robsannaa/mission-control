"use client";

import {
  useEffect,
  useState,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  Brain,
  LayoutDashboard,
  Activity,
  BarChart3,
  Users,
  MessageCircle,
  MessageSquare,
  ListChecks,
  Calendar,
  Puzzle,
  Clock,
  Heart,
  Wrench,
  Package,
  FolderOpen,
  Database,
  Cpu,
  KeyRound,
  ShieldCheck,
  Webhook,
  Settings2,
  Stethoscope,
  SquareTerminal,
  Terminal,
  Globe,
  Volume2,
  Waypoints,
  Settings,
  Radio,
  HelpCircle,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap, useBodyScrollLock } from "@/hooks/use-modal-accessibility";
import { InlineSpinner } from "@/components/ui/loading-state";
import { useCapabilities } from "@/hooks/use-capabilities";
import type { CapabilityKey, CapabilityMatrix } from "@/lib/capabilities";

/* ── types ────────────────────────────────────────── */

type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export type QuickAction = {
  id: string;
  label: string;
  group: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  keywords: string[];
  /** Hidden entirely unless this capability resolves `true` — the tags here
   * must mirror sidebar.tsx's `NavItem.requiresCapability` tags for the same
   * feature, or a "hidden" feature stays reachable from the command palette. */
  requiresCapability?: CapabilityKey;
};

type UnifiedItem =
  | { kind: "action"; action: QuickAction }
  | { kind: "result"; result: SearchResult };

type Props = {
  open: boolean;
  onClose: () => void;
};

/* ── quick actions (sidebar nav as command palette) ──
 * Mirrors the sidebar's IA (src/components/sidebar.tsx) — same renames,
 * same grouping, same hosted-only gaps. Ordered Chat-first so the empty-query
 * default (first 6) matches what the rail leads with. */

const ALL_QUICK_ACTIONS: QuickAction[] = [
  { id: "chat", label: "Chat", group: "Overview", href: "/chat", icon: MessageCircle, keywords: ["message", "talk", "ping"] },
  { id: "tasks", label: "Tasks", group: "Overview", href: "/tasks", icon: ListChecks, keywords: ["todo", "jobs", "queue"] },
  { id: "dashboard", label: "Dashboard", group: "Overview", href: "/dashboard", icon: LayoutDashboard, keywords: ["home", "overview", "main"] },
  { id: "activity", label: "Activity", group: "Overview", href: "/activity", icon: Activity, keywords: ["log", "events", "history"] },
  { id: "usage", label: "Usage", group: "Overview", href: "/usage", icon: BarChart3, keywords: ["stats", "metrics", "analytics"] },
  { id: "sessions", label: "Sessions", group: "Overview", href: "/sessions", icon: MessageSquare, keywords: ["conversations", "threads"] },
  { id: "calendar", label: "Calendar", group: "Overview", href: "/calendar", icon: Calendar, keywords: ["schedule", "events", "date"], requiresCapability: "calendarWorkspace" },

  { id: "agents", label: "Agents", group: "Agents", href: "/agents", icon: Users, keywords: ["bots", "assistants"] },
  { id: "models", label: "Models", group: "Agents", href: "/agents?tab=models", icon: Cpu, keywords: ["llm", "ai", "gpt", "claude"] },
  { id: "skills", label: "Skills", group: "Agents", href: "/skills", icon: Wrench, keywords: ["tools", "capabilities"] },
  { id: "clawhub", label: "Marketplace", group: "Agents", href: "/skills?tab=clawhub", icon: Package, keywords: ["marketplace", "store", "plugins", "clawhub"] },
  { id: "cron", label: "Cron Jobs", group: "Agents", href: "/cron", icon: Clock, keywords: ["schedule", "scheduled tasks", "timer", "recurring", "cron", "cron jobs"] },
  { id: "heartbeat", label: "Heartbeat", group: "Agents", href: "/heartbeat", icon: Heart, keywords: ["pulse", "keep-alive", "recurring"] },

  { id: "memory", label: "Memory", group: "Knowledge", href: "/memory", icon: Brain, keywords: ["knowledge", "notes", "journal"] },
  { id: "docs", label: "Documents", group: "Knowledge", href: "/documents", icon: FolderOpen, keywords: ["files", "uploads"] },
  { id: "vectors", label: "Vector DB", group: "Knowledge", href: "/vectors", icon: Database, keywords: ["embeddings", "semantic", "index"] },
  { id: "web-search", label: "Web Search", group: "Knowledge", href: "/search", icon: Search, keywords: ["perplexity", "brave", "internet"] },

  { id: "channels", label: "Channels", group: "Connections", href: "/channels", icon: Radio, keywords: ["telegram", "discord", "slack"] },
  { id: "integrations", label: "Integrations", group: "Connections", href: "/integrations", icon: Puzzle, keywords: ["connect", "apps", "plugins", "gmail", "drive"] },

  { id: "logs", label: "Logs", group: "Settings", href: "/logs", icon: Terminal, keywords: ["output", "debug", "trace"], requiresCapability: "hostInfrastructure" },
  { id: "accounts", label: "API Keys", group: "Settings", href: "/accounts", icon: KeyRound, keywords: ["credentials", "tokens", "auth", "keys", "api", "secrets"] },
  { id: "security", label: "Security", group: "Settings", href: "/security", icon: ShieldCheck, keywords: ["permissions", "access"] },
  { id: "hooks", label: "Webhooks", group: "Settings", href: "/hooks", icon: Webhook, keywords: ["events", "triggers", "automation", "hooks"] },
  { id: "settings", label: "Preferences", group: "Settings", href: "/settings", icon: Settings2, keywords: ["config", "options"] },
  { id: "doctor", label: "Doctor", group: "Settings", href: "/doctor", icon: Stethoscope, keywords: ["health", "diagnostics", "debug"] },
  { id: "terminal", label: "Terminal", group: "Settings", href: "/terminal", icon: SquareTerminal, keywords: ["shell", "console", "cli"], requiresCapability: "hostInfrastructure" },
  { id: "browser", label: "Browser Automation", group: "Settings", href: "/browser", icon: Globe, keywords: ["web", "proxy", "remote", "browser relay"], requiresCapability: "hostInfrastructure" },
  { id: "audio", label: "Audio & Voice", group: "Settings", href: "/audio", icon: Volume2, keywords: ["speech", "microphone", "tts"], requiresCapability: "hostInfrastructure" },
  { id: "tailscale", label: "Tailscale", group: "Settings", href: "/tailscale", icon: Waypoints, keywords: ["vpn", "network", "tunnel"], requiresCapability: "tailscaleNetworking" },
  { id: "config", label: "Config", group: "Settings", href: "/config", icon: Settings, keywords: ["configuration", "system"], requiresCapability: "hostInfrastructure" },
  { id: "help", label: "Help & Support", group: "Settings", href: "/help", icon: HelpCircle, keywords: ["support", "faq", "contact"] },
];

/** Pure filter — mirrors `sidebar.tsx`'s `filterNavItemsForCapabilities`,
 * kept separate from any context read so it is exercised the same way in
 * tests (no rendering, no provider). */
export function filterQuickActionsForCapabilities(
  actions: QuickAction[],
  capabilities: CapabilityMatrix,
): QuickAction[] {
  return actions.filter((action) => !action.requiresCapability || capabilities[action.requiresCapability]);
}

/* ── helpers ──────────────────────────────────────── */

function scoreLabel(score: number): string {
  if (score >= 0.6) return "High";
  if (score >= 0.45) return "Medium";
  return "Low";
}

function scoreColor(score: number): string {
  if (score >= 0.6) return "text-success-fg";
  if (score >= 0.45) return "text-warning-fg";
  return "text-muted-foreground";
}

/** Friendly display for paths like memory/2026-02-14.md */
function pathDisplay(path: string): { icon: string; label: string } {
  if (path.startsWith("memory/")) {
    return { icon: "🧠", label: path.replace("memory/", "") };
  }
  return { icon: "📄", label: path };
}

/** Escape HTML entities to prevent XSS */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Highlight markdown-style bold tokens as HTML (sanitized) */
function highlightSnippet(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<span class="text-foreground font-semibold">$1</span>')
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1 py-0.5 text-xs text-fg-secondary font-mono">$1</code>');
}

/* ── sessionStorage result cache ── */

const CACHE_KEY = "mc-search-cache";
const MAX_CACHED = 5;

type CacheEntry = { query: string; results: SearchResult[]; ts: number };

function readCache(): CacheEntry[] {
  try {
    return JSON.parse(sessionStorage.getItem(CACHE_KEY) || "[]");
  } catch {
    return [];
  }
}

function writeCache(query: string, results: SearchResult[]) {
  try {
    const entries = readCache().filter((e) => e.query !== query);
    entries.unshift({ query, results, ts: Date.now() });
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(entries.slice(0, MAX_CACHED)));
  } catch { /* quota exceeded — ignore */ }
}

function getCached(query: string): SearchResult[] | null {
  const entry = readCache().find((e) => e.query === query);
  // Expire after 5 minutes
  if (entry && Date.now() - entry.ts < 5 * 60 * 1000) return entry.results;
  return null;
}

/* ── component ───────────────────────────────────── */

export function SearchModal({ open, onClose }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [indexWarning, setIndexWarning] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultListRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const focusTrapRef = useFocusTrap(open);
  useBodyScrollLock(open);

  const { capabilities } = useCapabilities();
  const quickActions = useMemo(
    () => filterQuickActionsForCapabilities(ALL_QUICK_ACTIONS, capabilities),
    [capabilities],
  );

  // Detect command palette mode (query starts with ">")
  const isCommandMode = query.startsWith(">");
  const commandQuery = isCommandMode ? query.slice(1).trim().toLowerCase() : "";

  /**
   * Destination matching. Plain text searches EVERYTHING — pages, settings and
   * memory — because a user who presses Cmd+K and types "cron" wants the Cron
   * page, not a semantic memory hit. The ">" prefix remains as an explicit
   * "commands only" filter for people who know it, but nothing depends on
   * discovering it.
   */
  const filteredActions = useMemo(() => {
    const term = (isCommandMode ? commandQuery : query.trim().toLowerCase());

    // Empty input: show the most useful destinations rather than a blank panel.
    if (!term) return isCommandMode ? quickActions : quickActions.slice(0, 6);

    const scored = quickActions
      .map((a) => {
        const label = a.label.toLowerCase();
        let score = 0;
        if (label === term) score = 100;
        else if (label.startsWith(term)) score = 80;
        else if (label.includes(term)) score = 60;
        else if (a.keywords.some((k) => k === term)) score = 55;
        else if (a.keywords.some((k) => k.startsWith(term))) score = 45;
        else if (a.keywords.some((k) => k.includes(term))) score = 35;
        else if (a.group.toLowerCase().includes(term)) score = 25;
        return { action: a, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.action.label.localeCompare(b.action.label));

    return scored.map((x) => x.action);
  }, [isCommandMode, commandQuery, query, quickActions]);

  // Build unified items list for keyboard navigation. Destinations come first:
  // they are exact, instant and local, while memory results are fuzzy.
  const unifiedItems = useMemo((): UnifiedItem[] => {
    const actions = filteredActions.map((a) => ({ kind: "action" as const, action: a }));
    if (isCommandMode) return actions;
    return [...actions, ...results.map((r) => ({ kind: "result" as const, result: r }))];
  }, [isCommandMode, filteredActions, results]);

  // Check vector index status on modal open
  useEffect(() => {
    if (!open) return;
    setIndexWarning(null);
    const controller = new AbortController();
    fetch("/api/vector?scope=status", { signal: controller.signal, cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        // Check if any agents have "not_indexed" status
        const agents = data.agents || [];
        const unindexed = agents.filter(
          (a: { indexStatus?: string }) => a.indexStatus === "not_indexed"
        );
        if (unindexed.length > 0 && agents.length > 0) {
          if (unindexed.length === agents.length) {
            setIndexWarning("Memory is not indexed. Go to Vector DB to set up indexing for better search results.");
          } else {
            setIndexWarning(`${unindexed.length} agent(s) have unindexed memory. Results may be incomplete.`);
          }
        }
      })
      .catch(() => { /* non-critical — don't block search */ });
    return () => controller.abort();
  }, [open]);

  // Reset state when modal opens; auto-focus input
  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setSearched(false);
      setSelectedIdx(0);
      setError(null);
      // Focus input after DOM settles (focus trap may also handle this)
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
    // Clean up debounce and in-flight fetch when closing
    if (debounceRef.current) clearTimeout(debounceRef.current);
    abortRef.current?.abort();
  }, [open]);

  // Debounced search
  const doSearch = useCallback(async (q: string) => {
    if (q.trim().length < 2) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      setError(null);
      return;
    }

    // Check sessionStorage cache first
    const cached = getCached(q.trim());
    if (cached) {
      setResults(cached);
      setSearched(true);
      setSelectedIdx(0);
      setLoading(false);
      setError(null);
      return;
    }

    // Abort any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setSearched(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Search failed (${res.status})`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const searchResults = data.results || [];
      setResults(searchResults);
      setSelectedIdx(0);
      // Cache successful results
      if (searchResults.length > 0) {
        writeCache(q.trim(), searchResults);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setResults([]);
      setError(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleQueryChange = (value: string) => {
    setQuery(value);
    // Any keystroke re-ranks the list, so selection must return to the top.
    setSelectedIdx(0);
    // Skip API search in command mode
    if (value.startsWith(">")) {
      setResults([]);
      setSearched(false);
      setLoading(false);
      setError(null);
      setSelectedIdx(0);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doSearch(value), 300);
  };

  const openResult = useCallback((result: SearchResult) => {
    // Start clean: params from the page behind the modal do not belong on /memory.
    const params = new URLSearchParams();
    params.set("memoryPath", result.path);
    params.set("memoryLine", String(result.startLine));
    if (query.trim()) params.set("memoryQuery", query.trim());
    else params.delete("memoryQuery");

    const next = params.toString();
    router.push(next ? `/memory?${next}` : "/memory", { scroll: false });
    onClose();
  }, [onClose, query, router]);

  const openAction = useCallback((action: QuickAction) => {
    router.push(action.href, { scroll: false });
    onClose();
  }, [onClose, router]);

  // Scroll selected result into view
  useEffect(() => {
    const container = resultListRef.current;
    if (!container || unifiedItems.length === 0) return;
    const buttons = container.querySelectorAll<HTMLButtonElement>("button[data-result]");
    buttons[selectedIdx]?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, unifiedItems.length]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(i + 1, unifiedItems.length - 1));
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(i - 1, 0));
    }
    if (e.key === "Enter" && unifiedItems[selectedIdx]) {
      e.preventDefault();
      const item = unifiedItems[selectedIdx];
      if (item.kind === "action") openAction(item.action);
      else openResult(item.result);
    }
  };

  if (!open) return null;

  const showEmptyHint = !searched && !loading && !isCommandMode && query.trim().length === 0;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div
        ref={focusTrapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search and navigate"
        className="fixed inset-x-0 top-24 z-50 w-full max-w-2xl px-4 sm:left-1/2 sm:-translate-x-1/2 sm:px-0"
      >
        <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card shadow-2xl shadow-black/50">
          {/* Search input */}
          <div className="flex min-w-0 items-center gap-3 border-b border-foreground/10 px-4 py-3 sm:px-6">
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search memories or type > to navigate..."
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-fg-subtle"
              spellCheck={false}
              autoComplete="off"
            />
            <kbd className="hidden rounded border border-foreground/10 bg-muted/70 px-1.5 py-0.5 text-xs text-fg-subtle sm:inline">
              ESC
            </kbd>
          </div>

          {/* Results */}
          <div ref={resultListRef} className="max-h-96 overflow-x-hidden overflow-y-auto">
            {/* Index warning banner */}
            {indexWarning && !isCommandMode && (
              <div className="flex items-center gap-2 border-b border-foreground/5 bg-warning-bg px-4 py-2 sm:px-6">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning-fg" />
                <span className="text-xs text-warning-fg">{indexWarning}</span>
              </div>
            )}

            {/* Empty state hint */}
            {showEmptyHint && (
              <div className="flex flex-col items-center gap-3 px-4 py-10 text-center sm:px-6">
                <div className="flex items-center gap-2 text-fg-subtle">
                  <Brain className="h-5 w-5" />
                  <span className="text-sm font-medium">
                    Semantic Memory Search
                  </span>
                </div>
                <p className="max-w-sm text-xs leading-5 text-fg-subtle">
                  Search across MEMORY.md and daily journals using vector
                  search. Type at least 2 characters, or type{" "}
                  <kbd className="rounded border border-foreground/10 bg-muted/60 px-1 py-0.5 font-mono">
                    &gt;
                  </kbd>{" "}
                  to navigate to any page.
                </p>
              </div>
            )}

            {/* Destinations — pages, settings, features */}
            {(isCommandMode || filteredActions.length > 0) && (
              <div className="min-w-0 py-2">
                {isCommandMode && filteredActions.length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-fg-subtle sm:px-6">
                    No matching pages for &quot;{commandQuery}&quot;
                  </div>
                ) : (
                  <>
                    {/* Group actions by category */}
                    {(() => {
                      let lastGroup = "";
                      return filteredActions.map((action, idx) => {
                        const showGroup = action.group !== lastGroup;
                        lastGroup = action.group;
                        const Icon = action.icon;
                        const isSelected = idx === selectedIdx;
                        return (
                          <div key={action.id}>
                            {showGroup && (
                              <div className="px-4 pb-1 pt-3 first:pt-1 sm:px-6">
                                <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                                  {action.group}
                                </span>
                              </div>
                            )}
                            <button
                              type="button"
                              data-result
                              className={cn(
                                "flex w-full items-center gap-3 px-4 py-2 text-left text-sm transition-colors sm:px-6",
                                isSelected
                                  ? "bg-muted-foreground/10 text-foreground"
                                  : "text-fg-secondary hover:bg-muted/60"
                              )}
                              onMouseEnter={() => setSelectedIdx(idx)}
                              onClick={() => openAction(action)}
                            >
                              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                              <span className="flex-1">{action.label}</span>
                              <span className="text-xs text-fg-subtle">{action.group}</span>
                            </button>
                          </div>
                        );
                      });
                    })()}
                  </>
                )}
              </div>
            )}

            {/* Loading state (memory search) */}
            {!isCommandMode && loading && results.length === 0 && searched && (
              <div className="flex items-center justify-center px-4 py-10 sm:px-6">
                <InlineSpinner />
              </div>
            )}

            {/* Error state */}
            {!isCommandMode && error && !loading && (
              <div className="px-4 py-10 text-center text-sm text-danger-fg sm:px-6">
                {error}
              </div>
            )}

            {/* No results */}
            {!isCommandMode && searched && !loading && !error && results.length === 0 && (
              <div className="px-4 py-10 text-center text-sm text-fg-subtle sm:px-6">
                No matches found for &quot;{query}&quot;
              </div>
            )}

            {/* Memory search result list */}
            {!isCommandMode && results.length > 0 && (
              <div className="min-w-0 py-2">
                <div className="px-4 pb-2 sm:px-6">
                  <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                    {results.length} result{results.length !== 1 ? "s" : ""}
                  </span>
                </div>
                {results.map((result, rIdx) => {
                  const idx = filteredActions.length + rIdx;
                  const { icon, label } = pathDisplay(result.path);
                  const isSelected = idx === selectedIdx;
                  return (
                    <button
                      key={`${result.path}-${result.startLine}`}
                      type="button"
                      data-result
                      className={cn(
                        "flex w-full min-w-0 flex-col gap-1.5 px-4 py-3 text-left transition-colors sm:px-6",
                        isSelected
                          ? "bg-muted-foreground/10"
                          : "hover:bg-muted/60"
                      )}
                      onMouseEnter={() => setSelectedIdx(idx)}
                      onClick={() => openResult(result)}
                    >
                      {/* Header row */}
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 text-sm">{icon}</span>
                        <span className="min-w-0 truncate text-xs font-medium text-fg-secondary">
                          {label}
                        </span>
                        <span className="text-xs text-fg-subtle">
                          L{result.startLine}–{result.endLine}
                        </span>
                        <div className="flex-1" />
                        <span
                          className={cn(
                            "text-xs font-medium",
                            scoreColor(result.score)
                          )}
                        >
                          {(result.score * 100).toFixed(0)}% &middot;{" "}
                          {scoreLabel(result.score)}
                        </span>
                      </div>

                      {/* Snippet */}
                      <div
                        className="line-clamp-4 break-words text-xs leading-5 text-muted-foreground"
                        dangerouslySetInnerHTML={{
                          __html: highlightSnippet(
                            result.snippet.substring(0, 400)
                          ),
                        }}
                      />
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-foreground/10 px-4 py-2 text-xs text-fg-subtle sm:px-6">
            <span>
              {isCommandMode ? (
                "Type to filter pages"
              ) : (
                <>
                  Powered by{" "}
                  <span className="font-medium text-muted-foreground">
                    openclaw memory search
                  </span>
                </>
              )}
            </span>
            <div className="flex items-center gap-2">
              <span>
                <kbd className="rounded border border-foreground/10 bg-muted/60 px-1 py-0.5">
                  ↑↓
                </kbd>{" "}
                navigate
              </span>
              <span>
                <kbd className="rounded border border-foreground/10 bg-muted/60 px-1 py-0.5">
                  enter
                </kbd>{" "}
                {isCommandMode ? "go" : "open"}
              </span>
              <span>
                <kbd className="rounded border border-foreground/10 bg-muted/60 px-1 py-0.5">
                  esc
                </kbd>{" "}
                close
              </span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
