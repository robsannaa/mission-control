"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import {
  Clock,
  Globe,
  Monitor,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/* ── Types ────────────────────────────────────────── */

type PendingRequest = {
  requestId: string;
  deviceId?: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  createdAtMs?: number;
};

type DevicesResponse = {
  pending?: PendingRequest[];
  degraded?: boolean;
};

/* ── Helpers ──────────────────────────────────────── */

function formatTimeAgo(ms?: number): string {
  if (!ms) return "";
  const ago = Date.now() - ms;
  if (ago < 60000) return "just now";
  if (ago < 3600000) return Math.floor(ago / 60000) + "m ago";
  if (ago < 86400000) return Math.floor(ago / 3600000) + "h ago";
  return Math.floor(ago / 86400000) + "d ago";
}

function PlatformIcon({ platform, className }: { platform?: string; className?: string }) {
  if (!platform) return <Monitor className={className} />;
  const p = platform.toLowerCase();
  if (p.includes("iphone") || p.includes("ios") || p.includes("android"))
    return <Smartphone className={className} />;
  if (p.includes("mac") || p.includes("darwin") || p.includes("linux"))
    return <Monitor className={className} />;
  return <Globe className={className} />;
}

/** Marker so hot reloads / double mounts never stack fetch wrappers. */
const FETCH_PATCH_FLAG = "__mcPairingFetchPatched";

/**
 * Prominent approval banner for gateway pairing.
 *
 * When the gateway answers "pairing required" (device asking for more scopes
 * than approved), every data route returns 428 / X-Pairing-Required and pages
 * would otherwise look empty. This banner turns that dead end into a one-click
 * approval moment: it polls /api/devices for pending pairing requests, also
 * listens for 428 / X-Pairing-Required on any fetch the app makes, and offers
 * an Approve button wired to the existing device.pair.approve action.
 *
 * Mount once in layout.tsx — fixed position, does not affect page flow.
 */
export function PairingBanner() {
  const [pending, setPending] = useState<PendingRequest[]>([]);
  const [signalSeen, setSignalSeen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  /* ── Poll pending device requests ── */

  const fetchPending = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/api/devices", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = (await res.json()) as DevicesResponse;
      setPending(Array.isArray(data.pending) ? data.pending : []);
    } catch {
      // silent (includes abort)
    }
  }, []);

  useSmartPoll(fetchPending, { intervalMs: 10000 });

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /* ── Observe 428 / X-Pairing-Required on the app's own fetches ── */

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>;
    if (w[FETCH_PATCH_FLAG]) return;
    w[FETCH_PATCH_FLAG] = true;

    const original = window.fetch.bind(window);
    const patched: typeof window.fetch = async (...args) => {
      const res = await original(...args);
      try {
        if (res.status === 428 || res.headers.get("X-Pairing-Required") === "1") {
          setSignalSeen(true);
        }
      } catch {
        // Never let observation break the caller's request.
      }
      return res;
    };
    window.fetch = patched;

    return () => {
      window.fetch = original;
      delete w[FETCH_PATCH_FLAG];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A pairing signal means the pending list just changed — look immediately.
  useEffect(() => {
    if (signalSeen) void fetchPending();
  }, [signalSeen, fetchPending]);

  /* ── Approve ── */

  const approve = useCallback(
    async (requestId: string) => {
      setBusyId(requestId);
      setError(null);
      try {
        const res = await fetch("/api/devices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "approve", requestId }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.error) {
          throw new Error(String(data?.error || `Approve failed (${res.status})`));
        }
        setApproved(true);
        // Let the celebration land, then refresh every view's data — scopes
        // just changed, so all previously-empty pages come alive.
        setTimeout(() => window.location.reload(), 1400);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Approve failed");
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  /* ── Visibility ── */

  const pendingKey = pending.map((p) => p.requestId).sort().join(",");
  const show =
    (pending.length > 0 || (signalSeen && !approved)) &&
    dismissedKey !== pendingKey;

  if (!show && !approved) return null;

  /* ── Approved celebration ── */

  if (approved) {
    return (
      <div className="fixed bottom-4 right-4 z-50 w-96 animate-in slide-in-from-bottom-4 fade-in duration-300">
        <div className="rounded-xl border border-emerald-500/30 bg-card/95 shadow-2xl shadow-emerald-500/10 backdrop-blur-sm">
          <div className="flex items-center gap-3 px-4 py-4">
            <div className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-emerald-500/30 bg-emerald-500/20 text-emerald-400">
              <ShieldCheck className="h-5 w-5" />
              <span className="absolute inset-0 animate-ping rounded-lg border border-emerald-400/40" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                Approved
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
              </p>
              <p className="text-xs text-muted-foreground">
                Unlocking your sessions and cron data&hellip;
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-96 max-w-[calc(100vw-2rem)] animate-in slide-in-from-bottom-4 fade-in duration-300">
      <div className="rounded-xl border border-amber-500/30 bg-card/95 shadow-2xl shadow-amber-500/10 backdrop-blur-sm">
        {/* Header */}
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/20 text-amber-400">
            <ShieldAlert className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-foreground">
              Mission Control needs approval to see sessions &amp; cron
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The gateway is holding data back until you approve the pending
              pairing request below.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setDismissedKey(pendingKey)}
            className="shrink-0 rounded-md p-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Pending requests */}
        {pending.length > 0 ? (
          <div className="space-y-2 border-t border-border/50 px-4 py-3">
            {pending.map((req) => (
              <div
                key={req.requestId}
                className="rounded-lg border border-foreground/10 bg-foreground/5 p-3"
              >
                <div className="flex items-start gap-2.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-400">
                    <PlatformIcon platform={req.platform} className="h-3.5 w-3.5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <span className="text-xs font-semibold text-foreground/90">
                      {req.displayName || req.clientId || "Unknown device"}
                    </span>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {req.requestedRole && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                          {req.requestedRole}
                        </span>
                      )}
                      {(req.requestedScopes || []).map((scope) => (
                        <span
                          key={scope}
                          className="rounded bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-400"
                        >
                          {scope}
                        </span>
                      ))}
                      {req.createdAtMs ? (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground/60">
                          <Clock className="h-2.5 w-2.5" />
                          {formatTimeAgo(req.createdAtMs)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void approve(req.requestId)}
                  disabled={busyId !== null}
                  className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                >
                  {busyId === req.requestId ? (
                    <span className="inline-flex items-center gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                    </span>
                  ) : (
                    <ShieldCheck className="h-3 w-3" />
                  )}
                  Approve
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="border-t border-border/50 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              Waiting for the pairing request to appear&hellip; If it does not,
              run{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                openclaw devices approve
              </code>{" "}
              on the gateway host.
            </p>
          </div>
        )}

        {error && (
          <div className="border-t border-border/50 px-4 py-2">
            <p className="text-[11px] text-red-400">{error}</p>
          </div>
        )}
      </div>
    </div>
  );
}
