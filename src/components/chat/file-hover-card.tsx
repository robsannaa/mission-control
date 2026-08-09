"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, ExternalLink } from "lucide-react";

type Preview = {
  path: string;
  previewable: boolean;
  size: number;
  modified: number;
  lines?: number;
  truncated?: boolean;
  preview?: string;
  error?: string;
};

const cache = new Map<string, Preview>();
const OPEN_DELAY_MS = 300;
// Grace period so the pointer can travel from the pill to the card.
const CLOSE_DELAY_MS = 260;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Hover card for a file reference.
 *
 * Opens on a deliberate hover (a short delay keeps it from firing while the
 * pointer crosses a sentence), shows the head of the file, and hands off to the
 * Documents page on click. Previews are cached per path — re-reading the same
 * file every time the pointer passes over it is wasteful and makes the card
 * feel laggy.
 */
export function FileHoverCard({
  path,
  children,
}: {
  path: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Preview | null>(cache.get(path) ?? null);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (cache.has(path)) {
      setData(cache.get(path)!);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `/api/chat/files/preview?path=${encodeURIComponent(path)}`,
        { cache: "no-store" },
      );
      const body = (await res.json()) as Preview;
      if (res.ok) cache.set(path, body);
      setData(res.ok ? body : { ...body, previewable: false, size: 0, modified: 0, path });
    } catch {
      setData({ path, previewable: false, size: 0, modified: 0, error: "Preview unavailable" });
    } finally {
      setLoading(false);
    }
  }, [path]);

  const scheduleOpen = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setOpen(true);
      void load();
    }, OPEN_DELAY_MS);
  }, [load]);

  /**
   * Closing is deliberately lazy. The pointer has to travel from the pill to
   * the card, and any moment outside both would otherwise dismiss it mid-
   * journey — the card became impossible to reach.
   */
  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
  }, []);

  return (
    <span
      className="relative inline-block"
      onMouseEnter={scheduleOpen}
      onMouseLeave={cancel}
      onFocus={scheduleOpen}
      onBlur={cancel}
    >
      <a
        href={`/documents?path=${encodeURIComponent(path)}`}
        className="no-underline"
      >
        {children}
      </a>

      {open && (
        <span
          role="tooltip"
          onMouseEnter={scheduleOpen}
          onMouseLeave={cancel}
          className="absolute bottom-full left-0 z-50 block w-[min(28rem,80vw)] pb-2"
        >
        <span className="group/card block overflow-hidden rounded-xl border border-border bg-popover shadow-2xl">
          <span className="flex items-center gap-2 border-b border-border px-3 py-2">
            <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
              {path}
            </span>
            {data && !data.error && (
              <span className="shrink-0 text-[11px] text-muted-foreground">
                {formatSize(data.size)}
                {data.lines ? ` · ${data.lines} lines` : ""}
              </span>
            )}
          </span>

          <span className="block px-3 py-2">
            {loading && (
              <span className="block space-y-1.5">
                <span className="block h-2.5 w-full animate-pulse rounded bg-muted" />
                <span className="block h-2.5 w-5/6 animate-pulse rounded bg-muted" />
                <span className="block h-2.5 w-2/3 animate-pulse rounded bg-muted" />
              </span>
            )}

            {!loading && data?.error && (
              <span className="block text-[12px] text-muted-foreground">
                {data.error}
              </span>
            )}

            {!loading && data && !data.error && !data.previewable && (
              <span className="block text-[12px] text-muted-foreground">
                No preview for this file type.
              </span>
            )}

            {!loading && data?.previewable && (
              <span className="block max-h-56 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-fg-secondary">
                {data.preview}
                {data.truncated ? "\n…" : ""}
              </span>
            )}
          </span>

          <span className="flex items-center gap-1.5 border-t border-border px-3 py-2 text-[11px] text-muted-foreground transition-colors group-hover/card:text-foreground group-hover/card:underline group-hover/card:underline-offset-2">
            <ExternalLink className="h-3 w-3" />
            Click to open in Documents
          </span>
        </span>
        </span>
      )}
    </span>
  );
}
