"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Trash2, RefreshCw, MessageSquare, Clock, Zap, DollarSign, AlertCircle } from "lucide-react";
import { estimateCostUsd } from "@/lib/model-metadata";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { notifyError } from "@/lib/notification-store";
import { classifySessionKind, sessionKindOf } from "@/lib/session-kinds";
import { SessionTranscriptPanel } from "@/components/session-transcript-panel";

type Session = {
  key: string;
  kind: string;
  updatedAt?: number | null;
  ageMs?: number | null;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  model: string;
  contextTokens: number;
};

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatAge(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function getAgeMs(session: Session): number | null {
  const ageMs = Number(session.ageMs);
  if (Number.isFinite(ageMs) && ageMs >= 0) return ageMs;

  const updatedAt = Number(session.updatedAt);
  if (Number.isFinite(updatedAt) && updatedAt > 0) {
    return Math.max(0, Date.now() - updatedAt);
  }
  return null;
}

/**
 * Origin label for a session. Neutral by design: the kind of a session is
 * metadata, not a status, so it gets no colour. Colour on this page is reserved
 * for the one thing that deserves attention — destroying a conversation.
 * Classification comes from the shared helper rather than ad-hoc key matching.
 */
function sessionLabel(key: string): string {
  return classifySessionKind(sessionKindOf({ key })).label;
}

export function SessionsView() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [openSession, setOpenSession] = useState<string | null>(null);
  const hasLoadedOnce = useRef(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/sessions", {
        cache: "no-store",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const msg = `Failed to load sessions (${res.status})`;
        if (!hasLoadedOnce.current) setError(msg);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      const data = await res.json();
      const list = Array.isArray(data.sessions) ? data.sessions : [];
      setSessions(list);
      setError(null);
      hasLoadedOnce.current = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Network error";
      if (!hasLoadedOnce.current) setError(msg);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useSmartPoll(fetchSessions, { intervalMs: 10_000 });

  const killSession = useCallback(
    async (key: string) => {
      setDeleting(key);
      try {
        const res = await fetch(
          `/api/sessions?key=${encodeURIComponent(key)}`,
          { method: "DELETE", signal: AbortSignal.timeout(10000) },
        );
        if (!res.ok) {
          notifyError("Session kill failed", `Failed to kill session (${res.status})`, "sessions");
          setDeleting(null);
          return;
        }
        const data = await res.json();
        if (data.ok || data.deleted) {
          setSessions((prev) => prev.filter((s) => s.key !== key));
          setConfirmDelete(null);
        } else {
          notifyError("Session kill failed", "Gateway did not confirm deletion", "sessions");
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Network error";
        notifyError("Session kill failed", errMsg, "sessions");
      }
      setDeleting(null);
    },
    [],
  );

  // Clear stale confirmDelete if the session disappeared (deferred to avoid
  // a synchronous setState cascade inside the effect)
  useEffect(() => {
    if (confirmDelete && !sessions.some((s) => s.key === confirmDelete)) {
      const t = setTimeout(() => setConfirmDelete(null), 0);
      return () => clearTimeout(t);
    }
  }, [confirmDelete, sessions]);

  if (loading) {
    return (
      <SectionLayout>
        <ScreenLoadingState />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title={`Sessions (${sessions.length})`}
        description="Every conversation your agents are holding. Open one to read what happened."
        actions={
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              fetchSessions();
            }}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 dark:hover:bg-secondary"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} /> Refresh
          </button>
        }
      />

      <SectionBody width="content" padding="compact" innerClassName="space-y-2">
        {/* Error banner */}
        {error && sessions.length === 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-danger-border bg-danger-bg px-4 py-3">
            <AlertCircle className="h-4 w-4 shrink-0 text-danger-fg" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-danger-fg">
                Failed to load sessions
              </p>
              <p className="mt-0.5 text-xs text-danger-fg">
                {error}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                setError(null);
                fetchSessions();
              }}
              className="shrink-0 rounded-lg bg-danger-bg px-3 py-1.5 text-xs font-medium text-danger-fg transition-colors hover:bg-danger-bg"
            >
              Retry
            </button>
          </div>
        )}

        {sessions.map((s) => {
          const type = sessionLabel(s.key);
          const isConfirming = confirmDelete === s.key;
          const isDeleting = deleting === s.key;
          const ageMs = getAgeMs(s);
          const ageLabel = ageMs === null ? "Unknown" : `${formatAge(ageMs)} ago`;
          const canOpen = classifySessionKind(sessionKindOf({ key: s.key })).isInspectable;
          return (
            <div
              key={s.key}
              className={cn(
                "rounded-xl border border-border bg-card p-4 transition-colors",
                canOpen && "cursor-pointer hover:border-border-strong hover:bg-muted/40",
              )}
              onClick={canOpen ? () => setOpenSession(s.key) : undefined}
              role={canOpen ? "button" : undefined}
              tabIndex={canOpen ? 0 : undefined}
              onKeyDown={
                canOpen
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpenSession(s.key);
                      }
                    }
                  : undefined
              }
            >
              <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {/* Origin is metadata, not status — it gets no colour. */}
                    <span className="text-sm font-medium text-foreground">{type}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {s.key}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" /> {ageLabel}
                    </span>
                    <span className="flex items-center gap-1">
                      <Zap className="h-3 w-3" /> {formatTokens(s.totalTokens)} tokens
                    </span>
                    <span>
                      In: {formatTokens(s.inputTokens)} / Out: {formatTokens(s.outputTokens)}
                    </span>
                    {(() => {
                      const cost = estimateCostUsd(s.model, s.inputTokens, s.outputTokens);
                      if (cost === null) return null;
                      return (
                        <span className="flex items-center gap-1">
                          <DollarSign className="h-3 w-3" />
                          {cost < 0.01 ? "<$0.01" : `$${cost.toFixed(2)}`}
                        </span>
                      );
                    })()}
                    <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-xs font-mono text-fg-secondary">
                      {s.model}
                    </span>
                  </div>
                </div>

                {/* Kill button */}
                <div className="shrink-0">
                  {isConfirming ? (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void killSession(s.key); }}
                        disabled={isDeleting}
                        className="rounded-lg bg-destructive px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-destructive/88 disabled:opacity-50"
                      >
                        {isDeleting ? "Killing..." : "Confirm Kill"}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                        className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(s.key); }}
                      className="rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-danger-bg hover:text-danger-fg"
                      title="Kill session"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        {sessions.length === 0 && !error && (
          <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
            No active sessions
          </div>
        )}
      </SectionBody>

      <SessionTranscriptPanel
        sessionKey={openSession}
        fallbackTitle={openSession ? sessionLabel(openSession) : undefined}
        subtitle={
          openSession
            ? sessions.find((x) => x.key === openSession)?.model
            : undefined
        }
        onClose={() => setOpenSession(null)}
      />
    </SectionLayout>
  );
}
