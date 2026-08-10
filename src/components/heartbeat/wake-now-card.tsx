"use client";

/**
 * A manual nudge — run a check-in without waiting for the schedule.
 */

import { Play } from "lucide-react";
import { ChoicePill, Panel, fieldInputClass } from "./primitives";

export function WakeNowCard({
  mode,
  onModeChange,
  text,
  onTextChange,
  onTrigger,
  busy,
}: {
  mode: "now" | "next-heartbeat";
  onModeChange: (mode: "now" | "next-heartbeat") => void;
  text: string;
  onTextChange: (text: string) => void;
  onTrigger: () => void;
  busy: boolean;
}) {
  return (
    <Panel className="p-5">
      <p className="text-sm font-semibold text-foreground">Check in right now</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Don&rsquo;t wait for the schedule — ask your agent to look now.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <ChoicePill selected={mode === "now"} onClick={() => onModeChange("now")}>
          Right now
        </ChoicePill>
        <ChoicePill selected={mode === "next-heartbeat"} onClick={() => onModeChange("next-heartbeat")}>
          At the next scheduled check-in
        </ChoicePill>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          disabled={busy}
          placeholder="What should it look for? (optional)"
          className={`${fieldInputClass} min-w-0 flex-1`}
        />
        <button
          type="button"
          onClick={onTrigger}
          disabled={busy}
          className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-50"
        >
          <Play className="h-3.5 w-3.5" />
          {busy ? "Sending..." : "Check in"}
        </button>
      </div>
    </Panel>
  );
}
