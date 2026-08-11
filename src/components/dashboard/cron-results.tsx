"use client";

/**
 * Recent cron run results — a quiet, scannable list, not a stack of coloured
 * cards. One panel, hairline row dividers, a status dot that is the only
 * colour in the row, monospace timing. Mirrors the row language used by
 * TaskCard / vector primitives elsewhere in the app.
 */

import { Zap } from "lucide-react";
import { StatusDot } from "@/components/vector/primitives";
import { formatAgo, formatDuration } from "./format";
import type { CronRun } from "./types";

export function CronResults({
  runs,
  onOpenJob,
}: {
  runs: CronRun[];
  onOpenJob: (jobId: string) => void;
}) {
  if (runs.length === 0) return null;

  return (
    <div>
      <h2 className="eyebrow mb-3 flex items-center gap-2">
        <Zap className="h-3.5 w-3.5" /> Recent Cron Results
      </h2>
      <div className="overflow-hidden rounded-xl border border-border-subtle bg-card">
        <ul className="divide-y divide-border-subtle">
          {runs.slice(0, 6).map((run, i) => (
            <li key={`${run.jobId}-${run.ts}-${i}`}>
              <button
                type="button"
                onClick={() => onOpenJob(run.jobId)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60"
              >
                <StatusDot tone={run.status === "ok" ? "positive" : "critical"} className="mt-[5px]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-xs">
                    <span className="font-mono tabular-nums text-fg-subtle">{formatAgo(run.ts)}</span>
                    {typeof run.durationMs === "number" && run.durationMs > 0 && (
                      <span className="font-mono tabular-nums text-fg-placeholder">
                        {formatDuration(run.durationMs)}
                      </span>
                    )}
                  </div>
                  {run.summary && (
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-fg-secondary">
                      {run.summary.replace(/[*#|_]/g, "").substring(0, 200)}
                    </p>
                  )}
                  {run.error && <p className="mt-1 text-xs text-danger-fg">{run.error}</p>}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
