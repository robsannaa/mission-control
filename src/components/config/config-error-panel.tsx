"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, Copy, Timer, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A failure the operator can actually act on.
 *
 * The old editor showed every error in a toast that auto-dismissed after four
 * seconds and rendered nothing but `data.error`, so the server's `details` and
 * captured `doctor --fix` output were thrown away. This panel stays until it is
 * dismissed, renders every field the route can return, is scrollable and
 * copyable, and counts down a rate-limit window instead of inviting a retry
 * that cannot succeed.
 */

export type ConfigErrorDetail = {
  title: string;
  message: string;
  details?: string;
  doctorOutput?: string;
  fallback?: string;
  /** Set for HTTP 429 — the retry button stays disabled until it elapses. */
  retryAfterMs?: number;
  /** When the error was raised, for the countdown. */
  at: number;
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true));
      }}
      className="flex items-center gap-1 rounded border border-foreground/10 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
    >
      {copied ? <Check className="h-2.5 w-2.5" /> : <Copy className="h-2.5 w-2.5" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Block({ label, body }: { label: string; body: string }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-red-800/70 dark:text-red-200/70">
          {label}
        </span>
        <CopyButton text={body} />
      </div>
      <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded border border-red-500/20 bg-red-950/5 p-2 font-mono text-xs leading-relaxed text-red-900/90 dark:bg-black/30 dark:text-red-100/90">
        {body}
      </pre>
    </div>
  );
}

/** Remaining rate-limit window in seconds, or 0. */
function useCountdown(startedAt: number, durationMs?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!durationMs) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [durationMs]);
  if (!durationMs) return 0;
  return Math.max(0, Math.ceil((startedAt + durationMs - now) / 1000));
}

export function ConfigErrorPanel({
  error,
  onDismiss,
  onRetry,
  className,
}: {
  error: ConfigErrorDetail;
  onDismiss: () => void;
  onRetry?: () => void;
  className?: string;
}) {
  const remaining = useCountdown(error.at, error.retryAfterMs);
  const copyAll = [
    error.title,
    error.message,
    error.details ? `\nDetails:\n${error.details}` : "",
    error.doctorOutput ? `\nDoctor output:\n${error.doctorOutput}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      role="alert"
      data-testid="config-error-panel"
      className={cn(
        "rounded-xl border border-red-500/30 bg-red-50 dark:bg-red-950/30",
        className
      )}
    >
      <div className="flex items-start gap-2.5 px-4 py-3">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-red-900 dark:text-red-100">{error.title}</p>
          <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-red-900/90 dark:text-red-100/90">
            {error.message}
          </p>
          {remaining > 0 && (
            <p className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-red-900/80 dark:text-red-100/80">
              <Timer className="h-3 w-3" />
              Writes are limited to 3 per minute. You can try again in {remaining}s.
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton text={copyAll} />
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss error"
            className="rounded p-1 text-red-700/70 transition-colors hover:text-red-900 dark:text-red-200/70 dark:hover:text-red-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {(error.details || error.doctorOutput || error.fallback) && (
        <div className="space-y-2.5 border-t border-red-500/15 px-4 py-3">
          {error.details && error.details !== error.message && (
            <Block label="Server details" body={error.details} />
          )}
          {error.doctorOutput && <Block label="openclaw doctor --fix output" body={error.doctorOutput} />}
          {error.fallback && (
            <p className="text-xs text-red-900/80 dark:text-red-100/80">
              Compatibility fallback: {error.fallback}
            </p>
          )}
        </div>
      )}

      {onRetry && (
        <div className="flex justify-end border-t border-red-500/15 px-4 py-2.5">
          <button
            type="button"
            onClick={onRetry}
            disabled={remaining > 0}
            className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-900 transition-colors hover:bg-red-500/10 disabled:opacity-50 dark:text-red-100"
          >
            {remaining > 0 ? `Retry in ${remaining}s` : "Try again"}
          </button>
        </div>
      )}
    </div>
  );
}
