"use client";
/* eslint-disable @next/next/no-img-element */

/**
 * The card, opened.
 *
 * Everything about a run that will not fit on the card lives here and nowhere
 * else: what the agent is doing right now, every step it took, what it
 * concluded, why the card moved, and the identifiers needed to find the run in
 * the gateway. A finished run must never be a card that silently moved to Done.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertCircle, Check, MessageSquare, Play, RotateCcw, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/markdown-content";
import { useBodyScrollLock, useFocusTrap } from "@/hooks/use-modal-accessibility";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
} from "@/lib/time-format-preference";
import { AssigneePicker } from "./assignee-picker";
import { LiveLog, StepSpinner } from "./live-log";
import { TransitionList } from "./move-trace";
import { Elapsed } from "./run-strip";
import { backfillRun, useTaskRun } from "./run-store";
import { PRIORITY_TEXT, attachmentUrl, isImageAttachment } from "./task-card";
import {
  agentLabel,
  columnTitle,
  formatCost,
  formatDuration,
  formatTokens,
  isAwaitingUser,
  isRunActive,
  questionCopy,
  statusIsRedundant,
  stripMarker,
  type AgentInfo,
  type Column,
  type DispatchAssignee,
  type DispatchStatus,
  type Task,
} from "./types";

const STATUS_LABEL: Partial<Record<DispatchStatus, string>> = {
  dispatching: "Starting",
  running: "Working",
  asking: "Waiting on you",
  "needs-review": "Needs your review",
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
};

export function TaskDetailDialog({
  task,
  columns,
  agents,
  isDispatching,
  onClose,
  onEdit,
  onDispatch,
  onAssign,
  onStop,
  onAnswer,
  onMarkDone,
  onAttachmentClick,
}: {
  task: Task;
  columns: Column[];
  agents: AgentInfo[];
  isDispatching?: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDispatch: () => void;
  onAssign: (next: { agentId?: string; assignee: DispatchAssignee }) => void;
  onStop: () => void;
  onAnswer: () => void;
  onMarkDone: () => void;
  onAttachmentClick: (url: string) => void;
}) {
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const trapRef = useFocusTrap(true);
  useBodyScrollLock(true);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const snapshot = useTaskRun(task.id);
  const everRan = Boolean(task.dispatchStatus && task.dispatchStatus !== "idle");

  // A server restart empties the in-memory log while the board file still shows
  // a run. Backfill once, on open — never on a timer, since this one costs a
  // real gateway round trip.
  useEffect(() => {
    if (!everRan) return;
    if (snapshot && snapshot.activity.length > 0) return;
    void backfillRun(task.id);
    // Only on open, and only for a card whose log the engine has lost.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  const assignee: DispatchAssignee =
    snapshot?.assignee ?? task.dispatchAssignee ?? "agent";
  const status = snapshot?.status ?? task.dispatchStatus ?? "idle";
  const result = snapshot?.result;
  const active = isRunActive(status);
  const waiting = isAwaitingUser(status);
  const startedAt = snapshot?.startedAt ?? task.dispatchedAt ?? null;
  const resultText = result?.text ?? task.dispatchResultText ?? null;
  const errorText = snapshot?.error ?? task.dispatchError ?? null;
  const activity = snapshot?.activity ?? [];
  const transitions = snapshot?.transitions ?? task.dispatchTransitions ?? [];
  const question = snapshot?.question?.text ?? task.dispatchQuestion ?? null;
  const confidence = snapshot?.question?.confidence ?? task.dispatchConfidence;
  const lowConfidence = confidence === "low" || status === "needs-review";
  const returnColumn = snapshot?.question?.askedFromColumn ?? task.askedFromColumn ?? null;
  const turns = snapshot?.turns ?? task.dispatchTurns ?? 0;
  const stale = snapshot ? !snapshot.live : false;
  const column = columnTitle(columns, task.column);

  const runtimeMs = result?.runtimeMs ?? task.dispatchRuntimeMs ?? null;
  const tokens = formatTokens(result?.totalTokens ?? task.dispatchTotalTokens);
  const cost = formatCost(result?.costUsd ?? task.dispatchCostUsd);

  const showStatusLabel = !statusIsRedundant(status, task.column, columns);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 animate-backdrop-in"
      onClick={onClose}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={task.title}
        className="relative flex max-h-[86vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-4">
          <div className="min-w-0">
            <h3 className="break-words text-sm font-semibold text-foreground">{task.title}</h3>
            {/* Every child shrinks or truncates — this row must never clip. */}
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
              <AssigneePicker
                agents={agents}
                agentId={task.agentId}
                assignee={assignee}
                disabled={active}
                onChange={onAssign}
              />
              <span className="shrink-0 text-fg-subtle">&bull;</span>
              <span
                className={cn(
                  "shrink-0 font-medium capitalize",
                  PRIORITY_TEXT[task.priority] || "text-muted-foreground",
                )}
              >
                {task.priority}
              </span>
              <span className="shrink-0 text-fg-subtle">&bull;</span>
              <span className="min-w-0 truncate text-muted-foreground">{column}</span>
              {/* Shown only when it says something the column does not. */}
              {showStatusLabel && STATUS_LABEL[status] && (
                <span
                  className={cn(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                    status === "failed"
                      ? "bg-danger-bg text-danger-fg"
                      : "bg-muted text-fg-secondary",
                  )}
                >
                  {STATUS_LABEL[status]}
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {task.description && (
            <Section label="Task">
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-fg-secondary">
                {task.description}
              </p>
            </Section>
          )}

          {/* ── waiting on the user: the first thing they should see ── */}
          {waiting && question && (
            <Section label={lowConfidence ? "Needs your review" : "The agent asked"}>
              <div className="rounded-xl border border-border-strong bg-muted/40 px-3.5 py-3">
                <p className="text-xs leading-relaxed text-muted-foreground">
                  {questionCopy(lowConfidence ? "low" : "high").lead}
                </p>
                <div className="mt-2">
                  <MarkdownContent
                    content={lowConfidence ? question : stripMarker(question)}
                    className="text-[13px]"
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={onAnswer}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    <MessageSquare className="h-3 w-3" />
                    Answer
                  </button>
                  {lowConfidence && (
                    <button
                      type="button"
                      onClick={onMarkDone}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground"
                    >
                      <Check className="h-3 w-3" />
                      Mark done
                    </button>
                  )}
                  {returnColumn && (
                    <span className="text-[11px] text-fg-subtle">
                      Answering returns it to {columnTitle(columns, returnColumn)}.
                    </span>
                  )}
                </div>
              </div>
            </Section>
          )}

          {/* ── the run ── */}
          <Section
            label="Run"
            aside={
              everRan ? (
                <span className="font-mono text-[10.5px] text-fg-subtle">
                  {assignee === "subagent" ? "isolated subagent" : "agent session"}
                  {turns > 1 ? ` · turn ${turns}` : ""}
                </span>
              ) : undefined
            }
          >
            <div className="rounded-xl border border-border-subtle bg-muted/30 px-3.5 py-3">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                {active ? (
                  <>
                    <StepSpinner className="text-foreground" />
                    <span className="shrink-0 text-[13px] font-medium text-foreground">
                      {status === "dispatching" ? "Starting" : "Working"}
                    </span>
                    {startedAt && (
                      <Elapsed since={startedAt} className="shrink-0 text-xs text-muted-foreground" />
                    )}
                  </>
                ) : status === "failed" ? (
                  <>
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger-fg" />
                    <span className="shrink-0 text-[13px] font-medium text-danger-fg">Failed</span>
                  </>
                ) : status === "cancelled" ? (
                  <>
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span className="shrink-0 text-[13px] text-muted-foreground">
                      Stopped by you
                    </span>
                  </>
                ) : status === "completed" ? (
                  <span className="shrink-0 text-[13px] text-muted-foreground">Finished</span>
                ) : waiting ? (
                  <span className="shrink-0 text-[13px] text-muted-foreground">
                    Paused, waiting on you
                  </span>
                ) : (
                  <span className="min-w-0 text-[13px] text-muted-foreground">
                    {task.agentId
                      ? `Not started. ${agentLabel(agents, task.agentId)} is ready.`
                      : "No agent assigned yet."}
                  </span>
                )}

                {!active && everRan && (
                  <span className="min-w-0 truncate text-[11px] text-fg-subtle tabular-nums">
                    {[runtimeMs != null ? formatDuration(runtimeMs) : null, tokens, cost]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                )}

                <div className="min-w-0 flex-1" />

                {active ? (
                  <Action onClick={onStop} icon={Square} label="Stop" tone="danger" />
                ) : task.agentId && !waiting ? (
                  <Action
                    onClick={onDispatch}
                    disabled={isDispatching}
                    icon={status === "failed" ? RotateCcw : Play}
                    label={
                      isDispatching
                        ? "Starting…"
                        : status === "failed"
                          ? "Retry"
                          : everRan
                            ? "Run again"
                            : "Run"
                    }
                  />
                ) : null}
              </div>

              {stale && active && (
                <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
                  The live feed to the gateway dropped. This is being kept up by
                  slower background reconciliation, so it may lag.
                </p>
              )}

              {status === "failed" && (
                <div className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-danger-fg">
                    {errorText || "The agent stopped without an explanation."}
                  </p>
                </div>
              )}

              {status === "cancelled" && (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  You stopped this run. Whatever it had done up to that point is below.
                </p>
              )}

              {(task.dispatchRunId || task.dispatchSessionKey) && (
                <dl className="mt-3 space-y-1 border-t border-border-subtle pt-2.5">
                  {task.dispatchRunId && <IdRow label="Run" value={task.dispatchRunId} />}
                  {task.dispatchSessionKey && (
                    <IdRow label="Session" value={task.dispatchSessionKey} />
                  )}
                  {task.dispatchedAt && (
                    <IdRow
                      label="Started"
                      value={new Date(task.dispatchedAt).toLocaleString(
                        undefined,
                        withTimeFormat(
                          {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          },
                          timeFormat,
                        ),
                      )}
                    />
                  )}
                  {task.completedAt && (
                    <IdRow
                      label="Ended"
                      value={new Date(task.completedAt).toLocaleString(
                        undefined,
                        withTimeFormat(
                          {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          },
                          timeFormat,
                        ),
                      )}
                    />
                  )}
                </dl>
              )}
            </div>
          </Section>

          {/* ── what it concluded ── */}
          {resultText && !waiting && (
            <Section label={status === "completed" ? "Result" : "Last thing it said"}>
              <div className="rounded-xl border border-border-subtle bg-surface-inset px-3.5 py-3">
                <MarkdownContent content={stripMarker(resultText)} className="text-[13px]" />
                {result?.truncated && (
                  <p className="mt-2 text-[11px] text-fg-subtle">
                    Stored result was truncated. The full text is in the activity below.
                  </p>
                )}
              </div>
            </Section>
          )}

          {/* ── everything it did ── */}
          {everRan && (
            <Section
              label="Activity"
              aside={
                activity.length > 0 ? (
                  <span className="text-[11px] text-fg-subtle">
                    {activity.length} {activity.length === 1 ? "step" : "steps"}
                  </span>
                ) : undefined
              }
            >
              {activity.length > 0 ? (
                <div className="rounded-xl border border-border-subtle bg-surface-inset px-3 py-2.5">
                  <LiveLog entries={activity} origin={startedAt} active={active} variant="full" />
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {active
                    ? "Waiting for the first step…"
                    : "No step-by-step log was kept for this run."}
                </p>
              )}
            </Section>
          )}

          {/* ── why the card is where it is ── */}
          {transitions.length > 0 && (
            <Section
              label="History"
              aside={
                <button
                  type="button"
                  onClick={() => setShowHistory((v) => !v)}
                  className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {showHistory ? "Hide" : `Show all ${transitions.length}`}
                </button>
              }
            >
              <div className="rounded-xl border border-border-subtle bg-surface-inset px-3.5 py-3">
                <TransitionList
                  transitions={showHistory ? transitions : transitions.slice(-3)}
                  columns={columns}
                />
              </div>
            </Section>
          )}

          {task.attachments && task.attachments.length > 0 && (
            <Section label="Attachments">
              <div className="flex flex-wrap gap-2">
                {task.attachments.filter(isImageAttachment).map((path, i) => (
                  <button
                    key={`${path}-${i}`}
                    type="button"
                    onClick={() => onAttachmentClick(attachmentUrl(path))}
                    aria-label={`View attachment ${i + 1}`}
                    className="overflow-hidden rounded-lg border border-foreground/10 bg-muted/50 transition-opacity hover:opacity-90 focus:ring-2 focus:ring-border-strong"
                  >
                    <img src={attachmentUrl(path)} alt="" className="h-20 w-20 object-cover" />
                  </button>
                ))}
                {task.attachments.filter((p) => !isImageAttachment(p)).length > 0 && (
                  <span className="self-center text-xs text-muted-foreground">
                    +{task.attachments.filter((p) => !isImageAttachment(p)).length} file(s)
                  </span>
                )}
              </div>
            </Section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onEdit}
            className="rounded-full px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-muted px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/70"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({
  label,
  aside,
  children,
}: {
  label: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        {/* Sentence case: a label, not a database column. */}
        <h4 className="text-[11px] font-semibold text-fg-subtle">{label}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function IdRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <dt className="w-14 shrink-0 text-fg-subtle">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-muted-foreground" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Action({
  onClick,
  disabled,
  icon: Icon,
  label,
  tone,
}: {
  onClick: () => void;
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
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors disabled:opacity-40",
        tone === "danger"
          ? "border-danger-border text-danger-fg hover:bg-danger-bg"
          : "border-border-subtle text-muted-foreground hover:border-border-strong hover:bg-muted hover:text-foreground",
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </button>
  );
}
