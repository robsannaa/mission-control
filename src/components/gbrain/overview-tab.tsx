"use client";

import { useMemo } from "react";
import { AlertTriangle, Link2, Loader2, RefreshCw, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { parseHealth, parseStats } from "./parse";
import { Bar, Disclosure, Panel, Pill, ScoreRing, Stat, type Tone } from "./primitives";
import { CommandRunner } from "./command-runner";
import type { Overview } from "./types";

function scoreTone(score: number | null | undefined): Tone {
  if (score == null) return "unknown";
  if (score >= 90) return "positive";
  if (score >= 70) return "attention";
  return "critical";
}

function statusLabel(status: string | undefined): string {
  if (!status) return "Unknown";
  if (status === "ok") return "Healthy";
  if (status === "warnings") return "Needs attention";
  if (status === "critical" || status === "error") return "Something's broken";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function issueTone(status: string): Tone {
  if (status === "error" || status === "critical") return "critical";
  if (status === "warn" || status === "warning") return "attention";
  return "neutral";
}

export function OverviewTab({
  overview,
  loading,
  refreshing,
  onRefresh,
  onGoToDreaming,
}: {
  overview: Overview | null;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onGoToDreaming: () => void;
}) {
  const doctor = overview?.doctor ?? null;
  const stats = useMemo(() => parseStats(overview?.stats), [overview?.stats]);
  const health = useMemo(() => parseHealth(overview?.health), [overview?.health]);

  if (loading && !overview) {
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Reading your brain…
      </div>
    );
  }

  const score = doctor?.health_score ?? null;
  const tone = scoreTone(score);
  const issues = doctor?.top_issues ?? [];

  return (
    <div className="space-y-5">
      {/* Health hero */}
      <Panel className="p-5 md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-4 sm:gap-6">
            <ScoreRing value={score} tone={tone} label="health" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold text-foreground">{statusLabel(doctor?.status)}</h2>
                {overview?.detection?.engine && (
                  <Pill tone="neutral" title="Engine">{overview.detection.engine}</Pill>
                )}
                {overview?.detection?.schemaPack && (
                  <Pill tone="neutral" title="Schema pack">{overview.detection.schemaPack}</Pill>
                )}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {overview?.doctorError
                  ? overview.doctorError
                  : score == null
                    ? "No health score yet — run Doctor to check."
                    : `Doctor scored this brain ${score} out of 100.`}
              </p>
            </div>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={onRefresh} disabled={refreshing} className="shrink-0">
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
        {doctor?.category_scores && (
          <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border-subtle pt-4 sm:grid-cols-4">
            {Object.entries(doctor.category_scores).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium capitalize text-muted-foreground">{k}</span>
                  <span className="shrink-0 text-xs font-semibold tabular-nums text-foreground">{v}</span>
                </div>
                <Bar pct={v} tone={scoreTone(v) === "unknown" ? "neutral" : scoreTone(v)} className="mt-1.5" />
              </div>
            ))}
          </div>
        )}
      </Panel>

      {/* Top issues */}
      {issues.length > 0 && (
        <Panel className="p-5">
          <p className="eyebrow mb-3">Top issues</p>
          <ul className="space-y-2.5">
            {issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <AlertTriangle
                  className={cn(
                    "mt-0.5 h-4 w-4 shrink-0",
                    issueTone(issue.status) === "critical" ? "text-danger-fg" : "text-warning-fg",
                  )}
                />
                <span className="min-w-0 leading-relaxed">
                  <span className="font-medium text-foreground">{issue.name.replace(/_/g, " ")}</span>
                  <span className="text-muted-foreground"> — {issue.fix}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {issues.length === 0 && doctor && (
        <Panel className="flex items-center gap-2.5 p-4">
          <ShieldCheck className="h-4 w-4 shrink-0 text-success-fg" />
          <p className="text-sm text-foreground">Nothing needs your attention right now.</p>
        </Panel>
      )}

      {/* Brain statistics */}
      <Panel className="p-5">
        <p className="eyebrow mb-4">Brain statistics</p>
        {stats ? (
          <>
            <div className="grid grid-cols-2 gap-5 sm:grid-cols-5">
              <Stat label="Pages" value={stats.pages ?? "—"} />
              <Stat label="Chunks" value={stats.chunks ?? "—"} />
              <Stat label="Embedded" value={stats.embedded ?? "—"} />
              <Stat label="Links" value={stats.links ?? "—"} />
              <Stat label="Timeline" value={stats.timeline ?? "—"} />
            </div>
            {stats.byType.length > 0 && (
              <div className="mt-5 border-t border-border-subtle pt-4">
                <p className="mb-2.5 text-xs font-medium text-fg-subtle">By type</p>
                <div className="flex flex-wrap gap-2">
                  {stats.byType.map((t) => (
                    <Pill key={t.type} tone="neutral">
                      <span className="capitalize">{t.type}</span>
                      <span className="tabular-nums text-fg-subtle">{t.count}</span>
                    </Pill>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No statistics yet.</p>
        )}
      </Panel>

      {/* Health dashboard + most connected */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Panel className="p-5">
          <p className="eyebrow mb-4">Coverage & staleness</p>
          {health ? (
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="Embed coverage"
                value={health.embedCoveragePct != null ? `${health.embedCoveragePct}%` : "—"}
                tone={health.embedCoveragePct != null && health.embedCoveragePct < 90 ? "attention" : "positive"}
              />
              <Stat
                label="Link coverage"
                value={health.linkCoveragePct != null ? `${health.linkCoveragePct}%` : "—"}
                tone={health.linkCoveragePct != null && health.linkCoveragePct < 70 ? "attention" : "positive"}
              />
              <Stat
                label="Stale pages"
                value={health.stalePages ?? "—"}
                tone={health.stalePages ? "attention" : "neutral"}
              />
              <Stat
                label="Orphan pages"
                value={health.orphanPages ?? "—"}
                tone={health.orphanPages ? "attention" : "neutral"}
              />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No health dashboard data yet.</p>
          )}
        </Panel>

        <Panel className="p-5">
          <p className="eyebrow mb-4">Most connected entities</p>
          {health && health.mostConnected.length > 0 ? (
            <ul className="space-y-2.5">
              {health.mostConnected.map((e) => {
                const max = health.mostConnected[0]?.count || 1;
                return (
                  <li key={e.slug} className="flex items-center gap-3">
                    <Link2 className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-secondary" title={e.slug}>
                      {e.slug}
                    </span>
                    <Bar pct={(e.count / max) * 100} className="w-16 shrink-0" />
                    <span className="w-6 shrink-0 text-right text-xs tabular-nums text-fg-subtle">{e.count}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Nothing linked yet.</p>
          )}
        </Panel>
      </div>

      {/* Jobs teaser */}
      {overview?.jobs && (
        <button
          type="button"
          onClick={onGoToDreaming}
          className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border-subtle bg-surface-subtle px-5 py-3.5 text-left transition-colors hover:border-border hover:bg-muted"
        >
          <span className="text-sm text-muted-foreground">
            Background jobs run here while you&rsquo;re away — see the queue in <span className="font-medium text-foreground">Dreaming</span>.
          </span>
          <span className="shrink-0 text-xs font-medium text-foreground">Open →</span>
        </button>
      )}

      {/* More diagnostics */}
      <Disclosure label="More diagnostics" className="px-1">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <CommandRunner command={{ id: "features", label: "Feature usage", category: "overview", description: "Unused features worth turning on.", json: true }} />
          <CommandRunner command={{ id: "storage-status", label: "Storage status", category: "overview", description: "Git-tracked vs. remote-only storage tiers.", json: true }} />
          <CommandRunner command={{ id: "config-show", label: "Config", category: "overview", description: "Brain configuration." }} />
          <CommandRunner command={{ id: "check-update", label: "Check for updates", category: "overview", description: "Is a newer gbrain version available?", json: true }} />
        </div>
      </Disclosure>
    </div>
  );
}
