"use client";

/**
 * Loading skeleton shaped like the real page. The gap between paint and data
 * is small (well under a second on a warm dev server) but never zero, and an
 * empty screen reads as broken — this fills it with the shape of what is
 * coming instead.
 */

import { Panel } from "./primitives";

function Bar({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted/60 ${className || ""}`} />;
}

export function HeartbeatSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading heartbeat settings">
      <Panel className="p-5">
        <div className="flex items-start gap-3">
          <Bar className="h-9 w-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2.5">
            <Bar className="h-4 w-48" />
            <Bar className="h-3 w-full max-w-md" />
            <Bar className="h-3 w-3/5 max-w-sm" />
          </div>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Bar className="h-8 w-28 rounded-full" />
          <Bar className="h-8 w-28 rounded-full" />
          <Bar className="h-8 w-24 rounded-full" />
        </div>
      </Panel>
      <Panel className="p-5">
        <Bar className="h-3 w-32" />
        <div className="mt-4 space-y-3">
          <Bar className="h-9 w-full" />
          <Bar className="h-16 w-full" />
        </div>
      </Panel>
    </div>
  );
}
