"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { Trash2, RefreshCw, MessageSquare, Clock, Zap, DollarSign, AlertCircle } from "lucide-react";
import { estimateCostUsd } from "@/lib/model-metadata";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { LoadingState } from "@/components/ui/loading-state";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { notifyError } from "@/lib/notification-store";

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

function sessionLabel(key: string): { type: string; badge: string } {
  if (key.includes(":cron:") && key.includes(":run:"))
    return { type: "Cron Run", badge: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" };
  if (key.includes(":cron:"))
    return { type: "Cron", badge: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300" };
  if (key.includes(":main"))
    return { type: "Main", badge: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300" };
  if (key.includes(":hook:"))
    return { type: "Hook", badge: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300" };
  return { type: "Session", badge: "bg-stone-100 text-stone-600 dark:bg-stone-700/60 dark:text-stone-300" };
}

export function SessionsView() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
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
        <LoadingState label="Loading sessions..." />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title={`Sessions (${sessions.length})`}
        description="Live sessions via Gateway RPC • Kill to clear conversation history"
        actions={
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              fetchSessions();
            }}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900 disabled:opacity-50 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} /> Refresh
          </button>
        }
      />

      <SectionBody width="content" padding="compact" innerClassName="space-y-2">
        {/* Error banner */}
        {error && sessions.length === 0 && (
          <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 dark:border-red-500/20 dark:bg-red-500/10">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-red-700 dark:text-red-400">
                Failed to load sessions
              </p>
              <p className="mt-0.5 text-xs text-red-600 dark:text-red-300/70">
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
              className="shrink-0 rounded-lg bg-red-100 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-200 dark:bg-red-500/20 dark:text-red-300 dark:hover:bg-red-500/30"
            >
              Retry
            </button>
          </div>
        )}

        {sessions.map((s) => {
          const { type, badge } = sessionLabel(s.key);
          const isConfirming = confirmDelete === s.key;
          const isDeleting = deleting === s.key;
          const ageMs = getAgeMs(s);
          const ageLabel = ageMs === null ? "Unknown" : `${formatAge(ageMs)} ago`;
          return (
            <div
              key={s.key}
              className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm dark:border-[#2c343d] dark:bg-[#171a1d]"
            >
              <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                <MessageSquare className="mt-0.5 h-4 w-4 shrink-0 text-stone-400 dark:text-[#7a8591]" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", badge)}>
                      {type}
                    </span>
                    <span className="truncate text-xs font-mono text-stone-500 dark:text-[#8d98a5]">
                      {s.key}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-stone-500 dark:text-[#8d98a5]">
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
                    <span className="rounded-md border border-stone-200 bg-stone-50 px-1.5 py-0.5 text-xs font-mono text-stone-600 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#c7d0d9]">
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
                        onClick={() => killSession(s.key)}
                        disabled={isDeleting}
                        className="rounded-lg bg-red-500 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600 disabled:opacity-50"
                      >
                        {isDeleting ? "Killing..." : "Confirm Kill"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className="rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:bg-stone-50 hover:text-stone-900 dark:border-[#2c343d] dark:bg-[#171a1d] dark:text-[#c7d0d9] dark:hover:bg-[#20252a] dark:hover:text-[#f5f7fa]"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(s.key)}
                      className="rounded-lg p-1.5 text-stone-400 transition-colors hover:bg-red-50 hover:text-red-500 dark:text-[#7a8591] dark:hover:bg-red-500/10 dark:hover:text-red-300"
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
          <div className="flex items-center justify-center py-12 text-sm text-stone-500 dark:text-[#8d98a5]">
            No active sessions
          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
