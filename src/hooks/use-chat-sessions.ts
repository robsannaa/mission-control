"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import type { ChatSessionRow, LoadFailure } from "@/components/chat/types";

/**
 * The user's own conversations.
 *
 * Backed by /api/chat/sessions, which applies the chat-kind allowlist from
 * src/lib/session-kinds.ts server-side — a channel transcript can therefore
 * never reach this list, even if the gateway grows a new origin tomorrow.
 *
 * Two behaviours here are load-bearing:
 *  - failure is typed (offline / pairing / error), never an empty array, so
 *    the UI can avoid telling someone with 50 conversations that they have
 *    none because a socket blipped;
 *  - polling is gated inside the callback rather than through the hook's
 *    `enabled` flag, because useSmartPoll captures `enabled` once in a
 *    useCallback with an empty dependency list — a false-at-mount value keeps
 *    ticking forever without ever running the poll.
 */

type SessionsResponse = {
  sessions?: ChatSessionRow[];
  total?: number;
  archivedCount?: number;
  error?: string;
};

export type ChatSessionsState = {
  sessions: ChatSessionRow[];
  total: number;
  failure: LoadFailure;
  loaded: boolean;
  refresh: () => Promise<void>;
  rename: (key: string, label: string) => Promise<boolean>;
  setPinned: (key: string, pinned: boolean) => Promise<boolean>;
  remove: (key: string) => Promise<boolean>;
  markRead: (key: string) => void;
  /** Show a not-yet-persisted conversation at the top of the list. */
  addDraft: (row: ChatSessionRow) => void;
};

export function useChatSessions(
  agentId: string,
  active: boolean,
): ChatSessionsState {
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [total, setTotal] = useState(0);
  const [failure, setFailure] = useState<LoadFailure>({ kind: "none" });
  const [loaded, setLoaded] = useState(false);

  const activeRef = useRef(active);
  activeRef.current = active;
  const agentRef = useRef(agentId);
  agentRef.current = agentId;
  const draftsRef = useRef<ChatSessionRow[]>([]);

  const merge = useCallback((rows: ChatSessionRow[]) => {
    const known = new Set(rows.map((row) => row.key));
    // A draft graduates to a real row as soon as the gateway knows it.
    draftsRef.current = draftsRef.current.filter((row) => !known.has(row.key));
    return [...draftsRef.current, ...rows];
  }, []);

  const load = useCallback(async () => {
    if (!activeRef.current) return;
    const agent = agentRef.current;
    try {
      const params = new URLSearchParams({ limit: "40" });
      if (agent) params.set("agentId", agent);
      const res = await fetch(`/api/chat/sessions?${params.toString()}`, {
        cache: "no-store",
      });

      if (res.status === 428) {
        setFailure({
          kind: "pairing",
          detail: "This browser is waiting for pairing approval.",
        });
        setLoaded(true);
        return;
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as SessionsResponse;
        setFailure({
          kind: res.status >= 500 ? "offline" : "error",
          detail: body.error ?? `Request failed (${res.status})`,
        });
        setLoaded(true);
        return;
      }

      const body = (await res.json()) as SessionsResponse;
      const rows = Array.isArray(body.sessions) ? body.sessions : [];
      setSessions(merge(rows));
      setTotal(body.total ?? rows.length);
      setFailure({ kind: "none" });
    } catch {
      setFailure({
        kind: "offline",
        detail: "Mission Control could not reach the gateway.",
      });
    } finally {
      setLoaded(true);
    }
  }, [merge]);

  useSmartPoll(load, { intervalMs: 15_000 });

  // The first poll usually fires before the agent id is known, and switching
  // agents changes the whole list — both need an immediate refetch rather than
  // a wait for the next tick.
  useEffect(() => {
    if (!agentId || !active) return;
    void load();
  }, [agentId, active, load]);

  const patch = useCallback(
    async (key: string, body: Record<string, unknown>) => {
      try {
        const res = await fetch("/api/chat/sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, ...body }),
        });
        if (!res.ok) return false;
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  const rename = useCallback(
    async (key: string, label: string) => {
      const trimmed = label.trim();
      if (!trimmed) return false;
      const previous = sessions;
      setSessions((rows) =>
        rows.map((row) =>
          row.key === key
            ? { ...row, title: trimmed, titleSource: "label" as const }
            : row,
        ),
      );
      const ok = await patch(key, { label: trimmed });
      if (!ok) setSessions(previous);
      else void load();
      return ok;
    },
    [load, patch, sessions],
  );

  const setPinned = useCallback(
    async (key: string, pinned: boolean) => {
      const previous = sessions;
      setSessions((rows) => {
        const next = rows.map((row) =>
          row.key === key ? { ...row, pinned } : row,
        );
        next.sort((a, b) => {
          if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
        return next;
      });
      const ok = await patch(key, { pinned });
      if (!ok) setSessions(previous);
      return ok;
    },
    [patch, sessions],
  );

  const remove = useCallback(
    async (key: string) => {
      const previous = sessions;
      draftsRef.current = draftsRef.current.filter((row) => row.key !== key);
      setSessions((rows) => rows.filter((row) => row.key !== key));
      try {
        const res = await fetch(
          `/api/chat/sessions?key=${encodeURIComponent(key)}`,
          { method: "DELETE" },
        );
        if (!res.ok) {
          setSessions(previous);
          return false;
        }
        return true;
      } catch {
        setSessions(previous);
        return false;
      }
    },
    [sessions],
  );

  const markRead = useCallback(
    (key: string) => {
      setSessions((rows) =>
        rows.map((row) => (row.key === key ? { ...row, unread: false } : row)),
      );
      void patch(key, { unread: false });
    },
    [patch],
  );

  const addDraft = useCallback((row: ChatSessionRow) => {
    draftsRef.current = [
      row,
      ...draftsRef.current.filter((draft) => draft.key !== row.key),
    ].slice(0, 4);
    setSessions((rows) => [
      row,
      ...rows.filter((existing) => existing.key !== row.key),
    ]);
  }, []);

  return {
    sessions,
    total,
    failure,
    loaded,
    refresh: load,
    rename,
    setPinned,
    remove,
    markRead,
    addDraft,
  };
}
