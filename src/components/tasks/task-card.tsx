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
import { RunStrip } from "./run-strip";
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

  const assignee: DispatchAssignee =
    snapshot?.assignee ?? task.dispatchAssignee ?? "agent";
  const status = snapshot?.status ?? task.dispatchStatus;
  const active = isRunActive(status);
  const waiting = isAwaitingUser(status);
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
        "group min-w-0 rounded-xl border border-foreground/10 bg-card p-3.5 shadow-sm transition-all hover:border-foreground/15 hover:shadow-md",
        isDragging && "opacity-40 scale-95",
        // A working card is visibly distinct from a resting one at a glance —
        // one quiet lift, not a colour change that would compete with priority.
        active && "border-border-strong shadow-md ring-1 ring-inset ring-border-subtle",
        waiting && "border-border-strong",
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
        <GripVertical className="mt-1 h-3.5 w-3.5 shrink-0 text-fg-subtle transition-colors group-hover:text-fg-subtle" />
        <div
          className={cn(
            "mt-1.5 h-2 w-2 shrink-0 rounded-full",
            PRIORITY_COLORS[task.priority] || "bg-muted-foreground",
          )}
        />
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
              className="w-full bg-transparent text-sm font-medium text-foreground outline-none border-b border-border-strong pb-0.5"
            />
          ) : (
            <p
              className="break-words text-sm font-medium text-foreground"
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
            <p className="mt-1 line-clamp-2 break-words text-xs leading-5 text-muted-foreground">
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
                      className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-foreground/10 bg-muted/50 object-cover transition-opacity hover:opacity-90 focus:ring-2 focus:ring-border-strong"
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
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
            <span
              className={cn(
                "shrink-0 font-medium capitalize",
                PRIORITY_TEXT[task.priority] || "text-muted-foreground",
              )}
            >
              {task.priority}
            </span>
            {task.assignee && (
              <>
                <span className="shrink-0 text-fg-subtle">&bull;</span>
                <span className="min-w-0 max-w-[10rem] truncate text-muted-foreground">
                  {task.assignee}
                </span>
              </>
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
                disabled={active || !onAssign}
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
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border-subtle px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                <Play className="h-3 w-3" />
                {isDispatching ? "Starting…" : "Run"}
              </button>
            )}
          </div>
        </div>
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
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary disabled:opacity-30"
          title="Move left"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!canRight}
          onClick={() => onMove("right")}
          className="rounded p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-fg-secondary disabled:opacity-30"
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
