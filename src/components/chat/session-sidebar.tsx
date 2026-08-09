"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Search,
  ShieldQuestion,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { rank } from "@/components/chat/fuzzy";
import type { ChatSessionRow, LoadFailure } from "@/components/chat/types";

/**
 * Conversation list.
 *
 * Every state is distinct on purpose. "The gateway is unreachable", "this
 * browser needs pairing approval" and "you have not started a conversation
 * yet" are three different facts, and rendering the same empty list for all
 * three is a lie the user acts on.
 */

function relativeTime(value: number): string {
  if (!value) return "";
  const diff = Date.now() - value;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(value).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

function StateBlock({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-3 py-8 text-center">
      <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-full border border-border text-muted-foreground">
        {icon}
      </div>
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[220px] text-[12px] leading-relaxed text-muted-foreground">
        {body}
      </p>
      {action ? <div className="mt-3.5">{action}</div> : null}
    </div>
  );
}

function RowMenu({
  row,
  onRename,
  onTogglePin,
  onDelete,
}: {
  row: ChatSessionRow;
  onRename: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={`Options for ${row.title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground transition-colors",
          "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          open ? "opacity-100" : "opacity-0 group-hover/row:opacity-100 focus:opacity-100",
        )}
      >
        <MoreHorizontal className="h-3.5 w-3.5" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-7 z-30 w-40 overflow-hidden rounded-2xl border border-border bg-popover p-1 shadow-xl"
        >
          <button
            role="menuitem"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onRename();
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] text-foreground transition-colors hover:bg-accent"
          >
            <Pencil className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            Rename
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onTogglePin();
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] text-foreground transition-colors hover:bg-accent"
          >
            {row.pinned ? (
              <PinOff className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            ) : (
              <Pin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
            )}
            {row.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] text-danger-fg transition-colors hover:bg-danger-bg"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

function SessionRow({
  row,
  isActive,
  onSelect,
  onRename,
  onTogglePin,
  onDelete,
}: {
  row: ChatSessionRow;
  isActive: boolean;
  onSelect: () => void;
  onRename: (label: string) => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  // `editing` carries the draft, so entering edit mode and seeding the field
  // happen in the same state update — no effect, no flash of stale text.
  const [editing, setEditing] = useState<string | null>(null);

  const commit = () => {
    const next = (editing ?? "").trim();
    setEditing(null);
    if (next && next !== row.title) onRename(next);
  };

  if (editing !== null) {
    return (
      <div className="rounded-xl bg-accent px-2.5 py-2">
        <input
          autoFocus
          ref={(node) => node?.select()}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEditing(null);
            }
          }}
          aria-label="Conversation name"
          className="w-full bg-transparent text-[13px] text-foreground outline-none"
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        "group/row relative flex items-center gap-2 rounded-xl px-2.5 py-2 transition-colors",
        isActive ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={isActive ? "true" : undefined}
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded-lg"
      >
        <span className="flex items-center gap-1.5">
          {row.pinned && (
            <Pin className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          )}
          {row.unread && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground"
              aria-label="Unread"
            />
          )}
          <span
            className={cn(
              "truncate text-[13px]",
              isActive ? "text-foreground" : "text-foreground/90",
              row.titleSource !== "label" && "font-normal",
            )}
            title={row.title}
          >
            {row.title}
          </span>
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          {row.hasActiveRun && (
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />
              running
            </span>
          )}
          <span>{relativeTime(row.updatedAt)}</span>
        </span>
      </button>
      <RowMenu
        row={row}
        onRename={() => setEditing(row.title)}
        onTogglePin={onTogglePin}
        onDelete={onDelete}
      />
    </div>
  );
}

export function SessionSidebar({
  sessions,
  activeKey,
  failure,
  loaded,
  onSelect,
  onNewChat,
  onRename,
  onTogglePin,
  onDelete,
  onRetry,
  onClose,
}: {
  sessions: ChatSessionRow[];
  activeKey: string | null;
  failure: LoadFailure;
  loaded: boolean;
  onSelect: (row: ChatSessionRow) => void;
  onNewChat: () => void;
  onRename: (key: string, label: string) => void;
  onTogglePin: (key: string, pinned: boolean) => void;
  onDelete: (key: string) => void;
  onRetry: () => void;
  onClose?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = useMemo(
    () => rank(sessions, query.trim(), (row) => [row.title, row.preview ?? ""], 60),
    [sessions, query],
  );
  const pinned = filtered.filter((row) => row.pinned);
  const rest = filtered.filter((row) => !row.pinned);

  const retryButton = (
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <RefreshCw className="h-3 w-3" aria-hidden />
      Try again
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <h2 className="flex-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          Conversations
        </h2>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close conversation list"
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={onNewChat}
          data-testid="chat-new"
          className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-foreground transition-colors hover:border-border-strong hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          New
        </button>
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 focus-within:border-border-strong">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="w-full bg-transparent text-[12.5px] text-foreground outline-none placeholder:text-fg-placeholder"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {failure.kind === "pairing" ? (
          <StateBlock
            icon={<ShieldQuestion className="h-4 w-4" aria-hidden />}
            title="Pairing required"
            body="This browser is not approved yet. Approve the pending device request, then reload."
            action={retryButton}
          />
        ) : failure.kind !== "none" ? (
          <StateBlock
            icon={<AlertTriangle className="h-4 w-4" aria-hidden />}
            title="Gateway unreachable"
            body={
              failure.detail ??
              "Your conversations are safe — Mission Control just cannot read them right now."
            }
            action={retryButton}
          />
        ) : !loaded ? (
          <div className="space-y-1.5 px-1 pt-2" aria-hidden>
            {[0, 1, 2, 3, 4].map((index) => (
              <div
                key={index}
                className="h-11 animate-pulse rounded-xl bg-muted"
                style={{ animationDelay: `${index * 80}ms` }}
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          query ? (
            <StateBlock
              icon={<Search className="h-4 w-4" aria-hidden />}
              title="No matches"
              body={`Nothing here matches “${query}”.`}
            />
          ) : (
            <StateBlock
              icon={<Plus className="h-4 w-4" aria-hidden />}
              title="No conversations yet"
              body="Send your first message and it will appear here, ready to resume."
            />
          )
        ) : (
          <div className="space-y-0.5">
            {pinned.length > 0 && (
              <>
                <p className="px-2.5 pb-1 pt-2 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                  Pinned
                </p>
                {pinned.map((row) => (
                  <SessionRow
                    key={row.key}
                    row={row}
                    isActive={row.key === activeKey}
                    onSelect={() => onSelect(row)}
                    onRename={(label) => onRename(row.key, label)}
                    onTogglePin={() => onTogglePin(row.key, !row.pinned)}
                    onDelete={() => setConfirmDelete(row.key)}
                  />
                ))}
              </>
            )}
            {rest.length > 0 && pinned.length > 0 && (
              <p className="px-2.5 pb-1 pt-3 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                Recent
              </p>
            )}
            {rest.map((row) => (
              <SessionRow
                key={row.key}
                row={row}
                isActive={row.key === activeKey}
                onSelect={() => onSelect(row)}
                onRename={(label) => onRename(row.key, label)}
                onTogglePin={() => onTogglePin(row.key, !row.pinned)}
                onDelete={() => setConfirmDelete(row.key)}
              />
            ))}
          </div>
        )}
      </div>

      {confirmDelete && (
        <div className="border-t border-border bg-card px-3 py-3">
          <p className="text-[12.5px] text-foreground">Delete this conversation?</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
            The transcript is removed from the gateway. This cannot be undone.
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => {
                onDelete(confirmDelete);
                setConfirmDelete(null);
              }}
              className="inline-flex items-center gap-1.5 rounded-full bg-danger px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Check className="h-3 w-3" aria-hidden />
              Delete
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(null)}
              className="rounded-full border border-border px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
