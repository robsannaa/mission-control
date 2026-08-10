"use client";

/**
 * A single search result: source pills, a clamped snippet, and — new — a way
 * to read the whole page in place and save it into memory.
 *
 * "Read" calls `/api/search/web/read`, which fetches through OpenClaw's own
 * `web_fetch` tool (the same call the agent makes) and returns plain text
 * already stripped of the `EXTERNAL_UNTRUSTED_CONTENT` wrapper — fine to
 * *display*. "Save to memory" reuses that exact fetched text as the source
 * of what gets written, rather than fetching the page a second time, and asks
 * `/api/search/web/save` to write it into `workspace/memory/` and reindex.
 * Saving is never presented as a quiet no-op: every click gets a fresh,
 * server-confirmed result.
 */

import { useCallback, useState } from "react";
import { ExternalLink, ChevronDown, Loader2, CircleAlert, BookmarkPlus, BookmarkCheck, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { NormalizedSearchResult, WebReadResponse, WebSaveResponse } from "@/components/search/providers";

type ReadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; reason: string }
  | { status: "ready"; title: string; finalUrl: string; text: string; truncated: boolean };

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "error"; reason: string }
  | { status: "saved"; file: string; action: "created" | "updated"; indexed: boolean; indexNote?: string };

/**
 * `2008-06-03` is a machine's way of writing a date. Providers send whatever
 * they scraped, so anything unparseable is shown exactly as it arrived rather
 * than guessed at.
 */
function formatPublished(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function ResultItem({ result }: { result: NormalizedSearchResult }) {
  const [expanded, setExpanded] = useState(false);
  const [read, setRead] = useState<ReadState>({ status: "idle" });
  const [save, setSave] = useState<SaveState>({ status: "idle" });

  let host = "";
  try {
    host = result.url ? new URL(result.url).hostname.replace(/^www\./, "") : "";
  } catch {
    host = "";
  }

  const runRead = useCallback(async () => {
    if (!result.url) return;
    setRead({ status: "loading" });
    try {
      const res = await fetch("/api/search/web/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: result.url }),
      });
      const data = (await res.json()) as WebReadResponse;
      if (!data.ok) {
        setRead({ status: "error", reason: data.reason || "That page couldn't be read." });
        return;
      }
      setRead({ status: "ready", title: data.title, finalUrl: data.finalUrl, text: data.text, truncated: data.truncated });
    } catch {
      setRead({ status: "error", reason: "Mission Control couldn't reach OpenClaw to read this page." });
    }
  }, [result.url]);

  const handleToggle = useCallback(() => {
    // Side effects don't belong inside a `setState` updater (React may
    // invoke it more than once, e.g. under StrictMode) — read `expanded` and
    // `read.status` from the closure instead and fire the fetch here.
    const next = !expanded;
    setExpanded(next);
    if (next && read.status === "idle") void runRead();
  }, [expanded, read.status, runRead]);

  const handleSave = useCallback(async () => {
    if (read.status !== "ready") return;
    setSave({ status: "saving" });
    try {
      const res = await fetch("/api/search/web/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: result.url,
          finalUrl: read.finalUrl,
          title: read.title || result.title,
          text: read.text,
        }),
      });
      const data = (await res.json()) as WebSaveResponse;
      if (!data.ok) {
        setSave({ status: "error", reason: data.reason || "That couldn't be saved." });
        return;
      }
      setSave({ status: "saved", file: data.file, action: data.action, indexed: data.indexed, indexNote: data.indexNote });
    } catch {
      setSave({ status: "error", reason: "Mission Control couldn't reach OpenClaw to save this." });
    }
  }, [read, result.url, result.title]);

  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {result.url ? (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline-flex items-start gap-1.5 text-sm font-medium text-foreground hover:underline"
            >
              {result.title}
              <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100" />
            </a>
          ) : (
            <p className="text-sm font-medium text-foreground">{result.title}</p>
          )}
        </div>
        {result.url && (
          <button
            type="button"
            onClick={handleToggle}
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border-subtle px-2.5 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
          >
            {read.status === "loading" ? "Reading…" : "Read"}
            <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
          </button>
        )}
      </div>

      {(host || result.siteName || result.published) && (
        /*
         * Where it came from and when, as two pills rather than one run of
         * dot-separated text: they are separate facts, and a reader scanning a
         * list wants to compare source against source and date against date.
         * Fully rounded with a hairline border, matching the pill language used
         * across the rest of the app.
         */
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {(result.siteName || host) && (
            <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-muted-foreground">
              {result.siteName || host}
            </span>
          )}
          {result.published && (
            <span className="inline-flex items-center rounded-full border border-border-subtle px-2 py-0.5 text-[11px] text-muted-foreground">
              {formatPublished(result.published)}
            </span>
          )}
        </div>
      )}
      {result.snippet && (
        /*
         * Clamped to three lines. Providers return whatever they scraped — one
         * result here ran to a dozen lines of flattened infobox — and a result
         * list is for scanning, not reading. The full text is one click away on
         * the page itself, which is where it belongs.
         */
        <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {result.snippet}
        </p>
      )}

      {expanded && (
        <div className="mt-3 rounded-xl border border-border-subtle bg-muted/30 p-3.5">
          {read.status === "loading" && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Reading the page through OpenClaw…
            </p>
          )}

          {read.status === "error" && (
            <div className="flex items-start justify-between gap-3">
              <p className="flex items-start gap-2 text-xs leading-relaxed text-danger-fg">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {read.reason}
              </p>
              <Button type="button" size="xs" variant="ghost" onClick={() => void runRead()}>
                Try again
              </Button>
            </div>
          )}

          {read.status === "ready" && (
            <div>
              {read.finalUrl && result.url && read.finalUrl !== result.url && (
                <p className="mb-2 text-[11px] text-fg-subtle">Redirected to {read.finalUrl}</p>
              )}
              <div className="max-h-72 overflow-y-auto whitespace-pre-line text-xs leading-relaxed text-foreground/90">
                {read.text}
              </div>
              {read.truncated && (
                <p className="mt-2 text-[11px] text-fg-subtle">
                  This is a long page — showing the first part of it. Saving stores exactly this much.
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
                {save.status === "idle" && (
                  <Button type="button" size="sm" variant="outline" onClick={() => void handleSave()}>
                    <BookmarkPlus className="h-3.5 w-3.5" />
                    Save to memory
                  </Button>
                )}
                {save.status === "saving" && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Saving, then reindexing — this can take up to 15 seconds for a long article…
                  </p>
                )}
                {save.status === "saved" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="flex items-center gap-1.5 text-xs text-success-fg">
                      <BookmarkCheck className="h-3.5 w-3.5" />
                      {save.action === "created" ? "Saved" : "Updated"} to memory/{save.file}
                      {save.indexed ? " · searchable now" : " · indexing pending"}
                    </p>
                    <Button type="button" size="xs" variant="ghost" onClick={() => void handleSave()}>
                      <RotateCcw className="h-3 w-3" />
                      Save again
                    </Button>
                  </div>
                )}
                {save.status === "error" && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-danger-fg">
                      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {save.reason}
                    </p>
                    <Button type="button" size="xs" variant="ghost" onClick={() => void handleSave()}>
                      Try again
                    </Button>
                  </div>
                )}
                {save.status === "saved" && save.indexNote && (
                  <p className="w-full text-[11px] text-fg-subtle">{save.indexNote}</p>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
