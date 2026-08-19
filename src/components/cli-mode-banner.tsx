"use client";

import { useCallback, useState } from "react";
import { X, TriangleAlert } from "lucide-react";
import { useGatewayStatusStore } from "@/lib/gateway-status-store";
import { useCapability } from "@/hooks/use-capabilities";

const DISMISS_KEY = "cli-mode-banner-dismissed";

/**
 * Amber warning banner shown at the top of the page when Mission Control
 * detects it is running in CLI fallback mode (transport === "cli").
 *
 * Dismissal is stored in sessionStorage — the banner won't nag again until
 * the browser tab is closed, but will reappear on a fresh session so the
 * user is always informed after a cold start.
 */
export function CliModeBanner() {
  const { transport, transportConfigured, transportReason, initialCheckDone } = useGatewayStatusStore();
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return true;
    return sessionStorage.getItem(DISMISS_KEY) === "1";
  });

  const handleDismiss = useCallback(() => {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
  }, []);

  // When the user doesn't control a local gateway, CLI is the expected
  // transport — no warning needed. The gateway only exposes
  // sessions_list/agents_list via HTTP; exec/read/write require CLI, so
  // AutoTransport always settles into CLI mode. This is correct.
  const localGatewayControl = useCapability("localGatewayControl");

  // Only render once we know the transport mode and the user hasn't dismissed
  if (!localGatewayControl || !initialCheckDone || transport !== "cli" || dismissed) return null;

  const isForcedCli = transportReason === "forced_cli" || transportConfigured === "cli";

  return (
    <div
      role="alert"
      aria-live="polite"
      className="relative z-40 flex items-center gap-2.5 bg-warning-bg px-4 py-2 text-warning-fg border-b border-warning-border"
    >
      <TriangleAlert className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
      <p className="flex-1 text-xs font-medium">
        {isForcedCli ? (
          <>
            Running in CLI mode because{" "}
            <code className="rounded bg-warning-bg px-1 py-0.5 font-mono text-[11px]">
              OPENCLAW_TRANSPORT=cli
            </code>{" "}
            is explicitly configured. Set{" "}
            <code className="rounded bg-warning-bg px-1 py-0.5 font-mono text-[11px]">
              OPENCLAW_TRANSPORT=auto
            </code>{" "}
            to re-enable automatic HTTP transport.
          </>
        ) : (
          <>
            Running in CLI fallback mode &mdash; HTTP transport is currently unavailable. Check Gateway connectivity and
            auth configuration, or set{" "}
            <code className="rounded bg-warning-bg px-1 py-0.5 font-mono text-[11px]">
              OPENCLAW_TRANSPORT=http
            </code>{" "}
            on stable VPS setups.
          </>
        )}
      </p>
      <button
        type="button"
        onClick={handleDismiss}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-warning-border"
        aria-label="Dismiss CLI fallback warning"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
