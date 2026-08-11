"use client";
/* eslint-disable @next/next/no-img-element */

/**
 * One card on the board.
 *
 * The card subscribes to its own slice of the live stream. That is deliberate: a
 * run pushes steps two or three times a second, and a push must repaint this
 * card only — never the board, never the other columns.
 */

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Pencil,
  Play,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AssigneePicker } from "./assignee-picker";
import { MoveTrace, latestSelfMove } from "./move-trace";
import { Elapsed, RunStrip } from "./run-strip";
import { useTaskRun } from "./run-store";
import {
  isAwaitingUser,
  isRunActive,
  type AgentInfo,
  type Column,
  type DispatchAssignee,
  type Task,
} from "./types";

const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

export function isImageAttachment(path: string): boolean {
  return IMAGE_EXTENSIONS.test(path);
}

export function attachmentUrl(path: string): string {
  const trimmed = path.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `/api/workspace/file?path=${encodeURIComponent(trimmed)}`;
}

/*
 * Colour means "this needs attention". Three priorities in three colours on
 * every card is decoration, not information — the eye has nowhere to land.
 * Only "high" is coloured; medium and low read as ordinary text.
 *
 * Rendered as a small Linear-style priority bar (three vertical bars, filled
 * height by level) rather than a dot — quieter than colour alone, still
 * scannable at a glance.
 */
export const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-danger",
  medium: "bg-muted-foreground/40",
  low: "bg-muted-foreground/25",
};
export const PRIORITY_TEXT: Record<string, string> = {
  high: "text-danger-fg",
  medium: "text-muted-foreground",
  low: "text-muted-foreground",
};

/** Bar heights (in eighths) for the mini priority glyph, low → high. */
const PRIORITY_BARS: Record<string, [boolean, boolean, boolean]> = {
  high: [true, true, true],
  medium: [true, true, false],
  low: [true, false, false],
};

function PriorityGlyph({ priority }: { priority: string }) {
  const bars = PRIORITY_BARS[priority] ?? [true, false, false];
  const tone = priority === "high" ? "bg-danger" : "bg-muted-foreground/50";
  return (
    <span
      className="mt-[3px] flex shrink-0 items-end gap-[1.5px]"
      title={`${priority} priority`}
      aria-hidden="true"
    >
      {bars.map((filled, i) => (
        <span
          key={i}
          className={cn(
            "w-[3px] rounded-[1px]",
            i === 0 ? "h-[5px]" : i === 1 ? "h-[8px]" : "h-[11px]",
            filled ? tone : "bg-muted-foreground/20",
          )}
        />
      ))}
    </span>
  );
}

/** Status as a small colour-coded dot — idle/muted, running/amber, done/green,
 * failed or blocked/red, waiting/blue. This is the one place colour speaks. */
function StatusDot({
  active,
  waiting,
  isDone,
  status,
}: {
  active: boolean;
  waiting: boolean;
  isDone: boolean;
  status: string | undefined;
}) {
  const failed = status === "failed";
  const cancelled = status === "cancelled";
  const tone = failed
    ? "bg-danger"
    : waiting
      ? "bg-info"
      : active
        ? "bg-warning"
        : isDone
          ? "bg-success"
          : cancelled
            ? "bg-muted-foreground/40"
            : "bg-muted-foreground/30";
  return (
    <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
      {active && (
        <span className="absolute inline-flex h-2 w-2 animate-ping rounded-full bg-warning opacity-50" />
      )}
      <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", tone)} />
    </span>
  );
}

export function TaskCard({
  task,
  columns,
  agents,
  onEdit,
  onMove,
  onDelete,
  onOpenDetail,
  onAttachmentClick,
  onDispatch,
  onAssign,
  onStop,
  onAnswer,
  onMarkDone,
  isDispatching,
  isDragging,
  onDragStart,
  onDragEnd,
  isRenaming,
  onStartRename,
  onRename,
}: {
  task: Task;
  columns: Column[];
  agents: AgentInfo[];
  onEdit: () => void;
  onMove: (dir: "left" | "right") => void;
  onDelete: () => void;
  onOpenDetail?: () => void;
  onAttachmentClick?: (url: string) => void;
  onDispatch?: () => void;
  onAssign?: (next: { agentId?: string; assignee: DispatchAssignee }) => void;
  onStop?: () => void;
  onAnswer?: () => void;
  onMarkDone?: () => void;
  isDispatching?: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  isRenaming: boolean;
  onStartRename: () => void;
  onRename: (title: string) => void;
}) {
  const colIdx = columns.findIndex((c) => c.id === task.column);
  const canLeft = colIdx > 0;
  const canRight = colIdx < columns.length - 1;
  const [renameValue, setRenameValue] = useState(task.title);
  const renameRef = useRef<HTMLInputElement>(null);

  // One push-driven subscription per card. No polling, no per-card timers.
  const snapshot = useTaskRun(task.id);

  const status = snapshot?.status ?? task.dispatchStatus;
  const active = isRunActive(status);
  const waiting = isAwaitingUser(status);
  // While a run is live, reflect the assignee that is actually running; when the
  // card is idle, reflect the user's saved choice so the picker doesn't snap
  // back to whatever last ran (which made "main" un-selectable after a subagent
  // run, and vice-versa).
  const assignee: DispatchAssignee = active
    ? snapshot?.assignee ?? task.dispatchAssignee ?? "agent"
    : task.dispatchAssignee ?? snapshot?.assignee ?? "agent";
  // A finished task is a record, not a queue item — reassigning it would imply
  // it can be re-run in place, which it can't without being reopened first.
  const isDone = status === "completed" || task.column === "done";
  const startedAt = snapshot?.startedAt ?? task.dispatchedAt ?? null;
  const selfMove = latestSelfMove(snapshot?.transitions ?? task.dispatchTransitions);

  useEffect(() => {
    if (isRenaming) {
      queueMicrotask(() => setRenameValue(task.title));
      setTimeout(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      }, 0);
    }
  }, [isRenaming, task.title]);

  /*
   * The title advertises "double-click to rename", but the card opens its
   * detail dialog on click — so the first of the two clicks used to open the
   * dialog and the rename never happened. Opening from the title is therefore
   * held for a moment and cancelled if a second click arrives.
   */
  const openTimer = useRef<number | null>(null);
  const cancelPendingOpen = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };
  useEffect(() => cancelPendingOpen, []);

  const showRunButton =
    Boolean(task.agentId) && !active && !waiting && (!status || status === "idle");

  return (
    <div
      className={cn(
        "group min-w-0 rounded-lg border border-border-subtle bg-card px-3 py-2.5 transition-colors hover:bg-muted/40",
        isDragging && "opacity-40 scale-95",
        // A working card is visibly distinct from a resting one at a glance —
        // a quiet border tint, not a colour change that would compete with priority.
        active && "border-warning-border/60",
        waiting && "border-info-border/60",
        !isRenaming && "cursor-grab active:cursor-grabbing",
      )}
      draggable={!isRenaming}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(task.id));
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onClick={() => !isRenaming && onOpenDetail?.()}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (!isRenaming && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpenDetail?.();
        }
      }}
    >
      <div className="flex min-w-0 items-start gap-2">
        <GripVertical className="mt-[3px] h-3 w-3 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-70" />
        <StatusDot active={active} waiting={waiting} isDone={isDone} status={status} />
        <PriorityGlyph priority={task.priority} />
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <input
              ref={renameRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRename(renameValue.trim() || task.title);
                if (e.key === "Escape") onRename(task.title);
              }}
              onBlur={() => onRename(renameValue.trim() || task.title)}
              className="w-full bg-transparent text-[13px] font-medium text-foreground outline-none border-b border-border-strong pb-0.5"
            />
          ) : (
            <p
              className="break-words text-[13px] font-medium leading-snug text-foreground"
              onClick={(e) => {
                e.stopPropagation();
                cancelPendingOpen();
                openTimer.current = window.setTimeout(() => {
                  openTimer.current = null;
                  onOpenDetail?.();
                }, 220);
              }}
              onDoubleClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                cancelPendingOpen();
                onStartRename();
              }}
              title="Double-click to rename"
            >
              {task.title}
            </p>
          )}
          {task.description && !isRenaming && (
            <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-fg-secondary">
              {task.description}
            </p>
          )}
          {task.attachments &&
            task.attachments.length > 0 &&
            isImageAttachment(task.attachments[0]) &&
            !isRenaming && (
              <div className="mt-2 flex gap-1.5 overflow-x-auto pb-0.5">
                {task.attachments
                  .filter(isImageAttachment)
                  .slice(0, 3)
                  .map((path, i) => (
                    <button
                      key={`${path}-${i}`}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAttachmentClick?.(attachmentUrl(path));
                      }}
                      className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border-subtle bg-muted/50 object-cover transition-opacity hover:opacity-90 focus:ring-2 focus:ring-border-strong"
                    >
                      <img
                        src={attachmentUrl(path)}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    </button>
                  ))}
                {task.attachments.filter(isImageAttachment).length > 3 && (
                  <span className="flex h-14 shrink-0 items-center rounded-md bg-muted/50 px-2 text-xs text-muted-foreground">
                    +{task.attachments.filter(isImageAttachment).length - 3}
                  </span>
                )}
              </div>
            )}

          {/*
            Meta row. Every child either shrinks or truncates: this row used to
            push "High · main · Done" past the card's edge and get clipped. The
            status that used to sit on the end is gone — the column already says
            it, and anything the column does not say is in the run strip below.
          */}
          <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {task.assignee && (
              <span className="min-w-0 max-w-[10rem] truncate text-fg-subtle">
                {task.assignee}
              </span>
            )}
            <span
              className="min-w-0 max-w-full"
              onDragStart={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <AssigneePicker
                agents={agents}
                agentId={task.agentId}
                assignee={assignee}
                disabled={active || isDone || !onAssign}
                lockedReason={
                  isDone
                    ? "This task is done. Reopen it to run it again."
                    : active
                      ? "Running — you can't reassign it mid-run."
                      : undefined
                }
                onChange={(next) => onAssign?.(next)}
              />
            </span>
            {showRunButton && (
              <button
                type="button"
                disabled={isDispatching}
                onClick={(e) => {
                  e.stopPropagation();
                  onDispatch?.();
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border-subtle px-1.5 py-0.5 text-[11px] font-medium text-fg-subtle transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <Play className="h-3 w-3" />
                {isDispatching ? "Starting…" : "Run"}
              </button>
            )}
          </div>
        </div>
        {active && startedAt && (
          <span
            className="mt-0.5 flex shrink-0 items-center gap-1 text-[11px] font-medium text-warning-fg tabular-nums"
            title="An agent is working on this right now"
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
            <Elapsed since={startedAt} />
          </span>
        )}
      </div>

      <RunStrip
        task={task}
        snapshot={snapshot}
        assignee={assignee}
        busy={isDispatching}
        onStop={() => onStop?.()}
        onRun={() => onDispatch?.()}
        onOpen={onOpenDetail}
        onAnswer={() => onAnswer?.()}
        onMarkDone={() => onMarkDone?.()}
      />

      {/* Why this card is where it is — only while the move is still news. */}
      <MoveTrace transition={selfMove} columns={columns} className="mt-2" />

      {/* Action bar -- visible on hover */}
      <div
        className="mt-2 flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          disabled={!canLeft}
          onClick={() => onMove("left")}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted/40 hover:text-fg-secondary disabled:opacity-30"
          title="Move left"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!canRight}
          onClick={() => onMove("right")}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted/40 hover:text-fg-secondary disabled:opacity-30"
          title="Move right"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onEdit}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary"
          title="Edit"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg"
          title="Delete"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
