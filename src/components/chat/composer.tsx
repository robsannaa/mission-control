"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import {
  Activity,
  ArrowUp,
  AtSign,
  Clock,
  FileText,
  Paperclip,
  Slash,
  Sparkles,
  Square,
  Wrench,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { rank } from "@/components/chat/fuzzy";
import {
  MentionMenu,
  SlashMenu,
  type MentionItem,
} from "@/components/chat/composer-menus";
import type {
  ChatAgent,
  Mention,
  SlashCommand,
} from "@/components/chat/types";
import { INSERT_COMMAND_EVENT } from "@/components/chat/entity-pill";
import { useSlashCommands } from "@/hooks/use-slash-commands";
import { useWorkspaceFiles } from "@/hooks/use-workspace-files";

/**
 * The composer.
 *
 * A floating card rather than a bar welded to the window edge: heavy radius,
 * hairline border, one soft shadow, and no inner input frame — the card is the
 * frame. Starter chips break the top edge, the controls sit as quiet inline
 * text along the bottom, and the send affordance is the single solid circle in
 * the whole screen.
 */

export type ComposerSubmission = {
  text: string;
  files: File[];
  mentions: Mention[];
  workspaceRoot: string | null;
};

type Trigger =
  | { kind: "none" }
  | { kind: "slash"; start: number; query: string }
  | { kind: "mention"; start: number; query: string };

/** Paths with spaces are quoted so a token stays a single word. */
function mentionToken(value: string): string {
  return /\s/.test(value) ? `@"${value}"` : `@${value}`;
}

function detectTrigger(value: string, caret: number): Trigger {
  const before = value.slice(0, caret);

  // Slash commands are only commands at the very start of a message — that is
  // the gateway's own rule ("must be sent as the only content in the message"),
  // so offering the menu mid-sentence would promise something that silently
  // becomes prose.
  const slashMatch = /^\/([^\s]*)$/.exec(before);
  if (slashMatch) return { kind: "slash", start: 0, query: slashMatch[1] };

  const at = before.lastIndexOf("@");
  if (at >= 0) {
    const preceding = at === 0 ? "" : before[at - 1];
    const isBoundary = at === 0 || /\s/.test(preceding);
    const query = before.slice(at + 1);
    if (isBoundary && !/\s/.test(query) && query.length <= 80) {
      return { kind: "mention", start: at, query };
    }
  }
  return { kind: "none" };
}

const STARTERS: Array<{
  label: string;
  icon: typeof Sparkles;
  value: string;
}> = [
  { label: "What can you do?", icon: Sparkles, value: "What can you do?" },
  { label: "Status", icon: Activity, value: "/status" },
  { label: "Tools", icon: Wrench, value: "/tools" },
  { label: "Today's activity", icon: Clock, value: "What did you do today?" },
];

export function Composer({
  agentId,
  agentName,
  agents,
  modelLabel,
  contextLabel,
  disabled,
  disabledPlaceholder,
  isStreaming,
  showStarters,
  onSubmit,
  onCommand,
  onStop,
  onSwitchAgent,
}: {
  agentId: string;
  agentName: string;
  agents: ChatAgent[];
  modelLabel: string;
  contextLabel: string | null;
  disabled: boolean;
  disabledPlaceholder?: string;
  isStreaming: boolean;
  showStarters: boolean;
  onSubmit: (submission: ComposerSubmission) => void;
  onCommand: (command: string) => void;
  onStop: () => void;
  onSwitchAgent: (id: string) => void;
}) {
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState(0);
  const [files, setFiles] = useState<File[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);

  const trigger = useMemo(() => detectTrigger(value, caret), [value, caret]);
  const suppressed = dismissedAt !== null && trigger.kind !== "none"
    ? dismissedAt === trigger.start
    : false;

  const slashOpen = trigger.kind === "slash" && !suppressed && !disabled;
  const mentionOpen = trigger.kind === "mention" && !suppressed && !disabled;

  const { commands, loading: commandsLoading, error: commandsError } =
    useSlashCommands(true);
  const {
    setQuery: setFileQuery,
    files: workspaceFiles,
    root: workspaceRoot,
    loading: filesLoading,
    error: filesError,
  } = useWorkspaceFiles(agentId, mentionOpen);

  useEffect(() => {
    if (mentionOpen && trigger.kind === "mention") setFileQuery(trigger.query);
  }, [mentionOpen, trigger, setFileQuery]);

  /* ── Menu contents ─────────────────────────────────────────────────────── */

  const slashQuery = trigger.kind === "slash" ? trigger.query : "";
  const filteredCommands = useMemo(() => {
    if (!slashQuery) {
      // Unfiltered, the menu is grouped by the gateway's own categories.
      return [...commands].sort((a, b) =>
        a.category === b.category
          ? a.name.localeCompare(b.name)
          : a.category.localeCompare(b.category),
      );
    }
    return rank(
      commands,
      slashQuery,
      (command) => [command.name, command.trigger, ...command.aliases],
      40,
    );
  }, [commands, slashQuery]);

  const mentionItems = useMemo<MentionItem[]>(() => {
    if (trigger.kind !== "mention") return [];
    const query = trigger.query.toLowerCase();
    const agentMatches = rank(
      agents,
      query,
      (agent) => [agent.id, agent.name],
      4,
    ).map((agent): MentionItem => ({ kind: "agent", agent }));
    const fileMatches = workspaceFiles
      .slice(0, 40)
      .map((file): MentionItem => ({ kind: "file", file }));
    // Files first: `@` is overwhelmingly about context, agents are the rarer
    // case, so they sit at the end where they cannot steal Enter.
    return [...fileMatches, ...agentMatches];
  }, [agents, trigger, workspaceFiles]);

  /* ── Text handling ─────────────────────────────────────────────────────── */

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    // A two-line resting height: the input should read as a place to write,
    // not as a single-line search field.
    node.style.height = `${Math.min(Math.max(node.scrollHeight, 56), 220)}px`;
  }, []);

  useEffect(() => {
    resize();
  }, [value, resize]);

  const syncCaret = useCallback(() => {
    const node = textareaRef.current;
    if (node) setCaret(node.selectionStart ?? 0);
  }, []);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      setValue(next);
      setCaret(event.target.selectionStart ?? next.length);
      setDismissedAt(null);
      // Every keystroke re-filters the menu, so the highlight goes back to the
      // best match. Resetting here (rather than in an effect) keeps the index
      // and the list in the same render.
      setActiveIndex(0);
      // A chip only means something while its token is still in the text.
      setMentions((current) =>
        current.filter((mention) => next.includes(mention.token)),
      );
    },
    [],
  );

  const replaceTrigger = useCallback(
    (start: number, end: number, insert: string, caretOffset?: number) => {
      const next = `${value.slice(0, start)}${insert}${value.slice(end)}`;
      setValue(next);
      const position = start + (caretOffset ?? insert.length);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(position, position);
        setCaret(position);
      });
    },
    [value],
  );

  const applyCommand = useCallback(
    (command: SlashCommand, keepOpen: boolean) => {
      if (trigger.kind !== "slash") return;
      // Measure the leading token now — never trust a range captured earlier.
      const leading = /^\/[^\s]*/.exec(value);
      const end = leading ? leading[0].length : 0;
      // acceptsArgs → leave a trailing space so the caret is already where the
      // argument goes; otherwise the command is complete as typed.
      const insert = command.acceptsArgs
        ? `${command.trigger} `
        : command.trigger;
      replaceTrigger(trigger.start, end, insert);
      if (!keepOpen) setDismissedAt(trigger.start);
    },
    [replaceTrigger, trigger, value],
  );

  const applyMention = useCallback(
    (item: MentionItem) => {
      if (trigger.kind !== "mention") return;
      const end = trigger.start + 1 + trigger.query.length;
      const mention: Mention =
        item.kind === "file"
          ? {
              kind: "file",
              token: mentionToken(item.file.path),
              path: item.file.path,
              name: item.file.name,
            }
          : {
              kind: "agent",
              token: mentionToken(item.agent.id),
              id: item.agent.id,
              name: item.agent.name,
            };
      replaceTrigger(trigger.start, end, `${mention.token} `);
      setMentions((current) =>
        current.some((entry) => entry.token === mention.token)
          ? current
          : [...current, mention],
      );
      setDismissedAt(null);
    },
    [replaceTrigger, trigger],
  );

  /**
   * The footer affordances are real controls: they put the trigger character
   * into the composer and focus it, which is exactly what typing "/" or "@"
   * does — so the same menu opens by the same code path.
   */
  // A command pill in a reply loads that command into the composer, so the
  // user can review or add arguments before sending rather than firing blind.
  useEffect(() => {
    const onInsert = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (typeof command !== "string" || !command.startsWith("/")) return;
      const next = `${command} `;
      setValue(next);
      setDismissedAt(0);
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(next.length, next.length);
        setCaret(next.length);
      });
    };
    window.addEventListener(INSERT_COMMAND_EVENT, onInsert);
    return () => window.removeEventListener(INSERT_COMMAND_EVENT, onInsert);
  }, []);

  const openCommandMenu = useCallback(() => {
    const next = value.startsWith("/") ? value : `/${value}`;
    setValue(next);
    setDismissedAt(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      const position = 1;
      node.setSelectionRange(position, position);
      setCaret(position);
    });
  }, [value]);

  const openFileMenu = useCallback(() => {
    const needsSpace = value.length > 0 && !/\s$/.test(value);
    const next = `${value}${needsSpace ? " " : ""}@`;
    setValue(next);
    setDismissedAt(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus();
      node.setSelectionRange(next.length, next.length);
      setCaret(next.length);
    });
  }, [value]);

  const removeMention = useCallback((token: string) => {
    setMentions((current) => current.filter((entry) => entry.token !== token));
    setValue((current) => current.replace(token, "").replace(/ {2,}/g, " "));
  }, []);

  /* ── Sending ───────────────────────────────────────────────────────────── */

  const canSend = (value.trim().length > 0 || files.length > 0) && !disabled;

  const submit = useCallback(() => {
    if (!canSend || isStreaming) return;
    const text = value.trim();
    setValue("");
    setFiles([]);
    setMentions([]);
    setDismissedAt(null);
    setCaret(0);
    requestAnimationFrame(resize);

    if (text.startsWith("/") && files.length === 0) {
      onCommand(text);
      return;
    }
    onSubmit({ text, files, mentions, workspaceRoot });
  }, [
    canSend,
    files,
    isStreaming,
    mentions,
    onCommand,
    onSubmit,
    resize,
    value,
    workspaceRoot,
  ]);

  const menuLength = slashOpen
    ? filteredCommands.length
    : mentionOpen
      ? mentionItems.length
      : 0;
  // Async results (workspace search) can shrink the list under the highlight.
  const safeIndex = menuLength > 0 ? Math.min(activeIndex, menuLength - 1) : 0;

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const menuIsOpen = (slashOpen || mentionOpen) && menuLength > 0;

      if (menuIsOpen) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setActiveIndex((index) => (index + 1) % menuLength);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setActiveIndex((index) => (index - 1 + menuLength) % menuLength);
          return;
        }
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          if (slashOpen) applyCommand(filteredCommands[safeIndex], false);
          else applyMention(mentionItems[safeIndex]);
          return;
        }
        if (event.key === "Tab") {
          event.preventDefault();
          // Tab completes but leaves the menu alive so the next keystroke keeps
          // narrowing — the behaviour a shell trains people to expect.
          if (slashOpen) applyCommand(filteredCommands[safeIndex], true);
          else applyMention(mentionItems[safeIndex]);
          return;
        }
      }

      if (event.key === "Escape") {
        if (menuIsOpen) {
          event.preventDefault();
          event.stopPropagation();
          setDismissedAt(trigger.start);
          return;
        }
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        submit();
      }
    },
    [
      safeIndex,
      applyCommand,
      applyMention,
      filteredCommands,
      mentionItems,
      menuLength,
      mentionOpen,
      slashOpen,
      submit,
      trigger,
    ],
  );

  /* ── Attachments ───────────────────────────────────────────────────────── */

  const addFiles = useCallback((incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length) setFiles((current) => [...current, ...list]);
  }, []);

  useEffect(() => {
    if (!agentMenuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(event.target as Node)) {
        setAgentMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [agentMenuOpen]);

  /* ── Render ────────────────────────────────────────────────────────────── */

  const placeholder = disabled
    ? disabledPlaceholder ?? "Chat is unavailable right now"
    : `Message ${agentName} — press / for commands, @ to reference a file`;

  return (
    <div className="relative mx-auto w-full max-w-3xl">
      {showStarters && !value && (
        <div className="relative z-10 -mb-4 flex flex-wrap items-center justify-center gap-2 px-6">
          {STARTERS.map((starter) => {
            const Icon = starter.icon;
            return (
              <button
                key={starter.label}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (starter.value.startsWith("/")) onCommand(starter.value);
                  else
                    onSubmit({
                      text: starter.value,
                      files: [],
                      mentions: [],
                      workspaceRoot,
                    });
                }}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-[12px] text-muted-foreground shadow-sm transition-colors",
                  "hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                )}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden />
                {starter.label}
              </button>
            );
          })}
        </div>
      )}

      <div
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files?.length) addFiles(event.dataTransfer.files);
        }}
        className={cn(
          "relative rounded-3xl border bg-card px-4 pb-3 pt-3.5 shadow-[0_24px_70px_-28px_rgba(0,0,0,0.6)] transition-colors",
          dragging ? "border-border-accent" : "border-border",
        )}
      >
        {slashOpen && (
          <SlashMenu
            commands={filteredCommands}
            grouped={!slashQuery}
            activeIndex={safeIndex}
            loading={commandsLoading}
            error={commandsError}
            onSelect={(command) => applyCommand(command, false)}
            onHover={setActiveIndex}
          />
        )}
        {mentionOpen && (
          <MentionMenu
            items={mentionItems}
            activeIndex={safeIndex}
            loading={filesLoading}
            error={filesError}
            root={workspaceRoot}
            onSelect={applyMention}
            onHover={setActiveIndex}
          />
        )}

        {(mentions.length > 0 || files.length > 0) && (
          <div className="mb-2 flex flex-wrap gap-1.5 px-0.5">
            {mentions.map((mention) => (
              <span
                key={mention.token}
                className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-border bg-muted py-1 pl-2.5 pr-1.5 text-[11.5px] text-foreground"
              >
                {mention.kind === "file" ? (
                  <FileText className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  <AtSign className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                )}
                <span className="truncate">
                  {mention.kind === "file" ? mention.path : mention.name}
                </span>
                <button
                  type="button"
                  onClick={() => removeMention(mention.token)}
                  aria-label={`Remove reference ${mention.kind === "file" ? mention.path : mention.name}`}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
            {files.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                className="inline-flex max-w-[240px] items-center gap-1.5 rounded-full border border-border bg-muted py-1 pl-2.5 pr-1.5 text-[11.5px] text-foreground"
              >
                <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate">{file.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setFiles((current) => current.filter((_, i) => i !== index))
                  }
                  aria-label={`Remove attachment ${file.name}`}
                  className="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </span>
            ))}
          </div>
        )}

        <label htmlFor="chat-composer-input" className="sr-only">
          Message {agentName}
        </label>
        <textarea
          id="chat-composer-input"
          data-testid="chat-input"
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          rows={1}
          disabled={disabled}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={slashOpen || mentionOpen}
          className={cn(
            "max-h-[220px] w-full resize-none bg-transparent px-1 pb-1 pt-0.5 text-[15px] leading-7 text-foreground outline-none",
            "placeholder:text-fg-placeholder disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.target.files?.length) addFiles(event.target.files);
            event.target.value = "";
          }}
        />

        <div className="flex items-end justify-between gap-3 px-0.5 pt-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled}
              className="inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              Attach
            </button>

            {agents.length > 1 ? (
              <div ref={agentMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setAgentMenuOpen((open) => !open)}
                  aria-haspopup="menu"
                  aria-expanded={agentMenuOpen}
                  className="inline-flex items-center gap-1.5 rounded-full px-1 py-0.5 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {agentName}
                </button>
                {agentMenuOpen && (
                  <div
                    role="menu"
                    className="absolute bottom-7 left-0 z-40 w-52 overflow-hidden rounded-2xl border border-border bg-popover p-1 shadow-xl"
                  >
                    {agents.map((agent) => (
                      <button
                        key={agent.id}
                        role="menuitemradio"
                        aria-checked={agent.id === agentId}
                        type="button"
                        onClick={() => {
                          setAgentMenuOpen(false);
                          onSwitchAgent(agent.id);
                        }}
                        className={cn(
                          "flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12.5px] transition-colors hover:bg-accent",
                          agent.id === agentId ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        <span className="truncate">{agent.name}</span>
                        <span className="shrink-0 text-[10.5px] text-muted-foreground">
                          {agent.model.split("/").pop()}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span className="truncate">{agentName}</span>
            )}

            {modelLabel && <span className="truncate">{modelLabel}</span>}

            <button
              type="button"
              onClick={openCommandMenu}
              disabled={disabled}
              className="hidden items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 sm:inline-flex"
            >
              <span className="font-mono text-[13px] leading-none" aria-hidden>
                /
              </span>
              commands
            </button>
            <button
              type="button"
              onClick={openFileMenu}
              disabled={disabled}
              className="hidden items-center gap-1.5 rounded-full px-2 py-1 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 sm:inline-flex"
            >
              <AtSign className="h-3 w-3" aria-hidden />
              files
            </button>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            {contextLabel && (
              <span className="hidden text-[11.5px] text-muted-foreground sm:inline">
                {contextLabel}
              </span>
            )}
            {isStreaming ? (
              <button
                type="button"
                onClick={onStop}
                aria-label="Stop generating"
                data-testid="chat-stop"
                className="flex h-10 w-10 items-center justify-center rounded-full border border-border-strong text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                aria-label="Send message"
                data-testid="chat-send"
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  canSend
                    ? "bg-primary text-primary-foreground hover:opacity-90"
                    : "bg-muted text-fg-placeholder",
                )}
              >
                <ArrowUp className="h-[18px] w-[18px]" aria-hidden />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
