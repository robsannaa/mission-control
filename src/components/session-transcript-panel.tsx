"use client";

import { useCallback, useEffect, useState } from "react";
import { X, AlertCircle, Bot, User, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { useFocusTrap, useBodyScrollLock } from "@/hooks/use-modal-accessibility";

/* ── types ────────────────────────────────────────── */

type TranscriptMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
};

type TranscriptResponse = {
  sessionKey: string;
  sessionId: string | null;
  kind: string;
  title: string;
  isChat: boolean;
  messages: TranscriptMessage[];
  limit: number;
  truncated: boolean;
};

type Props = {
  sessionKey: string | null;
  /** Shown in the header before the transcript loads. */
  fallbackTitle?: string;
  subtitle?: string;
  onClose: () => void;
};

/* ── helpers ──────────────────────────────────────── */

/**
 * Message content arrives as a string, or as an array of parts, or as an
 * object — depending on which client wrote the turn. Flatten defensively:
 * showing nothing because the shape surprised us is the worst outcome.
 */
function contentToText(content: unknown): { text: string; machinery: string[] } {
  const machinery: string[] = [];

  const flatten = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") return p.text;
            if (typeof p.content === "string") return p.content;
            // Thinking blocks and tool calls are machinery, not conversation.
            // Record that they happened, but keep them out of the reading flow.
            if (typeof p.type === "string") {
              machinery.push(String(p.type));
              return "";
            }
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (value && typeof value === "object") {
      const c = value as Record<string, unknown>;
      if (typeof c.text === "string") return c.text;
      // A raw JSON payload (tool result): pretty-print rather than dump one
      // long escaped line.
      try {
        return JSON.stringify(value, null, 2);
      } catch {
        return "";
      }
    }
    return "";
  };

  let text = flatten(content);

  // Tool results often arrive as JSON whose fields contain escaped newlines.
  // Unescaping makes them readable instead of a single wall of characters.
  if (text.includes("\\n")) text = text.replace(/\\n/g, "\n");

  return { text: text.trim(), machinery };
}

/** Machinery turns are collapsed by default — they are debugging detail. */
function isMachineryRole(role: string | undefined): boolean {
  const r = (role || "").toLowerCase();
  return r === "tool" || r === "function" || r === "toolresult" || r === "tool_result";
}

function roleMeta(role: string | undefined): {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
} {
  const r = (role || "").toLowerCase();
  if (r === "user") return { label: "You", icon: User };
  if (r === "assistant") return { label: "Agent", icon: Bot };
  if (r === "tool" || r === "function") return { label: "Tool", icon: Wrench };
  return { label: r ? r[0].toUpperCase() + r.slice(1) : "Message", icon: Bot };
}

function formatTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── component ────────────────────────────────────── */

export function SessionTranscriptPanel({
  sessionKey,
  fallbackTitle,
  subtitle,
  onClose,
}: Props) {
  const [data, setData] = useState<TranscriptResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const focusTrapRef = useFocusTrap(Boolean(sessionKey));
  useBodyScrollLock(Boolean(sessionKey));

  const load = useCallback(async (key: string) => {
    setLoading(true);
    setError(null);
    setUnavailable(false);
    setData(null);
    try {
      const res = await fetch(
        `/api/chat/history?sessionKey=${encodeURIComponent(key)}&limit=200`,
        { cache: "no-store" },
      );
      if (res.status === 403) {
        setUnavailable(true);
        return;
      }
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
      setData(body as TranscriptResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this conversation.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionKey) void load(sessionKey);
  }, [sessionKey, load]);

  useEffect(() => {
    if (!sessionKey) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sessionKey, onClose]);

  if (!sessionKey) return null;

  const messages = data?.messages ?? [];
  const title = data?.title || fallbackTitle || "Conversation";

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      <div
        ref={focusTrapRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Transcript: ${title}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
            <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground/70">
              {sessionKey}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close transcript"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading && (
            <div className="space-y-5" aria-live="polite" aria-busy="true">
              {[0, 1, 2].map((i) => (
                <div key={i} className="space-y-2">
                  <div className="h-3 w-16 animate-pulse rounded bg-muted" />
                  <div className="h-3 w-full animate-pulse rounded bg-muted" />
                  <div className="h-3 w-4/5 animate-pulse rounded bg-muted" />
                </div>
              ))}
            </div>
          )}

          {unavailable && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <AlertCircle className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm font-medium text-foreground">Not viewable here</p>
              <p className="max-w-xs text-xs leading-5 text-muted-foreground">
                This session belongs to a channel conversation. Those stay private to
                the channel they happened in.
              </p>
            </div>
          )}

          {error && !unavailable && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <AlertCircle className="h-5 w-5 text-danger-fg" />
              <p className="text-sm font-medium text-foreground">
                Could not load this conversation
              </p>
              <p className="max-w-xs text-xs leading-5 text-muted-foreground">{error}</p>
              <button
                type="button"
                onClick={() => void load(sessionKey)}
                className="mt-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Try again
              </button>
            </div>
          )}

          {!loading && !error && !unavailable && messages.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-16 text-center">
              <p className="text-sm font-medium text-foreground">Nothing was said yet</p>
              <p className="max-w-xs text-xs leading-5 text-muted-foreground">
                This session exists but has no messages.
              </p>
            </div>
          )}

          {messages.length > 0 && (
            <div className="space-y-6">
              {data?.truncated && (
                <p className="text-center text-xs text-muted-foreground">
                  Showing the most recent {messages.length} messages
                </p>
              )}
              {messages.map((m, i) => {
                const { label, icon: Icon } = roleMeta(m.role);
                const { text, machinery } = contentToText(m.content);
                const isUser = (m.role || "").toLowerCase() === "user";
                const isMachinery = isMachineryRole(m.role);

                // Tool traffic is collapsed: the transcript should read as a
                // conversation, with the plumbing available on demand.
                if (isMachinery) {
                  return (
                    <details key={i} className="group min-w-0">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
                        <Wrench className="h-3 w-3" />
                        <span className="font-medium uppercase tracking-wide">
                          {label}
                        </span>
                        {m.timestamp && <span>· {formatTime(m.timestamp)}</span>}
                        <span className="ml-1 text-muted-foreground/70 group-open:hidden">
                          show
                        </span>
                        <span className="ml-1 hidden text-muted-foreground/70 group-open:inline">
                          hide
                        </span>
                      </summary>
                      <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted/60 p-3 text-xs leading-5 text-fg-secondary">
                        {text || "(empty)"}
                      </pre>
                    </details>
                  );
                }

                return (
                  <div key={i} className="min-w-0">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Icon className="h-3 w-3 text-muted-foreground" />
                      <span
                        className={cn(
                          "text-[11px] font-medium uppercase tracking-wide",
                          isUser ? "text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {label}
                      </span>
                      {m.timestamp && (
                        <span className="text-[11px] text-muted-foreground/70">
                          · {formatTime(m.timestamp)}
                        </span>
                      )}
                    </div>
                    {text && (
                      <div
                        className={cn(
                          "whitespace-pre-wrap break-words text-sm leading-6",
                          isUser ? "text-foreground" : "text-fg-secondary",
                        )}
                      >
                        {text}
                      </div>
                    )}
                    {!text && machinery.length === 0 && (
                      <span className="text-sm italic text-muted-foreground">
                        (no text content)
                      </span>
                    )}
                    {machinery.length > 0 && (
                      <p className="mt-1 text-[11px] text-muted-foreground/70">
                        {machinery.includes("thinking") && "thought · "}
                        {machinery.filter((x) => x !== "thinking").length > 0 &&
                          `used ${machinery.filter((x) => x !== "thinking").length} tool${
                            machinery.filter((x) => x !== "thinking").length > 1 ? "s" : ""
                          }`}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
