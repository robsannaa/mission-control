"use client";

import { Mail } from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";

const SUPPORT_EMAIL = "roberto.sannazzaro@gmail.com";

export function HelpView() {
  return (
    <SectionLayout>
      <SectionHeader
        title="Help & support"
        description="Need assistance? Get in touch and we’ll get back to you."
      />
      <SectionBody>
        <div className="flex flex-col items-start gap-4">
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="inline-flex items-center gap-2 rounded-control border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Mail className="h-4 w-4" />
            Contact support
          </a>
          <p className="text-xs text-muted-foreground">
            Click the button above to open your email client and send a message to {SUPPORT_EMAIL}.
          </p>
        </div>
      </SectionBody>
    </SectionLayout>
  );
}
