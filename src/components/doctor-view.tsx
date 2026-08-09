"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Info,
  Loader2,
  MoreHorizontal,
  Play,
  RefreshCw,
  Search,
  Wrench,
  X,
  Zap,
  KeyRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import type { DoctorIssue } from "@/lib/doctor-checks";
import {
  getTimeFormatServerSnapshot,
  getTimeFormatSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";

/* ── types ─────────────────────────────────────── */

type RunMode = "scan" | "repair" | "repair-force" | "deep" | "generate-token" | "restart-gateway";

type DoctorStatus = {
  ts: number;
  overallHealth: "healthy" | "needs-attention" | "critical";
  healthScore: number;
  lastRunAt: number | null;
  summary: { errors: number; warnings: number; healthy: number };
  gateway: { status: string; port: number; pid?: number };
  issues: DoctorIssue[];
};

type DoctorRunRecord = {
  id: string;
  startedAt: number;
  completedAt: number;
  mode: string;
  exitCode: number;
  summary: { errors: number; warnings: number; healthy: number };
  issues: DoctorIssue[];
  rawOutput: string;
  durationMs: number;
};

type StreamEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | { type: "exit"; code: number }
  | { type: "error"; text: string };

type ConfirmState = {
  mode: RunMode;
  title: string;
  description: string;
  serious: boolean;
} | null;

/* ── helpers ───────────────────────────────────── */

function relativeTime(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatDate(ts: number, timeFormat: TimeFormatPreference): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    d.toLocaleTimeString(undefined, withTimeFormat({ hour: "2-digit", minute: "2-digit" }, timeFormat));
}

const MODE_LABELS: Record<string, string> = {
  scan: "Scan",
  repair: "Repair",
  "repair-force": "Advanced Repair",
  deep: "Deep Scan",
  "generate-token": "Generate Token",
};

const CATEGORY_ORDER = [
  "Gateway",
  "Configuration",
  "Security",
  "Services",
  "Skills & Channels",
  "Recommendations",
];

function groupByCategory(issues: DoctorIssue[]): Map<string, DoctorIssue[]> {
  const grouped = new Map<string, DoctorIssue[]>();
  for (const cat of CATEGORY_ORDER) {
    const items = issues.filter((i) => i.category === cat);
    if (items.length > 0) grouped.set(cat, items);
  }
  // Catch any uncategorized
  const uncategorized = issues.filter((i) => !CATEGORY_ORDER.includes(i.category));
  if (uncategorized.length > 0) {
    const existing = grouped.get("Recommendations") || [];
    grouped.set("Recommendations", [...existing, ...uncategorized]);
  }
  return grouped;
}

/* ── ConfirmDialog ─────────────────────────────── */

function ConfirmDialog({
  confirm,
  onConfirm,
  onCancel,
}: {
  confirm: NonNullable<ConfirmState>;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const canProceed = confirm.serious ? typed === "CONFIRM" : true;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div
        className={cn(
          "w-full max-w-md rounded-lg border bg-card p-5 shadow-xl",
          confirm.serious ? "border-danger-border" : "border-border"
        )}
      >
        <h3 className="text-sm font-semibold text-foreground">{confirm.title}</h3>
        <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{confirm.description}</p>

        {confirm.serious && (
          <div className="mt-4">
            <label className="block text-xs font-medium text-danger-fg mb-1.5">
              Type CONFIRM to proceed
            </label>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-sm text-foreground placeholder-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-danger-border"
              placeholder="CONFIRM"
              autoFocus
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!canProceed}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50",
              confirm.serious
                ? "bg-danger-bg text-white hover:bg-danger disabled:hover:bg-danger-bg"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── HealthBanner ──────────────────────────────── */

function HealthBanner({
  status,
  loading,
}: {
  status: DoctorStatus | null;
  loading: boolean;
}) {
  if (loading && !status) {
    return (
      <div className="glass rounded-lg p-5">
        <div className="flex items-center gap-4">
          <div className="h-14 w-14 rounded-full bg-muted animate-pulse" />
          <div className="space-y-2 flex-1">
            <div className="h-4 w-40 rounded bg-muted animate-pulse" />
            <div className="h-3 w-28 rounded bg-muted animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const scoreColor =
    status.healthScore >= 80
      ? "text-success-fg border-success-border bg-success-bg"
      : status.healthScore >= 40
        ? "text-warning-fg border-warning-border bg-warning-bg"
        : "text-danger-fg border-danger-border bg-danger-bg";

  const statusText =
    status.overallHealth === "healthy"
      ? "Your system is healthy"
      : status.overallHealth === "needs-attention"
        ? "Your system needs attention"
        : "Your system has critical issues";

  return (
    <div className="glass rounded-lg p-5">
      <div className="flex items-center gap-4">
        <div
          className={cn(
            "flex h-14 w-14 shrink-0 items-center justify-center rounded-full border-2 text-lg font-bold tabular-nums",
            scoreColor
          )}
        >
          {status.healthScore}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{statusText}</p>
          {status.lastRunAt && (
            <p className="mt-0.5 text-xs text-fg-subtle">
              Last checked {relativeTime(status.lastRunAt)}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {status.summary.errors > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-danger-bg px-2 py-0.5 text-xs font-medium text-danger-fg">
                <AlertCircle className="h-3 w-3" />
                {status.summary.errors} error{status.summary.errors !== 1 ? "s" : ""}
              </span>
            )}
            {status.summary.warnings > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-fg">
                <AlertTriangle className="h-3 w-3" />
                {status.summary.warnings} warning{status.summary.warnings !== 1 ? "s" : ""}
              </span>
            )}
            <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg">
              <CheckCircle className="h-3 w-3" />
              {status.summary.healthy} healthy
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── IssueCard ─────────────────────────────────── */

function IssueCard({
  issue,
  onFix,
  running,
}: {
  issue: DoctorIssue;
  onFix: (mode: RunMode) => void;
  running: boolean;
}) {
  const cfg =
    issue.severity === "error"
      ? { icon: AlertCircle, border: "border-danger-border", bg: "bg-danger-bg", iconColor: "text-danger-fg" }
      : issue.severity === "warning"
        ? { icon: AlertTriangle, border: "border-warning-border", bg: "bg-warning-bg", iconColor: "text-warning-fg" }
        : { icon: Info, border: "border-info-border", bg: "bg-info-bg", iconColor: "text-info-fg" };

  const Icon = cfg.icon;

  return (
    <div className={cn("rounded-lg border p-3", cfg.border, cfg.bg)}>
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", cfg.iconColor)} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{issue.title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground leading-relaxed">{issue.detail}</p>
        </div>
        {issue.fixable && issue.fixMode && (
          <button
            type="button"
            onClick={() => onFix(issue.fixMode === "restart" ? "restart-gateway" : issue.fixMode!)}
            disabled={running}
            className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-foreground/10 bg-foreground/[0.04] px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.08] disabled:opacity-50"
          >
            Fix this
            <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    </div>
  );
}

/* ── IssueCards ─────────────────────────────────── */

function IssueCards({
  issues,
  onFix,
  running,
}: {
  issues: DoctorIssue[];
  onFix: (mode: RunMode) => void;
  running: boolean;
}) {
  // Only show errors and warnings in issue cards
  const actionableIssues = issues.filter((i) => i.severity !== "info");

  if (actionableIssues.length === 0) {
    return (
      <div className="glass-subtle rounded-lg p-6 text-center">
        <CheckCircle className="mx-auto h-8 w-8 text-success-fg" />
        <p className="mt-2 text-sm font-medium text-foreground">Everything looks good!</p>
        <p className="mt-0.5 text-xs text-fg-subtle">No issues detected in your system.</p>
      </div>
    );
  }

  const grouped = groupByCategory(actionableIssues);

  return (
    <div className="space-y-4">
      {Array.from(grouped.entries()).map(([category, catIssues]) => (
        <div key={category}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
            {category}
          </h3>
          <div className="space-y-2">
            {catIssues.map((issue, idx) => (
              <IssueCard
                key={`${issue.checkId}-${idx}`}
                issue={issue}
                onFix={onFix}
                running={running}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── StreamingOutputPanel ──────────────────────── */

function StreamingOutputPanel({
  lines,
  running,
  elapsed,
  exitCode,
  onCancel,
}: {
  lines: Array<{ type: string; text: string }>;
  running: boolean;
  elapsed: number;
  exitCode: number | null;
  onCancel: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !autoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  }, []);

  return (
    <div className="glass rounded-lg overflow-hidden">
      <div className="flex items-center justify-between border-b border-border/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : exitCode === 0 ? (
            <CheckCircle className="h-3.5 w-3.5 text-success-fg" />
          ) : exitCode !== null ? (
            <AlertCircle className="h-3.5 w-3.5 text-danger-fg" />
          ) : null}
          <span className="text-xs font-medium text-foreground">
            {running ? "Running..." : exitCode !== null ? (exitCode === 0 ? "Completed" : `Exited (${exitCode})`) : "Output"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-fg-subtle">
            {formatDuration(elapsed)}
          </span>
          {running && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded border border-danger-border bg-danger-bg px-2 py-1 text-xs text-danger-fg transition-colors hover:bg-danger-bg"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="max-h-[400px] overflow-y-auto bg-black/20 p-3 font-mono text-xs leading-relaxed"
      >
        {lines.map((line, idx) => (
          <div
            key={idx}
            className={cn(
              "whitespace-pre-wrap break-all",
              line.type === "stderr" ? "text-danger-fg" : "text-foreground"
            )}
          >
            {line.text}
          </div>
        ))}
        {lines.length === 0 && (
          <div className="text-fg-subtle">Waiting for output...</div>
        )}
      </div>
    </div>
  );
}

/* ── RunHistory ────────────────────────────────── */

function RunHistory({
  runs,
  total,
  onLoadMore,
  timeFormat,
}: {
  runs: DoctorRunRecord[];
  total: number;
  onLoadMore: () => void;
  timeFormat: TimeFormatPreference;
}) {
  const [expanded, setExpanded] = useState(false);
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  if (runs.length === 0) return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5" />
        )}
        Past Runs ({total})
      </button>

      {expanded && (
        <div className="space-y-1">
          {runs.map((run) => {
            const isExpanded = expandedRun === run.id;
            const passed = run.exitCode === 0 && run.summary.errors === 0;
            const hasIssues = run.summary.errors > 0 || run.summary.warnings > 0;

            return (
              <div key={run.id}>
                <button
                  type="button"
                  onClick={() => setExpandedRun(isExpanded ? null : run.id)}
                  className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-foreground/[0.04]"
                >
                  <span className="text-xs tabular-nums text-fg-subtle w-32 shrink-0">
                    {formatDate(run.completedAt, timeFormat)}
                  </span>
                  <span className="inline-flex items-center rounded bg-foreground/[0.06] px-1.5 py-0.5 text-xs font-medium text-fg-secondary">
                    {MODE_LABELS[run.mode] || run.mode}
                  </span>
                  <span className="text-xs tabular-nums text-fg-subtle">
                    {formatDuration(run.durationMs)}
                  </span>
                  <span className="flex-1" />
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-xs font-medium",
                      passed
                        ? "text-success-fg"
                        : run.exitCode !== 0
                          ? "text-danger-fg"
                          : hasIssues
                            ? "text-warning-fg"
                            : "text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        passed
                          ? "bg-success"
                          : run.exitCode !== 0
                            ? "bg-danger"
                            : hasIssues
                              ? "bg-warning"
                              : "bg-muted-foreground"
                      )}
                    />
                    {passed ? "Passed" : run.exitCode !== 0 ? "Failed" : "Issues found"}
                  </span>
                  {isExpanded ? (
                    <ChevronDown className="h-3 w-3 text-fg-subtle" />
                  ) : (
                    <ChevronRight className="h-3 w-3 text-fg-subtle" />
                  )}
                </button>

                {isExpanded && (
                  <div className="ml-3 mt-1 mb-2 space-y-2 border-l-2 border-border/40 pl-4">
                    <div className="flex flex-wrap gap-2">
                      {run.summary.errors > 0 && (
                        <span className="text-xs text-danger-fg">{run.summary.errors} errors</span>
                      )}
                      {run.summary.warnings > 0 && (
                        <span className="text-xs text-warning-fg">{run.summary.warnings} warnings</span>
                      )}
                      {run.summary.healthy > 0 && (
                        <span className="text-xs text-success-fg">{run.summary.healthy} healthy</span>
                      )}
                    </div>
                    {run.issues.filter((i) => i.severity !== "info").length > 0 && (
                      <div className="space-y-1">
                        {run.issues
                          .filter((i) => i.severity !== "info")
                          .slice(0, 10)
                          .map((issue, idx) => (
                            <div
                              key={`${issue.checkId}-${idx}`}
                              className="flex items-start gap-2 text-xs"
                            >
                              {issue.severity === "error" ? (
                                <AlertCircle className="mt-0.5 h-3 w-3 shrink-0 text-danger-fg" />
                              ) : (
                                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning-fg" />
                              )}
                              <span className="text-muted-foreground">{issue.title}</span>
                            </div>
                          ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {runs.length < total && (
            <button
              type="button"
              onClick={onLoadMore}
              className="w-full rounded-lg py-2 text-center text-xs text-fg-subtle transition-colors hover:bg-foreground/[0.04] hover:text-muted-foreground"
            >
              Load more...
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/* ── ActionBar ─────────────────────────────────── */

function ActionBar({
  running,
  onRun,
}: {
  running: boolean;
  onRun: (mode: RunMode, needsConfirm: boolean) => void;
}) {
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMore) return;
    const handler = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setShowMore(false);
      }
    };
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMore(false);
    };
    document.addEventListener("pointerdown", handler);
    window.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("pointerdown", handler);
      window.removeEventListener("keydown", escHandler);
    };
  }, [showMore]);

  const btnClass =
    "inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.04] px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-foreground/[0.08] disabled:opacity-50";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => onRun("scan", false)}
        disabled={running}
        className={cn(btnClass, "bg-primary/10 border-primary/20 text-primary hover:bg-primary/20")}
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
        Run Health Check
      </button>

      <button
        type="button"
        onClick={() => onRun("repair", true)}
        disabled={running}
        className={btnClass}
      >
        <Wrench className="h-3.5 w-3.5" />
        Fix Known Issues
      </button>

      <button
        type="button"
        onClick={() => onRun("deep", false)}
        disabled={running}
        className={btnClass}
      >
        <Search className="h-3.5 w-3.5" />
        Deep System Scan
      </button>

      <div className="relative" ref={moreRef}>
        <button
          type="button"
          onClick={() => setShowMore(!showMore)}
          disabled={running}
          className={btnClass}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>

        {showMore && (
          <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-card py-1 shadow-xl">
            <button
              type="button"
              onClick={() => {
                setShowMore(false);
                onRun("repair-force", true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.06]"
            >
              <Zap className="h-3.5 w-3.5 text-danger-fg" />
              Advanced Repair
            </button>
            <button
              type="button"
              onClick={() => {
                setShowMore(false);
                onRun("generate-token", true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.06]"
            >
              <KeyRound className="h-3.5 w-3.5 text-warning-fg" />
              Generate Security Token
            </button>
            <button
              type="button"
              onClick={() => {
                setShowMore(false);
                onRun("restart-gateway", true);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-foreground/[0.06]"
            >
              <RefreshCw className="h-3.5 w-3.5 text-info-fg" />
              Restart Gateway
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── main component ────────────────────────────── */

const CONFIRM_CONFIG: Record<string, { title: string; description: string; serious: boolean }> = {
  repair: {
    title: "Fix Known Issues",
    description:
      "This will fix common issues like outdated settings and expired logins. Your settings are backed up first.",
    serious: false,
  },
  "repair-force": {
    title: "Advanced Repair",
    description:
      "This overwrites service configs and applies aggressive fixes. Only use if standard fix didn't help. On memory-constrained deployments this may cause high RAM usage — consider running from the host CLI instead.",
    serious: true,
  },
  "generate-token": {
    title: "Generate Security Token",
    description:
      "This will create a new gateway security token for authenticated communication between services.",
    serious: false,
  },
  "restart-gateway": {
    title: "Restart Gateway",
    description:
      "This will restart the gateway service. Connected clients will disconnect and the system will be briefly unavailable. On memory-constrained environments (e.g. Docker with limited RAM) this may cause cascading failures — consider running 'openclaw doctor' directly on the host instead.",
    serious: true,
  },
};

export function DoctorView() {
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [status, setStatus] = useState<DoctorStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [outputLines, setOutputLines] = useState<Array<{ type: string; text: string }>>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [history, setHistory] = useState<DoctorRunRecord[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingModeRef = useRef<RunMode | null>(null);

  // Fetch status on mount
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch("/api/doctor/status", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as DoctorStatus;
        setStatus(data);
      }
    } catch {
      // ignore
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const fetchHistory = useCallback(async (limit = 20) => {
    try {
      const res = await fetch(`/api/doctor/history?limit=${limit}`, { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { runs: DoctorRunRecord[]; total: number };
        setHistory(data.runs);
        setHistoryTotal(data.total);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    void fetchHistory();
  }, [fetchStatus, fetchHistory]);

  // Cleanup on unmount: abort any running fetch and clear interval
  useEffect(() => {
    return () => {
      if (abortRef.current) abortRef.current.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Run a doctor command via SSE
  const runDoctor = useCallback(async (mode: RunMode) => {
    if (mode === "restart-gateway") {
      // Use existing gateway restart endpoint
      try {
        await fetch("/api/gateway", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        });
      } catch {
        // ignore
      }
      // Refresh status after a delay
      setTimeout(() => void fetchStatus(), 3000);
      return;
    }

    setRunning(true);
    setOutputLines([]);
    setShowOutput(true);
    setExitCode(null);
    setElapsed(0);

    const startTime = Date.now();
    timerRef.current = setInterval(() => {
      setElapsed(Date.now() - startTime);
    }, 100);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/doctor/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
        signal: controller.signal,
      });

      if (res.status === 409) {
        setOutputLines([{ type: "stderr", text: "A doctor run is already in progress.\n" }]);
        setRunning(false);
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }

      if (!res.ok || !res.body) {
        setOutputLines([{ type: "stderr", text: `Failed to start: HTTP ${res.status}\n` }]);
        setRunning(false);
        if (timerRef.current) clearInterval(timerRef.current);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split("\n\n");
        buffer = parts.pop() || "";

        for (const part of parts) {
          const line = part.replace(/^data: /, "");
          if (!line) continue;
          try {
            const event = JSON.parse(line) as StreamEvent;
            if (event.type === "stdout" || event.type === "stderr") {
              setOutputLines((prev) => {
                const next = [...prev, { type: event.type, text: event.text }];
                // Cap at 2000 lines to prevent unbounded growth
                return next.length > 2000 ? next.slice(-2000) : next;
              });
            } else if (event.type === "exit") {
              setExitCode(event.code);
            } else if (event.type === "error") {
              setOutputLines((prev) => [...prev, { type: "stderr", text: event.text + "\n" }]);
            }
          } catch {
            // malformed JSON — skip
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setOutputLines((prev) => [...prev, { type: "stderr", text: "\nCancelled by user.\n" }]);
      } else {
        setOutputLines((prev) => [
          ...prev,
          { type: "stderr", text: `\nError: ${err instanceof Error ? err.message : String(err)}\n` },
        ]);
      }
    } finally {
      setRunning(false);
      if (timerRef.current) clearInterval(timerRef.current);
      setElapsed(Date.now() - startTime);
      abortRef.current = null;
      // Refresh status and history
      setTimeout(() => {
        void fetchStatus();
        void fetchHistory();
      }, 500);
    }
  }, [fetchStatus, fetchHistory]);

  const handleRunRequest = useCallback(
    (mode: RunMode, needsConfirm: boolean) => {
      if (needsConfirm && CONFIRM_CONFIG[mode]) {
        pendingModeRef.current = mode;
        setConfirm({ mode, ...CONFIRM_CONFIG[mode] });
      } else {
        void runDoctor(mode);
      }
    },
    [runDoctor]
  );

  const handleConfirm = useCallback(() => {
    const mode = pendingModeRef.current;
    setConfirm(null);
    pendingModeRef.current = null;
    if (mode) void runDoctor(mode);
  }, [runDoctor]);

  const handleCancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }, []);

  const handleFixIssue = useCallback(
    (mode: RunMode) => {
      handleRunRequest(mode, true);
    },
    [handleRunRequest]
  );

  return (
    <SectionLayout>
      <SectionHeader
        title="System Doctor"
        description="Monitor and repair your OpenClaw installation"
        actions={
          <button
            type="button"
            onClick={() => void fetchStatus()}
            disabled={statusLoading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/[0.04] px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-foreground/[0.08] disabled:opacity-60"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", statusLoading && "animate-spin")} />
            Refresh
          </button>
        }
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-5">
        {/* Health Banner */}
        <HealthBanner status={status} loading={statusLoading} />

        {/* Action Bar */}
        <ActionBar running={running} onRun={handleRunRequest} />

        {/* Issue Cards */}
        {status && !statusLoading && (
          <IssueCards issues={status.issues} onFix={handleFixIssue} running={running} />
        )}

        {/* Streaming Output Panel */}
        {showOutput && (
          <StreamingOutputPanel
            lines={outputLines}
            running={running}
            elapsed={elapsed}
            exitCode={exitCode}
            onCancel={handleCancel}
          />
        )}

        {/* Run History */}
        <RunHistory
          runs={history}
          total={historyTotal}
          onLoadMore={() => void fetchHistory(history.length + 20)}
          timeFormat={timeFormat}
        />
      </SectionBody>

      {/* Confirm Dialog */}
      {confirm && (
        <ConfirmDialog
          confirm={confirm}
          onConfirm={handleConfirm}
          onCancel={() => {
            setConfirm(null);
            pendingModeRef.current = null;
          }}
        />
      )}
    </SectionLayout>
  );
}
