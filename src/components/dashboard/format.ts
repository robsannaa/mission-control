/**
 * Shared formatting + small pure helpers for the dashboard.
 * Centralised so dashboard-view.tsx and the dashboard/* sub-components read
 * off one source of truth instead of duplicating the same string math.
 */

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatAgo(ms: number): string {
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

export function formatCountdown(ms: number | null): string {
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

export function formatBytesCompact(b: number): string {
  if (b >= 1073741824) return `${(b / 1073741824).toFixed(1)} GB`;
  if (b >= 1048576) return `${(b / 1048576).toFixed(0)} MB`;
  if (b >= 1024) return `${(b / 1024).toFixed(0)} KB`;
  return `${b} B`;
}

/** Progress of a cron job toward its next scheduled run, 0–100. */
export function cronProgress(job: { lastRunAtMs: number | null; nextRunAtMs: number | null }): number {
  if (!job.lastRunAtMs || !job.nextRunAtMs) return 0;
  const total = job.nextRunAtMs - job.lastRunAtMs;
  const elapsed = Date.now() - job.lastRunAtMs;
  if (total <= 0) return 100;
  return Math.min(100, Math.max(0, (elapsed / total) * 100));
}

/**
 * A healthy, working system renders in neutrals; a status colour only
 * appears once a metric actually needs a person's attention. Keeps the
 * dashboard from painting every idle gauge success-green.
 */
export type UsageTone = "neutral" | "attention" | "critical";

export function usageTone(percent: number, warnAt: number, dangerAt: number): UsageTone {
  if (percent >= dangerAt) return "critical";
  if (percent >= warnAt) return "attention";
  return "neutral";
}
