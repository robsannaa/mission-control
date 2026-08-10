"use client";

/**
 * The run, on the card.
 *
 * Seven outcomes that must never be conflated: in flight, asking, ended without
 * telling us which, finished, failed, stopped by the operator, never started.
 * Only failure earns colour — a finished run is a calm line of prose, not a
 * green badge. While a run is in flight the card shows what it is doing right
 * now, so watching one work never means opening anything.
 */

import { useEffect, useState } from "react";
import { AlertCircle, ArrowRight, Check, Play, RotateCcw, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { CurrentStep, StepSpinner } from "./live-log";
import {
  formatCost,
  formatDuration,
  formatTokens,
  questionCopy,
  stripMarker,
  type DispatchAssignee,
  type Task,
  type TaskRunSnapshot,
} from "./types";

/** A clock, isolated so a tick repaints six characters and nothing else. */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <span className={cn("tabular-nums", className)}>{formatDuration(now - since)}</span>
  );
}

export function LiveDot() {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fg-secondary opacity-60" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-fg-secondary" />
    </span>
  );
}

function RunMeta({
  runtimeMs,
  totalTokens,
  costUsd,
}: {
  runtimeMs: number | null;
  totalTokens: number | null;
  costUsd: number | null;
}) {
  const parts = [
    runtimeMs != null ? formatDuration(runtimeMs) : null,
    formatTokens(totalTokens),
    formatCost(costUsd),
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  return (
    <span className="min-w-0 truncate text-[11px] text-fg-subtle tabular-nums">
      {parts.join(" · ")}
    </span>
  );
}

export function RunStrip({
  task,
  snapshot,
  assignee,
  busy,
  onStop,
  onRun,
  onOpen,
  onAnswer,
  onMarkDone,
}: {
  task: Task;
  snapshot: TaskRunSnapshot | null;
  assignee: DispatchAssignee;
  busy?: boolean;
  onStop: () => void;
  onRun: () => void;
  onOpen?: () => void;
  onAnswer: () => void;
  onMarkDone: () => void;
}) {
  // The live snapshot leads; the board file is the fallback for a card the
  // engine has forgotten (a server restart) but whose result is still on disk.
  const status = snapshot?.status ?? task.dispatchStatus ?? "idle";
  const result = snapshot?.result;
  const startedAt = snapshot?.startedAt ?? task.dispatchedAt ?? null;
  const error = snapshot?.error ?? task.dispatchError ?? null;
  const resultText = result?.text ?? task.dispatchResultText ?? null;
  const question = snapshot?.question?.text ?? task.dispatchQuestion ?? null;
  const confidence = snapshot?.question?.confidence ?? task.dispatchConfidence;
  const stale = snapshot ? !snapshot.live : false;

  const stop = (e: React.MouseEvent) => {
    e.stopPropagation();
    onStop();
  };
  const run = (e: React.MouseEvent) => {
    e.stopPropagation();
    onRun();
  };

  if (status === "dispatching") {
    return (
      <Shell live>
        <div className="flex min-w-0 items-center gap-2">
          <StepSpinner className="text-fg-secondary" />
          <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary">
            Handing over{assignee === "subagent" ? " to a subagent" : ""}…
          </span>
          <GhostButton onClick={stop} disabled={busy} icon={Square} label="Stop" />
        </div>
      </Shell>
    );
  }

  if (status === "running") {
    return (
      <Shell live>
        <div className="flex min-w-0 items-center gap-2">
          {/* The one indicator. Large enough to read as motion across a room. */}
          <StepSpinner className="h-3.5 w-3.5 border-2 text-foreground opacity-100" />
          <span className="shrink-0 text-[13px] font-medium text-foreground">
            {stale ? "Running" : "Working"}
          </span>
          {startedAt && (
            <Elapsed since={startedAt} className="shrink-0 text-[11px] text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1" />
          <GhostButton onClick={stop} disabled={busy} icon={Square} label="Stop" />
        </div>
        <CurrentStep
          entries={snapshot?.activity ?? []}
          streamingText={snapshot?.streamingText}
          className="mt-1.5"
        />
        {stale && (
          <p className="mt-1 text-[10.5px] text-fg-subtle">
            The live feed dropped. Still reconciling in the background.
          </p>
        )}
      </Shell>
    );
  }

  /* The agent asked. This is the one state that earns a primary action. */
  if (status === "asking") {
    return (
      <div className="mt-2.5 min-w-0 rounded-lg border border-border-strong bg-muted/60 px-2.5 py-2">
        <p className="text-[11px] font-medium text-foreground">
          {questionCopy(confidence).heading}
        </p>
        {question && (
          <p className="mt-1 line-clamp-3 break-words text-[11px] leading-4 text-fg-secondary">
            {stripMarker(question)}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAnswer();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-[11px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Answer
          </button>
          {onOpen && <OpenLink onClick={onOpen} label="Details" />}
        </div>
      </div>
    );
  }

  /*
   * Ended with no marker. We genuinely do not know whether it finished or
   * stopped to ask, so the card says exactly that and offers both doors.
   */
  if (status === "needs-review") {
    return (
      <div className="mt-2.5 min-w-0 rounded-lg border border-border-subtle bg-muted/50 px-2.5 py-2">
        <p className="text-[11px] font-medium text-foreground">
          {questionCopy("low").heading}
        </p>
        {question && (
          <p className="mt-1 line-clamp-3 break-words text-[11px] leading-4 text-muted-foreground">
            {question}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onMarkDone();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground"
          >
            <Check className="h-3 w-3" />
            Mark done
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onAnswer();
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground"
          >
            Answer
          </button>
        </div>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div className="mt-2.5 min-w-0 rounded-lg border border-danger-border bg-danger-bg px-2.5 py-2">
        <div className="flex min-w-0 items-start gap-2">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-danger-fg">Run failed</p>
            <p className="mt-0.5 line-clamp-3 break-words text-[11px] leading-4 text-danger-fg/85">
              {error || "The agent stopped without an explanation."}
            </p>
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <GhostButton onClick={run} disabled={busy} icon={RotateCcw} label="Retry" tone="danger" />
          {onOpen && <OpenLink onClick={onOpen} label="Details" tone="danger" />}
        </div>
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <Shell>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
          <span className="shrink-0 text-xs text-muted-foreground">Stopped</span>
          <RunMeta
            runtimeMs={result?.runtimeMs ?? task.dispatchRuntimeMs ?? null}
            totalTokens={result?.totalTokens ?? task.dispatchTotalTokens ?? null}
            costUsd={null}
          />
          <div className="min-w-0 flex-1" />
          <GhostButton onClick={run} disabled={busy} icon={Play} label="Run again" />
        </div>
      </Shell>
    );
  }

  if (status === "completed") {
    return (
      <Shell>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="shrink-0 text-xs text-muted-foreground">Finished</span>
          <RunMeta
            runtimeMs={result?.runtimeMs ?? task.dispatchRuntimeMs ?? null}
            totalTokens={result?.totalTokens ?? task.dispatchTotalTokens ?? null}
            costUsd={result?.costUsd ?? task.dispatchCostUsd ?? null}
          />
        </div>
        {resultText && (
          <p className="mt-1 line-clamp-2 break-words text-[11px] leading-4 text-fg-secondary">
            {stripMarker(resultText)}
          </p>
        )}
        {onOpen && (
          <OpenLink
            onClick={onOpen}
            label={resultText ? "Read the result" : "See what it did"}
            className="mt-1"
          />
        )}
      </Shell>
    );
  }

  return null;
}

function Shell({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <div
      className={cn(
        "mt-2.5 min-w-0 rounded-lg px-2.5 py-2 transition-colors",
        live ? "bg-muted/70 ring-1 ring-inset ring-border-subtle" : "bg-muted/40",
      )}
    >
      {children}
    </div>
  );
}

function GhostButton({
  onClick,
  disabled,
  icon: Icon,
  label,
  tone,
}: {
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  icon: typeof Play;
  label: string;
  tone?: "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-40",
        tone === "danger"
          ? "text-danger-fg hover:bg-danger-fg/10"
          : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}

function OpenLink({
  onClick,
  label,
  tone,
  className,
}: {
  onClick: () => void;
  label: string;
  tone?: "danger";
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "group/link inline-flex shrink-0 items-center gap-1 text-[11px] font-medium transition-colors",
        tone === "danger"
          ? "text-danger-fg hover:opacity-80"
          : "text-muted-foreground hover:text-foreground",
        className,
      )}
    >
      {label}
      <ArrowRight className="h-3 w-3 transition-transform duration-200 group-hover/link:translate-x-0.5" />
    </button>
  );
}
