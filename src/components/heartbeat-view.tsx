"use client";

import { Heart } from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { HeartbeatManager } from "@/components/heartbeat-manager";

export function HeartbeatView() {
  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2 text-xs">
            <Heart className="h-4 w-4 text-danger-fg" />
            Heartbeat
          </span>
        }
        description="Stay on top of important updates automatically, without checking in manually. Heartbeat is a scheduled check-in that lets your agent watch for what matters and notify you when needed."
      />
      <SectionBody width="content" padding="compact" innerClassName="space-y-4">
        <HeartbeatManager />
      </SectionBody>
    </SectionLayout>
  );
}
