"use client";

/**
 * The full and deep checks apply OpenClaw's own safe migrations as they go, so
 * they are not really "checks" — they change files on this machine. The server
 * refuses them without `acknowledgeMutation: true`; this dialog is where that
 * acknowledgement is actually earned, in words rather than in a flag.
 *
 * The read-only alternative is always offered on the same screen, because the
 * honest default for someone who just wants to know how things are is the quick
 * check.
 */

import { Button } from "@/components/ui/button";
import { Modal, Pill } from "./primitives";
import type { RunMode } from "./types";

const COPY: Record<
  Exclude<RunMode, "quick">,
  { title: string; blurb: string; changes: string[] }
> = {
  full: {
    title: "Run the full check?",
    blurb:
      "The full check runs everything the quick check does, and then hands over to OpenClaw's own doctor. That part does not only look — it tidies as it goes.",
    changes: [
      "Settings that live in files newer versions no longer read are moved across.",
      "Leftover conversation files are archived by renaming them, never deleted.",
      "Your settings file is backed up before anything is written.",
    ],
  },
  deep: {
    title: "Run the deep check?",
    blurb:
      "The deep check does everything the full check does, and additionally reports gaps in your conversation history, the current tool-result limit, and who is connected to the gateway right now.",
    changes: [
      "Settings that live in files newer versions no longer read are moved across.",
      "Leftover conversation files are archived by renaming them, never deleted.",
      "Your settings file is backed up before anything is written.",
      "It takes a little longer, because it reads every recent conversation.",
    ],
  },
};

export function RunConfirmDialog({
  mode,
  onClose,
  onConfirm,
  onChooseQuick,
}: {
  mode: Exclude<RunMode, "quick">;
  onClose: () => void;
  onConfirm: () => void;
  onChooseQuick: () => void;
}) {
  const copy = COPY[mode];

  return (
    <Modal
      title={copy.title}
      subtitle={copy.blurb}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button size="sm" variant="ghost" onClick={onChooseQuick}>
            Just look, change nothing
          </Button>
          <div className="flex items-center gap-2.5">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={onConfirm} data-autofocus>
              Yes, run it
            </Button>
          </div>
        </div>
      }
    >
      <div className="space-y-5">
        <Pill tone="attention">Changes files on this machine</Pill>

        <section>
          <h3 className="text-sm font-semibold text-foreground">What it will change</h3>
          <ul className="mt-2.5 space-y-2">
            {copy.changes.map((c) => (
              <li key={c} className="flex gap-2.5 text-sm leading-relaxed text-fg-secondary">
                <span
                  className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-border-strong"
                  aria-hidden
                />
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </section>

        <p className="rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3.5 text-sm leading-relaxed text-fg-secondary">
          If you only want to know how things stand, the quick check answers that without touching
          anything. It covers all 51 health checks, the security audit and the live readings — the
          full check adds OpenClaw&rsquo;s own pass on top.
        </p>
      </div>
    </Modal>
  );
}
