"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceFile } from "@/components/chat/types";

/**
 * Workspace file search for the `@` picker.
 *
 * The server owns both the root and the matching, so the browser never learns
 * an absolute path it did not need and a long query cannot turn into a
 * directory traversal. Requests are debounced and superseded — a fast typist
 * must never see results for a prefix they already deleted.
 */
export function useWorkspaceFiles(agentId: string, enabled: boolean) {
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [root, setRoot] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestId = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (value: string) => {
      const id = requestId.current + 1;
      requestId.current = id;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (agentId) params.set("agentId", agentId);
        if (value) params.set("q", value);
        const res = await fetch(`/api/chat/files?${params.toString()}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`files ${res.status}`);
        const body = (await res.json()) as {
          files?: WorkspaceFile[];
          root?: string;
        };
        // A stale response must not overwrite a newer one.
        if (!alive.current || requestId.current !== id) return;
        setFiles(Array.isArray(body.files) ? body.files : []);
        setRoot(body.root ?? null);
        setError(null);
      } catch {
        if (!alive.current || requestId.current !== id) return;
        setFiles([]);
        setError("Workspace unavailable");
      } finally {
        if (alive.current && requestId.current === id) setLoading(false);
      }
    },
    [agentId],
  );

  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(() => void run(query), query ? 90 : 0);
    return () => clearTimeout(timer);
  }, [enabled, query, run]);

  return { query, setQuery, files, root, loading, error };
}
