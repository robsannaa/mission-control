"use client";

import { useState, useCallback } from "react";
import {
  Clock,
  CheckCircle,
  AlertCircle,
  AlertTriangle,
  Info,
  RefreshCw,
  Filter,
  Activity,
  Radio,
  Terminal,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { useSmartPoll } from "@/hooks/use-smart-poll";

/* ── types ────────────────────────────────────────── */

type ActivityEvent = {
  id: string;
  type: "cron" | "session" | "log" | "system";
  timestamp: number;
  title: string;
  detail?: string;
  status?: "ok" | "error" | "info" | "warning";
  source?: string;
};

type FilterType = "all" | "cron" | "session" | "log" | "system";

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

/* ── sub-components ───────────────────────────────── */

const TYPE_CONFIG: Record<
  ActivityEvent["type"],
  {
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    dotClass: string;
    label: string;
  }
> = {
  cron: {
    icon: Clock,
    iconClass: "text-muted-foreground",
    dotClass: "bg-warning",
    label: "Cron",
  },
  session: {
    icon: Zap,
    iconClass: "text-muted-foreground",
    dotClass: "bg-success",
    label: "Session",
  },
  log: {
    icon: Terminal,
    iconClass: "text-muted-foreground dark:text-fg-subtle",
    dotClass: "bg-muted-foreground",
    label: "Log",
  },
  system: {
    icon: Radio,
    iconClass: "text-muted-foreground",
    dotClass: "bg-info",
    label: "System",
  },
};

const STATUS_CONFIG: Record<
  NonNullable<ActivityEvent["status"]>,
  {
    icon: React.ComponentType<{ className?: string }>;
    iconClass: string;
    dotClass: string;
    borderClass: string;
  }
> = {
  ok: {
    icon: CheckCircle,
    iconClass: "text-success-fg",
    dotClass: "bg-success",
    borderClass: "border-l-success",
  },
  error: {
    icon: AlertCircle,
    iconClass: "text-danger-fg",
    dotClass: "bg-danger",
    borderClass: "border-l-danger",
  },
  warning: {
    icon: AlertTriangle,
    iconClass: "text-warning-fg",
    dotClass: "bg-warning",
    borderClass: "border-l-warning",
  },
  info: {
    icon: Info,
    iconClass: "text-info-fg",
    dotClass: "bg-info",
    borderClass: "border-l-info",
  },
};

const FILTER_PILLS: { key: FilterType; label: string }[] = [
  { key: "all", label: "All" },
  { key: "cron", label: "Cron" },
  { key: "session", label: "Sessions" },
  { key: "system", label: "System" },
];

function EventCard({ event }: { event: ActivityEvent }) {
  const typeConf = TYPE_CONFIG[event.type];
  const needsAttention = event.status === "error" || event.status === "warning";
  const statusConf = needsAttention && event.status ? STATUS_CONFIG[event.status] : null;
  const TypeIcon = typeConf.icon;

  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-4 shadow-sm",
      )}
    >
      <div className="flex items-start gap-3">
        {/* Type icon column */}
        <div className="mt-0.5 flex shrink-0 flex-col items-center gap-1.5">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-lg",
              "bg-muted dark:bg-secondary",
            )}
          >
            <TypeIcon className={cn("h-3.5 w-3.5", typeConf.iconClass)} />
          </div>
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <p className="min-w-0 truncate text-sm font-semibold text-foreground">
              {event.title}
            </p>

            <div className="flex shrink-0 items-center gap-2">
              {/* Status dot + icon */}
              {statusConf && (
                <span
                  className={cn(
                    "flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
                    event.status === "ok" &&
                      "text-muted-foreground",
                    event.status === "error" &&
                      "bg-danger-bg text-danger-fg",
                    event.status === "warning" &&
                      "bg-warning-bg text-warning-fg",
                    event.status === "info" &&
                      "text-muted-foreground",
                  )}
                >
                  <span className={cn("h-1.5 w-1.5 rounded-full", statusConf.dotClass)} />
                  {event.status}
                </span>
              )}

              {/* Relative time */}
              <span className="text-xs text-muted-foreground">
                {timeAgo(event.timestamp)}
              </span>
            </div>
          </div>

          {/* Detail line */}
          {event.detail && (
            <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {event.detail}
            </p>
          )}

          {/* Source badge */}
          {event.source && (
            <p className="mt-1.5 text-xs font-medium text-fg-subtle">
              {event.source}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── main component ───────────────────────────────── */

export function ActivityView() {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeFilter, setActiveFilter] = useState<FilterType>("all");

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

  if (loading) {
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
        description="What's been happening across your agents, cron jobs, and system"
        bordered
        actions={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void fetchActivity();
            }}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        }
      />

      <SectionBody>
        {/* Filter pills */}
        <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filter activity by type">
          <Filter className="h-3.5 w-3.5 shrink-0 text-fg-subtle dark:text-muted-foreground" />
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
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-muted dark:bg-secondary">
              <Activity className="h-6 w-6 text-fg-subtle dark:text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              {activeFilter === "all"
                ? "No recent activity"
                : `No ${activeFilter} events — try a different filter`}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filtered.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
