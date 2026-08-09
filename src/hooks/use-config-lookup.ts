"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type {
  ConfigReloadKind,
  NormalizedConfigLookup,
} from "@/lib/config-schema-validate";

/**
 * Per-path config schema intelligence for the config editor.
 *
 * `GET /api/config/lookup` surfaces OpenClaw's `config.schema.lookup` RPC:
 * per-path `reloadKind` (restart / hot / none), `required`, `deprecated`,
 * `readOnly`, and the JSON Schema constraints the client-safe validator in
 * `@/lib/config-schema-validate` enforces. The editor needs it for hundreds of
 * fields, so this hook batches, caches and de-duplicates:
 *
 *   - requests are coalesced over a short debounce window,
 *   - each request carries at most `LOOKUP_BATCH_SIZE` paths (the endpoint's
 *     documented cap is 25 and it 400s rather than truncating silently),
 *   - a path is fetched once; the answer (including a `null` "no such path")
 *     is cached for the life of the editor session,
 *   - `reset()` drops the cache after a config write, because a write can
 *     change which dynamic paths exist.
 *
 * IMPORTANT: this file imports types from `@/lib/config-schema-validate`, the
 * pure/browser-safe half. `@/lib/config-schema-lookup` pulls in the gateway
 * transport (child_process, fs) and must never reach a client bundle.
 */

/** Endpoint cap is 25 paths per request (MAX_LOOKUP_PATHS_PER_REQUEST). */
export const LOOKUP_BATCH_SIZE = 25;

/** How long to collect paths before firing a batch. */
const LOOKUP_DEBOUNCE_MS = 60;

export type ConfigLookupApi = {
  /**
   * Cached lookup for a path.
   *
   * `undefined` — not fetched yet (render neutrally, do not claim "valid").
   * `null`      — the gateway answered "no such path" (an unknown/extra key).
   */
  get: (path: string) => NormalizedConfigLookup | null | undefined;
  /** Queue paths for the next batch. Safe to call on every render. */
  request: (paths: string[]) => void;
  /**
   * Fetch every uncached path now and resolve once they are all in the cache.
   * Used by the save path, which must validate paths whose fields are not
   * mounted (a collapsed section still has to block an invalid write).
   */
  ensure: (paths: string[]) => Promise<void>;
  /** Reload kind for a path, or `null` when unknown. */
  reloadKind: (path: string) => ConfigReloadKind | null;
  /** True once at least one batch has resolved. */
  ready: boolean;
  /** Number of paths still in flight. */
  pending: number;
  /**
   * Set when the endpoint reported one cause for every path (gateway down, RPC
   * unsupported). The UI must say so instead of implying validated certainty.
   */
  reason: string | null;
  /** Forget everything — call after a successful write. */
  reset: () => void;
};

const EMPTY_API: ConfigLookupApi = {
  get: () => undefined,
  request: () => {},
  ensure: async () => {},
  reloadKind: () => null,
  ready: false,
  pending: 0,
  reason: null,
  reset: () => {},
};

export const ConfigLookupContext = createContext<ConfigLookupApi>(EMPTY_API);

/** Read the shared lookup cache from anywhere under the provider. */
export function useConfigLookup(): ConfigLookupApi {
  return useContext(ConfigLookupContext);
}

/**
 * Look one path up and keep it fresh. Requests on mount, re-renders when the
 * answer lands.
 */
export function useFieldLookup(path: string | null | undefined) {
  const api = useConfigLookup();
  const { request } = api;
  useEffect(() => {
    if (path) request([path]);
  }, [path, request]);
  return path ? api.get(path) : undefined;
}

type LookupResponse = {
  path?: string;
  lookup?: NormalizedConfigLookup | null;
  results?: Record<string, NormalizedConfigLookup | null>;
  reasons?: Record<string, string>;
  reason?: string;
  error?: string;
};

/**
 * Owns the cache. Mount exactly once (in the editor) and publish the result
 * through `ConfigLookupContext`.
 */
export function useConfigLookupSource(options?: { enabled?: boolean }): ConfigLookupApi {
  const enabled = options?.enabled !== false;

  const cache = useRef(new Map<string, NormalizedConfigLookup | null>());
  const inflight = useRef(new Set<string>());
  const queue = useRef(new Set<string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposed = useRef(false);

  // Cache lives in a ref (stable identity for `get`); this counter is what
  // tells React a batch landed.
  const [version, setVersion] = useState(0);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(0);
  const [reason, setReason] = useState<string | null>(null);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const fetchPaths = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    for (const p of paths) inflight.current.add(p);
    setPending(inflight.current.size);

    for (let i = 0; i < paths.length; i += LOOKUP_BATCH_SIZE) {
      const chunk = paths.slice(i, i + LOOKUP_BATCH_SIZE);
      try {
        const res = await fetch(
          `/api/config/lookup?paths=${chunk.map(encodeURIComponent).join(",")}`,
          { cache: "no-store" }
        );
        const data = (await res.json()) as LookupResponse;
        // `?paths=` always answers in the map form, keys echoed exactly as
        // requested — index straight by the string we sent.
        const results = data.results ?? {};
        for (const path of chunk) {
          cache.current.set(path, results[path] ?? null);
        }
        setReason(data.reason ? String(data.reason) : null);
      } catch (err) {
        // A failed batch must not masquerade as "no constraints": leave those
        // paths uncached so a later attempt can retry, and say why.
        setReason(
          `Field rules could not be loaded (${err instanceof Error ? err.message : String(err)}).`
        );
      } finally {
        for (const p of chunk) inflight.current.delete(p);
      }
      if (disposed.current) return;
      setPending(inflight.current.size);
      setVersion((v) => v + 1);
      setReady(true);
    }
  }, []);

  /** Paths that are neither cached nor already on the wire. */
  const missing = useCallback((paths: string[]) => {
    const out: string[] = [];
    for (const raw of paths) {
      const path = raw?.trim();
      if (!path) continue;
      if (cache.current.has(path)) continue;
      if (out.includes(path)) continue;
      out.push(path);
    }
    return out;
  }, []);

  const flush = useCallback(async () => {
    timer.current = null;
    const paths = Array.from(queue.current).filter((p) => !inflight.current.has(p));
    queue.current.clear();
    await fetchPaths(paths);
  }, [fetchPaths]);

  const request = useCallback(
    (paths: string[]) => {
      if (!enabled) return;
      let queued = false;
      for (const path of missing(paths)) {
        if (inflight.current.has(path) || queue.current.has(path)) continue;
        queue.current.add(path);
        queued = true;
      }
      if (!queued || timer.current) return;
      timer.current = setTimeout(() => {
        void flush();
      }, LOOKUP_DEBOUNCE_MS);
    },
    [enabled, flush, missing]
  );

  const ensure = useCallback(
    async (paths: string[]) => {
      if (!enabled) return;
      // Wait out anything already in flight for these paths, then fetch the rest.
      for (let spins = 0; spins < 100; spins += 1) {
        if (!paths.some((p) => inflight.current.has(p.trim()))) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const wanted = missing(paths);
      for (const path of wanted) queue.current.delete(path);
      await fetchPaths(wanted);
    },
    [enabled, fetchPaths, missing]
  );

  const reset = useCallback(() => {
    cache.current.clear();
    queue.current.clear();
    setReady(false);
    setReason(null);
    setVersion((v) => v + 1);
  }, []);

  return useMemo<ConfigLookupApi>(() => {
    void version; // re-created whenever a batch lands, so consumers re-render
    return {
      get: (path: string) => cache.current.get(path),
      request,
      ensure,
      reloadKind: (path: string) => cache.current.get(path)?.reloadKind ?? null,
      ready,
      pending,
      reason,
      reset,
    };
  }, [version, ready, pending, reason, request, ensure, reset]);
}
