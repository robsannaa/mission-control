"use client";

/**
 * Small shared pieces the Heartbeat page is built from — same conventions as
 * the Doctor and Tasks surfaces: semantic tokens only, rounded-2xl cards,
 * pills over chips, colour used only where something wants attention.
 */

import { type ReactNode, useId, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type Tone = "neutral" | "attention" | "critical" | "positive";

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  attention: "bg-warning",
  critical: "bg-danger",
  positive: "bg-success",
};

export function StatusDot({
  tone,
  pulse = false,
  className,
}: {
  tone: Tone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex h-2 w-2 shrink-0", className)} aria-hidden>
      {pulse && (
        <span
          className={cn(
            "absolute inset-0 rounded-full opacity-40 motion-safe:animate-ping",
            TONE_DOT[tone]
          )}
        />
      )}
      <span className={cn("relative h-2 w-2 rounded-full", TONE_DOT[tone])} />
    </span>
  );
}

export function Panel({
  children,
  className,
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return <As className={cn("rounded-2xl border border-border bg-card", className)}>{children}</As>;
}

export function Pill({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const toneClass =
    tone === "attention"
      ? "border-warning-border bg-warning-bg text-warning-fg"
      : tone === "critical"
        ? "border-danger-border bg-danger-bg text-danger-fg"
        : tone === "positive"
          ? "border-success-border bg-success-bg text-success-fg"
          : "border-border bg-muted text-muted-foreground";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none",
        toneClass,
        className
      )}
    >
      {children}
    </span>
  );
}

/** A pill-shaped choice button, used for cadence and delivery pickers. */
export function ChoicePill({
  selected,
  onClick,
  children,
  className,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
        selected
          ? "border-primary/40 bg-primary/12 text-foreground"
          : "border-border text-muted-foreground hover:border-border-strong hover:text-foreground",
        className
      )}
    >
      {children}
    </button>
  );
}

export function Disclosure({
  label,
  openLabel,
  children,
  defaultOpen = false,
  className,
  contentClassName,
}: {
  label: ReactNode;
  openLabel?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        className="group inline-flex items-center gap-1.5 rounded-control text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform duration-200 ease-out", open && "rotate-90")}
        />
        <span>{open ? (openLabel ?? label) : label}</span>
      </button>
      <div
        id={panelId}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-250 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden">
          <div className={cn("pt-3", contentClassName)}>{children}</div>
        </div>
      </div>
    </div>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs text-muted-foreground">{children}</label>;
}

export const fieldInputClass =
  "w-full rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-foreground outline-none transition-colors focus-visible:border-border-strong";
