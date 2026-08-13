"use client";

import { useEffect, useState, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import {
  Search,
  RefreshCw,
  AlertCircle,
  AlertTriangle,
  Info,
  Filter,
  ArrowDown,
  Pause,
  Play,
  Terminal,
  X,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { InlineSpinner, LoadingState } from "@/components/ui/loading-state";
import {
  getTimeFormatServerSnapshot,
  getTimeFormatSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";

type LogEntry = {
  anchor: string;
  line: number;
  time: string;
  timeMs: number;
  source: string;
  level: "info" | "warn" | "error";
  message: string;
  raw: string;
};

type LogStats = { info: number; warn: number; error: number };

const LEVEL_STYLES: Record<
  string,
  {
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    rowClass: string;
    messageClass: string;
  }
> = {
  error: {
    icon: AlertCircle,
    iconClass: "text-danger-fg",
    rowClass: "border-l-2 border-danger-border bg-danger-bg",
    messageClass: "text-danger-fg",
  },
  warn: {
    icon: AlertTriangle,
    iconClass: "text-warning-fg",
    rowClass: "border-l-2 border-warning-border bg-warning-bg",
    messageClass: "text-warning-fg",
  },
  info: {
    icon: Info,
    iconClass: "text-muted-foreground dark:text-fg-subtle",
    rowClass: "border-l-2 border-transparent",
    messageClass: "text-foreground",
  },
};

function sourceClass(source: string): string {
  switch (source) {
    case "ws":
      return "text-info-fg";
    case "cron":
      return "text-warning-fg";
    case "telegram":
      return "text-info-fg";
    case "tools":
      return "text-success-fg";
    case "skills-remote":
      return "text-warning-fg";
    case "agent":
      return "text-success-fg";
    case "system":
      return "text-danger-fg";
    default:
      return "text-fg-secondary";
  }
}

function formatLogTime(time: string, timeFormat: TimeFormatPreference): string {
  if (!time) return "";
  try {
    const d = new Date(time);
    return d.toLocaleTimeString(
      "en-US",
      withTimeFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit" }, timeFormat),
    );
  } catch {
    return time;
  }
}

function formatLogDate(time: string): string {
  if (!time) return "";
  try {
    const d = new Date(time);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function LogsView() {
  const searchParams = useSearchParams();
  const targetAnchor = searchParams.get("anchor") || "";
  const targetTime = Number(searchParams.get("time") || 0);
  const targetSource = searchParams.get("source") || "";
  const targetSignature = `${targetAnchor}|${targetTime}|${targetSource}`;
  const hasLogTarget = Boolean(targetAnchor || targetTime);
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [stats, setStats] = useState<LogStats>({ info: 0, warn: 0, error: 0 });
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [autoScroll, setAutoScroll] = useState(!hasLogTarget);
  const [limit, setLimit] = useState(hasLogTarget ? 1000 : 200);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const scrolledTargetRef = useRef("");

  // Debounce search: only update debouncedSearch 300ms after the user stops typing
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const fetchLogs = useCallback(async () => {
    try {
      const requestedLimit = hasLogTarget ? Math.max(limit, 1000) : limit;
      const params = new URLSearchParams({ limit: String(requestedLimit) });
      if (debouncedSearch) params.set("search", debouncedSearch);
      if (sourceFilter) params.set("source", sourceFilter);
      if (levelFilter) params.set("level", levelFilter);
      const res = await fetch(`/api/logs?${params}`, { signal: AbortSignal.timeout(10000) });
      const data = await res.json();
      setEntries(data.entries || []);
      setSources(data.sources || []);
      setStats(data.stats || { info: 0, warn: 0, error: 0 });
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [limit, hasLogTarget, debouncedSearch, sourceFilter, levelFilter]);

  // Initial fetch + auto-refresh every 10s (paused when autoRefresh is off)
  useSmartPoll(fetchLogs, { intervalMs: 10000, enabled: autoRefresh });

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (autoScroll && !hasLogTarget && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, autoScroll, hasLogTarget]);

  // Detect manual scroll to disable auto-scroll
  const handleScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  }, []);

  const clearFilters = useCallback(() => {
    setSearch("");
    setDebouncedSearch("");
    setSourceFilter("");
    setLevelFilter("");
  }, []);

  const hasFilters = search || sourceFilter || levelFilter;

  // Reversed entries for terminal display (oldest at top, newest at bottom)
  const displayEntries = useMemo(
    () => [...entries].reverse(),
    [entries]
  );

  const targetEntry = useMemo(() => {
    if (!hasLogTarget) return null;
    if (targetAnchor) {
      const exact = displayEntries.find((entry) => entry.anchor === targetAnchor);
      if (exact) return exact;
    }
    if (!targetTime) return null;
    const matchingSource = targetSource.toLocaleLowerCase();
    return displayEntries
      .filter((entry) => !matchingSource || entry.source.toLocaleLowerCase() === matchingSource)
      .map((entry) => ({ entry, distance: Math.abs(entry.timeMs - targetTime) }))
      .filter(({ distance }) => distance <= 2_000)
      .sort((left, right) => left.distance - right.distance)[0]?.entry || null;
  }, [displayEntries, hasLogTarget, targetAnchor, targetSource, targetTime]);

  useEffect(() => {
    if (!targetEntry || scrolledTargetRef.current === targetSignature) return;
    const row = rowRefs.current.get(targetEntry.anchor);
    if (!row) return;
    scrolledTargetRef.current = targetSignature;
    const frame = window.requestAnimationFrame(() => {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [targetEntry, targetSignature]);

  const downloadLogs = useCallback(() => {
    const blob = new Blob([JSON.stringify(displayEntries, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `openclaw-logs-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [displayEntries]);

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Terminal className="h-5 w-5 text-fg-secondary dark:text-foreground" />
            Logs
          </span>
        }
        description="Live gateway and agent logs with filtering, tailing, and quick source inspection."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1.5">
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-fg-secondary dark:bg-card">
              {stats.info} info
              </span>
            {stats.warn > 0 && (
                <span className="rounded-full bg-warning-bg px-2.5 py-0.5 text-xs font-semibold text-warning-fg">
                {stats.warn} warn
                </span>
            )}
            {stats.error > 0 && (
                <span className="rounded-full bg-danger-bg px-2.5 py-0.5 text-xs font-semibold text-danger-fg">
                {stats.error} err
                </span>
            )}
            </div>
            <button
              type="button"
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                autoRefresh
                  ? "border-success-border bg-success-bg text-success-fg"
                  : "border-border bg-card text-fg-secondary hover:bg-muted hover:text-foreground dark:hover:bg-card"
              )}
            >
              {autoRefresh ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {autoRefresh ? "Live" : "Paused"}
            </button>
            <button
              type="button"
              onClick={fetchLogs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-card"
              title="Refresh now"
            >
              {loading ? (
                <InlineSpinner size="sm" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
            <button
              type="button"
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                showFilters || hasFilters
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-card text-fg-secondary hover:bg-muted hover:text-foreground dark:hover:bg-card"
              )}
            >
              <Filter className="h-3.5 w-3.5" />
              Filters
              {hasFilters && (
                <span className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  showFilters || hasFilters
                    ? "bg-white/20 text-white dark:bg-foreground/15 dark:text-foreground"
                    : "bg-muted text-fg-secondary"
                )}>
                  Active
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={downloadLogs}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-card"
              title="Download logs as JSON"
              aria-label="Download logs as JSON"
            >
              <Download className="h-3.5 w-3.5" />
              Export
            </button>
          </div>
        }
      />

      <SectionBody width="wide" padding="regular" innerClassName="space-y-4">
        {showFilters && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold text-foreground">Filters</p>
                <p className="text-xs text-muted-foreground dark:text-fg-subtle">Narrow logs by search, source, level, or history depth.</p>
              </div>
              {hasFilters && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-fg-subtle"
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-2 dark:bg-foreground/70">
              <Search className="h-3.5 w-3.5 text-fg-subtle dark:text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search logs..."
                className="w-44 bg-transparent text-sm text-fg-secondary outline-none placeholder:text-fg-subtle dark:text-foreground dark:placeholder:text-muted-foreground"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch("")}
                  className="text-fg-subtle hover:text-fg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-muted-foreground dark:hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>

            {/* Source filter */}
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg-secondary outline-none dark:text-foreground"
            >
              <option value="">All sources</option>
              {sources.map((s) => (
                <option key={s} value={s}>
                  [{s}]
                </option>
              ))}
            </select>

            {/* Level filter */}
            <div className="flex items-center gap-1">
              {(["info", "warn", "error"] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  onClick={() =>
                    setLevelFilter(levelFilter === level ? "" : level)
                  }
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    levelFilter === level
                      ? level === "error"
                        ? "border-danger-border bg-danger-bg text-danger-fg"
                      : level === "warn"
                          ? "border-warning-border bg-warning-bg text-warning-fg"
                          : "border-info-border bg-info-bg text-info-fg"
                      : "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {level}
                </button>
              ))}
            </div>

            {/* Limit */}
            <select
              value={limit}
              onChange={(e) => setLimit(parseInt(e.target.value, 10))}
              className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-fg-secondary outline-none dark:text-foreground"
            >
              <option value="100">100 lines</option>
              <option value="200">200 lines</option>
              <option value="500">500 lines</option>
              <option value="1000">1000 lines</option>
            </select>
          </div>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div
            ref={scrollRef}
            onScroll={handleScroll}
            className="max-h-[calc(100vh-18rem)] overflow-y-auto bg-card font-mono text-xs leading-relaxed"
          >
        {loading && entries.length === 0 ? (
          <LoadingState className="py-12" />
        ) : displayEntries.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-12 text-fg-subtle dark:text-muted-foreground">
            <Terminal className="h-6 w-6" />
            <span className="text-sm font-medium">No log entries found</span>
            {hasFilters && (
              <button
                type="button"
                onClick={clearFilters}
                className="text-xs font-medium text-success-fg hover:text-success-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <div className="px-2 py-2">
            {displayEntries.map((entry, i) => {
              const style = LEVEL_STYLES[entry.level] || LEVEL_STYLES.info;
              const LevelIcon = style.icon;
              const isTargeted = targetEntry?.anchor === entry.anchor;
              // Show date separator
              const prevEntry = i > 0 ? displayEntries[i - 1] : null;
              const showDate =
                i === 0 ||
                (entry.time &&
                  prevEntry?.time &&
                  formatLogDate(entry.time) !== formatLogDate(prevEntry.time));

              return (
                <div key={`${entry.time}-${entry.line}-${i}`}>
                  {showDate && entry.time && (
                    <div className="my-1 flex items-center gap-2 px-2 py-0.5">
                      <div className="h-px flex-1 bg-secondary dark:bg-accent" />
                      <span className="text-xs font-medium text-fg-subtle dark:text-muted-foreground">
                        {formatLogDate(entry.time)}
                      </span>
                      <div className="h-px flex-1 bg-secondary dark:bg-accent" />
                    </div>
                  )}
                    <div
                      ref={(node) => {
                        if (node) rowRefs.current.set(entry.anchor, node);
                        else rowRefs.current.delete(entry.anchor);
                      }}
                      tabIndex={isTargeted ? -1 : undefined}
                      aria-current={isTargeted ? "true" : undefined}
                      data-log-anchor={entry.anchor}
                      className={cn(
                        "group flex scroll-m-8 items-start gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent focus:outline-none",
                        style.rowClass,
                        isTargeted && "relative z-[1] bg-accent ring-2 ring-inset ring-ring shadow-sm"
                      )}
                    >
                    <span className="w-16 shrink-0 text-fg-subtle dark:text-muted-foreground">
                      {formatLogTime(entry.time, timeFormat)}
                    </span>
                    <LevelIcon
                      className={cn("mt-0.5 h-3 w-3 shrink-0", style.iconClass)}
                    />
                    <span
                      className={cn(
                        "w-24 shrink-0 truncate font-semibold",
                        sourceClass(entry.source)
                      )}
                    >
                      [{entry.source}]
                    </span>
                    <span
                      className={cn(
                        "flex-1 break-all whitespace-pre-wrap",
                        style.messageClass
                      )}
                    >
                      {highlightMessage(entry.message, debouncedSearch)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-border bg-muted px-4 py-2 dark:bg-card">
        <span className="text-xs text-muted-foreground dark:text-fg-subtle">
          {displayEntries.length} entries
          {hasFilters && " (filtered)"}
        </span>
        <div className="flex items-center gap-2">
          {!autoScroll && (
            <button
              type="button"
              onClick={() => {
                setAutoScroll(true);
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowDown className="h-3 w-3" />
              Scroll to bottom
            </button>
          )}
          {autoRefresh && (
            <span className="flex items-center gap-1 text-xs text-success-fg">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              Auto-refresh 10s
            </span>
          )}
        </div>
          </div>
        </div>
      </SectionBody>
    </SectionLayout>
  );
}

/** Highlight search matches in log messages */
function highlightMessage(message: string, search: string): React.ReactNode {
  if (!search) return message;
  const idx = message.toLowerCase().indexOf(search.toLowerCase());
  if (idx === -1) return message;
  return (
    <>
      {message.slice(0, idx)}
      <mark className="rounded bg-warning-bg px-0.5 text-warning-fg">
        {message.slice(idx, idx + search.length)}
      </mark>
      {message.slice(idx + search.length)}
    </>
  );
}
