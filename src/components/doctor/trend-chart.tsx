"use client";

/**
 * Health over time — one series, drawn in ink rather than colour.
 *
 * Design decisions worth stating, because each one was a choice:
 *
 * - **One series, so no legend.** The heading names it.
 * - **Neutral ink, not a status hue.** Amber and red are reserved on this page
 *   for "something wants you"; a chart of past scores is reference, not an
 *   alarm, so it draws in the type ramp.
 * - **Even spacing, labelled honestly.** Checks are not evenly spaced in time,
 *   and a time-proportional axis collapses a burst of runs into one smudge. The
 *   x axis is "oldest → newest", the endpoints carry their real timestamps, and
 *   the tooltip gives each point's actual time.
 * - **Selective labels.** Only the newest point is labelled; everything else is
 *   in the tooltip. A number on every point is noise.
 * - **A run with no score is a gap**, not a zero — the line breaks.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { DoctorTrendPoint } from "./types";
import { formatStamp } from "./format";

const PAD_TOP = 18;
const PAD_BOTTOM = 22;
/** Plain-language names for the stored run modes. */
const MODE_LABELS: Record<string, string> = {
  quick: "quick",
  full: "full",
  deep: "deep",
  lint: "quick",
};

const PAD_X = 10;

export function TrendChart({
  points,
  hour12,
  className,
  height = 132,
}: {
  points: DoctorTrendPoint[];
  hour12?: boolean;
  className?: string;
  height?: number;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const node = hostRef.current;
    if (!node) return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (points.length < 2 || width <= 0) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const inner = Math.max(1, width - PAD_X * 2);
      const step = inner / (points.length - 1);
      const idx = Math.round((x - PAD_X) / step);
      setHover(Math.min(points.length - 1, Math.max(0, idx)));
    },
    [points.length, width]
  );

  if (points.length < 2) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)}>
        There is only one check on record so far, so there is no trend to draw yet.
      </p>
    );
  }

  const innerW = Math.max(1, width - PAD_X * 2);
  const innerH = Math.max(1, height - PAD_TOP - PAD_BOTTOM);
  const stepX = innerW / (points.length - 1);
  const xAt = (i: number) => PAD_X + i * stepX;
  const yAt = (score: number) => PAD_TOP + innerH - (Math.min(100, Math.max(0, score)) / 100) * innerH;

  /*
   * Break the path wherever a run has no score, and wherever the check depth
   * changes. A quick run skips the entire legacy pass, so it scores higher than
   * a deep run on an unchanged machine — joining them draws a recovery or a
   * collapse that never happened. Points still render; only the misleading
   * connecting line is withheld.
   */
  const segments: { i: number; x: number; y: number }[][] = [];
  let current: { i: number; x: number; y: number }[] = [];
  let currentMode: string | null = null;
  points.forEach((p, i) => {
    if (p.score === null) {
      if (current.length) segments.push(current);
      current = [];
      currentMode = null;
      return;
    }
    if (currentMode !== null && p.mode !== currentMode) {
      if (current.length) segments.push(current);
      current = [];
    }
    currentMode = p.mode;
    current.push({ i, x: xAt(i), y: yAt(p.score) });
  });
  if (current.length) segments.push(current);

  const lastScored = [...points].reverse().find((p) => p.score !== null);
  const lastScoredIndex = lastScored ? points.lastIndexOf(lastScored) : -1;
  // Clamp during render: a shorter trend must never index past the end.
  const cursor = hover === null ? null : Math.min(hover, points.length - 1);
  const active = cursor === null ? null : points[cursor];
  const baselineY = PAD_TOP + innerH;

  return (
    <div ref={hostRef} className={cn("relative w-full", className)}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Health score across the last ${points.length} checks`}
          className="block touch-none select-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* Recessive frame: a floor and a ceiling, nothing else. */}
          <line
            x1={0}
            x2={width}
            y1={PAD_TOP}
            y2={PAD_TOP}
            stroke="var(--chart-grid)"
            strokeWidth={1}
          />
          <line
            x1={0}
            x2={width}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--chart-grid)"
            strokeWidth={1}
          />

          {segments.map((seg, si) => {
            const d = seg.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
            const area = `${d} L${seg[seg.length - 1].x},${baselineY} L${seg[0].x},${baselineY} Z`;
            return (
              <g key={si}>
                {seg.length > 1 && <path d={area} fill="var(--chart-grid)" />}
                <path
                  d={d}
                  fill="none"
                  stroke="var(--chart-text)"
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                {seg.length === 1 && (
                  <circle cx={seg[0].x} cy={seg[0].y} r={3} fill="var(--chart-text)" />
                )}
              </g>
            );
          })}

          {/* Newest point, always marked and labelled. */}
          {lastScoredIndex >= 0 && points[lastScoredIndex].score !== null && (
            <>
              <circle
                cx={xAt(lastScoredIndex)}
                cy={yAt(points[lastScoredIndex].score as number)}
                r={4}
                fill="var(--card)"
                stroke="var(--chart-text)"
                strokeWidth={2}
              />
              <text
                x={xAt(lastScoredIndex)}
                y={Math.max(12, yAt(points[lastScoredIndex].score as number) - 10)}
                textAnchor={lastScoredIndex === points.length - 1 ? "end" : "middle"}
                className="fill-foreground text-[11px] font-semibold tabular-nums"
              >
                {points[lastScoredIndex].score}
              </text>
            </>
          )}

          {/* Crosshair */}
          {cursor !== null && (
            <>
              <line
                x1={xAt(cursor)}
                x2={xAt(cursor)}
                y1={PAD_TOP}
                y2={baselineY}
                stroke="var(--chart-tick-muted)"
                strokeWidth={1}
              />
              {active?.score !== null && active !== null && (
                <circle
                  cx={xAt(cursor)}
                  cy={yAt(active.score as number)}
                  r={4.5}
                  fill="var(--card)"
                  stroke="var(--chart-text)"
                  strokeWidth={2}
                />
              )}
            </>
          )}

          <text
            x={0}
            y={height - 6}
            className="fill-fg-subtle text-[10px] tabular-nums"
          >
            {formatStamp(points[0].ts, hour12)}
          </text>
          <text
            x={width}
            y={height - 6}
            textAnchor="end"
            className="fill-fg-subtle text-[10px] tabular-nums"
          >
            {formatStamp(points[points.length - 1].ts, hour12)}
          </text>
        </svg>
      )}

      {active && cursor !== null && width > 0 && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-max max-w-[15rem] -translate-x-1/2 rounded-lg border border-border bg-popover px-3 py-2 shadow-md"
          style={{
            left: `${Math.min(Math.max(xAt(cursor), 78), Math.max(78, width - 78))}px`,
          }}
        >
          <p className="text-xs font-medium tabular-nums text-foreground">
            {active.score === null ? "No score recorded" : `Health ${active.score}`}
          </p>
          <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">
            {formatStamp(active.ts, hour12)}
            {/* Which check set produced this score — a quick run inspects less,
                so its number is not comparable with a deeper one. */}
            {active.mode ? ` · ${MODE_LABELS[active.mode] ?? active.mode} check` : ""}
          </p>
          <p className="mt-1 text-[11px] tabular-nums text-fg-subtle">
            {active.errors} serious · {active.warnings} warnings · {active.infos} notes
          </p>
        </div>
      )}
    </div>
  );
}
