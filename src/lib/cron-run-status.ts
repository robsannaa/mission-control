export type CronRunRecord = {
  ts?: number;
  runAtMs?: number;
  runId?: string;
  status?: string;
  action?: string;
  summary?: string;
  error?: string;
  sessionKey?: string;
  [key: string]: unknown;
};

export function cronRunStartedAt(entry: CronRunRecord): number {
  const value = Number(entry.runAtMs ?? entry.ts ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Pick the run created by a user's Run now request without mistaking the
 * previous scheduled run for the new one. Newer gateways label forced runs
 * with `manual:`; older gateways fall back to timestamps.
 */
export function selectTriggeredCronRun<T extends CronRunRecord>(
  entries: T[],
  requestedAtMs: number,
  baselineRunAtMs = 0,
): T | null {
  const candidates = entries.filter((entry) => {
    const startedAt = cronRunStartedAt(entry);
    return startedAt > baselineRunAtMs && startedAt >= requestedAtMs - 2_500;
  });
  if (candidates.length === 0) return null;
  return candidates.find((entry) => String(entry.runId || "").startsWith("manual:")) ?? candidates[0];
}

export function cronRunFailed(entry: CronRunRecord): boolean {
  const status = String(entry.status || "").toLowerCase();
  return Boolean(entry.error) || status === "error" || status === "failed";
}

export function cronRunOutput(entry: CronRunRecord, transcript = ""): string {
  const liveTranscript = transcript.trim();
  if (liveTranscript) return liveTranscript;
  return String(entry.error || entry.summary || "").trim();
}
