"use client";

/**
 * Stopping a run is destructive and irreversible, so it is always confirmed —
 * and the confirmation reports what actually happened. The gateway can answer
 * "there was nothing left to stop", and saying "stopped" in that case would be a
 * lie the card then has to live with.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock, useFocusTrap } from "@/hooks/use-modal-accessibility";

export type StopIntent = {
  taskId: number;
  taskTitle: string;
  agentLabel: string;
  /** Set when the stop was triggered by dragging the card somewhere else. */
  moveTo?: { columnId: string; columnTitle: string };
};

type Phase = "confirm" | "working" | "note" | "error";

export function StopRunDialog({
  intent,
  onStopped,
  onClose,
}: {
  intent: StopIntent;
  /**
   * The run is settled on disk. Given a column id, the board should also move
   * the card there — the server deliberately leaves the column alone.
   */
  onStopped: (moveToColumnId?: string) => void;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("confirm");
  const [message, setMessage] = useState("");
  const trapRef = useFocusTrap(true);
  useBodyScrollLock(true);

  const confirm = useCallback(async () => {
    setPhase("working");
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", taskId: intent.taskId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setMessage(body?.error || `The gateway refused (${res.status}).`);
        setPhase("error");
        return;
      }
      onStopped(intent.moveTo?.columnId);
      if (body?.cancelled) {
        onClose();
        return;
      }
      // Honest outcome: there was no live run left to abort.
      setMessage(
        "That run had already finished, so there was nothing to stop. The card is unchanged apart from the move.",
      );
      setPhase("note");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [intent, onStopped, onClose]);

  const working = phase === "working";

  // Escape backs out of the question, but never out of a stop in flight.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [working, onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 animate-backdrop-in"
      onClick={() => (phase === "confirm" ? onClose() : undefined)}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Stop this run"
        className="w-full max-w-sm rounded-2xl border border-border bg-card p-5 shadow-xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === "error" ? (
          <>
            <Head icon tone="danger" title="The run could not be stopped" />
            <p className="mt-2 break-words text-[13px] leading-relaxed text-muted-foreground">
              {message}
            </p>
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              It may still be going. The card has been left where it was.
            </p>
            <Actions>
              <Primary onClick={onClose}>Close</Primary>
            </Actions>
          </>
        ) : phase === "note" ? (
          <>
            <Head title="Nothing left to stop" />
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              {message}
            </p>
            <Actions>
              <Primary onClick={onClose}>Done</Primary>
            </Actions>
          </>
        ) : (
          <>
            <Head title="Stop this run?" />
            {/* An agent id is not a sentence opener — it reads as a typo. */}
            <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
              <span className="text-foreground">{intent.taskTitle}</span> is still
              running on {intent.agentLabel}. Stopping ends the run where it stands —
              whatever it has not finished is lost.
            </p>
            {intent.moveTo && (
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                The card will then move to{" "}
                <span className="text-foreground">{intent.moveTo.columnTitle}</span>.
              </p>
            )}
            <Actions>
              <button
                type="button"
                onClick={onClose}
                disabled={working}
                className="rounded-full px-4 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
              >
                Keep running
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={working}
                className="rounded-full bg-danger px-4 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {working ? "Stopping…" : "Stop the run"}
              </button>
            </Actions>
          </>
        )}
      </div>
    </div>
  );
}

function Head({
  title,
  icon,
  tone,
}: {
  title: string;
  icon?: boolean;
  tone?: "danger";
}) {
  return (
    <div className="flex items-center gap-2">
      {icon && (
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
            tone === "danger" ? "bg-danger-bg text-danger-fg" : "bg-muted text-muted-foreground",
          )}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
        </span>
      )}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex items-center justify-end gap-2">{children}</div>;
}

function Primary({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full bg-primary px-4 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
    >
      {children}
    </button>
  );
}
