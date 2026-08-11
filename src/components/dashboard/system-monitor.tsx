"use client";

/**
 * System Monitor — CPU / memory / disk / OpenClaw storage, read live off the
 * SSE stats stream.
 *
 * Design intent: this used to be three big colour-filled donut gauges plus
 * four boxed, tinted detail cards — busy, and mostly green regardless of
 * whether anything was actually healthy. The replacement reads like a
 * product status readout: precise numbers, thin meters, hairline dividers.
 * A metric only takes on colour once it crosses a real warn/critical
 * threshold — an idle system renders entirely in neutral ink.
 */

import { useEffect, useRef, useState } from "react";
import { Cpu, Database, FileText, Folder, HardDrive, MemoryStick, Server, Timer } from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusDot, TONE_TEXT, type Tone } from "@/components/vector/primitives";
import { formatBytesCompact } from "./format";

/* ── types ────────────────────────────────────────── */

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

/* ── SSE hook ─────────────────────────────────────── */

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

/* ── tone / meter primitives ─────────────────────── */

/** A healthy value renders in neutral ink; colour appears only once a
 *  metric crosses its warn / critical threshold. */
function usageTone(percent: number, warnAt: number, dangerAt: number): Tone {
  if (percent >= dangerAt) return "critical";
  if (percent >= warnAt) return "attention";
  return "neutral";
}

const METER_FILL: Record<Tone, string> = {
  neutral: "bg-foreground/70",
  attention: "bg-warning",
  critical: "bg-danger",
  positive: "bg-success",
  unknown: "bg-fg-placeholder",
};

function ThinMeter({ percent, tone }: { percent: number; tone: Tone }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-border-subtle">
      <div
        className={cn("h-full rounded-full transition-all duration-700 ease-out", METER_FILL[tone])}
        style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
      />
    </div>
  );
}

function MetricReadout({
  label,
  percent,
  tone,
  sub,
}: {
  label: string;
  percent: number;
  tone: Tone;
  sub: string;
}) {
  return (
    <div className="min-w-0 flex-1 px-4 py-4 sm:px-5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="eyebrow">{label}</span>
      </div>
      <p className={cn("mt-1.5 text-[28px] font-semibold leading-none tabular-nums", TONE_TEXT[tone])}>
        {Math.round(percent)}
        <span className="text-base font-medium text-fg-subtle">%</span>
      </p>
      <p className="mt-1.5 truncate text-xs text-fg-subtle" title={sub}>
        {sub}
      </p>
      <div className="mt-3">
        <ThinMeter percent={percent} tone={tone} />
      </div>
    </div>
  );
}

/* ── quiet detail rows ───────────────────────────── */

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="text-fg-subtle">{label}</span>
      <span className="truncate font-mono tabular-nums text-fg-secondary" title={value}>
        {value}
      </span>
    </div>
  );
}

function DetailGroup({
  icon: Icon,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs font-medium text-fg-secondary">{title}</span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

/** Memory composition as a single stacked hairline meter, distinguished by
 *  opacity rather than colour — the ElevenLabs way to show many segments
 *  without turning the bar into a rainbow. */
function MemoryComposition({
  memory,
  freeLabel,
}: {
  memory: SystemStats["memory"];
  freeLabel: string;
}) {
  type Seg = { key: string; label: string; value: number; opacity: number };
  const raw: (Seg | null)[] = [
    typeof memory.app === "number" && memory.app > 0 ? { key: "app", label: "App", value: memory.app, opacity: 0.85 } : null,
    typeof memory.wired === "number" && memory.wired > 0 ? { key: "wired", label: "Wired", value: memory.wired, opacity: 0.6 } : null,
    typeof memory.compressed === "number" && memory.compressed > 0
      ? { key: "compressed", label: "Compressed", value: memory.compressed, opacity: 0.4 }
      : null,
    typeof memory.cached === "number" && memory.cached > 0
      ? { key: "cached", label: "Cached files", value: memory.cached, opacity: 0.25 }
      : null,
  ];
  const segments = raw.filter((s): s is Seg => s !== null);

  if (segments.length === 0) {
    const used = Math.max(0, memory.used || 0);
    if (used > 0) segments.push({ key: "used", label: "Used", value: used, opacity: 0.7 });
  }

  const known = segments.reduce((sum, s) => sum + s.value, 0);
  const free = Math.max(0, memory.free || Math.max(0, (memory.total || 0) - known));
  const denom = Math.max(memory.total || 0, known + free, 1);

  return (
    <div className="space-y-1.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-border-subtle">
        {segments.map((s) => (
          <div
            key={s.key}
            className="h-full bg-foreground first:rounded-l-full transition-all duration-700 ease-out"
            style={{ width: `${(s.value / denom) * 100}%`, opacity: s.opacity }}
            title={`${s.label}: ${formatBytesCompact(s.value)}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-fg-subtle">
        {segments.map((s) => (
          <span key={`${s.key}-legend`} className="inline-flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-foreground" style={{ opacity: s.opacity }} />
            {s.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-border-strong" />
          {freeLabel}
        </span>
      </div>
    </div>
  );
}

function StorageStat({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-fg-subtle">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{value}</p>
      {sub && <p className="text-xs text-fg-subtle">{sub}</p>}
    </div>
  );
}

/* ── loading skeleton ────────────────────────────── */

function MonitorSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border-subtle bg-card">
      <div className="grid grid-cols-1 divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2.5 px-4 py-4 sm:px-5">
            <div className="h-2.5 w-14 animate-pulse rounded-full bg-border-subtle" />
            <div className="h-7 w-16 animate-pulse rounded-md bg-border-subtle" />
            <div className="h-1 w-full animate-pulse rounded-full bg-border-subtle" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── main panel ──────────────────────────────────── */

export function SystemMonitor() {
  const { stats, connected } = useSystemStats();

  const cpuTone = stats ? usageTone(stats.cpu.usage, 50, 80) : "neutral";
  const memTone = stats ? usageTone(stats.memory.percent, 65, 85) : "neutral";
  const diskTone = stats ? usageTone(stats.disk.percent, 75, 90) : "neutral";

  const memorySourceLabel =
    stats?.memory.source === "vm_stat" ? " (Activity-style)" : stats?.memory.source === "proc_meminfo" ? " (MemAvailable)" : "";
  const memoryFreeLabel =
    stats?.memory.source === "vm_stat" ? "Free + speculative" : stats?.memory.source === "proc_meminfo" ? "Available" : "Free";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="eyebrow flex items-center gap-2">
          <Server className="h-3.5 w-3.5" /> System Monitor
        </h2>
        <span className="inline-flex items-center gap-1.5 text-xs text-fg-subtle">
          <StatusDot tone={connected ? "positive" : "critical"} pulse={connected} />
          {connected ? "Live" : "Reconnecting"}
        </span>
      </div>

      {!stats ? (
        <MonitorSkeleton />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border-subtle bg-card">
          {/* Headline readouts */}
          <div className="grid grid-cols-1 divide-y divide-border-subtle sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            <MetricReadout
              label="CPU"
              percent={stats.cpu.usage}
              tone={cpuTone}
              sub={`${stats.cpu.cores} cores · ${stats.cpu.speed} MHz`}
            />
            <MetricReadout
              label="Memory"
              percent={stats.memory.percent}
              tone={memTone}
              sub={`${formatBytesCompact(stats.memory.used)} of ${formatBytesCompact(stats.memory.total)}`}
            />
            <MetricReadout
              label="Disk"
              percent={stats.disk.percent}
              tone={diskTone}
              sub={`${formatBytesCompact(stats.disk.used)} of ${formatBytesCompact(stats.disk.total)}`}
            />
          </div>

          {/* Quiet detail grid */}
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 border-t border-border-subtle p-4 sm:grid-cols-2 sm:p-5 lg:grid-cols-4">
            <DetailGroup icon={Cpu} title="CPU">
              <DetailRow label="Load (1/5/15m)" value={`${stats.cpu.load1} / ${stats.cpu.load5} / ${stats.cpu.load15}`} />
              <p className="truncate text-xs text-fg-subtle" title={stats.cpu.model}>
                {stats.cpu.model}
              </p>
            </DetailGroup>

            <DetailGroup icon={MemoryStick} title={`Memory${memorySourceLabel}`}>
              <MemoryComposition memory={stats.memory} freeLabel={memoryFreeLabel} />
              <DetailRow label={memoryFreeLabel} value={formatBytesCompact(stats.memory.free)} />
              {typeof stats.memory.swapUsed === "number" && (
                <DetailRow label="Swap used" value={formatBytesCompact(stats.memory.swapUsed)} />
              )}
            </DetailGroup>

            <DetailGroup icon={HardDrive} title="Disk">
              <DetailRow label="Free" value={formatBytesCompact(stats.disk.free)} />
              <DetailRow label="Total" value={formatBytesCompact(stats.disk.total)} />
            </DetailGroup>

            <DetailGroup icon={Timer} title="System">
              <DetailRow label="Host" value={stats.system.hostname} />
              <DetailRow label="Platform" value={`${stats.system.platform} ${stats.system.arch}`} />
              <DetailRow label="Uptime" value={stats.system.uptimeDisplay} />
              <DetailRow label="Processes" value={String(stats.system.processCount)} />
            </DetailGroup>
          </div>

          {/* OpenClaw storage */}
          <div className="grid grid-cols-2 gap-4 border-t border-border-subtle p-4 sm:grid-cols-4 sm:p-5">
            <StorageStat icon={Folder} label="Workspace" value={formatBytesCompact(stats.openclaw.workspaceSizeBytes)} />
            <StorageStat icon={FileText} label="Files" value={String(stats.openclaw.totalWorkspaceFiles)} />
            <StorageStat
              icon={Database}
              label="Sessions"
              value={String(stats.openclaw.activeSessions)}
              sub={formatBytesCompact(stats.openclaw.sessionsSizeBytes)}
            />
            <StorageStat icon={FileText} label="Today's log" value={formatBytesCompact(stats.openclaw.logSizeBytes)} />
          </div>
        </div>
      )}
    </div>
  );
}
