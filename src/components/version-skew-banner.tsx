"use client";

import { useCallback, useEffect, useState } from "react";
import { X, TriangleAlert } from "lucide-react";

const DISMISS_KEY_PREFIX = "version-skew-banner-dismissed:";
const POLL_INTERVAL_MS = 60_000;

type GatewayVersionInfo = {
  gateway: string | null;
  supportedRange: string;
  supported: boolean | null;
};

/**
 * Amber warning banner shown at the top of the page when the running gateway
 * reports an OpenClaw version outside the range this Mission Control build was
 * verified against (SUPPORTED_OPENCLAW_RANGE in lib/gateway-protocol.ts).
 *
 * Dismissal is stored in sessionStorage keyed by the offending version, so the
 * banner stays quiet for the rest of the tab session but reappears after an
 * upgrade to a different unsupported version or on a fresh session.
 */
export function VersionSkewBanner() {
  const [version, setVersion] = useState<GatewayVersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const fetchVersion = async () => {
      try {
        const res = await fetch("/api/gateway", {
          cache: "no-store",
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        if (cancelled) return;
        const info = data?.version;
        if (info && typeof info === "object") {
          const next: GatewayVersionInfo = {
            gateway: typeof info.gateway === "string" ? info.gateway : null,
            supportedRange:
              typeof info.supportedRange === "string" ? info.supportedRange : "",
            supported: typeof info.supported === "boolean" ? info.supported : null,
          };
          setVersion(next);
          if (next.gateway) {
            try {
              setDismissed(
                sessionStorage.getItem(`${DISMISS_KEY_PREFIX}${next.gateway}`) === "1"
              );
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        // Gateway/API unreachable — nothing to warn about yet; next poll retries.
      }
    };

    void fetchVersion();
    const timer = setInterval(() => void fetchVersion(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const handleDismiss = useCallback(() => {
    if (version?.gateway) {
      try {
        sessionStorage.setItem(`${DISMISS_KEY_PREFIX}${version.gateway}`, "1");
      } catch {
        /* ignore */
      }
    }
    setDismissed(true);
  }, [version]);

  // Only warn on a confirmed mismatch — unknown/unparseable versions stay quiet.
  if (!version || version.supported !== false || !version.gateway || dismissed) {
    return null;
  }

  return (
    <div
      role="alert"
      aria-live="polite"
      className="relative z-40 flex items-center gap-2.5 border-b border-warning-border bg-warning-bg px-4 py-2 text-warning-fg"
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
      <p className="flex-1 text-xs font-medium">
        The gateway is running OpenClaw{" "}
        <code className="rounded bg-warning-bg px-1 py-0.5 font-mono text-[11px]">
          {version.gateway}
        </code>
        , outside the range this dashboard was built against (
        <code className="rounded bg-warning-bg px-1 py-0.5 font-mono text-[11px]">
          {version.supportedRange}
        </code>
        ). Some panels may show incomplete data &mdash; update OpenClaw or Mission
        Control so the versions match.
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-warning-border"
        aria-label="Dismiss version mismatch warning"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
