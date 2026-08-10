"use client";

/**
 * Small shared pieces the Doctor page is built from.
 *
 * Two rules hold across all of them:
 *   1. Semantic tokens only — `bg-card`, `text-muted-foreground`, `border-border`.
 *      No hex, no palette classes.
 *   2. Colour is a signal, not decoration. A healthy system renders entirely in
 *      neutrals; amber and red appear only where something wants a person.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { ChevronRight, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ── tone ──────────────────────────────────────────────────────────────── */

export type Tone = "neutral" | "attention" | "critical" | "positive" | "unknown";

/** Text colour per tone. Neutral tones stay in the type ramp on purpose. */
export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  attention: "text-warning-fg",
  critical: "text-danger-fg",
  positive: "text-success-fg",
  unknown: "text-fg-subtle",
};

/** Solid indicator colour per tone. */
export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-fg-subtle",
  attention: "bg-warning",
  critical: "bg-danger",
  positive: "bg-success",
  unknown: "bg-fg-placeholder",
};

/* ── StatusDot ─────────────────────────────────────────────────────────── */

/**
 * A single small circle. `pulse` adds a slow halo — used once per page, on the
 * live verdict, never on a list of rows.
 */
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

/* ── Disclosure ────────────────────────────────────────────────────────── */

/**
 * A summary/detail pair that grows rather than jumps. The `grid-rows` trick
 * animates to the content's natural height without measuring it in JS, so it
 * stays smooth for a one-line note and a 40-line transcript alike.
 */
export function Disclosure({
  label,
  openLabel,
  children,
  defaultOpen = false,
  className,
  contentClassName,
  count,
}: {
  label: string;
  openLabel?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  contentClassName?: string;
  count?: number;
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
          className={cn(
            "h-3.5 w-3.5 transition-transform duration-200 ease-out",
            open && "rotate-90"
          )}
        />
        <span>{open ? (openLabel ?? label) : label}</span>
        {typeof count === "number" && count > 0 && (
          <span className="tabular-nums text-fg-subtle">{count}</span>
        )}
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

/* ── Code ──────────────────────────────────────────────────────────────── */

/** A command or a verbatim machine line. Always scrolls rather than wrapping badly. */
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

/* ── Card & section headings ───────────────────────────────────────────── */

export function Panel({
  children,
  className,
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
}) {
  return (
    <As className={cn("rounded-2xl border border-border bg-card", className)}>{children}</As>
  );
}

export function SectionTitle({
  title,
  hint,
  action,
  className,
}: {
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-end justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-[-0.01em] text-foreground">{title}</h2>
        {hint ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/* ── Modal ─────────────────────────────────────────────────────────────── */

/**
 * A centred dialog rendered into `document.body`, so no ancestor's `overflow`
 * or stacking context can clip it. Escape closes, the backdrop closes, focus
 * lands inside on open and returns to the opener on close.
 */
export function Modal({
  title,
  subtitle,
  onClose,
  children,
  footer,
  width = "md",
  tone = "neutral",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  tone?: Tone;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  // A dialog only ever opens from a user action, so this component never
  // renders on the server. Focus is captured on mount and handed back on close.
  useEffect(() => {
    const opener = document.activeElement;
    const node = panelRef.current;
    const target =
      node?.querySelector<HTMLElement>("[data-autofocus]") ??
      node?.querySelector<HTMLElement>("button, [href], input, select, textarea");
    target?.focus();
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  /*
   * `aria-modal` promises assistive tech that the rest of the page is
   * unreachable, so Tab must honour that. Without the trap, tabbing off the
   * last control lands silently behind the scrim — on the confirmation dialog
   * for a destructive repair, that is a bad place to lose the keyboard.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const node = panelRef.current;
      if (!node) return;
      const focusable = [
        ...node.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || !node.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Stop the page behind the scrim scrolling with the wheel or a trackpad.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  const stop = useCallback((e: React.MouseEvent) => e.stopPropagation(), []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      /* The scrim has to darken in both themes: `bg-foreground/30` is ink over
         paper in light mode, but in dark mode the foreground *is* the light
         colour, so the dark theme dims with its own background instead. */
      className="fixed inset-0 z-[70] flex items-end justify-center overflow-y-auto bg-foreground/30 p-0 backdrop-blur-[2px] animate-backdrop-in dark:bg-background/80 sm:items-center sm:p-6"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={stop}
        className={cn(
          "relative my-0 flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl border border-border bg-card shadow-xl animate-modal-in sm:my-auto sm:rounded-2xl",
          width === "lg" ? "sm:max-w-2xl" : "sm:max-w-xl"
        )}
      >
        <header className="flex shrink-0 items-start gap-4 border-b border-border-subtle px-6 pb-5 pt-6">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className={cn(
                "text-base font-semibold tracking-[-0.01em]",
                tone === "critical" ? "text-danger-fg" : "text-foreground"
              )}
            >
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{subtitle}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1.5 -mt-1 shrink-0 rounded-full p-1.5 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer ? (
          <footer className="shrink-0 border-t border-border-subtle bg-surface-subtle px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body
  );
}

/* ── EmptyNote ─────────────────────────────────────────────────────────── */

/** The calm way to say "nothing here" without a wall of ticks. */
export function QuietNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-sm leading-relaxed text-muted-foreground", className)}>{children}</p>
  );
}
