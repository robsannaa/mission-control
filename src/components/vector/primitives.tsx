"use client";

/**
 * Small shared pieces the Vector page is built from.
 *
 * Mirrors the tone/pill/panel vocabulary used elsewhere in Mission Control
 * (see `src/components/doctor/primitives.tsx`) so this page reads as the same
 * product, without importing from a page this rebuild is scoped to stay out
 * of. Two rules hold across all of them:
 *
 *   1. Semantic tokens only — `bg-card`, `text-muted-foreground`, `border-border`.
 *      No hex, no Tailwind palette classes.
 *   2. Colour is a signal, not decoration. A healthy, working system renders
 *      in neutrals; amber and red appear only where something wants a person.
 */

import { useId, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/* ── tone ──────────────────────────────────────────────────────────────── */

export type Tone = "neutral" | "attention" | "critical" | "positive" | "unknown";

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  attention: "text-warning-fg",
  critical: "text-danger-fg",
  positive: "text-success-fg",
  unknown: "text-fg-subtle",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  attention: "bg-warning",
  critical: "bg-danger",
  positive: "bg-success",
  unknown: "bg-fg-placeholder",
};

/* ── StatusDot ─────────────────────────────────────────────────────────── */

/** A single small circle. Its meaning is defined once per usage site — see callers. */
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

/* ── Pill ──────────────────────────────────────────────────────────────── */

export function Pill({
  children,
  tone = "neutral",
  className,
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
  title?: string;
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
      title={title}
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

/* ── Panel ─────────────────────────────────────────────────────────────── */

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

/* ── Segmented control (ElevenLabs pill register) ─────────────────────────
   Fully-pilled 9999px, hairline border, flat surfaces. Buttons default to a
   6px control radius app-wide unless explicitly marked pill. */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn("inline-flex rounded-full border border-border bg-muted p-1", className)}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          data-control-radius="pill"
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
            value === opt.value
              ? "border border-border bg-card text-foreground shadow-xs"
              : "border border-transparent text-muted-foreground hover:text-foreground"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ── Disclosure ────────────────────────────────────────────────────────── */

export function Disclosure({
  label,
  openLabel,
  children,
  defaultOpen = false,
  className,
  contentClassName,
  onOpenChange,
}: {
  label: string;
  openLabel?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
  /** Fires with the new open state — use it for lazy-loading content on first expand. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((v) => { onOpenChange?.(!v); return !v; })}
        aria-expanded={open}
        aria-controls={panelId}
        className="group inline-flex items-center gap-1.5 rounded-control text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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

/* ── CodeLine ──────────────────────────────────────────────────────────── */

export function CodeLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-md border border-border-subtle bg-surface-inset px-3 py-2 font-mono text-xs leading-relaxed text-fg-secondary",
        className
      )}
    >
      {children}
    </pre>
  );
}
