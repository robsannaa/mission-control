"use client";

import { AlertTriangle, ArrowRight, KeyRound, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Chat-level states.
 *
 * Each one names a different real situation. The rule: never show a message
 * that could equally be true of a working system doing nothing.
 */

export type ErrorShape = {
  title: string;
  body: string;
  action?: { label: string; href?: string; onClick?: () => void };
  tone: "danger" | "warning" | "neutral";
};

export function classifyChatError(message: string): ErrorShape {
  if (
    /No API key found|api[._-]key|auth\.profiles|FailoverError|Configure auth|unauthorized|invalid.*key|\b401\b/i.test(
      message,
    )
  ) {
    return {
      title: "Your agent needs an API key",
      body: "The model provider rejected the request — the key is missing, expired, or out of credit.",
      action: { label: "Open model settings", href: "/agents?tab=models" },
      tone: "warning",
    };
  }
  if (/rate.?limit|\b429\b|quota|exceeded|billing/i.test(message)) {
    return {
      title: "Usage limit reached",
      body: "Your provider reports a usage or billing limit. Wait a moment, or add credit to the account.",
      tone: "warning",
    };
  }
  if (/timeout|timed out|ECONNREFUSED|ENOTFOUND|fetch failed|network|503/i.test(message)) {
    return {
      title: "Could not reach the gateway",
      body: "The message was not sent. Check that the OpenClaw gateway is online, then try again.",
      tone: "warning",
    };
  }
  return {
    title: "Something went wrong",
    body: message.slice(0, 400),
    tone: "danger",
  };
}

export function InlineNotice({
  shape,
  onRetry,
  onDismiss,
}: {
  shape: ErrorShape;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "mx-auto mb-3 flex w-full max-w-3xl items-start gap-3 rounded-2xl border px-4 py-3",
        shape.tone === "danger"
          ? "border-danger-border bg-danger-bg"
          : shape.tone === "warning"
            ? "border-warning-border bg-warning-bg"
            : "border-border bg-card",
      )}
    >
      {shape.tone === "warning" ? (
        <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" aria-hidden />
      ) : (
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" aria-hidden />
      )}
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            "text-[13px] font-medium",
            shape.tone === "danger" ? "text-danger-fg" : "text-warning-fg",
          )}
        >
          {shape.title}
        </p>
        <p
          className={cn(
            "mt-1 text-[12px] leading-relaxed",
            shape.tone === "danger" ? "text-danger-fg" : "text-warning-fg",
          )}
        >
          {shape.body}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {shape.action?.href && (
            <a
              href={shape.action.href}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[12px] text-foreground transition-colors hover:bg-accent"
            >
              <ArrowRight className="h-3 w-3" aria-hidden />
              {shape.action.label}
            </a>
          )}
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[12px] text-foreground transition-colors hover:bg-accent"
            >
              <RefreshCw className="h-3 w-3" aria-hidden />
              Try again
            </button>
          )}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

export function ChatHero({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="px-6 py-10 text-center">
      <h1 className="text-[26px] font-medium tracking-tight text-foreground">
        {title}
      </h1>
      <p className="mx-auto mt-2 max-w-md text-[13.5px] leading-relaxed text-muted-foreground">
        {subtitle}
      </p>
    </div>
  );
}

export function AgentsUnavailable({
  warming,
  onRetry,
}: {
  warming: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <h2 className="text-[17px] font-medium text-foreground">
        {warming ? "Getting your agent ready" : "No agent is available"}
      </h2>
      <p className="mx-auto mt-2 max-w-sm text-[13px] leading-relaxed text-muted-foreground">
        {warming
          ? "Mission Control is waiting for the gateway to report an agent. This usually takes a few seconds."
          : "The gateway is not reporting any agent. Check that it is online, then try again."}
      </p>
      {!warming && (
        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            Try again
          </button>
          <a
            href="/doctor"
            className="inline-flex items-center gap-1.5 rounded-full border border-border px-3.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Run Doctor
          </a>
        </div>
      )}
    </div>
  );
}
