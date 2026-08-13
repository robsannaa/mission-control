"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useChat } from "@ai-sdk/react";
import { TextStreamChatTransport } from "ai";
import type { UIMessage } from "ai";
import { ArrowDown, CircleHelp, PanelLeft, Pencil, Plus } from "lucide-react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { cn } from "@/lib/utils";
import { addUnread, clearUnread, setChatActive } from "@/lib/chat-store";
import { classifySessionKind, sessionKindOf } from "@/lib/session-kinds";
import { Composer, type ComposerSubmission } from "@/components/chat/composer";
import {
  MessageList,
  ThinkingIndicator,
  type ChatMessageMeta,
} from "@/components/chat/message-list";
import { SessionSidebar } from "@/components/chat/session-sidebar";
import {
  AgentsUnavailable,
  ChatHero,
  InlineNotice,
  classifyChatError,
  type ErrorShape,
} from "@/components/chat/states";
import {
  MESSAGE_HISTORY_LIMIT,
  type ChatAgent,
  type ChatSessionRow,
} from "@/components/chat/types";
import type { InteractionRequest } from "@/lib/awareness/types";
import { announceInteractionsChanged } from "@/lib/interaction-events";
import { interactionReplyMessages } from "@/lib/interaction-chat";

/**
 * Mission Control chat.
 *
 * Three things here are load-bearing and were verified against a live gateway
 * rather than assumed:
 *
 * 1. SESSION CONTINUITY. A chat lives at `agent:<id>:openresponses:<uuid>` and
 *    the key travels to the gateway as `x-openclaw-session-key`. Sending twice
 *    with the same key continues the same transcript (probed: the agent
 *    recalled a codeword set in the previous request). The previous
 *    implementation minted `…:mission-control:<uuid>` keys, which are *not* in
 *    CHAT_SESSION_KINDS — every conversation it created was invisible to any
 *    session browser that classifies correctly.
 *
 * 2. SLASH COMMANDS ARE A DIFFERENT WIRE. POST /v1/responses with "/whoami"
 *    returns the model improvising an answer; only `chat.send` reaches the
 *    command handler. Commands therefore go to /api/chat/command, never
 *    through the streaming path.
 *
 * 3. HISTORY IS THE TAIL. `chat.history` returns the most recent N messages
 *    and takes no offset, so resuming loads a bounded window, and the UI says
 *    so when it is truncated instead of implying the conversation began there.
 */

/* ── Types ────────────────────────────────────────────────────────────────── */

type BootstrapAgent = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  isDefault: boolean;
};

type BootstrapResponse = {
  agents?: BootstrapAgent[];
  models?: Array<{ key?: string; name?: string }>;
};

type HistoryResponse = {
  sessionKey?: string;
  title?: string;
  messages?: Array<{ role?: string; content?: unknown; timestamp?: number }>;
  truncated?: boolean;
  error?: string;
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function shortModel(model: string): string {
  if (!model || model === "unknown") return "";
  return model.split("/").pop() ?? model;
}

function agentLabel(agent: BootstrapAgent): string {
  if (agent.name && agent.name !== agent.id) return agent.name;
  return shortModel(agent.model) || agent.id;
}

function newSessionKey(agentId: string): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  // `openresponses` — the origin the gateway itself uses for dashboard chats,
  // and one of the two kinds CHAT_SESSION_KINDS admits.
  return `agent:${agentId}:openresponses:${suffix}`;
}

function isChatSessionKey(key: string, agentId?: string): boolean {
  const parts = key.split(":");
  if (parts.length < 4 || parts[0] !== "agent") return false;
  if (agentId && parts[1] !== agentId) return false;
  return classifySessionKind(sessionKindOf({ key })).isChat;
}

function textFromHistoryContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      typeof block === "string"
        ? block
        : block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? ((block as { text: string }).text)
          : "",
    )
    .join("");
}

function toUIMessages(history: HistoryResponse): UIMessage[] {
  const rows = Array.isArray(history.messages) ? history.messages : [];
  const out: UIMessage[] = [];
  rows.forEach((row, index) => {
    const role = row.role === "assistant" ? "assistant" : row.role === "user" ? "user" : null;
    if (!role) return;
    const text = textFromHistoryContent(row.content).trim();
    if (!text) return;
    out.push({
      id: `history-${index}-${row.timestamp ?? index}`,
      role,
      parts: [{ type: "text", text }],
      metadata: { timestamp: row.timestamp } satisfies ChatMessageMeta,
    } as UIMessage);
  });
  return out;
}

function makeMessage(
  role: "user" | "assistant",
  text: string,
  meta?: ChatMessageMeta,
): UIMessage {
  return {
    id:
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${role}-${Date.now()}-${Math.random()}`,
    role,
    parts: [{ type: "text", text }],
    metadata: { timestamp: Date.now(), ...meta } satisfies ChatMessageMeta,
  } as UIMessage;
}

async function filesToParts(files: File[]) {
  return Promise.all(
    files.map(
      (file) =>
        new Promise<{
          type: "file";
          mediaType: string;
          filename?: string;
          url: string;
        }>((resolve, reject) => {
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
        }),
    ),
  );
}

/**
 * Turn `@`-references into something the agent can act on.
 *
 * The token alone ("@notes/plan.md") is ambiguous — it could be prose. The
 * outgoing message therefore carries an explicit, unmistakable footer naming
 * the workspace root and each path.
 */
function withReferences(
  text: string,
  submission: ComposerSubmission,
): string {
  const files = submission.mentions.filter((m) => m.kind === "file");
  const agents = submission.mentions.filter((m) => m.kind === "agent");
  if (files.length === 0 && agents.length === 0) return text;

  const lines: string[] = [text.trim(), ""];
  if (files.length) {
    lines.push(
      submission.workspaceRoot
        ? `Referenced files (relative to the agent workspace ${submission.workspaceRoot}):`
        : "Referenced files (relative to the agent workspace):",
    );
    for (const mention of files) {
      if (mention.kind !== "file") continue;
      lines.push(
        submission.workspaceRoot
          ? `- ${mention.path} — ${submission.workspaceRoot}/${mention.path}`
          : `- ${mention.path}`,
      );
    }
  }
  if (agents.length) {
    if (files.length) lines.push("");
    lines.push("Referenced agents:");
    for (const mention of agents) {
      if (mention.kind !== "agent") continue;
      lines.push(`- ${mention.id}`);
    }
  }
  return lines.join("\n");
}

function formatTokens(value: number): string {
  if (!value) return "";
  if (value < 1000) return `${value} tokens`;
  if (value < 1_000_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k tokens`;
  return `${(value / 1_000_000).toFixed(2)}M tokens`;
}

/* ── Inner view ───────────────────────────────────────────────────────────── */

function ChatViewInner({ isVisible }: { isVisible: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlAgent = searchParams.get("agent")?.trim() ?? "";
  const urlSession = searchParams.get("session")?.trim() ?? "";
  const interactionId = searchParams.get("interaction")?.trim() ?? "";

  const [agents, setAgents] = useState<BootstrapAgent[]>([]);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [modelCount, setModelCount] = useState<number | null>(null);
  const [warmupExpired, setWarmupExpired] = useState(false);

  const [agentId, setAgentId] = useState("");
  const [sessionKey, setSessionKey] = useState("");
  const [sessionIsDraft, setSessionIsDraft] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [notice, setNotice] = useState<ErrorShape | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [commandRunning, setCommandRunning] = useState(false);
  const [interaction, setInteraction] = useState<InteractionRequest | null>(null);
  const [interactionLoading, setInteractionLoading] = useState(false);
  const [interactionBusy, setInteractionBusy] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;
  const historyRequestRef = useRef(0);
  const seenMessagesRef = useRef(0);
  const renameInputRef = useRef<HTMLInputElement>(null);

  /* ── Bootstrap ───────────────────────────────────────────────────────── */

  const loadBootstrap = useCallback(async () => {
    if (!visibleRef.current) return;
    try {
      const res = await fetch("/api/chat/bootstrap", { cache: "no-store" });
      const data = (await res.json()) as BootstrapResponse;
      const list = Array.isArray(data.agents) ? data.agents : [];
      setAgents(list);
      setModelCount(Array.isArray(data.models) ? data.models.length : null);
    } catch {
      // Leave the previous agent list in place — a blip must not blank the UI.
    } finally {
      setAgentsLoaded(true);
    }
  }, []);

  // `enabled` is deliberately left at its default: useSmartPoll captures that
  // flag once in a useCallback with an empty dependency list, so a
  // false-at-mount value would silently disable polling forever. Visibility is
  // gated inside the callback instead.
  useSmartPoll(loadBootstrap, { intervalMs: 30_000 });

  useEffect(() => {
    const timer = setTimeout(() => setWarmupExpired(true), 20_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    setChatActive(isVisible);
  }, [isVisible]);

  const loadInteraction = useCallback(async () => {
    if (!interactionId) return;
    setInteractionLoading(true);
    try {
      const response = await fetch(
        `/api/interactions?id=${encodeURIComponent(interactionId)}`,
        { cache: "no-store" },
      );
      const payload = await response.json() as { interaction?: InteractionRequest; error?: string };
      if (!response.ok || !payload.interaction) {
        throw new Error(payload.error || "Could not load this question");
      }
      setInteraction(payload.interaction);
    } catch (cause) {
      setInteraction(null);
      setNotice({
        title: "That question is not available",
        body: cause instanceof Error ? cause.message : String(cause),
        tone: "warning",
      });
    } finally {
      setInteractionLoading(false);
    }
  }, [interactionId]);

  useEffect(() => {
    void loadInteraction();
  }, [loadInteraction]);

  const loadActiveInteraction = useCallback(async () => {
    if (interactionId || !visibleRef.current) return;
    try {
      const response = await fetch("/api/interactions?status=active&limit=1", {
        cache: "no-store",
      });
      const payload = await response.json() as {
        interactions?: InteractionRequest[];
      };
      if (!response.ok) return;
      setInteraction(payload.interactions?.[0] ?? null);
    } catch {
      // Chat remains usable if the interaction inbox has a temporary problem.
    }
  }, [interactionId]);

  useEffect(() => {
    if (interactionId || !isVisible) return;
    void loadActiveInteraction();
    const timer = window.setInterval(() => void loadActiveInteraction(), 8_000);
    return () => window.clearInterval(timer);
  }, [interactionId, isVisible, loadActiveInteraction]);

  useEffect(() => {
    if (interaction?.status !== "resuming") return;
    const timer = window.setInterval(() => void loadInteraction(), 3_000);
    return () => window.clearInterval(timer);
  }, [interaction?.status, loadInteraction]);

  /* ── Resolve the agent from the URL ──────────────────────────────────── */

  const resolvedAgent = useMemo(() => {
    if (agents.length === 0) return null;
    const wanted = urlAgent && agents.find((agent) => agent.id === urlAgent);
    if (wanted) return wanted;
    return agents.find((agent) => agent.isDefault) ?? agents[0];
  }, [agents, urlAgent]);

  useEffect(() => {
    if (!resolvedAgent) return;
    setAgentId((current) => (current === resolvedAgent.id ? current : resolvedAgent.id));
  }, [resolvedAgent]);

  const sessions = useChatSessions(agentId, isVisible && Boolean(agentId));

  /* ── Chat transport ──────────────────────────────────────────────────── */

  const transport = useMemo(
    () => new TextStreamChatTransport({ api: "/api/chat" }),
    [],
  );
  const { messages, sendMessage, setMessages, status, error, stop, clearError } =
    useChat({ transport });

  const isStreaming = status === "streaming";
  const isBusy = status === "submitted" || isStreaming || commandRunning;

  /* ── Session selection & history ─────────────────────────────────────── */

  const startNewChat = useCallback(
    (targetAgent: string, options: { push: boolean }) => {
      const key = newSessionKey(targetAgent);
      historyRequestRef.current += 1;
      setSessionKey(key);
      setSessionIsDraft(true);
      setHistoryTruncated(false);
      setMessages([]);
      seenMessagesRef.current = 0;
      clearError();
      setNotice(null);
      const params = new URLSearchParams();
      params.set("agent", targetAgent);
      if (options.push) router.push(`/chat?${params.toString()}`);
      else router.replace(`/chat?${params.toString()}`);
      return key;
    },
    [clearError, router, setMessages],
  );

  const loadHistory = useCallback(
    async (key: string) => {
      const requestId = historyRequestRef.current + 1;
      historyRequestRef.current = requestId;
      setHistoryLoading(true);
      try {
        const res = await fetch(
          `/api/chat/history?sessionKey=${encodeURIComponent(key)}&limit=${MESSAGE_HISTORY_LIMIT}`,
          { cache: "no-store" },
        );
        // A response for a session the user already left must never land.
        if (historyRequestRef.current !== requestId) return;

        if (res.status === 404 || res.status === 403) {
          setNotice({
            title: "That conversation is not available",
            body:
              res.status === 403
                ? "It belongs to a channel conversation, which the dashboard never opens."
                : "The gateway does not have this conversation any more. Started a new one instead.",
            tone: "neutral",
          });
          startNewChat(agentId || resolvedAgent?.id || "main", { push: false });
          return;
        }
        if (!res.ok) {
          setNotice({
            title: "Could not load this conversation",
            body: "The gateway did not return the transcript. Your messages are safe.",
            tone: "warning",
          });
          return;
        }

        const body = (await res.json()) as HistoryResponse;
        if (historyRequestRef.current !== requestId) return;
        setMessages(toUIMessages(body));
        seenMessagesRef.current = body.messages?.length ?? 0;
        setHistoryTruncated(Boolean(body.truncated));
        setSessionIsDraft(false);
        setNotice(null);
      } catch {
        if (historyRequestRef.current !== requestId) return;
        setNotice({
          title: "Could not load this conversation",
          body: "Mission Control could not reach the gateway.",
          tone: "warning",
        });
      } finally {
        if (historyRequestRef.current === requestId) setHistoryLoading(false);
      }
    },
    [agentId, resolvedAgent, setMessages, startNewChat],
  );

  // URL → state. This is the only place a session is adopted, so a shared link
  // and an in-app click follow exactly the same path.
  useEffect(() => {
    if (!agentId) return;

    if (!urlSession) {
      if (!sessionKey || !sessionKey.startsWith(`agent:${agentId}:`)) {
        const key = newSessionKey(agentId);
        historyRequestRef.current += 1;
        setSessionKey(key);
        setSessionIsDraft(true);
        setMessages([]);
        seenMessagesRef.current = 0;
      }
      return;
    }

    if (urlSession === sessionKey) return;

    if (!isChatSessionKey(urlSession, agentId)) {
      // Correct the URL rather than leaving a link that silently shows the
      // wrong conversation.
      setNotice({
        title: "That link does not point at one of your chats",
        body: "Started a new conversation instead.",
        tone: "neutral",
      });
      startNewChat(agentId, { push: false });
      return;
    }

    setSessionKey(urlSession);
    void loadHistory(urlSession);
  }, [agentId, loadHistory, sessionKey, setMessages, startNewChat, urlSession]);

  // Correct an unknown ?agent= to whatever we actually fell back to.
  useEffect(() => {
    if (!resolvedAgent || !urlAgent) return;
    if (urlAgent === resolvedAgent.id) return;
    const params = new URLSearchParams(searchParams.toString());
    params.set("agent", resolvedAgent.id);
    params.delete("session");
    router.replace(`/chat?${params.toString()}`);
  }, [resolvedAgent, router, searchParams, urlAgent]);

  const selectSession = useCallback(
    (row: ChatSessionRow) => {
      if (row.key === sessionKey) {
        setSidebarOpen(false);
        return;
      }
      if (isBusy) stop();
      setSidebarOpen(false);
      sessions.markRead(row.key);
      const params = new URLSearchParams();
      params.set("agent", row.agentId ?? agentId);
      params.set("session", row.key);
      // push, not replace: Back must return to the previous conversation.
      router.push(`/chat?${params.toString()}`);
    },
    [agentId, isBusy, router, sessionKey, sessions, stop],
  );

  const handleNewChat = useCallback(() => {
    if (isBusy) stop();
    setSidebarOpen(false);
    startNewChat(agentId, { push: true });
  }, [agentId, isBusy, startNewChat, stop]);

  const switchAgent = useCallback(
    (nextAgent: string) => {
      if (nextAgent === agentId) return;
      if (isBusy) stop();
      startNewChat(nextAgent, { push: true });
    },
    [agentId, isBusy, startNewChat, stop],
  );

  /* ── Sending ─────────────────────────────────────────────────────────── */

  const registerDraftSession = useCallback(
    (key: string, title: string) => {
      if (!sessionIsDraft) return;
      setSessionIsDraft(false);
      sessions.addDraft({
        key,
        sessionId: null,
        agentId,
        title: title.slice(0, 60) || "New conversation",
        titleSource: "derived",
        preview: null,
        updatedAt: Date.now(),
        pinned: false,
        unread: false,
        archived: false,
        hasActiveRun: false,
        model: null,
        totalTokens: 0,
        contextTokens: 0,
      });
      const params = new URLSearchParams();
      params.set("agent", agentId);
      params.set("session", key);
      // replace: the empty version of this chat is not a place to go Back to.
      router.replace(`/chat?${params.toString()}`);
    },
    [agentId, router, sessionIsDraft, sessions],
  );

  const handleSubmit = useCallback(
    async (submission: ComposerSubmission) => {
      if (interaction?.status === "open") {
        const answer = submission.text.trim();
        if (!answer || interactionBusy) return;
        setInteractionBusy(true);
        setNotice(null);
        try {
          const response = await fetch("/api/interactions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "answer",
              id: interaction.id,
              answer,
              channel: "mission-control-chat",
            }),
          });
          const payload = await response.json() as {
            interaction?: InteractionRequest;
            resumed?: boolean;
            scheduleResumed?: boolean;
            error?: string;
          };
          if (!response.ok || !payload.interaction) {
            throw new Error(payload.error || "Could not send your answer");
          }
          setInteraction(payload.interaction);
          announceInteractionsChanged();
          if (payload.resumed && payload.scheduleResumed === false) {
            setNotice({
              title: "The run continued, but its schedule is still paused",
              body: payload.error || "Enable this Cron Job again from Cron Jobs.",
              tone: "warning",
            });
          }
        } catch (cause) {
          setNotice({
            title: "Your answer was not sent",
            body: cause instanceof Error ? cause.message : String(cause),
            tone: "warning",
          });
        } finally {
          setInteractionBusy(false);
        }
        return;
      }

      const key = sessionKey || newSessionKey(agentId);
      if (!sessionKey) setSessionKey(key);
      clearError();
      setNotice(null);
      registerDraftSession(key, submission.text);

      const text = withReferences(submission.text, submission);
      const fileParts = submission.files.length
        ? await filesToParts(submission.files)
        : undefined;

      await sendMessage(
        { text, ...(fileParts ? { files: fileParts } : {}) },
        { body: { agentId, sessionKey: key } },
      );
      void sessions.refresh();
    },
    [agentId, clearError, interaction, interactionBusy, registerDraftSession, sendMessage, sessionKey, sessions],
  );

  const handleCommand = useCallback(
    async (command: string) => {
      const key = sessionKey || newSessionKey(agentId);
      if (!sessionKey) setSessionKey(key);
      setNotice(null);
      clearError();

      // Documented Control UI behaviour: a typed /new starts a fresh dashboard
      // session rather than being sent to the gateway.
      if (/^\/new\b/i.test(command)) {
        handleNewChat();
        return;
      }

      registerDraftSession(key, command);
      setMessages((current) => [...current, makeMessage("user", command)]);
      setCommandRunning(true);
      try {
        const res = await fetch("/api/chat/command", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionKey: key, command }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          text?: string;
          pending?: boolean;
          error?: string;
        };
        if (!res.ok) {
          setNotice({
            title: "That command did not run",
            body: body.error ?? "The gateway refused the command.",
            tone: "warning",
          });
          return;
        }
        if (body.text) {
          setMessages((current) => [
            ...current,
            makeMessage("assistant", body.text as string, { source: "command" }),
          ]);
        } else if (body.pending) {
          setNotice({
            title: "Still running",
            body: "The command is taking a while. Its reply will appear when the transcript refreshes.",
            tone: "neutral",
          });
        }
      } catch {
        setNotice({
          title: "That command did not run",
          body: "Mission Control could not reach the gateway.",
          tone: "warning",
        });
      } finally {
        setCommandRunning(false);
        void sessions.refresh();
      }
    },
    [
      agentId,
      clearError,
      handleNewChat,
      registerDraftSession,
      sessionKey,
      sessions,
      setMessages,
    ],
  );

  /* ── Scrolling ───────────────────────────────────────────────────────── */

  const handleScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    setAtBottom(distance < 120);
  }, []);

  useEffect(() => {
    if (!isVisible) return;
    if (!atBottom) return;
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, status, interaction?.id, interaction?.updatedAt, isVisible, atBottom]);

  /* ── Unread badges ───────────────────────────────────────────────────── */

  useEffect(() => {
    if (messages.length > seenMessagesRef.current) {
      const fresh = messages.slice(seenMessagesRef.current);
      if (!isVisible && fresh.some((message) => message.role === "assistant")) {
        addUnread(agentId, resolvedAgent ? agentLabel(resolvedAgent) : agentId);
      }
    }
    seenMessagesRef.current = messages.length;
  }, [messages, isVisible, agentId, resolvedAgent]);

  useEffect(() => {
    if (isVisible && agentId) clearUnread(agentId);
  }, [isVisible, agentId]);

  /* ── Derived UI values ───────────────────────────────────────────────── */

  const activeRow = useMemo(
    () => sessions.sessions.find((row) => row.key === sessionKey) ?? null,
    [sessions.sessions, sessionKey],
  );
  const agentName = resolvedAgent ? agentLabel(resolvedAgent) : "your agent";
  const rawModel = resolvedAgent ? shortModel(resolvedAgent.model) : "";
  // Agents often have no display name, in which case the label already *is*
  // the model — printing it twice reads like a bug.
  const modelLabel =
    rawModel && rawModel.toLowerCase() !== agentName.toLowerCase() ? rawModel : "";
  /**
   * "32.7k tokens" means nothing to someone who has never heard of a token.
   * What a person actually wants to know is whether this conversation is
   * getting close to the point where the agent starts forgetting the start of
   * it — so express it as how full the conversation is, and only speak up when
   * it is worth knowing.
   */
  const contextLabel = (() => {
    const used = activeRow?.totalTokens ?? 0;
    const capacity = activeRow?.contextTokens ?? 0;
    if (!used) return null;
    if (!capacity) return `${formatTokens(used)} used`;
    const percent = Math.min(100, Math.round((used / capacity) * 100));
    if (percent < 50) return null; // Nothing useful to say yet.
    if (percent < 80) return `Conversation ${percent}% full`;
    return `Conversation ${percent}% full — older messages may drop soon`;
  })();

  const composerAgents: ChatAgent[] = useMemo(
    () =>
      agents.map((agent) => ({
        id: agent.id,
        name: agentLabel(agent),
        emoji: agent.emoji,
        model: agent.model,
        isDefault: agent.isDefault,
      })),
    [agents],
  );

  const noModels = modelCount === 0 && warmupExpired;
  const isEmpty = messages.length === 0 && !historyLoading && !interaction && !interactionLoading;
  const streamingId =
    isStreaming && messages.length
      ? messages[messages.length - 1].role === "assistant"
        ? messages[messages.length - 1].id
        : null
      : null;

  const errorShape = error ? classifyChatError(error.message) : null;
  const interactionReplies = useMemo(
    () => interactionReplyMessages(interaction),
    [interaction],
  );

  useEffect(() => {
    if (renaming) requestAnimationFrame(() => renameInputRef.current?.select());
  }, [renaming]);

  /* ── Agents missing ──────────────────────────────────────────────────── */

  if (agentsLoaded && agents.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <AgentsUnavailable warming={!warmupExpired} onRetry={() => void loadBootstrap()} />
      </div>
    );
  }

  const headerTitle =
    interaction?.status === "open"
      ? interaction.title
      : activeRow?.title ?? (sessionIsDraft ? "New conversation" : "Conversation");
  const conversationAttention = interaction?.status === "open"
    ? {
        id: interaction.id,
        title: interaction.title,
        question: interaction.question,
        createdAt: interaction.createdAt,
        sessionKey: interaction.source.sessionKey,
      }
    : null;
  const selectConversationAttention = (attention: { id: string }) => {
    setSidebarOpen(false);
    router.push(`/chat?interaction=${encodeURIComponent(attention.id)}`);
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* ── Conversation rail ─────────────────────────────────────────── */}
      <aside className="hidden w-[264px] shrink-0 border-r border-border lg:block">
        <SessionSidebar
          sessions={sessions.sessions}
          activeKey={sessionKey}
          failure={sessions.failure}
          loaded={sessions.loaded}
          onSelect={selectSession}
          onNewChat={handleNewChat}
          onRename={(key, label) => void sessions.rename(key, label)}
          onTogglePin={(key, pinned) => void sessions.setPinned(key, pinned)}
          onDelete={(key) => {
            void sessions.remove(key);
            if (key === sessionKey) startNewChat(agentId, { push: false });
          }}
          onRetry={() => void sessions.refresh()}
          attention={conversationAttention}
          onSelectAttention={selectConversationAttention}
        />
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close conversation list"
            onClick={() => setSidebarOpen(false)}
            className="absolute inset-0 bg-background/70 backdrop-blur-sm"
          />
          <div className="absolute inset-y-0 left-0 w-[280px] border-r border-border shadow-2xl">
            <SessionSidebar
              sessions={sessions.sessions}
              activeKey={sessionKey}
              failure={sessions.failure}
              loaded={sessions.loaded}
              onSelect={selectSession}
              onNewChat={handleNewChat}
              onRename={(key, label) => void sessions.rename(key, label)}
              onTogglePin={(key, pinned) => void sessions.setPinned(key, pinned)}
              onDelete={(key) => {
                void sessions.remove(key);
                if (key === sessionKey) startNewChat(agentId, { push: false });
              }}
              onRetry={() => void sessions.refresh()}
              attention={conversationAttention}
              onSelectAttention={selectConversationAttention}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      {/* ── Conversation ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Show conversations"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <PanelLeft className="h-4 w-4" aria-hidden />
          </button>

          {renaming && activeRow ? (
            <input
              ref={renameInputRef}
              defaultValue={activeRow.title}
              aria-label="Conversation name"
              onBlur={(event) => {
                setRenaming(false);
                const next = event.target.value.trim();
                if (next && next !== activeRow.title) {
                  void sessions.rename(activeRow.key, next);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = activeRow.title;
                  event.currentTarget.blur();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] text-foreground outline-none"
            />
          ) : (
            <button
              type="button"
              disabled={!activeRow}
              onClick={() => setRenaming(true)}
              title={activeRow ? "Rename this conversation" : undefined}
              className="group/title flex min-w-0 flex-1 items-center gap-2 rounded-full px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate text-[13.5px] text-foreground">
                {headerTitle}
              </span>
              {activeRow && (
                <Pencil
                  className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/title:opacity-100"
                  aria-hidden
                />
              )}
            </button>
          )}

          <button
            type="button"
            onClick={handleNewChat}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring lg:hidden"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            New
          </button>
        </header>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className={cn(
            "relative min-h-0 flex-1 overflow-y-auto",
            isEmpty && "flex flex-col justify-center",
          )}
        >
          {isEmpty ? (
            <ChatHero
              title={`Chat with ${agentName}`}
              subtitle={
                noModels
                  ? "Connect a model provider to start the conversation."
                  : "Ask anything. Type / for gateway commands, or @ to reference a file from the workspace."
              }
            />
          ) : (
            <div
              className="mx-auto w-full max-w-3xl px-5 py-8"
              role="log"
              aria-live="polite"
              aria-relevant="additions text"
              aria-busy={isBusy}
              aria-label="Conversation transcript"
            >
              {historyTruncated && (
                <p className="mb-6 text-center text-[11.5px] text-muted-foreground">
                  Showing the most recent {MESSAGE_HISTORY_LIMIT} messages of
                  this conversation.
                </p>
              )}
              <MessageList messages={messages} streamingId={streamingId} />
              {interaction && (
                <div className="mt-2 mb-6 rounded-lg border border-border bg-card p-4 shadow-sm" data-interaction-id={interaction.id}>
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-muted text-fg-subtle">
                      <CircleHelp className="h-4 w-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-semibold text-foreground">{interaction.title}</p>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs capitalize text-muted-foreground">
                          {interaction.status === "open" ? "Needs your answer" : interaction.status}
                        </span>
                      </div>
                      {interaction.context && (
                        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{interaction.context}</p>
                      )}
                      <p className="mt-3 text-[15px] font-medium leading-relaxed text-foreground">{interaction.question}</p>
                      {interaction.status === "open" && (
                        <p className="mt-2 text-xs text-fg-subtle">Reply in the message box below. Your answer will resume the paused cron run.</p>
                      )}
                      {interaction.status === "resuming" && (
                        <p className="mt-2 text-xs text-muted-foreground">Answer received. The original run is continuing from its checkpoint.</p>
                      )}
                      {interaction.status === "completed" && (
                        <p className="mt-2 text-xs text-success-fg">The resumed work finished.</p>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {interactionReplies.length > 0 && (
                <MessageList messages={interactionReplies} streamingId={null} />
              )}
              {(status === "submitted" || commandRunning || interactionBusy) && (
                <ThinkingIndicator
                  label={interactionBusy ? "Resuming background work" : commandRunning ? "Running command" : "Thinking"}
                />
              )}
              <div ref={bottomRef} />
            </div>
          )}

          {historyLoading && (
            <div className="mx-auto w-full max-w-3xl px-5 py-8" aria-hidden>
              {[0, 1].map((index) => (
                <div key={index}>
                  {/* user turn: short, right-aligned, bubble-shaped */}
                  <div className="mb-7 flex justify-end">
                    <div className="h-9 w-2/5 animate-pulse rounded-2xl bg-muted" />
                  </div>
                  {/* assistant turn: full-width card with lines of prose */}
                  <div className="mb-9 space-y-2.5 rounded-2xl bg-card/60 px-4 py-3 ring-1 ring-border/60">
                    <div className="h-3 w-full animate-pulse rounded-full bg-muted" />
                    <div className="h-3 w-11/12 animate-pulse rounded-full bg-muted" />
                    <div className="h-3 w-3/4 animate-pulse rounded-full bg-muted" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {!atBottom && !isEmpty && (
          <div className="pointer-events-none relative">
            <button
              type="button"
              onClick={() => {
                setAtBottom(true);
                bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
              }}
              className="pointer-events-auto absolute -top-11 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-lg transition-colors hover:text-foreground"
              aria-label="Jump to latest message"
            >
              <ArrowDown className="h-4 w-4" aria-hidden />
            </button>
          </div>
        )}

        <div className="shrink-0 px-4 pb-5 pt-1">
          {notice && (
            <InlineNotice shape={notice} onDismiss={() => setNotice(null)} />
          )}
          {errorShape && (
            <InlineNotice
              shape={errorShape}
              onDismiss={() => clearError()}
            />
          )}
          <Composer
            agentId={agentId}
            agentName={agentName}
            agents={composerAgents}
            modelLabel={modelLabel}
            contextLabel={contextLabel}
            disabled={!agentId || noModels}
            disabledPlaceholder={
              noModels
                ? "Connect a model provider to start chatting"
                : "Waiting for the gateway…"
            }
            placeholder={interaction?.status === "open" ? "Type your clarification…" : undefined}
            isStreaming={isStreaming || status === "submitted" || interactionBusy}
            showStarters={isEmpty && !noModels && !interaction}
            onSubmit={(submission) => void handleSubmit(submission)}
            onCommand={(command) => void handleCommand(command)}
            onStop={stop}
            onSwitchAgent={switchAgent}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Export ───────────────────────────────────────────────────────────────── */

function ChatViewFallback() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <div className="h-3 w-40 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

export function ChatView({ isVisible = true }: { isVisible?: boolean }) {
  // useSearchParams needs a Suspense boundary, and this component is rendered
  // from a shared client shell that must not be edited from here.
  return (
    <Suspense fallback={<ChatViewFallback />}>
      <ChatViewInner isVisible={isVisible} />
    </Suspense>
  );
}
