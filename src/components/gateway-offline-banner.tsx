"use client";

import { useGatewayStatusStore } from "@/lib/gateway-status-store";
import { WifiOff } from "lucide-react";

export function GatewayOfflineBanner() {
  const { status, restarting, initialCheckDone } = useGatewayStatusStore();

  if (status === "online" || status === "loading" || !initialCheckDone) return null;

  const isOffline = status === "offline";

  return (
    <div className="shrink-0 border-b border-warning-border bg-warning-bg px-6 py-2 text-xs">
      <div className="flex items-center gap-2">
        <WifiOff className="h-3.5 w-3.5 shrink-0 text-warning-fg" />
        <span className="text-warning-fg">
          {restarting
            ? "Applying changes — reconnecting your channels now…"
            : isOffline
            ? "Gateway is unreachable — data may be stale. Retrying automatically\u2026"
            : "Gateway is degraded — some features may be unavailable. Retrying automatically\u2026"}
        </span>
        <span className="ml-auto flex items-center gap-1 text-xs text-warning-fg">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
          {restarting ? "Reconnecting" : "Retrying"}
        </span>
      </div>
    </div>
  );
}
