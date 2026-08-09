"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, ExternalLink, Loader2, X } from "lucide-react";

const DISMISS_KEY = "mission-control-update-dismissed";

type UpdateInfo = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  installMode: "git" | "unknown";
  supported: boolean;
  unsupportedReason: string | null;
  behind?: number | null;
  releaseUrl: string | null;
  restartHint: string | null;
  error?: string;
};

type UpdateResult = {
  ok: boolean;
  error?: string;
  restartRequired?: boolean;
  restartHint?: string;
  after?: { currentVersion?: string | null };
};

/**
 * Mission Control self-update toast.
 *
 * Scope: only supports git-based clean checkouts. Other install modes still get
 * update notification + release link, with explicit manual fallback.
 */
export function MissionControlUpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const fetchUpdate = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/mission-control-update", { cache: "no-store" });
      const data = (await res.json()) as UpdateInfo & { error?: string };
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setInfo(data);
      if (data.updateAvailable) {
        const versionKey = data.latestVersion || `behind-${data.behind ?? "unknown"}`;
        const key = `${DISMISS_KEY}:${versionKey}`;
        setDismissed(sessionStorage.getItem(key) === "1");
      } else {
        setDismissed(false);
      }
    } catch (err) {
      setInfo(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchUpdate();
    });
  }, [fetchUpdate]);

  const handleDismiss = useCallback(() => {
    if (!info) {
      setDismissed(true);
      return;
    }
    const versionKey = info.latestVersion || `behind-${info.behind ?? "unknown"}`;
    const key = `${DISMISS_KEY}:${versionKey}`;
    sessionStorage.setItem(key, "1");
    setDismissed(true);
  }, [info]);

  const handleRunUpdate = useCallback(async () => {
    setUpdating(true);
    setError(null);
    setSuccess(null);
    try {
      const res = await fetch("/api/mission-control-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run-update" }),
      });
      const data = (await res.json()) as UpdateResult;
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `Update failed (${res.status})`);
      }
      const hint = data.restartHint || info?.restartHint || "Restart Mission Control to apply changes.";
      const version = info?.latestVersion || data.after?.currentVersion || "latest";
      setSuccess(`Updated to v${version}. ${hint}`);
      await fetchUpdate();
      if (version) {
        sessionStorage.setItem(`${DISMISS_KEY}:${version}`, "1");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed.");
    } finally {
      setUpdating(false);
    }
  }, [fetchUpdate, info?.latestVersion, info?.restartHint]);

  if (loading || !info?.updateAvailable || dismissed) return null;
  const headerText = info.latestVersion
    ? `Mission Control v${info.latestVersion} available`
    : "Mission Control update available";

  return (
    <div className="fixed bottom-4 left-4 z-50 w-80 animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="rounded-xl border border-success-border bg-card/95 shadow-2xl backdrop-blur-sm">
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-success-bg">
            <ArrowUpCircle className="h-4 w-4 text-success-fg" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">
              {headerText}
            </p>
            {info.currentVersion && (
              <p className="text-xs text-muted-foreground">You have v{info.currentVersion}</p>
            )}
            {!info.supported && (
              <p className="mt-1 text-[11px] text-warning-fg">
                {info.unsupportedReason || "In-dashboard update is unavailable for this install mode."}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            className="shrink-0 rounded-md p-1 text-fg-subtle transition-colors hover:text-muted-foreground"
            aria-label="Dismiss Mission Control update"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 border-t border-border/50 px-4 py-2.5">
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
          {info.supported && (
            <button
              type="button"
              onClick={() => void handleRunUpdate()}
              disabled={updating}
              className="ml-auto flex items-center gap-1.5 rounded-full bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {updating ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpCircle className="h-3 w-3" />}
              {updating ? "Updating..." : "Update"}
            </button>
          )}
        </div>
        {(error || success) && (
          <div className="border-t border-border/50 px-4 py-2">
            {error && <p className="text-[11px] text-danger-fg">{error}</p>}
            {!error && success && <p className="text-[11px] text-success-fg">{success}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
