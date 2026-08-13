"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";
import {
  AlertTriangle,
  Bot,
  ChevronDown,
  Inbox,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InlineSpinner, ContentLoadingState } from "@/components/ui/loading-state";
import { classifySessionKind, sessionKindOf } from "@/lib/session-kinds";
import {
  groupRunsFromEvents,
  type AuditEvent,
  type AuditResult,
  type AuditRun,
  type AuditToolCall,
} from "@/lib/audit-grouping";

/* ── imperative handle ───────────────────────────────
   The parent's single Refresh button drives whichever mode is active, so
   Trace needs to expose a refresh entry point rather than owning its own
   button — keeping the page feeling like one surface, not two bolted
   together. */

export type AuditTraceHandle = {
  refresh: () => void;
};

/* ── filter option config ────────────────────────────── */

type KindFilter = "all" | "agent_run" | "tool_action";

const KIND_OPTIONS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "agent_run", label: "Agent runs" },
  { key: "tool_action", label: "Tool actions" },
];

const STATUS_OPTIONS: { key: AuditEvent["status"]; label: string }[] = [
  { key: "started", label: "Running" },
  { key: "succeeded", label: "Succeeded" },
  { key: "failed", label: "Failed" },
  { key: "timed_out", label: "Timed out" },
  { key: "blocked", label: "Blocked" },
  { key: "cancelled", label: "Cancelled" },
];

const TIME_WINDOWS = [
  { key: "1h", label: "1h", ms: 60 * 60 * 1000 },
  { key: "24h", label: "24h", ms: 24 * 60 * 60 * 1000 },
  { key: "7d", label: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "all", label: "All time", ms: 0 },
] as const;

type TimeWindowKey = (typeof TIME_WINDOWS)[number]["key"];

/* ── status chip styling ─────────────────────────────
   succeeded → green, failed/timed_out/blocked → red, started (running) →
   amber, cancelled/unknown → muted. Matches the STATUS styling used by the
   Live view's own chips. */

const STATUS_META: Record<
  string,
  { label: string; dotClass: string; bgClass: string; fgClass: string; pulse?: boolean }
> = {
  succeeded: { label: "Succeeded", dotClass: "bg-success", bgClass: "bg-success-bg", fgClass: "text-success-fg" },
  failed: { label: "Failed", dotClass: "bg-danger", bgClass: "bg-danger-bg", fgClass: "text-danger-fg" },
  timed_out: { label: "Timed out", dotClass: "bg-danger", bgClass: "bg-danger-bg", fgClass: "text-danger-fg" },
  blocked: { label: "Blocked", dotClass: "bg-danger", bgClass: "bg-danger-bg", fgClass: "text-danger-fg" },
  started: { label: "Running", dotClass: "bg-warning", bgClass: "bg-warning-bg", fgClass: "text-warning-fg", pulse: true },
  cancelled: { label: "Cancelled", dotClass: "bg-muted-foreground", bgClass: "bg-muted", fgClass: "text-muted-foreground" },
  unknown: { label: "Unknown", dotClass: "bg-muted-foreground", bgClass: "bg-muted", fgClass: "text-muted-foreground" },
};

function StatusChip({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? STATUS_META.unknown;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold",
        meta.bgClass,
        meta.fgClass,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass, meta.pulse && "animate-pulse")} />
      {meta.label}
    </span>
  );
}

/* ── helpers ──────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatAbsolute(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(ts);
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function toolDurationLabel(tool: AuditToolCall): string {
  if (typeof tool.durationMs === "number") return formatDuration(tool.durationMs);
  if (tool.startedAt && tool.endedAt) return formatDuration(tool.endedAt - tool.startedAt);
  if (!tool.endedAt) return "Running…";
  return "—";
}

function originLabel(sessionKey?: string): string {
  return classifySessionKind(sessionKindOf({ key: sessionKey })).label;
}

/* ── sub-components ───────────────────────────────── */

function ToolCallRow({ tool }: { tool: AuditToolCall }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border-subtle bg-background/60 px-3 py-2">
      <Wrench aria-hidden="true" strokeWidth={1.75} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary">{tool.toolName}</span>
      <StatusChip status={tool.status} />
      <span className="w-16 shrink-0 text-right text-[11px] text-fg-subtle">{toolDurationLabel(tool)}</span>
    </li>
  );
}

function RunRow({
  run,
  expanded,
  onToggle,
}: {
  run: AuditRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const toolCount = run.tools?.length ?? 0;
  const origin = originLabel(run.sessionKey);

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground">
          <Bot aria-hidden="true" strokeWidth={1.75} className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <p className="min-w-0 truncate text-sm font-semibold text-foreground">
                {run.agentId || "Unknown agent"}
              </p>
              <ChevronDown
                aria-hidden="true"
                className={cn("h-4 w-4 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-180")}
              />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusChip status={run.status} />
              <span className="text-xs text-muted-foreground" title={formatAbsolute(run.startedAt)}>
                {timeAgo(run.startedAt)}
              </span>
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
            <span className="rounded-md bg-muted px-1.5 py-0.5 font-medium text-fg-secondary">{origin}</span>
            {run.sessionKey && <span className="min-w-0 truncate font-mono text-[11px]">{run.sessionKey}</span>}
            <span className="ml-auto shrink-0">
              {toolCount} tool{toolCount === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-border px-4 py-3">
          {toolCount === 0 ? (
            <p className="py-2 text-center text-xs text-muted-foreground">No tool calls recorded for this run.</p>
          ) : (
            <ol className="space-y-1.5">
              {run.tools.map((tool) => (
                <ToolCallRow key={tool.toolCallId} tool={tool} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/* ── main component ───────────────────────────────── */

export const AuditTrace = forwardRef<AuditTraceHandle>(function AuditTrace(_props, ref) {
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  // The audit API accepts a single `status` value per request, so this is a
  // single-select toggle (click again to clear), not a multi-select set.
  const [statusFilter, setStatusFilter] = useState<AuditEvent["status"] | null>(null);
  const [timeWindow, setTimeWindow] = useState<TimeWindowKey>("24h");
  const [agentInput, setAgentInput] = useState("");
  const [debouncedAgent, setDebouncedAgent] = useState("");

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [available, setAvailable] = useState(true);
  const [reason, setReason] = useState<string | undefined>(undefined);
  const [cursor, setCursor] = useState<string | number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  // Debounce the agent id text filter so keystrokes don't each trigger a fetch.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedAgent(agentInput.trim()), 300);
    return () => clearTimeout(id);
  }, [agentInput]);

  const buildParams = useCallback(
    (cursorParam?: string | number) => {
      const params = new URLSearchParams();
      params.set("limit", "100");
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (statusFilter) params.set("status", statusFilter);
      if (debouncedAgent) params.set("agent", debouncedAgent);
      const window = TIME_WINDOWS.find((w) => w.key === timeWindow);
      if (window && window.ms > 0) params.set("after", String(Date.now() - window.ms));
      if (cursorParam !== undefined) params.set("cursor", String(cursorParam));
      return params;
    },
    [kindFilter, statusFilter, debouncedAgent, timeWindow],
  );

  const fetchEvents = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/audit?${buildParams().toString()}`, { cache: "no-store" });
      const data = (await res.json()) as AuditResult & { error?: string };
      if (!res.ok) {
        setError(data.error || "Could not load the audit trace.");
        setLoading(false);
        return;
      }
      setAvailable(data.available ?? true);
      setReason(data.reason);
      setEvents(Array.isArray(data.events) ? data.events : []);
      setCursor(data.cursor);
      setExpandedRunId(null);
    } catch {
      setError("Could not reach the audit trace endpoint.");
    }
    setLoading(false);
  }, [buildParams]);

  useEffect(() => {
    void fetchEvents();
    // Re-fetch whenever a filter changes; fetchEvents itself is intentionally
    // excluded so identity churn from buildParams doesn't cause extra runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kindFilter, statusFilter, debouncedAgent, timeWindow]);

  useImperativeHandle(ref, () => ({ refresh: () => void fetchEvents() }), [fetchEvents]);

  const loadOlder = useCallback(async () => {
    if (cursor === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/audit?${buildParams(cursor).toString()}`, { cache: "no-store" });
      const data = (await res.json()) as AuditResult;
      if (res.ok) {
        setEvents((prev) => {
          const seen = new Set(prev.map((e) => e.eventId));
          const additions = (Array.isArray(data.events) ? data.events : []).filter((e) => !seen.has(e.eventId));
          return [...prev, ...additions];
        });
        setCursor(data.cursor);
        setAvailable(data.available ?? true);
      }
    } catch {
      /* Older pages are a convenience — a failed load leaves the ledger as-is. */
    }
    setLoadingMore(false);
  }, [buildParams, cursor, loadingMore]);

  const runs = useMemo(() => {
    const grouped = groupRunsFromEvents(events);
    return [...grouped].sort((a, b) => b.startedAt - a.startedAt);
  }, [events]);

  const toggleStatus = (status: AuditEvent["status"]) => {
    setStatusFilter((prev) => (prev === status ? null : status));
  };

  return (
    <>
      {/* Privacy reassurance — persistent, matching the Live inspector's own note. */}
      <div className="mb-4 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          This is a privacy-safe, replayable metadata trace of agent runs and tool calls. Secrets and message
          contents are never recorded.
        </p>
      </div>

      {/* Filters */}
      <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filter audit trace">
        <SlidersHorizontal
          aria-hidden="true"
          strokeWidth={1.75}
          className="h-3.5 w-3.5 shrink-0 text-fg-subtle dark:text-muted-foreground"
        />
        {KIND_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            aria-pressed={kindFilter === opt.key}
            onClick={() => setKindFilter(opt.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              kindFilter === opt.key
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-fg-secondary hover:bg-muted hover:text-foreground dark:hover:bg-secondary",
            )}
          >
            {opt.label}
          </button>
        ))}

        <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {STATUS_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            aria-pressed={statusFilter === opt.key}
            onClick={() => toggleStatus(opt.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              statusFilter === opt.key
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-fg-secondary hover:bg-muted hover:text-foreground dark:hover:bg-secondary",
            )}
          >
            {opt.label}
          </button>
        ))}

        <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true" />

        {TIME_WINDOWS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            aria-pressed={timeWindow === opt.key}
            onClick={() => setTimeWindow(opt.key)}
            className={cn(
              "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
              timeWindow === opt.key
                ? "bg-primary text-primary-foreground"
                : "border border-border bg-card text-fg-secondary hover:bg-muted hover:text-foreground dark:hover:bg-secondary",
            )}
          >
            {opt.label}
          </button>
        ))}

        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-2.5 py-1.5 dark:bg-foreground/70">
          <UserRound aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-subtle dark:text-muted-foreground" />
          <input
            value={agentInput}
            onChange={(e) => setAgentInput(e.target.value)}
            placeholder="Agent id"
            className="w-28 bg-transparent text-xs text-fg-secondary outline-none placeholder:text-fg-subtle dark:text-foreground dark:placeholder:text-muted-foreground"
          />
        </div>

        <button
          type="button"
          onClick={() => void fetchEvents()}
          title="Refresh audit trace"
          className="ml-auto flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Content */}
      {loading && events.length === 0 ? (
        <ContentLoadingState />
      ) : error ? (
        <div className="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger-fg">{error}</div>
      ) : !available ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <AlertTriangle aria-hidden="true" strokeWidth={1.5} className="h-7 w-7 text-fg-subtle dark:text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">Audit trace is not available right now.</p>
          {reason && <p className="max-w-sm text-xs text-fg-subtle">{reason}</p>}
        </div>
      ) : runs.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <Inbox aria-hidden="true" strokeWidth={1.5} className="h-7 w-7 text-fg-subtle dark:text-muted-foreground" />
          <p className="text-sm font-medium text-muted-foreground">No recorded activity yet.</p>
          <p className="max-w-sm text-xs text-fg-subtle">
            Secrets and message contents are never recorded — this ledger only tracks run and tool-call metadata.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              expanded={expandedRunId === run.runId}
              onToggle={() => setExpandedRunId((current) => (current === run.runId ? null : run.runId))}
            />
          ))}

          {cursor !== undefined && (
            <div className="flex justify-center pt-2">
              <button
                type="button"
                onClick={() => void loadOlder()}
                disabled={loadingMore}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-secondary"
              >
                {loadingMore && <InlineSpinner size="sm" />}
                Load older
              </button>
            </div>
          )}
        </div>
      )}
    </>
  );
});
