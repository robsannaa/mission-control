"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Loader2,
  Stethoscope,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCTOR_COMPLETED_CHECK_ID, type DoctorReport } from "./config-api";

/**
 * Health check after a save — the safety net, not noise.
 *
 * `POST /api/config/doctor` is rate limited to one real run per 10s and is
 * answered from cache inside that window, so the panel reads `cached`/`ranAt`
 * and says out loud when the report predates the save instead of presenting a
 * stale clean bill of health. `ok === (summary.fail === 0)`: warnings do not
 * turn the panel red, because a machine with plaintext secrets warns on every
 * run and a save is not what broke it.
 */

function relativeAge(ranAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - ranAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return `${minutes}m ago`;
}

const STATUS_ICON = {
  ok: CheckCircle,
  warn: AlertTriangle,
  fail: XCircle,
} as const;

const STATUS_CLASS = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  fail: "text-red-600 dark:text-red-400",
} as const;

export function ConfigDoctorPanel({
  report,
  running,
  savedAt,
  onRecheck,
  onDismiss,
}: {
  report: DoctorReport | null;
  running: boolean;
  /** When the write completed, so a cached older report can be flagged. */
  savedAt: number | null;
  onRecheck: () => void;
  onDismiss: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (running && !report) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-foreground/10 bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Checking configuration health…
      </div>
    );
  }
  if (!report) return null;

  const checks = report.checks.filter((c) => c.id !== DOCTOR_COMPLETED_CHECK_ID);
  const problems = checks.filter((c) => c.status !== "ok");
  const healthy = report.ok && problems.length === 0 && !report.partial;
  const stale = savedAt !== null && report.ranAt < savedAt;
  const retryIn = Math.max(0, Math.ceil((report.ranAt + report.retryAfterMs - now) / 1000));

  const tone = !report.ok
    ? "border-red-500/30 bg-red-500/5"
    : problems.length > 0 || report.partial
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-emerald-500/30 bg-emerald-500/5";

  return (
    <div
      data-testid="config-doctor-panel"
      className={cn("rounded-xl border", tone)}
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <Stethoscope
          className={cn(
            "mt-0.5 h-4 w-4 shrink-0",
            report.ok ? STATUS_CLASS.ok : STATUS_CLASS.fail
          )}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground/90">
            {healthy
              ? "Configuration healthy"
              : report.ok
                ? `Saved — ${problems.length} item${problems.length === 1 ? "" : "s"} worth a look`
                : `${report.summary.fail} health check${report.summary.fail === 1 ? "" : "s"} failed`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {report.summary.ok} passed · {report.summary.warn} warning
            {report.summary.warn === 1 ? "" : "s"} · {report.summary.fail} failed ·{" "}
            {relativeAge(report.ranAt, now)}
            {report.cached && " (cached)"}
            {report.partial && " · deep check did not complete"}
            {report.timedOut && " · check timed out"}
          </p>
          {stale && (
            <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
              This report ran before your save (health checks are limited to one run every 10
              seconds). Re-check for a result that includes this change.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onRecheck}
            disabled={running || retryIn > 0}
            className="rounded border border-foreground/10 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            {running ? "Checking…" : retryIn > 0 ? `Re-check in ${retryIn}s` : "Re-check"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss health check"
            className="rounded p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-2 border-t border-foreground/5 px-4 py-3">
          {problems.map((check, i) => {
            const Icon = STATUS_ICON[check.status];
            return (
              <li key={`${check.id ?? check.name}-${i}`} className="flex gap-2">
                <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", STATUS_CLASS[check.status])} />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground/90">{check.name}</p>
                  {check.message && (
                    <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                      {check.message}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {checks.length > problems.length && (
        <div className="border-t border-foreground/5 px-4 py-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            {expanded ? "Hide" : "Show"} {checks.length - problems.length} passing check
            {checks.length - problems.length === 1 ? "" : "s"}
          </button>
          {expanded && (
            <ul className="mt-2 space-y-1">
              {checks
                .filter((c) => c.status === "ok")
                .map((check, i) => (
                  <li
                    key={`${check.id ?? check.name}-ok-${i}`}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <CheckCircle className={cn("h-3 w-3", STATUS_CLASS.ok)} />
                    {check.name}
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {report.filtered.length > 0 && (
        <p className="border-t border-foreground/5 px-4 py-2 text-xs text-muted-foreground/80">
          {report.filtered.length} cosmetic notice{report.filtered.length === 1 ? "" : "s"} hidden.
        </p>
      )}
    </div>
  );
}
