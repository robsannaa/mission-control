"use client";

/**
 * A walkthrough for the problems that have no single button.
 *
 * The contract is explicit that a guide must read without its commands, so the
 * `command` on each step lives behind an "advanced" disclosure and the step's
 * `detail` carries the actual instruction. Where a step *is* something Mission
 * Control can do (`fixId`), it becomes a button in place — the user never has
 * to leave for a terminal to finish the sequence.
 *
 * Steps are ticked off locally. That is deliberately a memory aid, not a claim
 * about the system: only a fresh check can say whether the problem is gone, and
 * the footer says so.
 */

import { useState } from "react";
import { Check, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeLine, Disclosure, Modal } from "./primitives";
import type { DoctorFinding, FixDescriptor } from "./types";

export function GuideDialog({
  finding,
  fixes,
  onClose,
  onRunFix,
}: {
  finding: DoctorFinding;
  /** The whole repair catalog, so a step's `fixId` can become a real button. */
  fixes: Record<string, FixDescriptor>;
  onClose: () => void;
  onRunFix: (fix: FixDescriptor, contextTitle: string) => void;
}) {
  const [done, setDone] = useState<Set<number>>(new Set());

  const toggle = (i: number) =>
    setDone((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <Modal
      title="How to put this right"
      subtitle={finding.title}
      onClose={onClose}
      width="lg"
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-relaxed text-fg-subtle">
            Ticking a step is just a note to yourself. Run a check when you are done to see whether
            the finding has actually gone.
          </p>
          <Button size="sm" onClick={onClose} data-autofocus>
            Close
          </Button>
        </div>
      }
    >
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
        {finding.explanation}
      </p>

      <ol className="mt-6 space-y-0">
        {finding.guide.map((step, i) => {
          const fix = step.fixId ? fixes[step.fixId] : undefined;
          const isDone = done.has(i);
          const isLast = i === finding.guide.length - 1;

          return (
            <li key={`${step.title}-${i}`} className="relative flex gap-4 pb-6 last:pb-0">
              {!isLast && (
                <span
                  className="absolute left-[0.9375rem] top-8 bottom-0 w-px bg-border"
                  aria-hidden
                />
              )}
              <button
                type="button"
                onClick={() => toggle(i)}
                aria-pressed={isDone}
                aria-label={isDone ? `Mark step ${i + 1} as not done` : `Mark step ${i + 1} as done`}
                className={cn(
                  "relative z-10 mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border text-xs font-semibold tabular-nums transition-colors",
                  isDone
                    ? "border-success-border bg-success-bg text-success-fg"
                    : "border-border bg-card text-muted-foreground hover:border-border-strong hover:text-foreground"
                )}
                data-control-radius="pill"
              >
                {isDone ? <Check className="h-4 w-4" strokeWidth={2.5} /> : i + 1}
              </button>

              <div className="min-w-0 flex-1 pt-1">
                <h3
                  className={cn(
                    "text-sm font-semibold leading-snug tracking-[-0.01em]",
                    isDone ? "text-muted-foreground line-through" : "text-foreground"
                  )}
                >
                  {step.title}
                </h3>
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
                  {step.detail}
                </p>

                {step.verify && (
                  <p className="mt-2 max-w-prose text-sm leading-relaxed text-fg-secondary">
                    <span className="font-medium text-foreground">You will know it worked: </span>
                    {step.verify}
                  </p>
                )}

                {fix && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-3"
                    onClick={() => onRunFix(fix, finding.title)}
                  >
                    <Wrench className="h-3.5 w-3.5" />
                    {fix.label}
                    {fix.safety !== "safe" ? "…" : ""}
                  </Button>
                )}

                {step.command && (
                  <Disclosure
                    className="mt-3"
                    label="Show the command, for the curious"
                    openLabel="Hide the command"
                  >
                    <CodeLine className="break-all">{step.command}</CodeLine>
                  </Disclosure>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}
