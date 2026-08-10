"use client";

/**
 * Why the card moved.
 *
 * Cards on this board relocate by themselves — the agent asks a question and the
 * card walks to Review without anyone touching it. Motion alone tells the user
 * that something happened; the transition record tells them what. The engine
 * writes `reason` for a human, so it is rendered verbatim.
 *
 * The trace is deliberately short-lived on the card: it is an explanation for
 * the move you just watched, not a permanent badge. The full history lives in
 * the detail dialog.
 */

import { useEffect, useState } from "react";
import { ArrowRight, CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { columnTitle, type Column, type TaskTransition } from "./types";

/** How long a self-move stays explained on the card. */
const TRACE_TTL_MS = 45_000;

/** The most recent transition that actually moved the card, and was not the user. */
export function latestSelfMove(
  transitions: TaskTransition[] | undefined,
): TaskTransition | null {
  if (!transitions || transitions.length === 0) return null;
  for (let i = transitions.length - 1; i >= 0; i -= 1) {
    const t = transitions[i];
    if (t.by === "user") continue;
    if (!t.toColumn || t.toColumn === t.fromColumn) continue;
    return t;
  }
  return null;
}

/**
 * A quiet line under a card that has just moved on its own.
 *
 * Renders nothing once the move is old news, so the board does not accumulate
 * explanations for things the user has long since absorbed.
 */
export function MoveTrace({
  transition,
  columns,
  className,
}: {
  transition: TaskTransition | null;
  columns: Column[];
  className?: string;
}) {
  // Expiry is derived, not stored: the timer only nudges the clock forward once,
  // at the moment the trace goes stale, so there is no cascading state update.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!transition) return;
    const remaining = TRACE_TTL_MS - (Date.now() - transition.at);
    if (remaining <= 0) return; // already old news — render works that out
    const id = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(id);
  }, [transition]);

  if (!transition || now - transition.at > TRACE_TTL_MS) return null;

  const from = columnTitle(columns, transition.fromColumn);
  const to = columnTitle(columns, transition.toColumn);

  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-1.5 text-[10.5px] leading-4 text-fg-subtle animate-enter",
        className,
      )}
    >
      <CornerDownRight className="mt-[1px] h-3 w-3 shrink-0 opacity-70" />
      <p className="min-w-0 flex-1 break-words">
        {/* The engine's own words for what happened. */}
        <span>{transition.reason}</span>
        {from && to && (
          <span className="whitespace-nowrap">
            {" "}
            <span className="opacity-70">{from}</span>
            <ArrowRight className="mx-0.5 inline h-2.5 w-2.5 -translate-y-[1px] opacity-70" />
            <span className="opacity-70">{to}</span>
          </span>
        )}
      </p>
    </div>
  );
}

/** The whole history, for the detail dialog. Newest last, as the engine stores it. */
export function TransitionList({
  transitions,
  columns,
}: {
  transitions: TaskTransition[];
  columns: Column[];
}) {
  if (transitions.length === 0) return null;
  return (
    <ol className="space-y-1.5">
      {transitions.map((t, i) => {
        const from = columnTitle(columns, t.fromColumn);
        const to = columnTitle(columns, t.toColumn);
        const moved = Boolean(t.fromColumn && t.toColumn && t.fromColumn !== t.toColumn);
        return (
          <li key={`${t.at}-${i}`} className="flex min-w-0 items-start gap-2">
            <span
              className={cn(
                "mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full",
                t.by === "user" ? "bg-muted-foreground/50" : "bg-fg-secondary/60",
              )}
            />
            <div className="min-w-0 flex-1">
              <p className="break-words text-xs leading-5 text-fg-secondary">{t.reason}</p>
              <p className="text-[10.5px] text-fg-subtle">
                {t.by === "user" ? "You" : t.by === "agent" ? "The agent" : "The board"}
                {moved && (
                  <>
                    {" · "}
                    {from}
                    <ArrowRight className="mx-0.5 inline h-2.5 w-2.5 -translate-y-[1px]" />
                    {to}
                  </>
                )}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
