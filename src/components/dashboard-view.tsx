"use client";

import { useEffect, useState, useRef, useCallback, useSyncExternalStore } from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { ContentLoadingState } from "@/components/ui/loading-state";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  Clock,
  Radio,
  Smartphone,
  Wrench,
  Users2,
  AlertCircle,
  CheckCircle,
  Zap,
  Cpu,
  MemoryStick,
  HardDrive,
  Server,
  Folder,
  FileText,
  Database,
  Gauge,
  Timer,
  AlertTriangle,
  Info,
  ArrowRight,
  Shield,
  Rocket,
  KeyRound,
  Bell,
  X,
  Stethoscope,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
} from "@/lib/time-format-preference";
import { useGatewayStatusStore } from "@/lib/gateway-status-store";

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

type CronRun = {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  durationMs?: number;
  error?: string;
};

type LogEntry = { time: string; source: string; message: string };

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


/* ── helpers ──────────────────────────────────────── */

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatAgo(ms: number): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatCountdown(ms: number | null): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  if (diff <= 0) return "overdue";
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remainSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remainSecs}s`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return `${hours}h ${remainMins}m`;
}

function cronProgress(job: CronJobLive): number {
  if (!job.lastRunAtMs || !job.nextRunAtMs) return 0;
  const total = job.nextRunAtMs - job.lastRunAtMs;
  const elapsed = Date.now() - job.lastRunAtMs;
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

/* ── System stats types ──────────────────────────── */

type SystemStats = {
  ts: number;
  cpu: {
    model: string;
    cores: number;
    usage: number;
    speed: number;
    load1: number;
    load5: number;
    load15: number;
  };
  memory: {
    total: number;
    used: number;
    free: number;
    percent: number;
    app?: number;
    wired?: number;
    compressed?: number;
    cached?: number;
    swapUsed?: number;
    source?: "os" | "vm_stat" | "proc_meminfo";
  };
  disk: { total: number; used: number; free: number; percent: number };
  system: {
    hostname: string;
    platform: string;
    arch: string;
    uptime: number;
    uptimeDisplay: string;
    processCount: number;
  };
  openclaw: {
    homeDir: string;
    workspaceSizeBytes: number;
    sessionsSizeBytes: number;
    totalWorkspaceFiles: number;
    logSizeBytes: number;
    activeSessions: number;
  };
};

function formatBytesCompact(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(0)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

const DASHBOARD_COLORS = {
  primary: "var(--chart-1)",
  success: "var(--chart-2)",
  warning: "var(--chart-3)",
  info: "var(--chart-4)",
  danger: "var(--chart-5)",
  muted: "var(--chart-muted)",
  mutedStrong: "var(--muted-foreground)",
};

/* ── SSE hook: useSystemStats ─────────────────────── */

function useSystemStats() {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stats/stream");
    esRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as SystemStats;
        if (data.ts) setStats(data);
      } catch {
        /* skip malformed */
      }
    };

    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  return { stats, connected };
}

/* ── Radial gauge ────────────────────────────────── */

function RadialGauge({
  value,
  max,
  label,
  unit,
  color,
  size = 88,
}: {
  value: number;
  max: number;
  label: string;
  unit?: string;
  color: string;
  size?: number;
}) {
  const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const r = (size - 12) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (percent / 100) * circ;

  return (
    <div className="flex flex-col items-center">
      <div className="relative">
        <svg width={size} height={size} className="-rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            className="text-foreground/[0.04]"
            strokeWidth={5}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={5}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circ}`}
            className="transition-all duration-700 ease-out"
            style={{}}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold tabular-nums text-foreground">
            {Math.round(percent)}
            <span className="text-xs text-fg-subtle">%</span>
          </span>
        </div>
      </div>
      <p className="mt-1.5 text-xs font-medium text-muted-foreground">{label}</p>
      {unit && <p className="text-[11px] text-fg-subtle">{unit}</p>}
    </div>
  );
}

/* ── Mini bar ────────────────────────────────────── */

function MiniBar({ percent, color }: { percent: number; color: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-foreground/[0.04]">
      <div
        className="h-1.5 rounded-full transition-all duration-700 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, percent))}%`, backgroundColor: color }}
      />
    </div>
  );
}

function MemoryCompositionBar({
  memory,
  memoryFreeLabel,
}: {
  memory: SystemStats["memory"];
  memoryFreeLabel: string;
}) {
  const seg = (
    key: string,
    label: string,
    value: number | undefined,
    color: string
  ): { key: string; label: string; value: number; color: string } | null => {
    if (typeof value !== "number" || value <= 0) return null;
    return { key, label, value, color };
  };

  const segments = [
    seg("app", "App", memory.app, DASHBOARD_COLORS.success),
    seg("wired", "Wired", memory.wired, DASHBOARD_COLORS.info),
    seg("compressed", "Compressed", memory.compressed, DASHBOARD_COLORS.danger),
    seg("cached", "Cached Files", memory.cached, DASHBOARD_COLORS.primary),
    seg("free", memoryFreeLabel, memory.free, DASHBOARD_COLORS.muted),
  ].filter((s): s is { key: string; label: string; value: number; color: string } => Boolean(s));

  if (segments.length === 0) {
    const fallbackUsed = Math.max(0, memory.used || 0);
    const fallbackFree = Math.max(0, memory.total - fallbackUsed);
    if (fallbackUsed > 0) segments.push({ key: "used", label: "Used", value: fallbackUsed, color: DASHBOARD_COLORS.primary });
    if (fallbackFree > 0) segments.push({ key: "free", label: memoryFreeLabel, value: fallbackFree, color: DASHBOARD_COLORS.muted });
  }

  const known = segments.reduce((sum, item) => sum + item.value, 0);
  const remainder = Math.max(0, (memory.total || 0) - known);
  if (remainder > (memory.total || 0) * 0.005) {
    segments.push({ key: "other", label: "Kernel / Other", value: remainder, color: DASHBOARD_COLORS.mutedStrong });
  }

  const denom = Math.max(memory.total || 0, segments.reduce((sum, item) => sum + item.value, 0), 1);

  return (
    <div className="space-y-1.5">
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-foreground/[0.04]">
        {segments.map((item) => (
          <div
            key={item.key}
            className="h-full first:rounded-l-full last:rounded-r-full transition-all duration-700 ease-out"
            style={{ width: `${(item.value / denom) * 100}%`, backgroundColor: item.color }}
            title={`${item.label}: ${formatBytesCompact(item.value)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-subtle">
        {segments.map((item) => (
          <span key={`${item.key}-legend`} className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── System Stats Panel ──────────────────────────── */

function SystemStatsPanel({ stats, connected }: { stats: SystemStats | null; connected: boolean }) {
  if (!stats) {
    return (
      <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Gauge className="h-4 w-4 animate-pulse" />
          Connecting to system stats stream...
        </div>
      </div>
    );
  }

  const cpuColor =
    stats.cpu.usage > 80 ? DASHBOARD_COLORS.danger : stats.cpu.usage > 50 ? DASHBOARD_COLORS.warning : DASHBOARD_COLORS.success;
  const memColor =
    stats.memory.percent > 85 ? DASHBOARD_COLORS.danger : stats.memory.percent > 65 ? DASHBOARD_COLORS.warning : DASHBOARD_COLORS.primary;
  const diskColor =
    stats.disk.percent > 90 ? DASHBOARD_COLORS.danger : stats.disk.percent > 75 ? DASHBOARD_COLORS.warning : DASHBOARD_COLORS.info;
  const memorySourceLabel =
    stats.memory.source === "vm_stat"
      ? " (Activity-style)"
      : stats.memory.source === "proc_meminfo"
        ? " (MemAvailable)"
        : "";
  const memoryFreeLabel =
    stats.memory.source === "vm_stat"
      ? "Free + Speculative"
      : stats.memory.source === "proc_meminfo"
        ? "Available"
        : "Free";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground">
          <Server className="h-3.5 w-3.5" /> System Monitor
        </h2>
        <div className="flex items-center gap-1.5">
          <span className={cn("inline-flex h-1.5 w-1.5 rounded-full", connected ? "bg-success" : "bg-danger")} />
          <span className="text-xs text-fg-subtle">
            {connected ? "LIVE" : "RECONNECTING"}
          </span>
        </div>
      </div>

      {/* Gauges row */}
      <div className="grid grid-cols-1 gap-4 rounded-xl border border-border bg-card px-4 py-5 shadow-sm sm:grid-cols-2 lg:grid-cols-3">
        <div className="relative flex justify-center">
          <RadialGauge value={stats.cpu.usage} max={100} label="CPU" unit={`${stats.cpu.cores} cores`} color={cpuColor} />
        </div>
        <div className="relative flex justify-center">
          <RadialGauge value={stats.memory.percent} max={100} label="Memory" unit={`${formatBytesCompact(stats.memory.used)} / ${formatBytesCompact(stats.memory.total)}`} color={memColor} />
        </div>
        <div className="relative flex justify-center">
          <RadialGauge value={stats.disk.percent} max={100} label="Disk" unit={`${formatBytesCompact(stats.disk.used)} / ${formatBytesCompact(stats.disk.total)}`} color={diskColor} />
        </div>
      </div>

      {/* Detail cards grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {/* CPU details */}
        <div className="rounded-xl border border-border bg-muted p-3 shadow-sm space-y-2">
          <div className="flex items-center gap-2">
            <Cpu className="h-3.5 w-3.5 text-success-fg" />
            <span className="text-xs font-sans font-semibold text-fg-secondary">CPU</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Usage</span>
              <span className="font-mono text-fg-secondary">{stats.cpu.usage}%</span>
            </div>
            <MiniBar percent={stats.cpu.usage} color={cpuColor} />
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Load (1/5/15m)</span>
              <span className="font-mono text-muted-foreground">
                {stats.cpu.load1} / {stats.cpu.load5} / {stats.cpu.load15}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Speed</span>
              <span className="font-mono text-muted-foreground">{stats.cpu.speed} MHz</span>
            </div>
            <p className="truncate text-xs text-fg-subtle" title={stats.cpu.model}>
              {stats.cpu.model}
            </p>
          </div>
        </div>

        {/* Memory details */}
        <div className="rounded-xl border border-border bg-muted p-3 shadow-sm space-y-2">
          <div className="flex items-center gap-2">
            <MemoryStick className="h-3.5 w-3.5 text-info-fg" />
            <span className="text-xs font-sans font-semibold text-fg-secondary">
              Memory
              {memorySourceLabel}
            </span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Used</span>
              <span className="font-mono text-fg-secondary">
                {formatBytesCompact(stats.memory.used)}
              </span>
            </div>
            <MemoryCompositionBar memory={stats.memory} memoryFreeLabel={memoryFreeLabel} />
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">{memoryFreeLabel}</span>
              <span className="font-mono text-muted-foreground">
                {formatBytesCompact(stats.memory.free)}
              </span>
            </div>
            {typeof stats.memory.app === "number" && (
              <div className="flex justify-between text-xs">
                <span className="text-fg-subtle">App</span>
                <span className="font-mono text-muted-foreground">
                  {formatBytesCompact(stats.memory.app)}
                </span>
              </div>
            )}
            {typeof stats.memory.wired === "number" && (
              <div className="flex justify-between text-xs">
                <span className="text-fg-subtle">Wired</span>
                <span className="font-mono text-muted-foreground">
                  {formatBytesCompact(stats.memory.wired)}
                </span>
              </div>
            )}
            {typeof stats.memory.compressed === "number" && (
              <div className="flex justify-between text-xs">
                <span className="text-fg-subtle">Compressed</span>
                <span className="font-mono text-muted-foreground">
                  {formatBytesCompact(stats.memory.compressed)}
                </span>
              </div>
            )}
            {typeof stats.memory.cached === "number" && (
              <div className="flex justify-between text-xs">
                <span className="text-fg-subtle">Cached Files</span>
                <span className="font-mono text-muted-foreground">
                  {formatBytesCompact(stats.memory.cached)}
                </span>
              </div>
            )}
            {typeof stats.memory.swapUsed === "number" && (
              <div className="flex justify-between text-xs">
                <span className="text-fg-subtle">Swap Used</span>
                <span className="font-mono text-muted-foreground">
                  {formatBytesCompact(stats.memory.swapUsed)}
                </span>
              </div>
            )}
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Total</span>
              <span className="font-mono text-muted-foreground">
                {formatBytesCompact(stats.memory.total)}
              </span>
            </div>
          </div>
        </div>

        {/* Disk details */}
        <div className="rounded-xl border border-border bg-muted p-3 shadow-sm space-y-2">
          <div className="flex items-center gap-2">
            <HardDrive className="h-3.5 w-3.5 text-info-fg" />
            <span className="text-xs font-sans font-semibold text-fg-secondary">Disk</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Used</span>
              <span className="font-mono text-fg-secondary">
                {formatBytesCompact(stats.disk.used)}
              </span>
            </div>
            <MiniBar percent={stats.disk.percent} color={diskColor} />
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Free</span>
              <span className="font-mono text-muted-foreground">
                {formatBytesCompact(stats.disk.free)}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Total</span>
              <span className="font-mono text-muted-foreground">
                {formatBytesCompact(stats.disk.total)}
              </span>
            </div>
          </div>
        </div>

        {/* System info */}
        <div className="rounded-xl border border-border bg-muted p-3 shadow-sm space-y-2">
          <div className="flex items-center gap-2">
            <Timer className="h-3.5 w-3.5 text-warning-fg" />
            <span className="text-xs font-sans font-semibold text-fg-secondary">System</span>
          </div>
          <div className="space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Hostname</span>
              <span className="font-mono text-muted-foreground">{stats.system.hostname}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Platform</span>
              <span className="font-mono text-muted-foreground">
                {stats.system.platform} {stats.system.arch}
              </span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Uptime</span>
              <span className="font-mono text-muted-foreground">{stats.system.uptimeDisplay}</span>
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-fg-subtle">Processes</span>
              <span className="font-mono text-muted-foreground">{stats.system.processCount}</span>
            </div>
          </div>
        </div>
      </div>

      {/* OpenClaw storage stats */}
      <div className="rounded-xl border border-border bg-muted p-3 shadow-sm space-y-2">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-fg-secondary" />
          <span className="text-xs font-sans font-semibold text-fg-secondary">OpenClaw Storage</span>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <OcStatMini icon={Folder} label="Workspace" value={formatBytesCompact(stats.openclaw.workspaceSizeBytes)} color="text-fg-secondary dark:text-fg-subtle" />
          <OcStatMini icon={FileText} label="Files" value={String(stats.openclaw.totalWorkspaceFiles)} color="text-info-fg" />
          <OcStatMini icon={Database} label="Sessions" value={String(stats.openclaw.activeSessions)} sub={formatBytesCompact(stats.openclaw.sessionsSizeBytes)} color="text-success-fg" />
          <OcStatMini icon={FileText} label="Today's Log" value={formatBytesCompact(stats.openclaw.logSizeBytes)} color="text-warning-fg dark:text-warning-fg" />
        </div>
      </div>
    </div>
  );
}


function OcStatMini({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  color: string;
}) {
  return (
    <div className="text-center">
      <Icon className={cn("mx-auto h-3.5 w-3.5", color)} />
      <p className="mt-1 text-sm font-semibold tabular-nums text-foreground">{value}</p>
      <p className="text-xs text-fg-subtle">{label}</p>
      {sub && <p className="text-xs text-fg-subtle">{sub}</p>}
    </div>
  );
}

/* ── component ───────────────────────────────────── */

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
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const { stats: sysStats, connected: sseConnected } = useSystemStats();
  const gwStore = useGatewayStatusStore();

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
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-fg-secondary">
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
              iconClassName="text-fg-subtle"
              href="/agents"
            />
            <StatCard
              icon={Activity}
              value={formatTokens(live.agents.reduce((s, a) => s + a.totalTokens, 0))}
              label="Tokens Used"
              iconClassName="text-fg-subtle"
              href="/sessions"
            />
            <StatCard
              icon={Clock}
              value={`${live.cron.stats.ok}/${live.cron.stats.total}`}
              label="Cron OK"
              iconClassName={
                live.cron.stats.error > 0
                  ? "text-warning-fg"
                  : "text-fg-subtle"
              }
              alert={live.cron.stats.error > 0 ? `${live.cron.stats.error} error` : undefined}
              alertHref={live.cron.stats.error > 0 ? "/cron?show=errors" : undefined}
              href="/cron"
            />
            <StatCard
              icon={Smartphone}
              value={system?.stats.totalDevices || 0}
              label="Devices"
              iconClassName="text-fg-subtle"
              href="/agents"
            />
            <StatCard
              icon={Wrench}
              value={system?.stats.totalSkills || 0}
              label="Skills"
              iconClassName="text-fg-subtle"
              href="/skills"
            />
          </div>

          {/* ── Access & pairing ─── */}
          {process.env.NEXT_PUBLIC_AGENTBAY_HOSTED !== "true" && <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="mb-3 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground">
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
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-warning-bg">
                  <Bell className="h-5 w-5 text-warning-fg" />
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
              <h2 className="mb-3 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground">
                <Shield className="h-3.5 w-3.5" />
                Top Issues
                <span className="ml-1 rounded-full bg-foreground/[0.08] px-1.5 py-0.5 text-xs font-medium">
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
                      badge: "bg-danger-bg text-danger-fg",
                      badgeLabel: "Critical",
                    },
                    warning: {
                      border: "border-warning-border",
                      bg: "bg-warning-bg",
                      icon: AlertTriangle,
                      iconColor: "text-warning-fg",
                      badge: "bg-warning-bg text-warning-fg",
                      badgeLabel: "Warning",
                    },
                    info: {
                      border: "border-info-border",
                      bg: "bg-info-bg",
                      icon: Info,
                      iconColor: "text-info-fg",
                      badge: "bg-info-bg text-info-fg",
                      badgeLabel: "Info",
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
                          <span className={cn("rounded-full px-1.5 py-0.5 text-xs font-medium", severityCfg.badge)}>
                            {severityCfg.badgeLabel}
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
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-success-bg">
                  <Rocket className="h-5 w-5 text-success-fg" />
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
                        className="flex items-center gap-2.5 rounded-lg border border-border bg-muted px-3 py-2.5 transition-colors hover:border-border-strong hover:bg-muted dark:bg-foreground/60 dark:hover:bg-accent"
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
              <Link href="/agents" className="mb-3 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-fg-secondary">
                <Bot className="h-3.5 w-3.5" /> Agents
              </Link>
              <div className="space-y-2.5">
                {live.agents.map((agent) => (
                  <div key={agent.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
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
                          <span>{formatTokens(agent.totalTokens)} tokens</span>
                          <span>Active {formatAgo(agent.lastActivity)}</span>
                        </div>
                      </div>
                      <span className={cn(
                        "inline-flex h-2 w-2 rounded-full",
                        now - agent.lastActivity < 300000 ? "bg-success" : "bg-muted-foreground/30"
                      )} />
                    </div>
                    {/* Token usage — relative bar across agents */}
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-fg-subtle">
                        <span>Token usage</span>
                        <span>{formatTokens(agent.totalTokens)}</span>
                      </div>
                      {maxAgentTokens > 0 && (
                        <div className="mt-1 h-1.5 rounded-full bg-foreground/[0.04]">
                          <div
                            className="h-1.5 rounded-full bg-success-bg transition-all duration-1000"
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
                  <h3 className="mb-2 text-xs font-sans font-semibold uppercase tracking-wider text-fg-subtle">
                    Model Aliases
                  </h3>
                  <div className="flex flex-wrap gap-1.5">
                    {system.models.map((m) => (
                      <span
                        key={m.id}
                        className="rounded-lg border border-border bg-muted px-2 py-1 text-xs text-fg-secondary dark:bg-secondary dark:text-muted-foreground"
                      >
                        {m.alias && (
                          <span className="mr-1 text-success-fg">/{m.alias}</span>
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
              <Link href="/cron" className="mb-3 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-fg-secondary">
                <Clock className="h-3.5 w-3.5" /> Cron Schedules
              </Link>
              <div className="space-y-2.5">
                {live.cron.jobs.map((job) => {
                  const progress = cronProgress(job);
                  const countdown = formatCountdown(job.nextRunAtMs);
                  return (
                    <div key={job.id} className="rounded-xl border border-border bg-card p-4 shadow-sm">
                      <div className="flex items-center gap-2.5">
                        <div
                          className={cn(
                            "h-2.5 w-2.5 shrink-0 rounded-full",
                            job.lastStatus === "ok"
                              ? "bg-success"
                              : job.lastStatus === "error"
                                ? "bg-danger"
                                : "bg-muted-foreground"
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-foreground">
                            {job.name}
                          </p>
                          <p className="text-xs text-fg-subtle">
                            {job.scheduleDisplay}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm font-semibold tabular-nums text-foreground">
                            {countdown}
                          </p>
                          <p className="text-xs text-fg-subtle">
                            ran {formatAgo(job.lastRunAtMs || 0)} ({formatDuration(job.lastDurationMs)})
                          </p>
                        </div>
                      </div>
                      <div className="mt-2.5 h-1.5 rounded-full bg-foreground/[0.04]">
                        <div
                          className={cn(
                            "h-1.5 rounded-full transition-all duration-1000",
                            job.lastStatus === "error"
                              ? "bg-danger-bg"
                              : "bg-success-bg"
                          )}
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      {job.lastError && (
                        <p className="mt-2 flex items-center gap-1 text-xs text-danger-fg">
                          <AlertCircle className="h-3 w-3" />
                          {job.lastError}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* ── System Stats (SSE – no polling) ────── */}
          <SystemStatsPanel stats={sysStats} connected={sseConnected} />

          {/* ── Recent cron run results ─────────────── */}
          {live.cronRuns.length > 0 && (
            <div>
              <h2 className="mb-3 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground">
                <Zap className="h-3.5 w-3.5" /> Recent Cron Results
              </h2>
              <div className="space-y-1.5">
                {live.cronRuns.slice(0, 6).map((run, i) => (
                  <button
                    type="button"
                    key={`${run.jobId}-${run.ts}-${i}`}
                    onClick={() => openCronJob(run.jobId)}
                    className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-left shadow-sm transition-colors hover:border-border-strong hover:bg-muted dark:hover:bg-secondary"
                  >
                    <div className="flex items-center gap-2">
                      {run.status === "ok" ? (
                        <CheckCircle className="h-3.5 w-3.5 shrink-0 text-success-fg" />
                      ) : (
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger-fg" />
                      )}
                      <span className="text-xs text-muted-foreground">
                        {formatAgo(run.ts)}
                      </span>
                      {run.durationMs && (
                        <span className="text-xs text-fg-subtle">
                          {formatDuration(run.durationMs)}
                        </span>
                      )}
                    </div>
                    {run.summary && (
                      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                        {run.summary.replace(/[*#|_]/g, "").substring(0, 200)}
                      </p>
                    )}
                    {run.error && (
                      <p className="mt-1 text-xs text-danger-fg">{run.error}</p>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Live activity log ───────────────────── */}
          <div>
            <Link href="/logs" className="mb-3 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground transition-colors hover:text-fg-secondary">
              <Radio className="h-3.5 w-3.5" /> Gateway Log
            </Link>
            <div className="rounded-xl border border-border bg-card p-1 shadow-sm">
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
          className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm transition-colors hover:bg-muted dark:hover:bg-secondary"
        >
          <Stethoscope className="h-4 w-4 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">System Doctor</p>
            <p className="text-xs text-fg-subtle">Run health checks, view diagnostics, and repair issues</p>
          </div>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
        </Link>
        {/* ── Contact & support ── */}
        {process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true" && (
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <h2 className="mb-2 flex items-center gap-2 text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground">
              Need help?
            </h2>
            <p className="text-xs text-fg-secondary dark:text-muted-foreground">
              Questions, feedback, or issues? Reach out anytime:
            </p>
            <a
              href="mailto:roberto.sannazzaro@gmail.com"
              className="mt-2 inline-flex items-center gap-2 text-sm font-medium text-success-fg transition-colors hover:text-success-fg"
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
    "rounded-xl border border-border bg-card p-4 shadow-sm",
    (onClick || href) && "cursor-pointer transition-colors hover:border-foreground/10 hover:bg-muted dark:hover:bg-accent"
  );
  const inner = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">
            {label}
          </p>
          <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
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
