"use client";

import { useEffect, useState, useCallback } from "react";
import { X, ExternalLink, FileText, ArrowUpCircle, Loader2 } from "lucide-react";
import { MarkdownContent } from "@/components/markdown-content";

const DISMISS_KEY = "openclaw-update-dismissed";

type UpdateInfo = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  changelog: string | null;
  releaseUrl: string | null;
  channelLabel?: string | null;
  installKind?: string | null;
  error?: string;
};

/**
 * Fixed-position toast notification for OpenClaw updates.
 * Appears in the bottom-right corner when a new version is available.
 * Mount once in layout.tsx — does not affect page content flow.
 */
export function OpenClawUpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [showChangelog, setShowChangelog] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateSuccess, setUpdateSuccess] = useState<string | null>(null);

  const fetchUpdate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/openclaw-update", { cache: "no-store" });
      const data = await res.json();
      setInfo({
        currentVersion: data.currentVersion ?? null,
        latestVersion: data.latestVersion ?? null,
        updateAvailable: Boolean(data.updateAvailable),
        changelog: data.changelog ?? null,
        releaseUrl: data.releaseUrl ?? null,
        channelLabel: data.channelLabel ?? null,
        installKind: data.installKind ?? null,
        error: data.error,
      });
      if (data.updateAvailable && typeof window !== "undefined") {
        const dismissedVersion = sessionStorage.getItem(DISMISS_KEY);
        setDismissed(dismissedVersion === data.latestVersion);
      }
    } catch {
      setInfo(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchUpdate();
    });
  }, [fetchUpdate]);

  const handleDismiss = useCallback(() => {
    if (info?.latestVersion) {
      sessionStorage.setItem(DISMISS_KEY, info.latestVersion);
      setDismissed(true);
    }
  }, [info]);

  const handleRunUpdate = useCallback(async () => {
    setUpdateError(null);
    setUpdateSuccess(null);
    setUpdating(true);
    try {
      const res = await fetch("/api/openclaw-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-update" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) {
        throw new Error(String(data?.error || `Update failed (${res.status})`));
      }
      const updatedVersion = typeof data?.currentVersionAfter === "string" && data.currentVersionAfter
        ? data.currentVersionAfter
        : info?.latestVersion || "latest";
      setUpdateSuccess(`Updated to v${updatedVersion}.`);
      await fetchUpdate();
      if (typeof data?.currentVersionAfter === "string" && data.currentVersionAfter) {
        sessionStorage.setItem(DISMISS_KEY, data.currentVersionAfter);
      }
    } catch (err) {
      setUpdateError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setUpdating(false);
    }
  }, [fetchUpdate, info?.latestVersion]);

  if (loading || !info?.updateAvailable || dismissed) return null;

  return (
    <>
      {/* Toast — fixed bottom-right, doesn't affect layout */}
      <div className="fixed bottom-4 right-4 z-50 w-80 animate-in slide-in-from-bottom-4 fade-in duration-300">
        <div className="rounded-xl border border-[var(--accent-brand-border)] bg-card/95 shadow-2xl backdrop-blur-sm">
          <div className="flex items-start gap-3 px-4 py-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-brand-subtle)]">
              <ArrowUpCircle className="h-4 w-4 text-[var(--accent-brand-text)]" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground">
                OpenClaw v{info.latestVersion} available
              </p>
              {info.currentVersion && (
                <p className="text-xs text-muted-foreground">
                  You have v{info.currentVersion}
                </p>
              )}
              {info.channelLabel && (
                <p className="text-[11px] text-muted-foreground">
                  Channel: {info.channelLabel}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={handleDismiss}
              className="shrink-0 rounded-md p-1 text-fg-subtle transition-colors hover:text-muted-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2.5">
            <button
              type="button"
              onClick={() => setShowChangelog(true)}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <FileText className="h-3 w-3" />
                Changelog
              </button>
            {info.releaseUrl && (
              <a
                href={info.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 rounded-control px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                Release
              </a>
            )}
            <button
              type="button"
              disabled={updating}
              onClick={() => void handleRunUpdate()}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-[var(--accent-brand)] px-2.5 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
              {updating ? "Updating..." : "Update"}
            </button>
          </div>
          {(updateError || updateSuccess) && (
            <div className="border-t border-border/50 px-4 py-2">
              {updateError && <p className="text-[11px] text-danger-fg">{updateError}</p>}
              {!updateError && updateSuccess && <p className="text-[11px] text-success-fg">{updateSuccess}</p>}
            </div>
          )}
        </div>
      </div>

      {/* Changelog modal */}
      {showChangelog && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60"
          onClick={() => setShowChangelog(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Changelog"
        >
          <div
            className="relative flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-foreground/10 bg-card shadow-xl animate-in zoom-in-95 fade-in duration-200"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-foreground/10 px-4 py-3">
              <h2 className="text-sm font-semibold text-foreground">
                What&apos;s new in v{info.latestVersion}
              </h2>
              <button
                type="button"
                onClick={() => setShowChangelog(false)}
                className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-4 py-3">
              {info.changelog ? (
                <MarkdownContent
                  content={info.changelog}
                  className="prose prose-invert max-w-none text-sm"
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No changelog available. See the release page for details.
                </p>
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-foreground/10 px-4 py-3">
              <p className="text-xs text-muted-foreground">
                Update from terminal: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">openclaw update --yes</code>
              </p>
              <div className="flex justify-end gap-2">
                {info.releaseUrl && (
                  <a
                    href={info.releaseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 rounded-control bg-[var(--accent-brand)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Open release page
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setShowChangelog(false)}
                  className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
