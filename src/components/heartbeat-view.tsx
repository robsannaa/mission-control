"use client";

import { Heart } from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { HeartbeatManager } from "@/components/heartbeat-manager";

export function HeartbeatView() {
  return (
    <SectionLayout>
      {/* One statement per screen. The card below explains heartbeat with the
          real numbers from this machine, so a second paragraph up here saying
          the same thing in vaguer words is just noise ahead of it. */}
      <SectionHeader
        title={
          <span className="flex items-center gap-2 text-xs">
            <Heart className="h-4 w-4 text-danger-fg" />
            Heartbeat
          </span>
        }
        description="A scheduled check-in that watches for what matters and tells you when something needs you."
      />
      <SectionBody width="content" padding="compact" innerClassName="space-y-4">
        <HeartbeatManager />
      </SectionBody>
    </SectionLayout>
  );
}
