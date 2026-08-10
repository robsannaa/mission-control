"use client";

/**
 * "This was fine yesterday."
 *
 * Two honesty notes are built into this panel:
 *
 * - Records from before the snapshot format changed are *discarded* by the
 *   server, and the count comes back as `discardedLegacyRuns`. They are
 *   reported here as "history starts here", never as an improvement — the old
 *   records described findings a regex classifier invented, and diffing against
 *   them would manufacture a fake recovery.
 * - A run with no score shows the words, not a zero.
 */

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Panel, QuietNote, SectionTitle } from "./primitives";
import { TrendChart } from "./trend-chart";
import { describeDuration, formatStamp, runModeLabel } from "./format";
import type { DoctorHistoryResponse, DoctorTrendPoint } from "./types";

export function HistoryPanel({
  history,
  trend,
  hour12,
  loading,
  onLoadMore,
}: {
  history: DoctorHistoryResponse | null;
  trend: DoctorTrendPoint[];
  hour12: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const runs = history?.runs ?? [];
  const shown = expanded ? runs : runs.slice(0, 6);
  const hiddenLocally = runs.length - shown.length;
  const canLoadMore = runs.length < (history?.total ?? 0);

  return (
    <Panel>
      <header className="px-5 pb-5 pt-5 md:px-6">
        <SectionTitle
          title="History"
          hint="Every check that has run on this machine, and how the score moved."
        />
      </header>

      {trend.length >= 2 && (
        <div className="px-5 pb-5 md:px-6">
          <TrendChart points={trend} hour12={hour12} />
        </div>
      )}

      {runs.length === 0 ? (
        <div className="border-t border-border-subtle px-5 py-6 md:px-6">
          {loading ? (
            <p className="flex items-center gap-2.5 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading past checks…
            </p>
          ) : (
            <QuietNote>No checks have been recorded yet.</QuietNote>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border-subtle border-t border-border-subtle">
          {shown.map((run) => {
            const needsYou = run.summary.errors + run.summary.warnings;
            return (
              <li
                key={run.id}
                className="flex flex-wrap items-baseline gap-x-5 gap-y-1 px-5 py-3.5 md:px-6"
              >
                <span className="w-40 shrink-0 text-sm tabular-nums text-fg-secondary">
                  {formatStamp(run.completedAt, hour12)}
                </span>
                <span className="w-24 shrink-0 text-xs text-fg-subtle">
                  {runModeLabel(run.mode)}
                </span>
                <span className="min-w-0 flex-1 text-sm text-muted-foreground">
                  {needsYou === 0
                    ? "Nothing needed attention"
                    : `${needsYou} needed attention`}
                  {run.summary.infos > 0 ? ` · ${run.summary.infos} noted` : ""}
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-fg-subtle">
                  {describeDuration(run.durationMs)}
                </span>
                <span
                  className={cn(
                    "w-12 shrink-0 text-right text-sm font-medium tabular-nums",
                    run.score === null ? "text-fg-subtle" : "text-foreground"
                  )}
                >
                  {run.score === null ? "—" : run.score}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {(hiddenLocally > 0 || canLoadMore) && (
        <div className="border-t border-border-subtle px-5 py-3 md:px-6">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (hiddenLocally > 0 ? setExpanded(true) : onLoadMore())}
            disabled={loading}
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {hiddenLocally > 0
              ? `Show the other ${hiddenLocally}`
              : `Load older checks — ${runs.length} of ${history?.total} shown`}
          </Button>
        </div>
      )}

      {history && history.discardedLegacyRuns > 0 && (
        <p className="border-t border-border-subtle px-5 py-4 text-xs leading-relaxed text-fg-subtle md:px-6">
          History starts here. {history.discardedLegacyRuns} older record
          {history.discardedLegacyRuns === 1 ? " was" : "s were"} discarded when Mission Control
          changed how it reads OpenClaw&rsquo;s output — those records described findings that were
          guessed from text rather than reported, so comparing against them would invent progress
          that never happened.
        </p>
      )}
    </Panel>
  );
}
