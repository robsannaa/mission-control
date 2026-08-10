"use client";

/**
 * What the agent is doing, as it does it.
 *
 * The engine hands us lines that are already readable — the gateway's own
 * wording for each step ("exec run sleep 5 → print text"), rewritten in place as
 * a step progresses rather than appended twice. So this renders them as they
 * are: no paraphrasing, no reconstruction, keyed on `id` so a step that updates
 * moves rather than duplicates.
 */

import { useEffect, useRef } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  HelpCircle,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatOffset, type ActivityKind, type TaskActivityLine } from "./types";

/** A small ring that spins — one step still in flight. */
export function StepSpinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent opacity-70",
        className,
      )}
      aria-hidden
    />
  );
}

function KindIcon({ kind, pending }: { kind: ActivityKind; pending?: boolean }) {
  if (pending) return <StepSpinner className="text-fg-secondary" />;
  switch (kind) {
    case "tool":
      return <Terminal className="h-3 w-3 shrink-0 opacity-60" />;
    case "error":
      return <AlertCircle className="h-3 w-3 shrink-0 text-danger-fg" />;
    case "result":
      return <CheckCircle2 className="h-3 w-3 shrink-0 opacity-60" />;
    case "question":
      return <HelpCircle className="h-3 w-3 shrink-0 opacity-70" />;
    default:
      return <CircleDot className="h-3 w-3 shrink-0 opacity-40" />;
  }
}

function toneFor(kind: ActivityKind): string {
  switch (kind) {
    case "error":
      return "text-danger-fg";
    case "assistant":
      return "text-fg-secondary";
    case "tool":
      return "text-muted-foreground font-mono text-[11px]";
    case "lifecycle":
    case "system":
      return "text-fg-subtle";
    default:
      return "text-muted-foreground";
  }
}

export function LiveLog({
  entries,
  origin,
  active,
  variant = "full",
  maxLines,
  className,
}: {
  entries: TaskActivityLine[];
  /** Run start, so every line is stamped as an offset rather than a clock. */
  origin: number | null;
  /** True while the run is still going — keeps the view following the tail. */
  active: boolean;
  variant?: "compact" | "full";
  maxLines?: number;
  className?: string;
}) {
  const compact = variant === "compact";
  const cap = maxLines ?? (compact ? 4 : 60);
  const lines = entries.length > cap ? entries.slice(entries.length - cap) : entries;

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastId = lines[lines.length - 1]?.id;

  // Follow the tail, but stop the moment the reader scrolls up to read something.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stick.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lastId, entries.length]);

  if (lines.length === 0) return null;

  return (
    <div
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn(
        "min-w-0 overflow-y-auto overscroll-contain",
        compact ? "max-h-24" : "max-h-80",
        className,
      )}
      // The tail view clips its top line. Fading it says "there is more above"
      // rather than looking like a rendering accident.
      style={
        compact
          ? {
              maskImage: "linear-gradient(to bottom, transparent 0, black 14px)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0, black 14px)",
            }
          : undefined
      }
    >
      <div className={cn("min-w-0 space-y-1", compact ? "pr-1" : "pr-2")}>
        {lines.map((line) => (
          <div key={line.id} className="flex min-w-0 items-start gap-2">
            {!compact && (
              <span className="mt-[3px] w-9 shrink-0 text-right font-mono text-[10px] leading-4 text-fg-subtle tabular-nums">
                {formatOffset(line.at, origin)}
              </span>
            )}
            <span className="mt-[2px] flex h-3 w-3 shrink-0 items-center justify-center text-muted-foreground">
              <KindIcon kind={line.kind} pending={line.pending} />
            </span>
            <p
              className={cn(
                "min-w-0 flex-1 break-words text-xs leading-5",
                toneFor(line.kind),
                compact && "line-clamp-2",
                line.pending && "text-fg-secondary",
              )}
              title={line.text}
            >
              {line.text}
            </p>
          </div>
        ))}
      </div>
      {active && <span className="sr-only">The agent is still working.</span>}
    </div>
  );
}

/**
 * The single most recent step, with a spinner — the two-metre view.
 *
 * A card in progress needs one unmistakable indicator, not a wall of log. This
 * is that indicator: what it is doing right now, and the fact that it is moving.
 */
export function CurrentStep({
  entries,
  streamingText,
  className,
}: {
  entries: TaskActivityLine[];
  streamingText?: string | null;
  className?: string;
}) {
  // Prefer the text being typed right now; fall back to the newest step.
  const streaming = streamingText?.trim();
  const last = entries[entries.length - 1];
  const text = streaming || last?.text || "Waiting for the first step…";

  // No spinner here on purpose. The strip above already carries the one moving
  // indicator; a second one beside it competes with the first and reads as
  // noise rather than as "this is happening".
  return (
    <div className={cn("min-w-0", className)}>
      <p className="min-w-0 break-words text-[11px] leading-4 text-muted-foreground line-clamp-2">
        {text}
        {streaming && (
          <span className="ml-0.5 inline-block h-3 w-[2px] translate-y-[2px] animate-pulse bg-fg-secondary align-baseline" />
        )}
      </p>
    </div>
  );
}
