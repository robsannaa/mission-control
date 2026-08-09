"use client";

import { useEffect, useRef } from "react";
import { AtSign, Bot, FileText, Slash } from "lucide-react";
import { cn } from "@/lib/utils";
import type {
  ChatAgent,
  SlashCommand,
  WorkspaceFile,
} from "@/components/chat/types";

/**
 * The `/` and `@` popovers.
 *
 * Both are plain lists driven from outside: the composer owns the active index
 * and the keyboard, so ↑/↓/Enter/Tab/Esc keep working while the caret stays in
 * the textarea. That is the difference between a menu you can use one-handed
 * and one that steals focus every time it opens.
 */

const CATEGORY_LABELS: Record<string, string> = {
  status: "Status",
  session: "Session",
  options: "Options",
  management: "Management",
  tools: "Skills & tools",
  media: "Media",
  docks: "Channel docks",
  other: "Other",
};

function useScrollIntoView(activeIndex: number) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  return listRef;
}

function MenuShell({
  children,
  label,
  footer,
  listRef,
}: {
  children: React.ReactNode;
  label: string;
  footer: React.ReactNode;
  listRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div
      className="absolute bottom-full left-0 right-0 z-40 mb-3 overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl"
      role="dialog"
      aria-label={label}
    >
      <div
        ref={listRef}
        role="listbox"
        aria-label={label}
        className="max-h-[300px] overflow-y-auto p-1.5"
      >
        {children}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {footer}
      </div>
    </div>
  );
}

function Hint({ keys, text }: { keys: string; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <kbd className="rounded border border-border px-1 font-sans text-[10px] text-muted-foreground">
        {keys}
      </kbd>
      {text}
    </span>
  );
}

export function SlashMenu({
  commands,
  grouped,
  activeIndex,
  loading,
  error,
  onSelect,
  onHover,
}: {
  commands: SlashCommand[];
  grouped: boolean;
  activeIndex: number;
  loading: boolean;
  error: string | null;
  onSelect: (command: SlashCommand) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useScrollIntoView(activeIndex);

  let lastCategory = "";
  return (
    <MenuShell
      label="Slash commands"
      listRef={listRef}
      footer={
        <>
          <Hint keys="↑↓" text="navigate" />
          <Hint keys="↵" text="select" />
          <Hint keys="tab" text="complete" />
          <Hint keys="esc" text="dismiss" />
        </>
      }
    >
      {error ? (
        <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
          {error}
        </p>
      ) : loading && commands.length === 0 ? (
        <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
          Loading commands…
        </p>
      ) : commands.length === 0 ? (
        <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
          No command matches that.
        </p>
      ) : (
        commands.map((command, index) => {
          const showHeader = grouped && command.category !== lastCategory;
          lastCategory = command.category;
          const active = index === activeIndex;
          return (
            <div key={`${command.name}-${index}`}>
              {showHeader && (
                <p className="px-2.5 pb-1 pt-2.5 text-[10.5px] uppercase tracking-wider text-muted-foreground">
                  {CATEGORY_LABELS[command.category] ?? command.category}
                </p>
              )}
              <button
                type="button"
                role="option"
                aria-selected={active}
                data-index={index}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onSelect(command);
                }}
                onMouseEnter={() => onHover(index)}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                  active ? "bg-accent" : "hover:bg-accent/60",
                )}
              >
                <Slash
                  className="mt-[3px] h-3 w-3 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[12.5px] text-foreground">
                      {command.trigger}
                    </span>
                    {command.acceptsArgs && (
                      <span className="text-[10.5px] text-muted-foreground">
                        {command.args[0]?.name
                          ? `<${command.args[0].name}>`
                          : "takes arguments"}
                      </span>
                    )}
                    {command.source !== "native" && (
                      <span className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground">
                        {command.source}
                      </span>
                    )}
                  </span>
                  {command.description && (
                    <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-relaxed text-muted-foreground">
                      {command.description}
                    </span>
                  )}
                </span>
              </button>
            </div>
          );
        })
      )}
    </MenuShell>
  );
}

export type MentionItem =
  | { kind: "file"; file: WorkspaceFile }
  | { kind: "agent"; agent: ChatAgent };

export function MentionMenu({
  items,
  activeIndex,
  loading,
  error,
  root,
  onSelect,
  onHover,
}: {
  items: MentionItem[];
  activeIndex: number;
  loading: boolean;
  error: string | null;
  root: string | null;
  onSelect: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const listRef = useScrollIntoView(activeIndex);

  return (
    <MenuShell
      label="Reference a file or agent"
      listRef={listRef}
      footer={
        <>
          <AtSign className="h-3 w-3" aria-hidden />
          <span className="truncate">
            {error ? error : root ? root : "Agent workspace"}
          </span>
        </>
      }
    >
      {items.length === 0 ? (
        <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
          {loading ? "Searching workspace…" : "Nothing matches that."}
        </p>
      ) : (
        items.map((item, index) => {
          const active = index === activeIndex;
          const isFile = item.kind === "file";
          return (
            <button
              key={isFile ? item.file.path : `agent:${item.agent.id}`}
              type="button"
              role="option"
              aria-selected={active}
              data-index={index}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item);
              }}
              onMouseEnter={() => onHover(index)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-1.5 text-left transition-colors",
                active ? "bg-accent" : "hover:bg-accent/60",
              )}
            >
              {isFile ? (
                <FileText
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              ) : (
                <Bot
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] text-foreground">
                  {isFile ? item.file.name : item.agent.name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {isFile
                    ? item.file.dir || "workspace root"
                    : `agent · ${item.agent.model}`}
                </span>
              </span>
            </button>
          );
        })
      )}
    </MenuShell>
  );
}
