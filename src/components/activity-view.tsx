"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  CalendarClock,
  RefreshCw,
  SlidersHorizontal,
  Inbox,
  Server,
  FileText,
  MessageSquareText,
  ChevronDown,
  ChevronRight,
  MessageSquareReply,
  UserRound,
  Wrench,
  BrainCircuit,
  LoaderCircle,
  CircleStop,
  CircleCheck,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { AuditTrace, type AuditTraceHandle } from "@/components/activity/audit-trace";

/* ── types ────────────────────────────────────────── */

type ActivityEvent = {
  id: string;
  type: "cron" | "session" | "log" | "system";
  timestamp: number;
  title: string;
  detail?: string;
  status?: "ok" | "error" | "info" | "warning";
  source?: string;
  session?: ActivitySessionSummary;
};

type ActivitySessionSummary = {
  key: string;
  sessionId: string;
  kind: string;
  kindLabel: string;
  inspectable: boolean;
  status: string;
  hasActiveRun: boolean;
  model: string;
  modelProvider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  processedTokens?: number;
  contextUsedTokens?: number;
  modelCalls?: number;
  totalTokens: number;
  startedAt: number;
  endedAt: number;
  runtimeMs: number;
  estimatedCostUsd: number | null;
  originLabel?: string;
};

type SessionTimelineItem = {
  id: string;
  type: "prompt" | "output" | "reasoning" | "tool-call" | "tool-result";
  timestamp: number | null;
  text?: string;
  name?: string;
  arguments?: string;
  isError?: boolean;
  stopReason?: string;
  provenance?: string[];
  truncated?: boolean;
};

type SessionInspectorData = {
  session: Omit<ActivitySessionSummary, "inspectable"> & {
    title: string;
    agentId: string | null;
    abortedLastRun: boolean;
  };
  timeline: SessionTimelineItem[];
  truncated: boolean;
  reasoningContentHidden: boolean;
  refreshedAt: number;
};

type FilterType = "all" | "cron" | "session" | "log" | "system";

/** "Live" is the existing event timeline; "Trace" is the new canonical, replayable audit ledger. */
type ViewMode = "live" | "trace";

/* ── helpers ──────────────────────────────────────── */

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function formatDuration(value: number): string {
  if (!value) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}

function formatTime(value: number | null): string {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 0.1 ? 4 : 2,
    maximumFractionDigits: value < 0.1 ? 4 : 2,
  }).format(value);
}

/* ── sub-components ───────────────────────────────── */

const TYPE_CONFIG: Record<
  ActivityEvent["type"],
  {
    icon: LucideIcon;
    dotClass: string;
    label: string;
  }
> = {
  cron: {
    icon: CalendarClock,
    dotClass: "bg-warning",
    label: "Scheduled job",
  },
  session: {
    icon: MessageSquareText,
    dotClass: "bg-success",
    label: "Agent session",
  },
  log: {
    icon: FileText,
    dotClass: "bg-muted-foreground",
    label: "Log entry",
  },
  system: {
    icon: Server,
    dotClass: "bg-info",
    label: "System event",
  },
};

const STATUS_CONFIG: Record<
  NonNullable<ActivityEvent["status"]>,
  {
    dotClass: string;
  }
> = {
  ok: {
    dotClass: "bg-success",
  },
  error: {
    dotClass: "bg-danger",
  },
  warning: {
    dotClass: "bg-warning",
  },
  info: {
    dotClass: "bg-info",
  },
};

const FILTER_PILLS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "cron", label: "Cron" },
  { key: "session", label: "Sessions" },
  { key: "system", label: "System" },
];

function ViewModeToggle({ mode, onChange }: { mode: ViewMode; onChange: (mode: ViewMode) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Activity view"
      className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-muted p-0.5"
    >
      {([
        { key: "live", label: "Live" },
        { key: "trace", label: "Trace" },
      ] as const).map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={mode === option.key}
          onClick={() => onChange(option.key)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
            mode === option.key
              ? "bg-card text-foreground shadow-sm"
              : "text-fg-secondary hover:text-foreground dark:hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function TimelineItemView({ item }: { item: SessionTimelineItem }) {
  const label =
    item.type === "prompt"
      ? "Prompt"
      : item.type === "output"
        ? "Agent output"
        : item.type === "reasoning"
          ? "Reasoning activity"
          : item.type === "tool-call"
            ? "Tool call"
            : item.isError
              ? "Tool error"
              : "Tool result";
  const Icon =
    item.type === "prompt"
      ? UserRound
      : item.type === "output"
        ? MessageSquareReply
        : item.type === "reasoning"
          ? BrainCircuit
          : Wrench;
  const isMachineEvent = item.type === "tool-call" || item.type === "tool-result";

  if (isMachineEvent) {
    const body = item.type === "tool-call" ? item.arguments : item.text;
    return (
      <details className="group rounded-lg border border-border bg-background/60">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs [&::-webkit-details-marker]:hidden">
          <Icon
            aria-hidden="true"
            strokeWidth={1.75}
            className={cn("h-3.5 w-3.5 shrink-0", item.isError ? "text-danger-fg" : "text-muted-foreground")}
          />
          <span className={cn("font-semibold", item.isError ? "text-danger-fg" : "text-foreground")}>{label}</span>
          <span className="min-w-0 truncate font-mono text-fg-secondary">{item.name || "Tool"}</span>
          {item.timestamp && <span className="ml-auto shrink-0 text-fg-subtle">{formatTime(item.timestamp)}</span>}
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-border px-3 py-3">
          {body ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-fg-secondary">
              {body}
            </pre>
          ) : (
            <p className="text-xs text-muted-foreground">No output was recorded.</p>
          )}
          {item.truncated && <p className="mt-2 text-[11px] text-fg-subtle">Long output was truncated for this view.</p>}
        </div>
      </details>
    );
  }

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center">
        <Icon aria-hidden="true" strokeWidth={1.75} className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold text-foreground">{label}</p>
          {item.timestamp && <span className="text-[11px] text-fg-subtle">{formatTime(item.timestamp)}</span>}
          {item.stopReason && <span className="text-[11px] text-fg-subtle">{item.stopReason}</span>}
        </div>
        {item.type === "reasoning" ? (
          <p className="mt-1 text-xs text-muted-foreground">
            The model was reasoning. Private chain-of-thought is not displayed.
          </p>
        ) : (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-secondary">
            {item.text}
          </p>
        )}
        {item.provenance && item.provenance.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {item.provenance.map((value) => (
              <span key={value} className="rounded-md bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {value}
              </span>
            ))}
          </div>
        )}
        {item.truncated && <p className="mt-1 text-[11px] text-fg-subtle">Long content was truncated for this view.</p>}
      </div>
    </div>
  );
}

function SessionLiveDetails({ summary }: { summary: ActivitySessionSummary }) {
  const [data, setData] = useState<SessionInspectorData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const response = await fetch(
          `/api/activity/session?sessionKey=${encodeURIComponent(summary.key)}&limit=200`,
          { cache: "no-store" },
        );
        const payload = await response.json() as SessionInspectorData & { error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(payload.error || "Could not load this session.");
          setLoading(false);
          return;
        }
        setData(payload);
        setError("");
        setLoading(false);
        if (payload.session.hasActiveRun) {
          timer = setTimeout(() => void load(), 2000);
        }
      } catch {
        if (cancelled) return;
        setError("Could not reach the gateway for this session.");
        setLoading(false);
        if (summary.hasActiveRun) timer = setTimeout(() => void load(), 3000);
      }
    };

    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [summary.key, summary.hasActiveRun]);

  const session = data?.session ?? summary;
  const isRunning = session.hasActiveRun || session.status === "running";
  const cacheReadTokens = session.cacheReadTokens ?? 0;
  const cacheWriteTokens = session.cacheWriteTokens ?? 0;
  const inputProcessedTokens = session.inputTokens + cacheReadTokens + cacheWriteTokens;
  const processedTokens = session.processedTokens ?? inputProcessedTokens + session.outputTokens;
  const contextUsedTokens = session.contextUsedTokens ?? session.totalTokens;
  const metrics = [
    {
      label: "Input processed",
      value: `${formatTokens(inputProcessedTokens)} tokens`,
      detail:
        cacheReadTokens || cacheWriteTokens
          ? `${formatTokens(session.inputTokens)} new · ${formatTokens(cacheReadTokens)} cache read · ${formatTokens(cacheWriteTokens)} cache write`
          : undefined,
    },
    { label: "Output", value: `${formatTokens(session.outputTokens)} tokens` },
    { label: "Total processed", value: `${formatTokens(processedTokens)} tokens` },
    { label: "Last context", value: `${formatTokens(contextUsedTokens)} tokens` },
    ...(session.modelCalls ? [{ label: "Model calls", value: String(session.modelCalls) }] : []),
    { label: "Runtime", value: formatDuration(session.runtimeMs) },
  ];

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] font-semibold",
            isRunning
              ? "border-success/30 bg-success-bg text-success-fg"
              : "border-border bg-muted text-fg-secondary",
          )}
        >
          {isRunning ? <LoaderCircle className="h-3 w-3 animate-spin" /> : session.status === "killed" ? <CircleStop className="h-3 w-3" /> : <CircleCheck className="h-3 w-3" />}
          {isRunning ? "Live" : session.status === "killed" ? "Stopped" : "Finished"}
        </span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-fg-secondary">
          {session.kindLabel}
        </span>
        {session.model && (
          <span className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-fg-secondary">
            {[session.modelProvider, session.model].filter(Boolean).join(" / ")}
          </span>
        )}
        {session.estimatedCostUsd !== null && session.estimatedCostUsd !== undefined && (
          <span className="rounded-full border border-border bg-background px-2 py-1 text-[11px] text-fg-secondary">
            {formatCost(session.estimatedCostUsd)} estimated
          </span>
        )}
        {data?.refreshedAt && (
          <span className="ml-auto text-[11px] text-fg-subtle">
            {isRunning ? "Updating live" : `Loaded ${timeAgo(data.refreshedAt)}`}
          </span>
        )}
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        {metrics.map((metric) => (
          <div key={metric.label} className="min-w-0 bg-background px-3 py-2.5">
            <dt className="text-[10px] font-semibold uppercase tracking-wide text-fg-subtle">{metric.label}</dt>
            <dd className="mt-0.5 text-xs font-medium text-foreground">{metric.value}</dd>
            {metric.detail && (
              <dd className="mt-1 text-[10px] leading-snug text-fg-subtle">{metric.detail}</dd>
            )}
          </div>
        ))}
      </dl>

      <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          Showing gateway-recorded prompts, responses, and tool activity for this session. Secrets are redacted; runtime system instructions and private model reasoning are not exposed.
        </p>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-10">
          <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="mt-3 rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-xs text-danger-fg">{error}</div>
      ) : data && data.timeline.length > 0 ? (
        <div className="mt-4 space-y-4">
          {data.timeline.map((item) => <TimelineItemView key={item.id} item={item} />)}
          {data.truncated && (
            <p className="text-center text-[11px] text-fg-subtle">Showing the latest 200 transcript messages.</p>
          )}
        </div>
      ) : (
        <p className="py-8 text-center text-xs text-muted-foreground">No prompt or output has been recorded for this session yet.</p>
      )}
    </div>
  );
}

function EventCard({
  event,
  expanded,
  onToggle,
  onOpen,
}: {
  event: ActivityEvent;
  expanded: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}) {
  const typeConf = TYPE_CONFIG[event.type];
  const needsAttention = event.status === "error" || event.status === "warning";
  const statusConf = needsAttention && event.status ? STATUS_CONFIG[event.status] : null;
  const TypeIcon = typeConf.icon;
  const canInspect = event.type === "session" && Boolean(event.session?.inspectable);
  // A cron run links to its job in Cron Jobs, where it can be edited/inspected.
  const canOpen = event.type === "cron" && Boolean(onOpen);
  const mainContent = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <p className="min-w-0 truncate text-sm font-semibold text-foreground">{event.title}</p>
          {canInspect && (
            <ChevronDown className={cn("h-4 w-4 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-180")} />
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {statusConf && (
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
                event.status === "ok" && "text-muted-foreground",
                event.status === "error" && "bg-danger-bg text-danger-fg",
                event.status === "warning" && "bg-warning-bg text-warning-fg",
                event.status === "info" && "text-muted-foreground",
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", statusConf.dotClass)} />
              {event.status}
            </span>
          )}
          <span className="text-xs text-muted-foreground">{timeAgo(event.timestamp)}</span>
        </div>
      </div>

      {event.detail && <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{event.detail}</p>}
      {event.source && <p className="mt-1.5 text-xs font-medium text-fg-subtle">{event.source}</p>}
    </>
  );

  return (
    <div
      {...(canOpen
        ? {
            role: "button",
            tabIndex: 0,
            onClick: onOpen,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onOpen?.();
              }
            },
            "aria-label": "Open this cron job in Cron Jobs",
          }
        : {})}
      className={cn(
        "group rounded-xl border border-border bg-card p-4 shadow-sm transition-colors",
        canOpen &&
          "cursor-pointer hover:border-foreground/15 hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
      )}
    >
      <div className="flex items-start gap-3">
        {/* The icon communicates the event type without a decorative tile. */}
        <div
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground"
          title={typeConf.label}
        >
          <TypeIcon aria-hidden="true" strokeWidth={1.75} className="h-4 w-4" />
        </div>

        {/* Main content */}
        {canInspect ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="min-w-0 flex-1 cursor-pointer text-left"
          >
            {mainContent}
          </button>
        ) : (
          <div className="min-w-0 flex-1">{mainContent}</div>
        )}

        {canOpen && (
          <ChevronRight
            aria-hidden="true"
            className="mt-0.5 h-4 w-4 shrink-0 self-center text-fg-subtle transition-colors group-hover:text-foreground"
          />
        )}
      </div>
      {expanded && event.session && <SessionLiveDetails summary={event.session} />}
    </div>
  );
}

/* ── main component ───────────────────────────────── */

export function ActivityView() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");
  const [expandedSessionKey, setExpandedSessionKey] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("live");
  const traceRef = useRef<AuditTraceHandle>(null);
  const router = useRouter();

  const fetchActivity = useCallback(async () => {
    try {
      const res = await fetch("/api/activity", { cache: "no-store" });
      if (!res.ok) {
        setLoading(false);
        return;
      }
      const data = await res.json() as ActivityEvent[];
      // Sort newest-first before storing
      const sorted = (Array.isArray(data) ? data : []).slice().sort((a, b) => b.timestamp - a.timestamp);
      setEvents(sorted);
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  useSmartPoll(fetchActivity, { intervalMs: 8000 });

  const filtered =
    activeFilter === "all" ? events : events.filter((e) => e.type === activeFilter);

  if (mode === "live" && loading) {
    return (
      <SectionLayout>
        <ContentLoadingState />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title="Activity"
        description={
          mode === "live"
            ? "What's been happening across your agents, cron jobs, and system"
            : "A canonical, replayable ledger of agent runs and tool calls"
        }
        bordered
        actions={
          <div className="flex items-center gap-2">
            <ViewModeToggle mode={mode} onChange={setMode} />
            <button
              type="button"
              onClick={() => {
                if (mode === "trace") {
                  traceRef.current?.refresh();
                  return;
                }
                setLoading(true);
                void fetchActivity();
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </button>
          </div>
        }
      />

      <SectionBody>
        {mode === "trace" ? (
          <AuditTrace ref={traceRef} />
        ) : (
          <>
            {/* Filter pills */}
            <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filter activity by type">
              <SlidersHorizontal
                aria-hidden="true"
                strokeWidth={1.75}
                className="h-3.5 w-3.5 shrink-0 text-fg-subtle dark:text-muted-foreground"
              />
              {FILTER_PILLS.map((pill) => (
                <button
                  key={pill.key}
                  type="button"
                  aria-pressed={activeFilter === pill.key}
                  onClick={() => setActiveFilter(pill.key)}
                  className={cn(
                    "rounded-full px-3 py-1 text-xs font-semibold transition-colors",
                    activeFilter === pill.key
                      ? "bg-primary text-primary-foreground"
                      : "border border-border bg-card text-fg-secondary hover:bg-muted hover:text-foreground dark:hover:bg-secondary",
                  )}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            {/* Timeline */}
            {filtered.length === 0 ? (
              /* Empty state */
              <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
                <Inbox
                  aria-hidden="true"
                  strokeWidth={1.5}
                  className="h-7 w-7 text-fg-subtle dark:text-muted-foreground"
                />
                <p className="text-sm font-medium text-muted-foreground">
                  {activeFilter === "all"
                    ? "No recent activity"
                    : `No ${activeFilter} events — try a different filter`}
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {filtered.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    expanded={event.session?.key === expandedSessionKey}
                    onToggle={() => {
                      const key = event.session?.key;
                      if (!key) return;
                      setExpandedSessionKey((current) => current === key ? null : key);
                    }}
                    onOpen={
                      event.type === "cron" && event.source
                        ? () => router.push(`/cron?job=${encodeURIComponent(event.source!)}`)
                        : undefined
                    }
                  />
                ))}
              </div>
            )}
          </>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
