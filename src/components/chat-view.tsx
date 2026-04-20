"use client";
/* eslint-disable @next/next/no-img-element */

import {
  useEffect,
  useState,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import {
  Send,
  User,
  RefreshCw,
  Cpu,
  Trash2,
  Paperclip,
  X,
  KeyRound,
  ArrowRight,
  ChevronRight,
  Wrench,
  Users,
  Check,
  Loader2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { TypingDots } from "@/components/typing-dots";
import { cn } from "@/lib/utils";
import { addUnread, clearUnread, setChatActive } from "@/lib/chat-store";
import {
  getTimeFormatServerSnapshot,
  getTimeFormatSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";

/* ── types ─────────────────────────────────────── */

type Agent = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  isDefault: boolean;
  workspace: string;
  sessionCount: number;
  lastActive: number | null;
};

type ChatBootstrapResponse = {
  agents?: Agent[];
  models?: Array<{ key?: string; name?: string }>;
  connectedProviders?: Array<{ id: string; name: string }>;
};

/* ── Agent display helpers ──────────────────────── */

/** Show a friendly display name: use agent name, but if it's just the raw ID, show model instead */
function agentDisplayName(agent: Agent): string {
  if (agent.name && agent.name !== agent.id) return agent.name;
  return formatModel(agent.model);
}

function formatTime(d: Date | undefined, timeFormat: TimeFormatPreference) {
  if (!d) return "";
  return d.toLocaleTimeString(
    "en-US",
    withTimeFormat({ hour: "numeric", minute: "2-digit" }, timeFormat),
  );
}

function formatModel(model: string) {
  const parts = model.split("/");
  return parts[parts.length - 1] || model;
}


function createChatSessionKey(agentId: string) {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `agent:${agentId}:mission-control:${suffix}`;
}

// ── Per-agent localStorage persistence ─────────────
const CHAT_SESSION_LS = (id: string) => `openclaw-session:${id}`;
const CHAT_MSGS_LS = (id: string) => `openclaw-msgs:${id}`;
const CHAT_MSGS_MAX = 100;
const CHAT_MSG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function loadStoredSessionKey(agentId: string): string {
  if (typeof window === "undefined") return "";
  try {
    const s = localStorage.getItem(CHAT_SESSION_LS(agentId));
    if (s && s.startsWith(`agent:${agentId}:mission-control:`)) return s;
  } catch { /* localStorage unavailable */ }
  const k = createChatSessionKey(agentId);
  try { localStorage.setItem(CHAT_SESSION_LS(agentId), k); } catch { /* ignore */ }
  return k;
}

function loadStoredMessages(agentId: string): unknown[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CHAT_MSGS_LS(agentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - CHAT_MSG_TTL_MS;
    return parsed
      .filter((m) => {
        if (!m.createdAt) return true;
        const t = typeof m.createdAt === "string" ? Date.parse(m.createdAt as string) : Number(m.createdAt);
        return isNaN(t) || t > cutoff;
      })
      .slice(-CHAT_MSGS_MAX)
      .map((m) => ({
        ...m,
        createdAt: m.createdAt ? new Date(m.createdAt as string | number) : undefined,
      }));
  } catch { return []; }
}

/** Convert File[] to FileUIPart[] (data URLs) for sendMessage */
async function filesToUIParts(files: File[]): Promise<Array<{ type: "file"; mediaType: string; filename?: string; url: string }>> {
  return Promise.all(
    files.map(
      (file): Promise<{ type: "file"; mediaType: string; filename?: string; url: string }> =>
        new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            resolve({
              type: "file",
              mediaType: file.type || "application/octet-stream",
              filename: file.name,
              url: reader.result as string,
            });
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        })
    )
  );
}

/* ── Full markdown renderer for messages (tables, lists, code, etc.) ───────── */

const chatMarkdownComponents: React.ComponentProps<
  typeof ReactMarkdown
>["components"] = {
  p: ({ children, ...props }) => (
    <p className="mb-2 last:mb-0 leading-relaxed text-xs" {...props}>
      {children}
    </p>
  ),
  h1: ({ children, ...props }) => (
    <h1 className="mb-2 mt-3 text-xs font-semibold first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mb-2 mt-3 text-xs font-semibold first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mb-1.5 mt-2 text-xs font-medium first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mb-1 mt-2 text-xs font-medium first:mt-0" {...props}>
      {children}
    </h4>
  ),
  ul: ({ children, ...props }) => (
    <ul className="my-2 list-inside list-disc space-y-0.5 text-xs" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="my-2 list-inside list-decimal space-y-0.5 text-xs" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="text-xs" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic opacity-90" {...props}>
      {children}
    </em>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = className?.includes("language-");
    if (isBlock) {
      return (
        <code className={cn("block p-0", className)} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-xs text-stone-700 dark:bg-stone-800 dark:text-stone-200"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children, ...props }) => (
    <pre
      className="my-2 overflow-x-auto rounded-lg bg-card p-3 text-xs leading-relaxed"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-2 border-l-2 border-emerald-300 pl-3 text-xs italic opacity-90 dark:border-emerald-500/40"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-emerald-700 underline decoration-emerald-300/70 hover:text-emerald-600 dark:text-emerald-300 dark:decoration-emerald-500/40 dark:hover:text-emerald-200"
      {...props}
    >
      {children}
    </a>
  ),
  hr: (props) => <hr className="my-3 border-foreground/10" {...props} />,
  table: ({ children, ...props }) => (
    <div className="my-3 w-full overflow-x-auto">
      <table className="min-w-full border-collapse border border-foreground/10 text-xs" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => <thead {...props}>{children}</thead>,
  tbody: ({ children, ...props }) => <tbody {...props}>{children}</tbody>,
  tr: ({ children, ...props }) => (
    <tr className="border-b border-foreground/10" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th
      className="border border-foreground/10 bg-muted/60 px-2 py-1.5 text-left font-medium"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-foreground/10 px-2 py-1.5" {...props}>
      {children}
    </td>
  ),
};

/* ── Tool call / agent activity parsing & rendering ─────────────────────────── */

type ToolCallSegment = {
  type: "tool_start";
  callId: string;
  toolName: string;
  displayName: string;
  args?: string;
  done: boolean;
};

type AgentSegment = {
  type: "agent_start";
  callId: string;
  agentName: string;
  done: boolean;
};

type TextSegment = { type: "text"; text: string };

type MessageSegment = TextSegment | ToolCallSegment | AgentSegment;

// Regex patterns for inline markers emitted by the backend SSE parser
const TOOL_START_RE = /\u200B\[\[TOOL_START:([^:]*):([^:]*):([^\]]*)\]\]\u200B/g;
const TOOL_ARGS_RE = /\u200B\[\[TOOL_ARGS:([^:]*):([^\]]*)\]\]\u200B/g;
const TOOL_END_RE = /\u200B\[\[TOOL_END:([^\]]*)\]\]\u200B/g;
const AGENT_START_RE = /\u200B\[\[AGENT_START:([^:]*):([^\]]*)\]\]\u200B/g;
const ALL_MARKERS_RE = /\u200B\[\[(TOOL_START|TOOL_ARGS|TOOL_END|AGENT_START):[^\]]*\]\]\u200B/g;

function parseMessageSegments(text: string): MessageSegment[] {
  if (!text.includes("\u200B[[")) {
    // Fast path: no markers at all
    return text.trim() ? [{ type: "text", text }] : [];
  }

  const segments: MessageSegment[] = [];
  const toolCalls = new Map<string, ToolCallSegment>();
  const agentCalls = new Map<string, AgentSegment>();

  // Collect all tool/agent metadata first
  let m: RegExpExecArray | null;

  TOOL_START_RE.lastIndex = 0;
  while ((m = TOOL_START_RE.exec(text)) !== null) {
    toolCalls.set(m[1], { type: "tool_start", callId: m[1], toolName: m[2], displayName: m[3], done: false });
  }
  TOOL_ARGS_RE.lastIndex = 0;
  while ((m = TOOL_ARGS_RE.exec(text)) !== null) {
    const tc = toolCalls.get(m[1]);
    if (tc) tc.args = m[2];
  }
  TOOL_END_RE.lastIndex = 0;
  while ((m = TOOL_END_RE.exec(text)) !== null) {
    const tc = toolCalls.get(m[1]);
    if (tc) tc.done = true;
    const ac = agentCalls.get(m[1]);
    if (ac) ac.done = true;
  }
  AGENT_START_RE.lastIndex = 0;
  while ((m = AGENT_START_RE.exec(text)) !== null) {
    agentCalls.set(m[1], { type: "agent_start", callId: m[1], agentName: m[2], done: false });
  }

  // Split text by all markers, interleaving text and tool/agent segments
  const parts = text.split(ALL_MARKERS_RE);
  let markerIdx = 0;
  ALL_MARKERS_RE.lastIndex = 0;
  const markers: RegExpExecArray[] = [];
  while ((m = ALL_MARKERS_RE.exec(text)) !== null) markers.push(m);

  for (let i = 0; i < parts.length; i++) {
    const cleaned = parts[i].trim();
    if (cleaned) segments.push({ type: "text", text: parts[i] });

    if (markerIdx < markers.length) {
      const marker = markers[markerIdx++];
      const full = marker[0];
      // Extract callId from the marker
      const inner = full.replace(/\u200B/g, "").replace(/^\[\[/, "").replace(/\]\]$/, "");
      const colonIdx = inner.indexOf(":");
      const callId = colonIdx >= 0 ? inner.slice(colonIdx + 1).split(":")[0] : "";

      if (full.includes("TOOL_START:")) {
        const tc = toolCalls.get(callId);
        if (tc) segments.push(tc);
      } else if (full.includes("AGENT_START:")) {
        const ac = agentCalls.get(callId);
        if (ac) segments.push(ac);
      }
      // TOOL_ARGS and TOOL_END are metadata-only — already applied above
    }
  }

  return segments;
}

function ToolCallBlock({ segment }: { segment: ToolCallSegment | AgentSegment }) {
  const [open, setOpen] = useState(false);
  const isAgent = segment.type === "agent_start";
  const label = isAgent
    ? `Calling ${(segment as AgentSegment).agentName}`
    : (segment as ToolCallSegment).displayName;
  const args = !isAgent ? (segment as ToolCallSegment).args : undefined;
  const isDone = segment.done;

  return (
    <div className="my-2 rounded-lg border border-foreground/5 bg-card/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/30"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90"
          )}
        />
        {isAgent ? (
          <Users className="h-3 w-3 shrink-0 text-violet-400" />
        ) : (
          <Wrench className="h-3 w-3 shrink-0 text-amber-400" />
        )}
        <span className="flex-1 truncate font-medium text-foreground/70">
          {label}
        </span>
        {isDone ? (
          <Check className="h-3 w-3 shrink-0 text-emerald-400" />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground/50" />
        )}
      </button>
      {open && args && (
        <div className="border-t border-foreground/5 px-3 py-2">
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] leading-relaxed text-muted-foreground/60">
            {tryFormatJson(args)}
          </pre>
        </div>
      )}
    </div>
  );
}

function tryFormatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function MessageContent({ text }: { text: string }) {
  if (!text.trim()) return null;

  const segments = parseMessageSegments(text);
  if (segments.length === 0) return null;

  // Optimization: if there's only plain text (no markers), render directly
  if (segments.length === 1 && segments[0].type === "text") {
    return (
      <div className="space-y-1 [&>*:last-child]:mb-0">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
          {segments[0].text}
        </ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="space-y-1 [&>*:last-child]:mb-0">
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          const cleaned = seg.text.trim();
          if (!cleaned) return null;
          return (
            <ReactMarkdown key={i} remarkPlugins={[remarkGfm]} components={chatMarkdownComponents}>
              {cleaned}
            </ReactMarkdown>
          );
        }
        return <ToolCallBlock key={seg.callId} segment={seg} />;
      })}
    </div>
  );
}


/* ── Chat panel for a single agent ─────────────── */
/* These are always mounted; hidden via CSS when not selected */

function ChatPanel({
  agentId,
  agentName,
  agentEmoji: emoji,
  agentModel,
  isSelected,
  isVisible,
  availableModels,
  selectedProvider,
  modelsLoaded,
  isPostOnboarding,
  onClearPostOnboarding,
}: {
  agentId: string;
  agentName: string;
  agentEmoji: string;
  agentModel: string;
  isSelected: boolean;
  isVisible: boolean;
  availableModels: Array<{ key: string; name: string }>;
  selectedProvider: string | null;
  modelsLoaded: boolean;
  isPostOnboarding: boolean;
  onClearPostOnboarding: () => void;
}) {
  const postOnboardingStarterPrompt = "Say hello and tell me how you can help me today.";
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [inputValue, setInputValue] = useState(() =>
    isPostOnboarding && isSelected ? postOnboardingStarterPrompt : ""
  );
  const chatSessionKeyRef = useRef(loadStoredSessionKey(agentId));
  // Load prior messages once on mount so navigation away and back restores history.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [initialMessages] = useState<any[]>(() => loadStoredMessages(agentId));
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevMsgCountRef = useRef(0);

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.isArray(files) ? files : Array.from(files);
    if (list.length) setAttachedFiles((prev) => [...prev, ...list]);
  }, []);

  const ensureChatSessionKey = useCallback(() => {
    const existing = chatSessionKeyRef.current.trim();
    if (existing) return existing;
    const next = createChatSessionKey(agentId);
    chatSessionKeyRef.current = next;
    try { localStorage.setItem(CHAT_SESSION_LS(agentId), next); } catch { /* ignore */ }
    return next;
  }, [agentId]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("Files")) {
      e.dataTransfer.dropEffect = "copy";
      setIsDraggingOver(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDraggingOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingOver(false);
    const files = e.dataTransfer.files;
    if (files?.length) addFiles(files);
  }, [addFiles]);


  // Create transport for chat requests. Per-request fields are attached via sendMessage.
  const transport = useMemo(
    () =>
      new TextStreamChatTransport({
        api: "/api/chat",
      }),
    []
  );

  const { messages, sendMessage, status, setMessages, error } = useChat({
    transport,
    initialMessages,
  });

  // Persist messages to localStorage so nav away and back restores history.
  useEffect(() => {
    if (messages.length === 0) return;
    try {
      localStorage.setItem(CHAT_MSGS_LS(agentId), JSON.stringify(messages.slice(-CHAT_MSGS_MAX)));
    } catch { /* localStorage full or unavailable */ }
  }, [messages, agentId]);

  const isLoading = status === "submitted" || status === "streaming";
  const noApiKeys = modelsLoaded && availableModels.length === 0;

  // ── Detect new assistant messages → trigger unread notification ──
  useEffect(() => {
    const count = messages.length;
    if (count > prevMsgCountRef.current) {
      // Find any new assistant messages
      const newMsgs = messages.slice(prevMsgCountRef.current);
      for (const m of newMsgs) {
        if (m.role === "assistant") {
          // Only add unread if the chat tab isn't visible,
          // or this specific agent panel isn't the one being viewed
          if (!isVisible || !isSelected) {
            addUnread(agentId, agentName);
          }
        }
      }
    }
    prevMsgCountRef.current = count;
  }, [messages, isVisible, isSelected, agentId, agentName]);

  // Auto-scroll (only when this panel is visible)
  useEffect(() => {
    if (isSelected && isVisible) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, status, isSelected, isVisible]);

  // Focus input when this panel becomes selected + visible
  useEffect(() => {
    if (isSelected && isVisible) {
      // Small delay to let DOM settle after CSS swap
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [isSelected, isVisible]);

  // Clear unread for this agent when the panel becomes visible and selected
  useEffect(() => {
    if (isSelected && isVisible) {
      clearUnread(agentId);
    }
  }, [isSelected, isVisible, agentId]);

  const sendWithActiveModel = useCallback(
    async (
      payload: {
        text: string;
        files?: Array<{ type: "file"; mediaType: string; filename?: string; url: string }>;
      },
    ) => {
      const sessionKey = ensureChatSessionKey();
      await sendMessage(payload, {
        body: { agentId, sessionKey },
      });
    },
    [agentId, ensureChatSessionKey, sendMessage],
  );

  const retryLastUserMessage = useCallback(() => {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    const retryText =
      lastUser.parts
        ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join("") || "";
    const retryFiles =
      lastUser.parts
        ?.filter(
          (p): p is { type: "file"; mediaType: string; filename?: string; url: string } =>
            p.type === "file" && "url" in p
        ) || [];
    if (!retryText && retryFiles.length === 0) return;
    void sendWithActiveModel({
      text: retryText,
      ...(retryFiles.length > 0 ? { files: retryFiles } : {}),
    });
  }, [messages, sendWithActiveModel]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    const hasFiles = attachedFiles.length > 0;
    if ((!text && !hasFiles) || isLoading || noApiKeys) return;
    onClearPostOnboarding();
    setInputValue("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    const fileParts = hasFiles ? await filesToUIParts(attachedFiles) : undefined;
    setAttachedFiles([]);
    await sendWithActiveModel(
      { text: text || "", files: fileParts },
    );
  }, [
    attachedFiles,
    inputValue,
    isLoading,
    noApiKeys,
    onClearPostOnboarding,
    sendWithActiveModel,
  ]);

  const clearChat = useCallback(() => {
    setMessages([]);
    prevMsgCountRef.current = 0;
    const newKey = createChatSessionKey(agentId);
    chatSessionKeyRef.current = newKey;
    try {
      localStorage.setItem(CHAT_SESSION_LS(agentId), newKey);
      localStorage.removeItem(CHAT_MSGS_LS(agentId));
    } catch { /* ignore */ }
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [agentId, setMessages]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInputValue(e.target.value);
      const target = e.target;
      target.style.height = "auto";
      target.style.height = Math.min(target.scrollHeight, 200) + "px";
    },
    []
  );

  return (
    <div
      className={cn(
        "flex flex-1 flex-col overflow-hidden",
        !isSelected && "hidden"
      )}
    >
      {/* ── Messages area ───────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          noApiKeys ? (
            /* ── No models — redirect to /models ── */
            <div className="flex h-full items-center justify-center px-4 md:px-6">
              <div className="relative w-full max-w-sm animate-modal-in">
                <div className="pointer-events-none absolute -inset-12 rounded-full bg-[var(--accent-brand)] opacity-[0.04] blur-3xl" />
                <div className="relative rounded-2xl border border-[var(--accent-brand-border)]/60 bg-card p-6 text-center shadow-lg shadow-[var(--accent-brand-ring)]/10">
                  <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-brand)] text-[var(--accent-brand-on)] shadow-sm">
                    <KeyRound className="h-5 w-5" />
                  </div>
                  <h3 className="text-sm font-semibold tracking-tight text-foreground">
                    No model configured
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Connect an AI provider and choose a model to start chatting with your agent.
                  </p>
                  <a
                    href="/agents?tab=models"
                    className="mt-4 inline-flex items-center gap-2 rounded-lg bg-[var(--accent-brand)] px-4 py-2 text-xs font-medium text-[var(--accent-brand-on)] shadow-sm transition-all hover:opacity-90 hover:shadow-md"
                  >
                    <ArrowRight className="h-3.5 w-3.5" />
                    Set up models
                  </a>
                </div>
              </div>
            </div>
          ) : (
            /* ── Normal empty state — ready to chat ── */
            <div className="flex h-full flex-col items-center justify-center gap-4 px-4 md:px-6">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/80 text-xl">
                {emoji}
              </div>
              <div className="text-center">
                <h3 className="text-xs font-semibold text-foreground/90">
                  Chat with {agentName}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Send a message to start a conversation with your agent.
                </p>
              </div>
              {/* Quick prompts */}
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {(isPostOnboarding
                  ? [
                      "Say hello!",
                      "What can you do?",
                      "Tell me a joke",
                      "Help me get started",
                    ]
                  : [
                      "What did you do today?",
                      "Check my scheduled tasks",
                      "Summarize recent activity",
                      "What tasks are pending?",
                    ]
                ).map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => {
                      onClearPostOnboarding();
                      void sendWithActiveModel({ text: prompt });
                    }}
                    className="rounded-lg border border-foreground/10 bg-muted/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground/70"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )
        ) : (
          <div className="mx-auto max-w-3xl px-4 py-6">
            {messages.map((message) => {
              const isUser = message.role === "user";
              const parts = message.parts ?? [];
              const text =
                parts
                  .filter(
                    (
                      p
                    ): p is Extract<(typeof parts)[number], { type: "text" }> =>
                      p.type === "text"
                  )
                  .map((p) => p.text)
                  .join("") || "";
              const fileParts = parts.filter(
                (
                  p
                ): p is Extract<(typeof parts)[number], { type: "file" }> =>
                  p.type === "file"
              );
              const imageParts = fileParts.filter(
                (p) => p.url && /^image\//i.test(p.mediaType ?? "")
              );
              const otherFileParts = fileParts.filter(
                (p) => !p.url || !/^image\//i.test(p.mediaType ?? "")
              );
              return (
                <div
                  key={message.id}
                  className={cn(
                    "mb-6 flex gap-3",
                    isUser ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  {/* Avatar */}
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-xs",
                      isUser
                        ? "bg-muted/80 text-foreground/70"
                        : "border border-violet-500/30 bg-violet-500/10"
                    )}
                  >
                    {isUser ? (
                      <User className="h-4 w-4" />
                    ) : (
                      <span className="text-sm">
                        {emoji}
                      </span>
                    )}
                  </div>

                  {/* Message bubble */}
                  <div
                    className={cn(
                      "max-w-md rounded-xl px-4 py-3 text-xs",
                      isUser
                        ? "bg-accent text-foreground"
                        : "bg-muted/80 text-foreground/70"
                    )}
                  >
                    {text ? <MessageContent text={text} /> : null}
                    {imageParts.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {imageParts.map((p, i) =>
                          p.url ? (
                            <img
                              key={i}
                              src={p.url}
                              alt={p.filename ?? "Attached image"}
                              className="max-h-48 max-w-full rounded-lg border border-foreground/10 object-contain"
                            />
                          ) : null
                        )}
                      </div>
                    )}
                    {otherFileParts.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {otherFileParts.map((p, i) => (
                          <span
                            key={i}
                            className="rounded bg-muted/80 px-1.5 py-0.5 text-xs opacity-90"
                          >
                            📎 {p.filename ?? "file"}
                          </span>
                        ))}
                      </div>
                    )}
                    <div
                      className={cn(
                        "mt-2 text-xs",
                        isUser
                          ? "text-right text-stone-400 dark:text-stone-500"
                          : "text-muted-foreground/60"
                      )}
                    >
                      {formatTime(
                        "createdAt" in message
                          ? (message as unknown as { createdAt: Date })
                              .createdAt
                          : new Date(),
                        timeFormat,
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* Loading indicator — only when waiting for first token, not during streaming */}
            {status === "submitted" && (
              <div className="mb-6 flex gap-3">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-xs"
                >
                  <span className="text-sm">{emoji}</span>
                </div>
                <div className="flex items-center gap-2 rounded-xl bg-muted/80 px-4 py-3">
                  <span className="inline-flex items-center gap-0.5 text-muted-foreground">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                  <span className="text-xs text-muted-foreground">Thinking...</span>
                </div>
              </div>
            )}

            {/* Error display */}
            {error && (
              /No API key found|api[._-]key|auth.profiles|FailoverError|Configure auth|unauthorized|invalid.*key|401/i.test(error.message) ? (
                /* Friendly API key error — redirect to models */
                <div className="mb-6 overflow-hidden rounded-xl border border-[var(--accent-brand-border)]/60 bg-card p-4 shadow-sm animate-modal-in">
                  <div className="mb-2 flex items-center gap-2">
                    <KeyRound className="h-3.5 w-3.5 text-[var(--accent-brand-text)]" />
                    <span className="text-xs font-medium text-[var(--accent-brand-text)]">Your agent needs an API key to reply</span>
                  </div>
                  <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
                    The AI provider rejected the request. This usually means your API key
                    is missing, expired, or doesn&apos;t have enough credits.
                  </p>
                  <a
                    href="/agents?tab=models"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--accent-brand)] px-3 py-1.5 text-xs font-medium text-[var(--accent-brand-on)] shadow-sm transition-all hover:opacity-90"
                  >
                    <ArrowRight className="h-3 w-3" />
                    Go to Models
                  </a>
                </div>
              ) : /avoid sending your message with a different model|switch this chat back to the agent setup|could not use .* because the OpenClaw gateway/i.test(error.message) ? (
                <div className="mb-6 rounded-lg border border-violet-500/20 bg-violet-500/5 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-violet-500">
                      Your selected chat model was protected
                    </span>
                    <button
                      type="button"
                      onClick={retryLastUserMessage}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-violet-500 transition-colors hover:bg-violet-500/10"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Try again
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-violet-500/80">
                    Mission Control stopped the request instead of sending it with the wrong model.
                    You can try again, or switch this chat back to the agent setup below.
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-violet-500/60">
                    {error.message}
                  </p>
                </div>
              ) : /timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed|network/i.test(error.message) ? (
                /* Connection / network error */
                <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-amber-400">
                      Connection problem
                    </span>
                    <button
                      type="button"
                      onClick={retryLastUserMessage}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-amber-400 transition-colors hover:bg-amber-500/10"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Try again
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-amber-400/70">
                    Could not reach the AI provider. Check that your internet connection is
                    working and that the OpenClaw gateway is online (green dot in the sidebar).
                  </p>
                </div>
              ) : /rate.?limit|429|quota|exceeded|billing/i.test(error.message) ? (
                /* Rate limit / quota error */
                <div className="mb-6 rounded-lg border border-amber-500/20 bg-amber-500/5 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-amber-400">
                      Usage limit reached
                    </span>
                    <button
                      type="button"
                      onClick={retryLastUserMessage}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-amber-400 transition-colors hover:bg-amber-500/10"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Try again
                    </button>
                  </div>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-amber-400/70">
                    Your AI provider says you&apos;ve hit a usage or billing limit. Wait a minute
                    and try again, or check your plan&apos;s dashboard to add credits.
                  </p>
                </div>
              ) : (
                /* Generic error — still helpful */
                <div className="mb-6 rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium text-red-400">
                      Something went wrong
                    </span>
                    <button
                      type="button"
                      onClick={retryLastUserMessage}
                      className="flex items-center gap-1 rounded px-2 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/10"
                    >
                      <RefreshCw className="h-3 w-3" />
                      Try again
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-red-400/70">
                    {error.message}
                  </p>
                  <p className="mt-1.5 text-[11px] leading-relaxed text-red-400/50">
                    If this keeps happening, try switching models (brain icon below),
                    or visit the Doctor page from the sidebar to run a system check.
                  </p>
                </div>
              )
            )}

            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* ── Input area (drag-and-drop zone) ─────── */}
      <div
        className={cn(
          "shrink-0 border-t border-foreground/10 bg-card/60 px-4 py-3 transition-colors",
          isDraggingOver && "bg-violet-500/10 border-violet-500/20"
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="mx-auto max-w-3xl space-y-2">
          {/* Attached files preview */}
          {attachedFiles.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {attachedFiles.map((f, i) => (
                <span
                  key={`${f.name}-${i}`}
                  className="inline-flex items-center gap-1 rounded-md border border-foreground/10 bg-muted/60 px-2 py-1 text-xs"
                >
                  <Paperclip className="h-3 w-3 text-muted-foreground/60" />
                  <span className="max-w-32 truncate">{f.name}</span>
                  <button
                    type="button"
                    onClick={() =>
                      setAttachedFiles((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="rounded p-0.5 text-muted-foreground/40 hover:bg-muted hover:text-foreground"
                    aria-label="Remove file"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {/* Input row: textarea with inline actions */}
          <div className="flex min-w-0 items-end gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-1 flex-col rounded-xl border border-foreground/10 bg-card focus-within:border-violet-500/30 focus-within:ring-1 focus-within:ring-violet-500/20">
              <textarea
                ref={inputRef}
                value={inputValue}
                onChange={handleTextareaChange}
                onKeyDown={handleKeyDown}
                placeholder={noApiKeys ? "Add an API key to start chatting..." : `Message ${agentName}...`}
                rows={1}
                disabled={isLoading || noApiKeys}
                className="max-h-48 flex-1 resize-none bg-transparent px-3 pt-2.5 pb-1 text-xs text-foreground/90 outline-none placeholder:text-muted-foreground/60 disabled:opacity-50 sm:px-4"
              />
              {/* Inline toolbar */}
              <div className="flex items-center gap-1 px-2 pb-1.5 sm:px-3">
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  title="Attach files"
                  className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground/70"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={clearChat}
                    title="Clear conversation"
                    className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/40 transition-colors hover:bg-muted hover:text-foreground/70"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <button
              type="button"
              onClick={handleSend}
              disabled={(!inputValue.trim() && attachedFiles.length === 0) || isLoading || noApiKeys}
              className={cn(
                "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors",
                (inputValue.trim() || attachedFiles.length > 0) && !isLoading && !noApiKeys
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground/60"
              )}
            >
              {isLoading ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                <Send className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground/40">
          Press Enter to send, Shift+Enter for a new line. You can also attach files.
        </p>
      </div>
    </div>
  );
}

/* ── Main chat view with agent selector ────────── */

const isHosted = process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";

export function ChatView({ isVisible = true }: { isVisible?: boolean }) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>("main");
  const selectedAgentRef = useRef(selectedAgent);
  selectedAgentRef.current = selectedAgent;
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [availableModels, setAvailableModels] = useState<Array<{ key: string; name: string }>>([]);
  const [connectedProviders, setConnectedProviders] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const providerDropdownRef = useRef<HTMLDivElement>(null);

  // ── Warm-up state: friendly loading for new users ──
  const [warmupExpired, setWarmupExpired] = useState(false);
  const mountedAtRef = useRef(0);
  const warmingUp = !warmupExpired && agents.length === 0;

  // ── Post-onboarding first-time prompts ──
  const [isPostOnboarding, setIsPostOnboarding] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem("mc-post-onboarding") === "1"; } catch { return false; }
  });

  const clearPostOnboarding = useCallback(() => {
    if (!isPostOnboarding) return;
    setIsPostOnboarding(false);
    try { localStorage.removeItem("mc-post-onboarding"); } catch {}
  }, [isPostOnboarding]);

  // Track which agents have been "opened" (we'll mount their ChatPanel forever)
  const [mountedAgents, setMountedAgents] = useState<Set<string>>(
    new Set(["main"])
  );

  // Fetch chat bootstrap data on mount (gateway config + sessions only)
  const bootstrapLoadedRef = useRef(false);
  const fetchBootstrap = useCallback(() => {
    // Only show loading spinner on initial fetch, not on background polls.
    // Setting loading on every poll clears the agent dropdown momentarily.
    if (!bootstrapLoadedRef.current) setAgentsLoading(true);
    fetch("/api/chat/bootstrap", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: ChatBootstrapResponse) => {
        const agentList = data.agents || [];
        const modelList = Array.isArray(data.models) ? data.models : [];
        setAgents(agentList);
        setAvailableModels(
          modelList
            .map((m) => ({
              key: String(m.key ?? ""),
              name: String(m.name ?? m.key ?? ""),
            }))
            .filter((m) => m.key)
        );
        const providers = Array.isArray(data.connectedProviders) ? data.connectedProviders : [];
        setConnectedProviders(providers);
        if (providers.length > 0 && !selectedProvider) {
          // Auto-select the provider of the current default model, or first provider
          const defaultModel = agentList.find((a) => a.isDefault)?.model || "";
          const defaultProv = defaultModel.split("/")[0];
          const match = providers.find((p: { id: string }) => p.id === defaultProv);
          setSelectedProvider(match?.id || providers[0]?.id || null);
        }
        bootstrapLoadedRef.current = true;
        if (
          agentList.length > 0 &&
          !agentList.find((a: Agent) => a.id === selectedAgentRef.current)
        ) {
          setSelectedAgent(agentList[0].id);
          setMountedAgents((prev) => {
            const next = new Set(prev);
            next.add(agentList[0].id);
            return next;
          });
        }
        // Only mark models as "loaded" if we actually found models,
        // or if warm-up is over. Prevents flash of "No model configured"
        // while gateway is still starting up.
        if (modelList.length > 0 || warmupExpired) {
          setModelsLoaded(true);
        }
        setAgentsLoading(false);
      })
      .catch(() => {
        if (warmupExpired) setModelsLoaded(true);
        setAgentsLoading(false);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmupExpired]);

  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, []);

  // End warm-up after 20s timeout
  useEffect(() => {
    const remaining = 20_000 - (Date.now() - mountedAtRef.current);
    const t = setTimeout(() => setWarmupExpired(true), Math.max(remaining, 0));
    return () => clearTimeout(t);
  }, []);

  // Fetch agents: fast-poll (10s) during warm-up, normal (30s) otherwise
  useSmartPoll(fetchBootstrap, {
    intervalMs: warmingUp ? 10000 : 30000,
    enabled: isVisible,
  });

  useEffect(() => {
    if (!isVisible) return;
    const tick = () => {
      if (document.visibilityState === "visible") {
        setNow(Date.now());
      }
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, [isVisible]);

  // Mark chat as active when visible
  useEffect(() => {
    setChatActive(isVisible);
  }, [isVisible]);

  // Close dropdowns on click outside
  useEffect(() => {
    if (!providerDropdownOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (providerDropdownOpen && providerDropdownRef.current && !providerDropdownRef.current.contains(e.target as Node)) {
        setProviderDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [providerDropdownOpen]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === selectedAgent),
    [agents, selectedAgent]
  );
  const currentAgentTitle = currentAgent ? agentDisplayName(currentAgent) : "Agent";
  const currentAgentModelLabel =
    currentAgent?.model && currentAgent.model !== "unknown"
      ? formatModel(currentAgent.model)
      : "";
  const showSecondaryModelLabel =
    Boolean(currentAgentModelLabel) &&
    currentAgentModelLabel.toLowerCase() !== currentAgentTitle.toLowerCase();

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* ── Top bar ─────────────── */}
      <div className="shrink-0 border-b border-stone-200 bg-stone-50 px-4 py-3 md:px-6 dark:border-stone-700 dark:bg-stone-900">
        <div className="flex items-center gap-2.5">
          <span className="text-sm">{currentAgent?.emoji || "🤖"}</span>
          <span className="text-sm font-medium text-stone-700 dark:text-stone-200">
            {currentAgentTitle}
          </span>
          {showSecondaryModelLabel && (
            <span className="text-xs text-muted-foreground">
              {currentAgentModelLabel}
            </span>
          )}
        </div>
      </div>

      {/*
       * ── Agent chat panels ──────────────────────
       * All opened agents are always mounted. Only the selected one is visible.
       * This ensures chat state (messages, streams) persist across tab switches
       * and agent switches.
       */}
      {!agentsLoading && agents.length === 0 ? (
        warmingUp ? (
          /* ── Warm-up: agent is starting ── */
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/80 text-xl">
              🤖
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">
                Getting your agent ready
                <TypingDots size="sm" className="ml-1 text-muted-foreground" />
              </h3>
              <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
                This usually only takes a few seconds.
              </p>
            </div>
          </div>
        ) : isHosted ? (
          /* ── Hosted post-warm-up: friendly fallback ── */
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/80 text-xl">
              🤖
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">
                Your agent isn&apos;t available yet
              </h3>
              <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
                Try refreshing the page. If the problem persists, please contact support.
              </p>
            </div>
            <button
              type="button"
              onClick={fetchBootstrap}
              className="flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-muted/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground/70"
            >
              <RefreshCw className="h-3 w-3" />
              Refresh
            </button>
          </div>
        ) : (
          /* ── Self-hosted: existing guidance ── */
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/80 text-xl">
              🤖
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground/90">
                No agents found
              </h3>
              <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
                Your agent hasn&apos;t started yet. Check that the gateway is online
                (green dot in the sidebar), then refresh this page.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={fetchBootstrap}
                className="flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-muted/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground/70"
              >
                <RefreshCw className="h-3 w-3" />
                Refresh
              </button>
              <a
                href="/doctor"
                className="flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-muted/60 px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground/70"
              >
                <Cpu className="h-3 w-3" />
                Run Doctor
              </a>
            </div>
          </div>
        )
      ) : (
        Array.from(mountedAgents).map((agentId) => {
          const agent = agents.find((a) => a.id === agentId);
          return (
            <ChatPanel
              key={agentId}
              agentId={agentId}
              agentName={agent ? agentDisplayName(agent) : agentId}
              agentEmoji={agent?.emoji || "🤖"}
              agentModel={agent?.model || "unknown"}
              isSelected={agentId === selectedAgent}
              isVisible={isVisible}
              availableModels={availableModels}
              selectedProvider={selectedProvider}
              modelsLoaded={modelsLoaded}
              isPostOnboarding={isPostOnboarding}
              onClearPostOnboarding={clearPostOnboarding}
            />
          );
        })
      )}
    </div>
  );
}
