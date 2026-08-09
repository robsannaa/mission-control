"use client";

import { useState, type ReactNode } from "react";
import { Eye, EyeOff, GitMerge, RotateCcw, Users, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock, useFocusTrap } from "@/hooks/use-modal-accessibility";
import {
  formatConfigValue,
  getAtPath,
  isSensitiveConfigPath,
  maskSecret,
  type ConflictAnalysis,
} from "./config-changes";

/**
 * HTTP 409 resolution.
 *
 * Mission Control may be the only gate to a hosted OpenClaw with several
 * operators connected, so a stale write is never re-applied on a fresh hash —
 * that silently destroyed the other person's edit. The server hands back their
 * current document; this dialog shows who changed what and makes the operator
 * choose:
 *
 *   - Reload theirs — discard the local draft entirely.
 *   - Re-apply mine — rebase the local diff onto their document and retry.
 *     Paths both sides touched are listed explicitly, because a rebase
 *     overwrites their value there.
 */

function PathList({
  title,
  paths,
  tone,
  render,
  emptyLabel,
}: {
  title: string;
  paths: string[];
  tone: "contested" | "theirs" | "mine";
  render?: (path: string) => ReactNode;
  emptyLabel?: string;
}) {
  const toneClass =
    tone === "contested"
      ? "border-red-500/30 bg-red-500/5"
      : tone === "theirs"
        ? "border-sky-500/25 bg-sky-500/5"
        : "border-emerald-500/25 bg-emerald-500/5";
  return (
    <div className={cn("rounded-lg border px-3 py-2.5", toneClass)}>
      <p className="text-xs font-semibold text-foreground/80">{title}</p>
      {paths.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">{emptyLabel ?? "None."}</p>
      ) : (
        <ul className="mt-1.5 space-y-1.5">
          {paths.slice(0, 40).map((path) => (
            <li key={path} className="text-xs">
              <code className="font-mono text-foreground/90">{path}</code>
              {render?.(path)}
            </li>
          ))}
          {paths.length > 40 && (
            <li className="text-xs text-muted-foreground">
              …and {paths.length - 40} more
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

export function ConfigConflictDialog({
  open,
  message,
  analysis,
  base,
  mine,
  theirs,
  hints,
  busy,
  onReloadTheirs,
  onRebase,
  onCancel,
}: {
  open: boolean;
  message: string;
  analysis: ConflictAnalysis;
  base: unknown;
  mine: unknown;
  theirs: unknown;
  hints: Record<string, { sensitive?: boolean } | undefined>;
  busy: boolean;
  onReloadTheirs: () => void;
  onRebase: () => void;
  onCancel: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const containerRef = useFocusTrap(open);
  useBodyScrollLock(open);

  if (!open) return null;

  const show = (value: unknown, path: string) =>
    isSensitiveConfigPath(hints, path) && !reveal
      ? maskSecret(value)
      : formatConfigValue(value, 80);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Configuration conflict"
    >
      <div
        ref={containerRef}
        data-testid="config-conflict-dialog"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-amber-500/30 bg-white shadow-2xl dark:bg-[#171a1d]"
      >
        <div className="flex shrink-0 items-start gap-3 border-b border-foreground/10 px-5 py-4">
          <Users className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">
              Someone else changed the configuration
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{message}</p>
          </div>
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
            aria-label={reveal ? "Hide secret values" : "Reveal secret values"}
          >
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-5 py-4">
          <PathList
            title={`Both of you changed ${analysis.contested.length} path${analysis.contested.length === 1 ? "" : "s"}`}
            paths={analysis.contested}
            tone="contested"
            emptyLabel="Nothing overlaps — re-applying your changes keeps both edits."
            render={(path) => (
              <div className="mt-0.5 space-y-0.5 pl-3 font-mono text-xs">
                <div className="text-sky-700 dark:text-sky-300">
                  theirs: {show(getAtPath(theirs, path), path)}
                </div>
                <div className="text-emerald-700 dark:text-emerald-300">
                  yours: {show(getAtPath(mine, path), path)}
                </div>
                <div className="text-muted-foreground/70">
                  was: {show(getAtPath(base, path), path)}
                </div>
              </div>
            )}
          />
          <PathList
            title="They changed (you did not)"
            paths={analysis.theirs}
            tone="theirs"
            emptyLabel="Nothing."
            render={(path) => (
              <span className="ml-2 font-mono text-muted-foreground">
                → {show(getAtPath(theirs, path), path)}
              </span>
            )}
          />
          <PathList
            title="You changed (they did not)"
            paths={analysis.mine}
            tone="mine"
            emptyLabel="Nothing."
            render={(path) => (
              <span className="ml-2 font-mono text-muted-foreground">
                → {show(getAtPath(mine, path), path)}
              </span>
            )}
          />
        </div>

        <div className="shrink-0 space-y-2 border-t border-foreground/10 px-5 py-3">
          {analysis.overlaps && (
            <p className="text-xs text-red-700 dark:text-red-300">
              Re-applying your changes replaces their value on the {analysis.contested.length}{" "}
              contested path{analysis.contested.length === 1 ? "" : "s"} above.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              Keep editing
            </button>
            <button
              type="button"
              onClick={onReloadTheirs}
              disabled={busy}
              data-testid="conflict-reload-theirs"
              className="flex items-center gap-1.5 rounded-lg border border-foreground/15 px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-muted disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reload theirs (discard mine)
            </button>
            <button
              type="button"
              onClick={onRebase}
              disabled={busy}
              data-testid="conflict-rebase"
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <GitMerge className="h-3.5 w-3.5" />
              Re-apply mine on top
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
