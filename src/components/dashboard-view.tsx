"use client";

import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { ContentLoadingState } from "@/components/ui/loading-state";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Bell,
  Bot,
  ChevronDown,
  Clock,
  Info,
  KeyRound,
  Radio,
  Rocket,
  Shield,
  Smartphone,
  Stethoscope,
  Users2,
  Wrench,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { SystemMonitor } from "@/components/dashboard/system-monitor";
import { CronResults } from "@/components/dashboard/cron-results";
import type { CronRun } from "@/components/dashboard/types";
import { cronProgress, formatAgo, formatCountdown, formatDuration, formatTokens } from "@/components/dashboard/format";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
} from "@/lib/time-format-preference";
import { useGatewayStatusStore } from "@/lib/gateway-status-store";
import { useCapabilities } from "@/hooks/use-capabilities";

/* ── types ────────────────────────────────────────── */

type LiveData = {
  timestamp: number;
  gateway: { status: string; latencyMs: number; port: number; version: string };
  cron: {
    jobs: CronJobLive[];
    stats: { total: number; ok: number; error: number };
  };
  cronRuns: CronRun[];
  agents: { id: string; name: string; emoji: string; sessionCount: number; totalTokens: number; lastActivity: number }[];
  logEntries: LogEntry[];
};

type CronJobLive = {
  id: string;
  name: string;
  enabled: boolean;
  lastStatus: string;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  scheduleDisplay: string;
};

type LogEntry = { time: string; source: string; message: string };

/** Full cron job details (from /api/cron) — carries the prompt, schedule
 *  expression, and delivery target that the summary /api/live data omits. */
type CronDetail = {
  id?: string;
  name?: string;
  description?: string;
  agentId?: string;
  schedule?: { kind?: string; expr?: string; everyMs?: number; tz?: string };
  payload?: { kind?: string; message?: string; text?: string; timeoutSeconds?: string | number };
  delivery?: { mode?: string; channel?: string; to?: string };
  sessionTarget?: string;
  wakeMode?: string;
};

type SystemData = {
  channels: { name: string; enabled: boolean; accounts: string[] }[];
  devices: { displayName?: string; platform: string; clientMode: string; lastUsedAt: number }[];
  skills: { name: string; source: string }[];
  models: { id: string; alias?: string }[];
  stats: { totalDevices: number; totalSkills: number; totalChannels: number };
  gateway?: {
    port?: number;
    mode?: string;
    authMode?: "token" | "password";
    tokenConfigured?: boolean;
    allowTailscale?: boolean;
  };
};

type PairingSummary = {
  dm: unknown[];
  devices: unknown[];
  total: number;
};

/* ── component ───────────────────────────────────── */

function CronMeta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="eyebrow">{label}</p>
      <p className={cn("truncate text-fg-secondary", mono && "font-mono")}>{value}</p>
    </div>
  );
}

export function DashboardView() {
  const router = useRouter();
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [live, setLive] = useState<LiveData | null>(null);
  const [system, setSystem] = useState<SystemData | null>(null);
  const [lastRefresh, setLastRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [pairingSummary, setPairingSummary] = useState<PairingSummary | null>(null);
  const [cronDetails, setCronDetails] = useState<Record<string, CronDetail>>({});
  const [expandedCron, setExpandedCron] = useState<string | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const gwStore = useGatewayStatusStore();
  const { capabilities, hosted } = useCapabilities();

  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch("/api/live", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      if (!res.ok) return;
      const data = await res.json();
      setLive(data);
      setLastRefresh(Date.now());
    } catch { /* retry next interval */ }
  }, []);

  const openCronJob = useCallback(
    (jobId: string) => {
      if (!jobId) return;
      const params = new URLSearchParams();
      params.set("job", jobId);
      router.push(`/cron?${params.toString()}`);
    },
    [router]
  );

  useSmartPoll(fetchLive, { intervalMs: 10000 });

  useEffect(() => {
    fetch("/api/system", { cache: "no-store" })
      .then((r) => r.json())
      .then(setSystem)
      .catch(() => { });
    fetch("/api/pairing", { cache: "no-store" })
      .then((r) => r.json())
      .then(setPairingSummary)
      .catch(() => { });
    // Full cron details (prompt, schedule expr, delivery target) — the live
    // summary omits these, and expanding a cron row shows them.
    fetch("/api/cron", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { jobs?: CronDetail[] }) => {
        const byName: Record<string, CronDetail> = {};
        for (const j of d.jobs ?? []) if (j.name) byName[j.name] = j;
        setCronDetails(byName);
      })
      .catch(() => { });

    tickRef.current = setInterval(() => {
      if (document.hidden) return;
      setNow(Date.now());
    }, 1000);

    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  if (!live) {
    return <ContentLoadingState />;
  }

  const gw = live.gateway;
  const maxAgentTokens = Math.max(...live.agents.map((a) => a.totalTokens), 1);
  // Use the shared gateway status store (same source as the header) to avoid
  // conflicting online/offline indicators.  Fall back to /api/live data only
  // while the store is still in its initial "loading" state.
  const isOnline =
    gwStore.status !== "loading"
      ? gwStore.status === "online"
      : gw.status === "online";

  // ── Issue detection ──────────────────────────────
  type Issue = {
    id: string;
    severity: "critical" | "warning" | "info";
    title: string;
    detail: string;
    fixLabel?: string;
    fixHref?: string;
  };

  const issues: Issue[] = [];

  if (!isOnline) {
    issues.push({
      id: "gw-offline",
      severity: "critical",
      title: "Gateway is offline",
      detail: "The OpenClaw gateway process is not responding. Most features will not work.",
      fixLabel: "Restart Gateway",
      fixHref: "/dashboard",
    });
  }

  for (const job of live.cron.jobs) {
    if (job.consecutiveErrors >= 3) {
      issues.push({
        id: `cron-err-${job.id}`,
        severity: "critical",
        title: `Cron "${job.name}" keeps failing`,
        detail: `${job.consecutiveErrors} consecutive errors. Last: ${job.lastError || "unknown"}`,
        fixLabel: "Fix Cron Job",
        fixHref: "/cron?show=errors",
      });
    }
  }

  for (const job of live.cron.jobs) {
    if (job.lastError?.includes("delivery target is missing")) {
      issues.push({
        id: `cron-target-${job.id}`,
        severity: "warning",
        title: `"${job.name}" has no delivery target`,
        detail: "Job runs but can't deliver results. Set a recipient (e.g. telegram:CHAT_ID).",
        fixLabel: "Set Target",
        fixHref: "/cron?show=errors",
      });
    }
  }

  for (const job of live.cron.jobs) {
    if (job.lastStatus === "error" && (job.consecutiveErrors || 0) < 3 && !issues.find(i => i.id === `cron-err-${job.id}` || i.id === `cron-target-${job.id}`)) {
      issues.push({
        id: `cron-warn-${job.id}`,
        severity: "warning",
        title: `Cron "${job.name}" last run failed`,
        detail: job.lastError || "Unknown error",
        fixLabel: "View Details",
        fixHref: "/cron?show=errors",
      });
    }
  }


  if (live.cron.stats.total === 0) {
    issues.push({
      id: "no-cron",
      severity: "info",
      title: "No cron jobs configured",
      detail: "Scheduled tasks let your agent work automatically — summaries, reminders, reports.",
      fixLabel: "Create Cron Job",
      fixHref: "/cron",
    });
  }

  const severityOrder = { critical: 0, warning: 1, info: 2 };
  issues.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

  const isFreshSetup = live.agents.length <= 1 && live.cron.stats.total === 0;

  return (
    <SectionLayout>
      <SectionHeader
        title="Dashboard"
        description="Live overview of gateway health, agent activity, cron jobs, and system status."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-xs font-medium tabular-nums text-fg-secondary">
              v{gw.version} · port {gw.port} · {gw.latencyMs}ms
            </span>
            <span className="text-xs text-fg-subtle dark:text-muted-foreground">
              {Math.floor((now - lastRefresh) / 1000)}s ago · auto 5s
            </span>
          </div>
        }
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-6">
        <div className="space-y-6">
          {/* ── Stat cards ─────────────────────────────── */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard
              icon={Users2}
              value={live.agents.length}
              label="Agents"
              href="/agents"
            />
            <StatCard
              icon={Activity}
              value={formatTokens(live.agents.reduce((s, a) => s + a.totalTokens, 0))}
              label="Tokens Used"
              href="/sessions"
            />
            <StatCard
              icon={Clock}
              value={`${live.cron.stats.ok}/${live.cron.stats.total}`}
              label="Cron OK"
              iconClassName={live.cron.stats.error > 0 ? "text-warning-fg" : undefined}
              alert={live.cron.stats.error > 0 ? `${live.cron.stats.error} error` : undefined}
              alertHref={live.cron.stats.error > 0 ? "/cron?show=errors" : undefined}
              href="/cron"
            />
            <StatCard
              icon={Smartphone}
              value={system?.stats.totalDevices || 0}
              label="Devices"
              href="/agents"
            />
            <StatCard
              icon={Wrench}
              value={system?.stats.totalSkills || 0}
              label="Skills"
              href="/skills"
            />
          </div>

          {/* ── Access & pairing ─── */}
          {capabilities.hostInfrastructure && <div className="rounded-xl border border-border-subtle bg-card p-4 shadow-sm">
            <h2 className="eyebrow mb-3 flex items-center gap-2">
              <KeyRound className="h-3.5 w-3.5" /> Access & pairing
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <p className="text-xs font-medium text-foreground">Gateway auth</p>
                <p className="mt-1 text-xs text-fg-secondary dark:text-muted-foreground">
                  {system?.gateway?.authMode
                    ? `Mode: ${system.gateway.authMode}${system.gateway.tokenConfigured ? " · Token set" : ""}`
                    : "Not configured (open access)"}
                  {system?.gateway?.allowTailscale && " · Tailscale allowed"}
                </p>
                <p className="mt-2 text-xs leading-5 text-muted-foreground">
                  Set or edit the token in{" "}
                  <Link href="/config" className="text-foreground hover:underline">
                    Config
                  </Link>{" "}
                  under <code className="rounded bg-muted px-1 text-fg-secondary dark:bg-secondary">gateway.auth.token</code>. Secrets, including this token, are visible and editable in this dashboard — access is controlled by the Mission Control auth gate (<code className="rounded bg-muted px-1 text-fg-secondary dark:bg-secondary">MISSION_CONTROL_AUTH</code>), so only expose the dashboard behind it.{" "}
                  <a
                    href="https://docs.openclaw.ai/web/dashboard"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-foreground hover:underline"
                  >
                    Docs
                  </a>
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-foreground">Pairing requests</p>
                <p className="mt-1 text-xs text-fg-secondary dark:text-muted-foreground">
                  {(pairingSummary?.total ?? 0) > 0
                    ? `${pairingSummary?.total ?? 0} pending (device + DM) — use the bell in the header to approve or reject.`
                    : "No pending requests. New device or DM pairing will show in the header bell."}
                </p>
                {(pairingSummary?.total ?? 0) > 0 && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Click the <Bell className="inline h-3 w-3" /> icon in the top bar to manage.
                  </p>
                )}
              </div>
            </div>
          </div>}

          {/* ── Pairing Request Banner ──────────────────── */}
          {(pairingSummary?.total ?? 0) > 0 && (
            <div className="rounded-xl border border-warning-border bg-warning-bg p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-card">
                  <Bell className="h-4 w-4 text-warning-fg" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-foreground">
                    {pairingSummary?.total === 1
                      ? "1 pairing request waiting for approval"
                      : `${pairingSummary?.total} pairing requests waiting for approval`}
                  </p>
                  <p className="mt-0.5 text-xs text-fg-secondary dark:text-muted-foreground">
                    Someone messaged your bot — approve the request so your AI can reply.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const bell = document.querySelector("[data-notification-bell]");
                    if (bell instanceof HTMLElement) bell.click();
                  }}
                  className="shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/88"
                >
                  Review &amp; Approve
                </button>
              </div>
            </div>
          )}

          {/* ── Top Issues Now ─────────────────────────── */}
          {issues.length > 0 && (
            <div>
              <h2 className="eyebrow mb-3 flex items-center gap-2">
                <Shield className="h-3.5 w-3.5" />
                Top Issues
                <span className="ml-1 rounded-full bg-foreground/[0.08] px-1.5 py-0.5 text-xs font-medium normal-case tracking-normal text-fg-secondary">
                  {issues.length}
                </span>
              </h2>
              <div className="space-y-2">
                {issues.slice(0, 5).map((issue) => {
                  const severityCfg = {
                    critical: {
                      border: "border-danger-border",
                      bg: "bg-danger-bg",
                      icon: AlertCircle,
                      iconColor: "text-danger-fg",
                      label: "Critical",
                    },
                    warning: {
                      border: "border-warning-border",
                      bg: "bg-warning-bg",
                      icon: AlertTriangle,
                      iconColor: "text-warning-fg",
                      label: "Warning",
                    },
                    info: {
                      border: "border-border-subtle",
                      bg: "bg-card",
                      icon: Info,
                      iconColor: "text-info-fg",
                      label: "Info",
                    },
                  }[issue.severity];
                  const SevIcon = severityCfg.icon;
                  return (
                    <div
                      key={issue.id}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border p-4 shadow-sm",
                        severityCfg.border,
                        severityCfg.bg
                      )}
                    >
                      <SevIcon className={cn("mt-0.5 h-4 w-4 shrink-0", severityCfg.iconColor)} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-medium text-foreground">
                            {issue.title}
                          </p>
                          <span className={cn("text-[10px] font-semibold uppercase tracking-wide", severityCfg.iconColor)}>
                            {severityCfg.label}
                          </span>
                        </div>
                        <p className="mt-0.5 text-xs text-fg-subtle line-clamp-2">
                          {issue.detail}
                        </p>
                      </div>
                      {issue.fixLabel && issue.fixHref && (
                        <a
                          href={issue.fixHref}
                          className="flex shrink-0 items-center gap-1 rounded-control border border-border bg-muted px-2.5 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground dark:bg-secondary dark:hover:bg-secondary"
                        >
                          {issue.fixLabel}
                          <ArrowRight className="h-3 w-3" />
                        </a>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Getting Started ────────── */}
          {isFreshSetup && issues.length === 0 && (
            <div className="rounded-xl border border-border-subtle bg-card p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <Rocket className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-foreground">
                    Welcome to Mission Control
                  </h3>
                  <p className="mt-1 text-sm text-fg-secondary dark:text-fg-subtle">
                    Your OpenClaw agent is running. Here are some things to try:
                  </p>
                  <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {[
                      { label: "Chat with your agent", href: "/chat", desc: "Send a message and see it respond" },
                      { label: "Create a cron job", href: "/cron", desc: "Schedule tasks like daily briefs" },
                      { label: "Connect a channel", href: "/agents", desc: "Link Telegram, WhatsApp, etc." },
                      { label: "Explore skills", href: "/skills", desc: "See what your agent can do" },
                    ].map((item) => (
                      <a
                        key={item.href}
                        href={item.href}
                        className="flex items-center gap-2.5 rounded-lg border border-border-subtle bg-muted px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-muted dark:bg-foreground/60 dark:hover:bg-accent"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-medium text-foreground">{item.label}</p>
                          <p className="text-xs text-fg-subtle">{item.desc}</p>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Main grid: Agents + Cron ──────────────── */}
          <div className="grid gap-5 lg:grid-cols-2">
            {/* Agents */}
            <div>
              <Link href="/agents" className="eyebrow mb-3 flex items-center gap-2 transition-colors hover:text-fg-secondary">
                <Bot className="h-3.5 w-3.5" /> Agents
              </Link>
              <div className="space-y-2.5">
                {live.agents.map((agent) => (
                  <div key={agent.id} className="rounded-xl border border-border-subtle bg-card p-4 shadow-sm">
                    <div className="flex items-center gap-3">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-base dark:bg-secondary">
                        {agent.emoji || (agent.id === "main" ? "🦞" : "🤖")}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium text-foreground capitalize">
                          {agent.name || agent.id}
                        </p>
                        <div className="flex items-center gap-3 text-xs text-fg-subtle">
                          <span>{agent.sessionCount} session{agent.sessionCount !== 1 ? "s" : ""}</span>
                          <span className="font-mono tabular-nums">{formatTokens(agent.totalTokens)} tokens</span>
                          <span>Active {formatAgo(agent.lastActivity)}</span>
                        </div>
                      </div>
                      <StatusDot online={now - agent.lastActivity < 300000} />
                    </div>
                    {/* Token usage — relative bar across agents */}
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-fg-subtle">
                        <span>Token usage</span>
                        <span className="font-mono tabular-nums">{formatTokens(agent.totalTokens)}</span>
                      </div>
                      {maxAgentTokens > 0 && (
                        <div className="mt-1 h-1 rounded-full bg-border-subtle">
                          <div
                            className="h-1 rounded-full bg-foreground/70 transition-all duration-1000"
                            style={{
                              width: `${Math.max(4, (agent.totalTokens / maxAgentTokens) * 100)}%`,
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Models */}
              {system?.models && system.models.length > 0 && (
                <div className="mt-4">
                  <h3 className="eyebrow mb-2">
                    Model Aliases
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {system.models.map((m) => (
                      <span
                        key={m.id}
                        className="rounded-lg border border-border-subtle bg-muted px-2 py-1 text-xs text-fg-secondary dark:bg-secondary dark:text-muted-foreground"
                      >
                        {m.alias && (
                          <span className="mr-1 font-mono text-fg-subtle">/{m.alias}</span>
                        )}
                        {m.id.split("/").pop()}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Cron countdowns */}
            <div>
              <Link href="/cron" className="eyebrow mb-3 flex items-center gap-2 transition-colors hover:text-fg-secondary">
                <Clock className="h-3.5 w-3.5" /> Cron Schedules
              </Link>
              <div className="space-y-2.5">
                {live.cron.jobs.map((job) => {
                  const progress = cronProgress(job);
                  const countdown = formatCountdown(job.nextRunAtMs);
                  const detail = cronDetails[job.name];
                  const expanded = expandedCron === job.id;
                  const prompt = detail?.payload?.message || detail?.payload?.text;
                  const target = detail?.delivery;
                  return (
                    <div key={job.id} className="rounded-xl border border-border-subtle bg-card shadow-sm">
                      <button
                        type="button"
                        onClick={() => setExpandedCron(expanded ? null : job.id)}
                        aria-expanded={expanded}
                        className="flex w-full items-center gap-2.5 rounded-xl p-4 text-left transition-colors hover:bg-muted/40"
                      >
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            job.lastStatus === "ok"
                              ? "bg-success"
                              : job.lastStatus === "error"
                                ? "bg-danger"
                                : "bg-muted-foreground/40"
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground">{job.name}</p>
                          <p className="text-xs text-fg-subtle">{job.scheduleDisplay}</p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-sm font-semibold tabular-nums text-foreground">{countdown}</p>
                          <p className="text-xs text-fg-subtle">
                            ran {formatAgo(job.lastRunAtMs || 0)} ({formatDuration(job.lastDurationMs)})
                          </p>
                        </div>
                        <ChevronDown className={cn("h-4 w-4 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-180")} />
                      </button>
                      <div className="px-4">
                        <div className="h-1 rounded-full bg-border-subtle">
                          <div
                            className={cn(
                              "h-1 rounded-full transition-all duration-1000",
                              job.lastStatus === "error" ? "bg-danger" : "bg-foreground/70"
                            )}
                            style={{ width: `${progress}%` }}
                          />
                        </div>
                      </div>
                      {job.lastError && (
                        <p className="flex items-center gap-1 px-4 pt-2 text-xs text-danger-fg">
                          <AlertCircle className="h-3 w-3" />
                          {job.lastError}
                        </p>
                      )}
                      {expanded && (
                        <div className="space-y-3 border-t border-border-subtle px-4 py-3 text-xs">
                          {detail?.description && (
                            <p className="text-fg-secondary">{detail.description}</p>
                          )}
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                            <CronMeta label="Schedule" value={detail?.schedule?.expr || job.scheduleDisplay} mono />
                            {detail?.schedule?.tz && <CronMeta label="Timezone" value={detail.schedule.tz} />}
                            {detail?.agentId && <CronMeta label="Agent" value={detail.agentId} />}
                            <CronMeta
                              label="Delivers to"
                              value={
                                !target || target.mode === "none"
                                  ? "Nothing (runs silently)"
                                  : [target.mode, target.channel, target.to].filter(Boolean).join(" · ")
                              }
                            />
                            {detail?.payload?.timeoutSeconds && (
                              <CronMeta label="Timeout" value={`${detail.payload.timeoutSeconds}s`} />
                            )}
                          </div>
                          {prompt && (
                            <div>
                              <p className="eyebrow mb-1">Prompt</p>
                              <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2.5 font-mono text-[11px] leading-relaxed text-fg-secondary">
                                {prompt}
                              </pre>
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openCronJob(job.id); }}
                            className="inline-flex items-center gap-1 font-medium text-fg-secondary transition-colors hover:text-foreground"
                          >
                            Open full job <ArrowRight className="h-3 w-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── System Stats (SSE – no polling) ────── */}
          <SystemMonitor />

          {/* ── Recent cron run results ─────────────── */}
          <CronResults runs={live.cronRuns} onOpenJob={openCronJob} />

          {/* ── Live activity log ───────────────────── */}
          <div>
            <Link href="/logs" className="eyebrow mb-3 flex items-center gap-2 transition-colors hover:text-fg-secondary">
              <Radio className="h-3.5 w-3.5" /> Gateway Log
            </Link>
            <div className="rounded-xl border border-border-subtle bg-card p-1 shadow-sm">
              <div className="max-h-80 overflow-y-auto font-mono text-xs leading-5">
                {live.logEntries.map((entry, i) => {
                  const isError =
                    entry.message.toLowerCase().includes("error") ||
                    entry.message.toLowerCase().includes("fail");
                  const isWs = entry.source === "ws";
                  const isCron = entry.source.includes("cron");
                  const time = entry.time
                    ? new Date(entry.time).toLocaleTimeString(
                        undefined,
                        withTimeFormat({ hour: "2-digit", minute: "2-digit", second: "2-digit" }, timeFormat),
                      )
                    : "";
                  return (
                    <div
                      key={i}
                      className={cn(
                        "flex gap-2 rounded px-2 py-0.5",
                        isError
                          ? "bg-danger-bg text-danger-fg"
                          : "hover:bg-muted dark:hover:bg-secondary"
                      )}
                    >
                      <span className="shrink-0 text-fg-subtle">{time}</span>
                      <span
                        className={cn(
                          "shrink-0 w-24 truncate",
                          isCron
                            ? "text-warning-fg"
                            : isWs
                              ? "text-info-fg"
                              : "text-fg-subtle"
                        )}
                      >
                        [{entry.source}]
                      </span>
                      <span className="min-w-0 truncate text-muted-foreground">
                        {entry.message}
                      </span>
                    </div>
                  );
                })}
                {live.logEntries.length === 0 && (
                  <p className="px-2 py-4 text-center text-fg-subtle">
                    No recent log entries
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Doctor link */}
        <Link
          href="/doctor"
          className="flex items-center gap-3 rounded-xl border border-border-subtle bg-card p-3 shadow-sm transition-colors hover:bg-muted dark:hover:bg-secondary"
        >
          <Stethoscope className="h-4 w-4 text-foreground" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">System Doctor</p>
            <p className="text-xs text-fg-subtle">Run health checks, view diagnostics, and repair issues</p>
          </div>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        </Link>
        {/* ── Contact & support ── */}
        {hosted && (
          <div className="rounded-xl border border-border-subtle bg-card p-4 shadow-sm">
            <h2 className="eyebrow mb-2">
              Need help?
            </h2>
            <p className="text-xs text-fg-secondary dark:text-muted-foreground">
              Questions, feedback, or issues? Reach out anytime:
            </p>
            <a
              href="mailto:roberto.sannazzaro@gmail.com"
              className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-foreground transition-colors hover:underline"
            >
              roberto.sannazzaro@gmail.com
            </a>
          </div>
        )}
        {/* ── Build info ── */}
        <div className="pt-2 text-center text-[10px] text-fg-subtle">
          Mission Control {process.env.NEXT_PUBLIC_APP_VERSION}
          {process.env.NEXT_PUBLIC_COMMIT_HASH && (
            <span className="ml-1 font-mono">({process.env.NEXT_PUBLIC_COMMIT_HASH})</span>
          )}
        </div>
      </SectionBody>
    </SectionLayout>
  );
}

/* ── sub-components ──────────────────────────────── */

/** Small online/offline presence dot — the one place colour is allowed to
 *  speak in the agent list, and only as a 2px dot. */
function StatusDot({ online }: { online: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex h-1.5 w-1.5 shrink-0 rounded-full",
        online ? "bg-success" : "bg-muted-foreground/30"
      )}
    />
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
  iconClassName,
  alert,
  alertHref,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string | number;
  label: string;
  iconClassName?: string;
  alert?: string;
  alertHref?: string;
  onClick?: () => void;
  href?: string;
}) {
  const cardClass = cn(
    "rounded-xl border border-border-subtle bg-card p-4 shadow-sm",
    (onClick || href) && "cursor-pointer transition-colors hover:border-border hover:bg-muted dark:hover:bg-accent"
  );
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">
            {label}
          </p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
            {value}
          </p>
        </div>
        <Icon
          className={cn(
            "mt-0.5 h-4.5 w-4.5 shrink-0 stroke-[1.75]",
            iconClassName ?? "text-fg-subtle"
          )}
        />
      </div>
      {alert && (
        alertHref ? (
          <a
            href={alertHref}
            className="mt-3 flex items-center gap-1 text-xs text-danger-fg transition-colors hover:text-danger-fg group"
            onClick={(e) => e.stopPropagation()}
          >
            <AlertCircle className="h-3 w-3" />
            <span className="group-hover:underline">{alert}</span>
            <span className="text-danger-fg group-hover:text-danger-fg">&rarr;</span>
          </a>
        ) : (
          <p className="mt-3 flex items-center gap-1 text-xs text-danger-fg">
            <AlertCircle className="h-3 w-3" />
            {alert}
          </p>
        )
      )}
    </>
  );
  if (href) {
    return (
      <Link href={href} className={cardClass}>
        {inner}
      </Link>
    );
  }
  return (
    <div className={cardClass} onClick={onClick}>
      {inner}
    </div>
  );
}
