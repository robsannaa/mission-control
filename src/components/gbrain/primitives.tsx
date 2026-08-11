"use client";

/**
 * Small shared pieces the G-Brain tab is built from.
 *
 * Mirrors the tone/pill/panel/segmented-control vocabulary used elsewhere in
 * Mission Control (see `src/components/vector/primitives.tsx` and
 * `src/components/doctor/primitives.tsx`) so this feature reads as the same
 * product, without cross-importing from a page this rebuild is scoped to
 * stay out of. Two rules hold across all of them:
 *
 *   1. Semantic tokens only — `bg-card`, `text-muted-foreground`, `border-border`.
 *      No hex, no Tailwind palette classes.
 *   2. Colour is a signal, not decoration. A healthy, working brain renders
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

export const TONE_STROKE: Record<Tone, string> = {
  neutral: "stroke-fg-subtle",
  attention: "stroke-warning",
  critical: "stroke-danger",
  positive: "stroke-success",
  unknown: "stroke-fg-placeholder",
};

/* ── StatusDot ─────────────────────────────────────────────────────────── */

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
            TONE_DOT[tone],
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
          : tone === "unknown"
            ? "border-border-subtle bg-surface-subtle text-fg-subtle"
            : "border-border bg-muted text-muted-foreground";

  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none",
        toneClass,
        className,
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
   Fully-pilled 9999px, hairline border, flat surfaces — this is the primary
   tab switcher for the whole feature (replacing a boxed underline-tab). */

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        "inline-flex flex-wrap items-center gap-0.5 rounded-full border border-border bg-muted p-1",
        className,
      )}
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
            "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors",
            value === opt.value
              ? "border border-border bg-card text-foreground shadow-xs"
              : "border border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {opt.icon}
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
  label: ReactNode;
  openLabel?: ReactNode;
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
        onClick={() => {
          const next = !open;
          setOpen(next);
          onOpenChange?.(next);
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className="group inline-flex items-center gap-1.5 rounded-control text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform duration-200 ease-out", open && "rotate-90")}
        />
        <span>{open ? (openLabel ?? label) : label}</span>
      </button>
      <div
        id={panelId}
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-250 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
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
        "overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-surface-inset px-3 py-2 font-mono text-xs leading-relaxed text-fg-secondary",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/* ── ScoreRing — circular health indicator ────────────────────────────── */

export function ScoreRing({
  value,
  max = 100,
  tone,
  size = 88,
  strokeWidth = 8,
  label,
}: {
  value: number | null;
  max?: number;
  tone: Tone;
  size?: number;
  strokeWidth?: number;
  label?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value / max));
  const dash = circumference * pct;

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-border-subtle"
        />
        {value != null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            className={cn("transition-[stroke-dasharray] duration-500 ease-out", TONE_STROKE[tone])}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold tabular-nums leading-none text-foreground">
          {value ?? "—"}
        </span>
        {label && <span className="mt-1 text-[10px] font-medium uppercase tracking-wide text-fg-subtle">{label}</span>}
      </div>
    </div>
  );
}

/* ── Stat — a single labelled number ─────────────────────────────────── */

export function Stat({
  label,
  value,
  sub,
  tone = "neutral",
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <p className="eyebrow">{label}</p>
      <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums leading-none", tone === "neutral" ? "text-foreground" : TONE_TEXT[tone])}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

/* ── Bar — a horizontal proportion bar ───────────────────────────────── */

export function Bar({ pct, tone = "neutral", className }: { pct: number; tone?: Tone; className?: string }) {
  const fill =
    tone === "positive" ? "bg-success" : tone === "attention" ? "bg-warning" : tone === "critical" ? "bg-danger" : "bg-fg-subtle";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-border-subtle", className)}>
      <div className={cn("h-full rounded-full transition-all duration-300", fill)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/* ── EmptyState ───────────────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border-subtle px-6 py-12 text-center", className)}>
      {icon && <div className="mb-1 text-fg-subtle">{icon}</div>}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
