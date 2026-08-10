"use client";

/**
 * Answering the agent.
 *
 * Two situations arrive here and they must never be collapsed into one:
 *
 *   high confidence — the agent emitted `NEEDS_INPUT:`. What it says is a
 *     question, and the only sensible action is to answer it.
 *   low confidence  — the run ended with no marker at all. We cannot tell
 *     "finished" from "waiting", so the board says so and offers both doors:
 *     answer it, or accept it as done.
 *
 * Claiming the agent asked something when we are guessing would make every
 * genuine question less believable.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CornerDownLeft, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/markdown-content";
import { useBodyScrollLock, useFocusTrap } from "@/hooks/use-modal-accessibility";
import { useSubmitModifier } from "@/hooks/use-shortcut-label";
import { questionCopy, stripMarker, type QuestionConfidence } from "./types";

export type AnswerIntent = {
  taskId: number;
  taskTitle: string;
  agentLabel: string;
  question: string;
  confidence: QuestionConfidence;
  /** Where the card goes back to once it resumes. */
  returnColumnTitle: string | null;
  turns: number;
};

export function AnswerDialog({
  intent,
  onClose,
  onResumed,
}: {
  intent: AnswerIntent;
  onClose: () => void;
  /** The card is running again (or has been marked done) — refetch the board. */
  onResumed: () => void;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<"answer" | "done" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const trapRef = useFocusTrap(true);
  useBodyScrollLock(true);
  const submitModifier = useSubmitModifier();

  const copy = questionCopy(intent.confidence);
  const lowConfidence = intent.confidence === "low";
  const body = lowConfidence ? intent.question : stripMarker(intent.question);

  useEffect(() => {
    // Keyboard-first: the caret is already where the user needs it.
    const id = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, []);

  const send = useCallback(async () => {
    const text = answer.trim();
    if (!text || busy) return;
    setBusy("answer");
    setError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "answer", taskId: intent.taskId, answer: text }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload?.error || `The gateway refused (${res.status}).`);
        setBusy(null);
        return;
      }
      onResumed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [answer, busy, intent.taskId, onClose, onResumed]);

  const markDone = useCallback(async () => {
    if (busy) return;
    setBusy("done");
    setError(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve", taskId: intent.taskId, outcome: "done" }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(payload?.error || `The gateway refused (${res.status}).`);
        setBusy(null);
        return;
      }
      onResumed();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }, [busy, intent.taskId, onClose, onResumed]);

  // Esc closes; Cmd/Ctrl+Enter submits from anywhere in the dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void send();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, send]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 animate-backdrop-in"
      onClick={() => !busy && onClose()}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label={copy.heading}
        className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — what happened, in one line of plain language. */}
        <div className="border-b border-border-subtle px-5 py-3.5">
          <h3 className="text-sm font-semibold text-foreground">{copy.heading}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={intent.taskTitle}>
            {intent.agentLabel} · {intent.taskTitle}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">{copy.lead}</p>

          {/* What it said. A quote, not a form field. */}
          <blockquote
            className={cn(
              "mt-2.5 rounded-xl border-l-2 bg-surface-inset px-3.5 py-3",
              lowConfidence ? "border-l-border-strong" : "border-l-foreground/30",
            )}
          >
            <MarkdownContent content={body} className="text-[13px]" />
          </blockquote>

          {lowConfidence && (
            <p className="mt-2.5 text-xs leading-relaxed text-fg-subtle">
              If that reads like a finished piece of work, mark it done. If it reads
              like it is waiting on you, answer it and the agent picks up where it
              left off.
            </p>
          )}

          {/* The answer. Sentence-case label that reads as language. */}
          <label className="mt-4 block">
            <span className="text-xs font-medium text-fg-secondary">Your answer</span>
            <textarea
              ref={inputRef}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={4}
              placeholder={
                lowConfidence
                  ? "Tell it what to do next…"
                  : "Answer the question, and it carries on…"
              }
              className="mt-1.5 w-full resize-y rounded-xl border border-border-subtle bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-fg-placeholder focus:border-border-strong"
            />
          </label>

          <p className="mt-2 text-[11px] leading-relaxed text-fg-subtle">
            {intent.returnColumnTitle
              ? `The card returns to ${intent.returnColumnTitle} and the agent resumes with everything it already knows.`
              : "The agent resumes with everything it already knows."}
            {intent.turns > 1 ? ` This is turn ${intent.turns + 1}.` : ""}
          </p>

          {error && (
            <p className="mt-3 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger-fg">
              {error}
            </p>
          )}
        </div>

        {/* Footer — real buttons, one clear primary action. */}
        <div className="flex items-center gap-2 border-t border-border-subtle px-5 py-3">
          {lowConfidence && (
            <button
              type="button"
              onClick={markDone}
              disabled={Boolean(busy)}
              className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground disabled:opacity-40"
            >
              <Check className="h-3.5 w-3.5" />
              {busy === "done" ? "Marking…" : "Mark done"}
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={Boolean(busy)}
            className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={send}
            disabled={!answer.trim() || Boolean(busy)}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
            {busy === "answer" ? "Sending…" : "Send answer"}
            <kbd className="ml-0.5 inline-flex items-center gap-0.5 rounded border border-primary-foreground/25 px-1 text-[10px] font-medium opacity-70">
              {submitModifier}
              <CornerDownLeft className="h-2.5 w-2.5" />
            </kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
