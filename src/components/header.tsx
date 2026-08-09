"use client";

import {
  Suspense,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  Search,
  Power,
  Zap,
  Send,
  ChevronDown,
  Check,
  AlertTriangle,
  Loader2,
  X,
  Wifi,
  WifiOff,
  Activity,
  MessageSquare,
  Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SearchModal } from "./search-modal";
import { NotificationCenter } from "./notification-center";
import { ThemeToggle } from "./theme-toggle";
import { chatStore, type ChatMessage } from "@/lib/chat-store";
import {
  notifyGatewayRestarting as notifyGatewayRestartingStore,
  useGatewayStatusStore,
  type GatewayHealth,
  type GatewayStatus,
} from "@/lib/gateway-status-store";
import {
  getTimeFormatServerSnapshot,
  getTimeFormatSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";

/* ── Types ──────────────────────────────────────── */

type AgentInfo = {
  id: string;
  name: string;
  model: string;
};

/* ── Agent Chat Panel (persistent, global state) ── */

function useChatState() {
  return useSyncExternalStore(chatStore.subscribe, chatStore.getSnapshot, chatStore.getServerSnapshot);
}

function formatTime(ts: number, timeFormat: TimeFormatPreference) {
  return new Date(ts).toLocaleTimeString(
    [],
    withTimeFormat({ hour: "2-digit", minute: "2-digit" }, timeFormat),
  );
}

function ChatBubble({ msg, timeFormat }: { msg: ChatMessage; timeFormat: TimeFormatPreference }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-md rounded-2xl rounded-tr-sm border border-primary/30 bg-primary text-primary-foreground px-3.5 py-2 text-xs leading-relaxed shadow-sm dark:border-border dark:bg-muted-foreground dark:text-white">
          <p className="whitespace-pre-wrap break-words">{msg.text}</p>
          <p className="mt-1 text-right text-xs text-white/70 dark:text-white/75">{formatTime(msg.timestamp, timeFormat)}</p>
        </div>
      </div>
    );
  }
  if (msg.role === "error") {
    return (
      <div className="flex justify-start">
        <div className="max-w-md rounded-2xl rounded-tl-sm border border-danger-border bg-danger-bg px-3.5 py-2 text-xs leading-relaxed text-danger-fg shadow-sm">
          <div className="mb-1 flex items-center gap-1 text-xs font-medium text-danger-fg">
            <AlertTriangle className="h-3 w-3" />Error
          </div>
          <p className="whitespace-pre-wrap break-words">{msg.text}</p>
          <p className="mt-1 text-xs text-danger-fg">{formatTime(msg.timestamp, timeFormat)}</p>
        </div>
      </div>
    );
  }
  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-md rounded-2xl rounded-tl-sm border border-foreground/10 bg-foreground/5 px-3.5 py-2 text-xs leading-relaxed text-foreground shadow-sm">
        <p className="whitespace-pre-wrap break-words">{msg.text}</p>
        <p className="mt-1 text-xs text-fg-subtle">{formatTime(msg.timestamp, timeFormat)}</p>
      </div>
    </div>
  );
}

export function AgentChatPanel() {
  const chat = useChatState();
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [prompt, setPrompt] = useState("");
  const [showAgentPicker, setShowAgentPicker] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Mount a dedicated portal root as the last child of body so the panel is always viewport-fixed
  useEffect(() => {
    const el = document.createElement("div");
    el.id = "agent-chat-portal-root";
    document.body.appendChild(el);
    setPortalRoot(el);
    return () => {
      if (document.body.contains(el)) document.body.removeChild(el);
    };
  }, []);

  // Fetch agents once
  useEffect(() => {
    fetch("/api/agents", { signal: AbortSignal.timeout(8000) })
      .then((r) => r.json())
      .then((data) => {
        const list = (data.agents || data || []) as AgentInfo[];
        setAgents(list);
        if (list.length > 0 && !chat.agentId) {
          chatStore.setAgent(list[0].id);
        }
      })
      .catch(() => { });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Request notification permission on first open
  useEffect(() => {
    if (chat.open) {
      chatStore.requestNotificationPermission();
    }
  }, [chat.open]);

  // Focus input when panel opens
  useEffect(() => {
    if (chat.open) {
      setTimeout(() => inputRef.current?.focus(), 150);
    }
  }, [chat.open]);

  // Scroll to bottom on new messages
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.open]);

  // Close on Escape — close agent picker first if open, then panel
  useEffect(() => {
    if (!chat.open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (showAgentPicker) {
          setShowAgentPicker(false);
        } else {
          chatStore.close();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chat.open, showAgentPicker]);

  // Close on click outside
  useEffect(() => {
    if (!chat.open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close if clicking the Ping Agent button (it has its own toggle)
        const target = e.target as HTMLElement;
        if (target.closest("[data-chat-toggle]")) return;
        chatStore.close();
      }
    };
    // Use setTimeout to avoid closing immediately on the same click that opened it
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handler); };
  }, [chat.open]);

  // Close agent picker on click outside it
  useEffect(() => {
    if (!showAgentPicker) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // The picker is inside the panel, so check if click is within the agent selector area
      if (!target.closest("[data-agent-picker]")) {
        setShowAgentPicker(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showAgentPicker]);

  const handleSend = useCallback(() => {
    if (!prompt.trim() || chat.sending) return;
    chatStore.send(prompt.trim());
    setPrompt("");
    // Reset textarea height after clearing
    if (inputRef.current) inputRef.current.style.height = "auto";
  }, [prompt, chat.sending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const currentAgent = agents.find((a) => a.id === chat.agentId);

  if (!chat.open || !portalRoot) return null;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Agent Chat"
      style={{
        position: "fixed",
        right: 16,
        top: 56,
        zIndex: 99999,
      }}
      className="flex max-h-[min(70vh,600px)] w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-2xl border border-foreground/10 bg-card/95 shadow-2xl backdrop-blur-md animate-in slide-in-from-top-2 fade-in duration-200 sm:w-auto sm:max-w-md"
    >
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-foreground/10 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
            <MessageSquare className="h-3.5 w-3.5 text-foreground" />
          </div>
          <div>
            <p className="text-xs font-semibold text-foreground">Agent Chat</p>
            <p className="text-xs text-fg-subtle">
              {chat.messages.length} messages
              {chat.sending && " · typing..."}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {chat.messages.length > 0 && (
            <button
              type="button"
              onClick={() => chatStore.clearMessages()}
              className="rounded-md p-1.5 text-fg-subtle transition hover:bg-muted/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Clear chat"
              aria-label="Clear chat history"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => chatStore.close()}
            className="rounded-md p-1.5 text-fg-subtle transition hover:bg-muted/60 hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close chat panel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Agent selector */}
      <div className="shrink-0 border-b border-foreground/10 px-4 py-2" data-agent-picker>
        <div className="relative">
          <button
            type="button"
            onClick={() => setShowAgentPicker(!showAgentPicker)}
            className="flex w-full items-center gap-2 rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="text-xs text-muted-foreground">Agent:</span>
            <span className="flex-1 truncate text-xs font-medium text-fg-secondary">
              {currentAgent?.name || currentAgent?.id || "Select agent..."}
            </span>
            {currentAgent?.model && (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-fg-subtle">
                {currentAgent.model.split("/").pop()}
              </span>
            )}
            <ChevronDown className="h-3 w-3 shrink-0 text-fg-subtle" />
          </button>

          {showAgentPicker && agents.length > 0 && (
            <div className="absolute left-0 top-full z-10 mt-1 w-full overflow-hidden rounded-lg border border-foreground/10 bg-card py-1 shadow-lg">
              {agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => {
                    chatStore.setAgent(a.id);
                    setShowAgentPicker(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    a.id === chat.agentId && "bg-muted"
                  )}
                >
                  <span className="text-xs font-medium text-fg-secondary">
                    {a.name || a.id}
                  </span>
                  {a.model && (
                    <span className="ml-auto text-xs text-fg-subtle">
                      {a.model.split("/").pop()}
                    </span>
                  )}
                  {a.id === chat.agentId && (
                    <Check className="h-3 w-3 shrink-0 text-foreground" />
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
        {chat.messages.length === 0 && !chat.sending && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
              <Zap className="h-6 w-6 text-fg-secondary" />
            </div>
            <p className="text-sm font-medium text-fg-secondary">Send a message</p>
            <p className="max-w-xs text-xs text-fg-subtle">
              Chat with your agents. History is kept while the app is open.
            </p>
          </div>
        )}
        {chat.messages.map((msg) => (
          <ChatBubble key={msg.id} msg={msg} timeFormat={timeFormat} />
        ))}
        {chat.sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-foreground/10 bg-foreground/5 px-3.5 py-2.5 shadow-sm">
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
              </span>
              <span className="text-xs text-fg-subtle">Agent is thinking...</span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-foreground/10 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message your agent..."
            rows={1}
            disabled={chat.sending || !chat.agentId}
            className="flex-1 resize-none rounded-xl border border-foreground/10 bg-foreground/5 px-3.5 py-2 text-xs text-foreground placeholder:text-fg-subtle focus:border-ring focus:ring-2 focus:ring-ring/20 focus:outline-none disabled:opacity-50"
            style={{ maxHeight: "80px" }}
            onInput={(e) => {
              const ta = e.target as HTMLTextAreaElement;
              ta.style.height = "auto";
              ta.style.height = Math.min(ta.scrollHeight, 80) + "px";
            }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!prompt.trim() || !chat.agentId || chat.sending}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chat.sending ? (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-fg-subtle">
          Enter to send · Shift+Enter for newline · Esc to close
        </p>
      </div>
    </div>
  );

  return createPortal(panel, portalRoot);
}

/* ── Gateway Power Toggle ──────────────────────── */

function useGatewayPower() {
  const [busy, setBusy] = useState(false);
  const { status } = useGatewayStatusStore();

  const isAlive = status === "online" || status === "degraded";

  const toggle = useCallback(async () => {
    setBusy(true);
    notifyGatewayRestarting();
    try {
      if (isAlive) {
        // Gateway is running → kill it
        await fetch("/api/gateway", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "stop" }),
        });
      } else {
        // Gateway is dead → spin it up
        await fetch("/api/gateway", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "restart" }),
        });
      }
    } catch {
      // ignore
    }
    setBusy(false);
  }, [isAlive]);

  return { isAlive, busy: busy || status === "loading", toggle };
}

/* ── Gateway Status Hook ───────────────────────── */

/**
 * Dispatch this event from anywhere (e.g. restart-announcement-bar)
 * to tell the status poller to immediately re-check and enter fast-poll mode.
 */
export function notifyGatewayRestarting() {
  notifyGatewayRestartingStore();
}

function useGatewayStatus() {
  const { status, health, latencyMs } = useGatewayStatusStore();
  return { status, health, latencyMs };
}

/* ── Gateway Status Badge ──────────────────────── */

function GatewayStatusBadge({
  status,
  health,
  latencyMs,
}: {
  status: GatewayStatus;
  health: GatewayHealth | null;
  latencyMs?: number | null;
}) {
  const [showPopover, setShowPopover] = useState(false);
  const hideTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleEnter = useCallback(() => {
    if (hideTimeout.current) clearTimeout(hideTimeout.current);
    setShowPopover(true);
  }, []);

  const handleLeave = useCallback(() => {
    hideTimeout.current = setTimeout(() => setShowPopover(false), 200);
  }, []);

  // Extract useful details from health
  const details = useMemo(() => {
    if (!health) return null;
    const gw = health.gateway as Record<string, unknown> | undefined;
    const rawChannels = health.channels;
    const rawAgents = health.agents;
    const version = (gw?.version as string) || null;
    const mode = (gw?.mode as string) || null;
    const port = (gw?.port as number) || 18789;
    const uptime = gw?.uptimeMs as number | undefined;

    // channels/agents may be arrays, objects, or missing — handle all cases
    const channelsArr = Array.isArray(rawChannels) ? rawChannels : [];
    const agentsArr = Array.isArray(rawAgents)
      ? rawAgents
      : rawAgents && typeof rawAgents === "object"
        ? Object.values(rawAgents)
        : [];

    const channelCount = channelsArr.length;
    const activeChannels = channelsArr.filter(
      (c: Record<string, unknown>) => c.connected || c.enabled
    ).length;
    const agentCount = agentsArr.length;

    let uptimeStr: string | null = null;
    if (uptime && uptime > 0) {
      const hours = Math.floor(uptime / 3_600_000);
      const mins = Math.floor((uptime % 3_600_000) / 60_000);
      uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    return { version, mode, port, uptimeStr, channelCount, activeChannels, agentCount };
  }, [health]);

  const statusConfig = {
    online: {
      dot: "bg-success",
      ping: true,
      text: "text-success-fg",
      label: "Online",
      bg: "bg-success-bg border-success-border",
      icon: Wifi,
    },
    degraded: {
      dot: "bg-warning",
      ping: false,
      text: "text-warning-fg",
      label: "Degraded",
      bg: "bg-warning-bg border-warning-border",
      icon: Activity,
    },
    offline: {
      dot: "bg-danger",
      ping: false,
      text: "text-danger-fg",
      label: "Offline",
      bg: "bg-danger-bg border-danger-border",
      icon: WifiOff,
    },
    loading: {
      dot: "bg-muted-foreground animate-pulse",
      ping: false,
      text: "text-muted-foreground dark:text-fg-subtle",
      label: "Checking…",
      bg: "bg-muted border-border",
      icon: Loader2,
    },
  };

  const cfg = statusConfig[status];
  const Icon = cfg.icon;

  return (
    <div
      className="relative"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <div
        className={cn(
          "flex cursor-default items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
          cfg.bg
        )}
      >
        {/* Dot */}
        <span className="relative flex h-2 w-2">
          {cfg.ping && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-50",
                cfg.dot
              )}
            />
          )}
          <span
            className={cn(
              "relative inline-flex h-2 w-2 rounded-full",
              cfg.dot
            )}
          />
        </span>
        {/* Label */}
        <span className={cn("text-xs font-medium", cfg.text)}>
          {cfg.label}
        </span>
      </div>

      {/* Popover */}
      {showPopover && (
        <div className="absolute left-0 top-full z-50 mt-2 w-64 overflow-hidden rounded-xl border border-border bg-popover/95 shadow-2xl backdrop-blur-sm animate-enter">
          {/* Header */}
          <div className={cn("flex items-center gap-2.5 px-3.5 py-3 border-b border-border", cfg.bg)}>
            <Icon className={cn("h-3.5 w-3.5", cfg.text, status === "loading" && "animate-pulse")} />
            <div>
              <p className={cn("text-xs font-semibold", cfg.text)}>
                Gateway {cfg.label}
              </p>
              <p className="text-xs text-muted-foreground">
                {status === "offline"
                  ? "Cannot reach gateway process"
                  : status === "degraded"
                    ? "Some services may be unavailable"
                    : status === "loading"
                      ? "Checking gateway health…"
                      : "All systems operational"}
              </p>
            </div>
          </div>

          {/* Details */}
          {details && status !== "loading" && (
            <div className="space-y-0 divide-y divide-foreground/5 px-3.5 py-1">
              {details.uptimeStr && (
                <DetailRow label="Uptime" value={details.uptimeStr} />
              )}
              {details.version && (
                <DetailRow label="Version" value={details.version} />
              )}
              <DetailRow label="Port" value={String(details.port)} />
              {details.mode && (
                <DetailRow label="Mode" value={details.mode} />
              )}
              {details.agentCount > 0 && (
                <DetailRow
                  label="Agents"
                  value={`${details.agentCount} configured`}
                />
              )}
              {details.channelCount > 0 && (
                <DetailRow
                  label="Channels"
                  value={`${details.activeChannels} / ${details.channelCount} active`}
                />
              )}
            </div>
          )}

          {/* Error info */}
          {!!health?.error && (
            <div className="border-t border-border px-3.5 py-2.5">
              <p className="text-xs leading-relaxed text-danger-fg">
                {String(health.error)}
              </p>
            </div>
          )}

          {/* Footer hint */}
          <div className="border-t border-border px-3.5 py-2">
            <p className="text-xs text-fg-subtle">
              {latencyMs !== null && latencyMs !== undefined ? `${latencyMs}ms · ` : ""}Polling every 12s · Use the power button to control gateway
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-xs text-fg-subtle">{label}</span>
      <span className="text-xs font-medium text-fg-secondary">{value}</span>
    </div>
  );
}

/* ── Header ─────────────────────────────────────── */

export function Header() {
  const [searchOpen, setSearchOpen] = useState(false);
  const chat = useChatState();
  const { isAlive, busy: powerBusy, toggle: togglePower } = useGatewayPower();
  const { status: gwStatus, health: gwHealth, latencyMs: gwLatencyMs } = useGatewayStatus();

  // Global Cmd+K / Ctrl+K shortcut
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      setSearchOpen((prev) => !prev);
    }
  }, []);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      <header className="flex shrink-0 items-center justify-between border-b border-border bg-surface-header px-4 py-3 text-xs backdrop-blur-md md:px-8">
        <div className="flex items-center gap-2 ml-11 md:ml-0">
          <GatewayStatusBadge status={gwStatus} health={gwHealth} latencyMs={gwLatencyMs} />
        </div>

        <div className="flex items-center gap-2">
          {/* ── Actions ── */}

          {/* Ping Agent (opens persistent chat panel) */}
          <button
            type="button"
            data-chat-toggle
            onClick={() => chatStore.toggle()}
            className={cn(
              "relative flex h-8 items-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-fg-secondary transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              chat.open
                ? "border-border-strong bg-accent text-foreground"
                : ""
            )}
          >
            <Zap className="h-3 w-3" />
            <span className="hidden md:inline">Ping Agent</span>
            {chat.unread > 0 && !chat.open && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-xs font-bold leading-none text-primary-foreground shadow-lg">
                {chat.unread}
              </span>
            )}
            {chat.sending && !chat.open && (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-primary [animation-delay:300ms]" />
              </span>
            )}
          </button>

          {/* Search */}
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="flex h-8 items-center justify-center gap-1.5 rounded-full border border-border bg-card px-3 text-xs font-medium text-fg-secondary transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:min-w-36 sm:gap-2 sm:px-4 sm:text-sm"
          >
            <Search className="h-3 w-3 sm:h-4 sm:w-4" />
            <span className="hidden sm:inline">Search</span>
            <kbd className="ml-1 hidden rounded-md border border-border bg-muted px-2 py-0.5 font-sans text-xs text-fg-subtle sm:inline">
              ⌘K
            </kbd>
          </button>

          {/* ── System controls ── */}

          {/* Gateway power toggle */}
          <div className="group relative">
            <button
              type="button"
              onClick={() => {
                if (isAlive) {
                  if (window.confirm("Stop the gateway? All running agents and sessions will be interrupted.")) {
                    togglePower();
                  }
                } else {
                  togglePower();
                }
              }}
              disabled={powerBusy}
              className={cn(
                "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium transition-colors disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isAlive
                  ? "border border-danger-border bg-danger-bg text-danger-fg hover:border-danger hover:bg-danger-bg/70"
                  : "border border-success-border bg-success-bg text-success-fg hover:border-success hover:bg-success-bg/70"
              )}
            >
              {powerBusy ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                <Power className="h-3 w-3" />
              )}
              <span className="hidden sm:inline">{isAlive ? "Kill" : "Start"}</span>
            </button>
            <div className="pointer-events-none absolute left-1/2 top-full z-50 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-muted-foreground opacity-0 shadow-md transition-opacity group-hover:opacity-100">
              {isAlive ? "Emergency stop — kill the gateway" : "Start the gateway"}
            </div>
          </div>

          <NotificationCenter />

          {/* ── Settings ── */}

          {/* Theme Toggle */}
          <ThemeToggle />
        </div>
      </header>

      <Suspense fallback={null}>
        <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      </Suspense>
    </>
  );
}
