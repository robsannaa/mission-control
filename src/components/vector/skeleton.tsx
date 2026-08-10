"use client";

/**
 * Loading skeleton shaped like the real page (Try it tab, the default view).
 *
 * A cold load here is dominated by one unavoidable subprocess call
 * (`openclaw memory status`, ~2s on a stock install with the gateway's HTTP
 * exec bridge denied — see `route.ts`), so the gap between paint and data is
 * real, not incidental. An empty screen reads as broken; this fills it with
 * the shape of what is coming so the wait reads as "loading," not "broken."
 */

import { Panel } from "./primitives";

function Bar({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-muted/60 ${className || ""}`} />;
}

export function VectorSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading memory status">
      {/* Tab picker */}
      <Bar className="h-9 w-48 rounded-full" />

      {/* Status line */}
      <div className="flex items-center gap-2.5">
        <Bar className="h-2 w-2 rounded-full" />
        <Bar className="h-4 w-72" />
      </div>

      {/* Search box */}
      <Panel className="p-4">
        <Bar className="h-10 w-full" />
      </Panel>

      {/* Result-shaped rows */}
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Panel key={i} className="p-4">
            <div className="flex items-center gap-3">
              <Bar className="h-7 w-7 shrink-0 rounded-lg" />
              <div className="min-w-0 flex-1 space-y-2">
                <Bar className="h-3.5 w-2/3" />
                <Bar className="h-3 w-1/3" />
              </div>
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
