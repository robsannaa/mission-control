"use client";

/**
 * Preview a repair, then commit to it — never the other way round.
 *
 * The dialog has four states and they always run in this order:
 *
 *   loading → preview → applying → outcome
 *
 * The preview is a real `GET /api/doctor/fix?fixId=…`. When the server says
 * `simulated: false` the wording changes from "here is what will happen" to
 * "here is what it claims it will fix", because the difference is the whole
 * point of asking.
 *
 * The outcome is reported as the server reports it. `still-present` — the
 * command exited zero and the problem is still there — is rendered as a
 * failure, with no tick anywhere near it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CircleAlert,
  Loader2,
  RotateCw,
  ShieldAlert,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { CodeLine, Disclosure, Modal, Pill } from "./primitives";
import { describeDuration } from "./format";
import { errorMessage, readEventStream } from "./sse";
import type { FixDescriptor, FixEvent, FixOutcome, FixPreview } from "./types";

type Phase = "loading" | "preview" | "applying" | "outcome" | "error";

const SAFETY_COPY: Record<
  FixDescriptor["safety"],
  { pill: string; tone: "neutral" | "attention" | "critical"; note: string }
> = {
  safe: {
    pill: "Safe",
    tone: "neutral",
    note: "This one is reversible in practice and touches nothing you set up by hand.",
  },
  caution: {
    pill: "Changes real settings",
    tone: "attention",
    note: "This rewrites something on your machine. Read what it changes before you press it.",
  },
  destructive: {
    pill: "Hard to undo",
    tone: "critical",
    note: "This overwrites something you may have set up yourself, or breaks connections that are working right now.",
  },
};

/* ── the streaming outcome view ────────────────────────────────────────── */

function OutcomeView({ outcome }: { outcome: FixOutcome }) {
  const good = outcome.status === "verified-fixed";
  const soft = outcome.status === "applied-unverified";
  const bad = outcome.status === "still-present" || outcome.status === "failed" || outcome.status === "refused";

  const heading =
    outcome.status === "verified-fixed"
      ? "Fixed — and checked again to be sure"
      : outcome.status === "applied-unverified"
        ? "Done. There is no automatic way to confirm this one."
        : outcome.status === "still-present"
          ? "It ran, but the problem is still there"
          : outcome.status === "refused"
            ? "OpenClaw refused to do this"
            : "That did not work";

  return (
    <div className="animate-in fade-in duration-300">
      <div className="flex items-start gap-4">
        <span
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border animate-in zoom-in-95 fade-in duration-500",
            good
              ? "border-success-border bg-success-bg text-success-fg"
              : soft
                ? "border-border bg-muted text-fg-secondary"
                : "border-danger-border bg-danger-bg text-danger-fg"
          )}
        >
          {good ? (
            <Check className="h-5 w-5" strokeWidth={2.5} />
          ) : soft ? (
            <Check className="h-5 w-5" strokeWidth={2} />
          ) : (
            <CircleAlert className="h-5 w-5" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "text-base font-semibold leading-snug tracking-[-0.01em]",
              bad ? "text-danger-fg" : "text-foreground"
            )}
          >
            {heading}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{outcome.message}</p>
          <p className="mt-2 text-xs tabular-nums text-fg-subtle">
            Took {describeDuration(outcome.durationMs)}
          </p>
        </div>
      </div>

      {outcome.verification && (
        <div className="mt-5 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3.5">
          <p className="text-xs font-medium text-fg-subtle">
            {outcome.verification.ran ? "How this was checked" : "Why it could not be checked"}
          </p>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-secondary">
            {outcome.verification.detail}
          </p>
        </div>
      )}

      {outcome.requiresRestart && (
        <p className="mt-4 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3 text-sm leading-relaxed text-fg-secondary">
          <RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          The change is saved, but the running service is still using the old settings. Restart it
          when convenient — the &ldquo;Restart the background service&rdquo; repair does exactly
          that.
        </p>
      )}

      {(outcome.raw.stdout || outcome.raw.stderr) && (
        <Disclosure
          className="mt-5"
          label="Show what the command printed"
          openLabel="Hide what the command printed"
        >
          <CodeLine className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words">
            {[outcome.raw.stdout, outcome.raw.stderr].filter(Boolean).join("\n")}
          </CodeLine>
        </Disclosure>
      )}
    </div>
  );
}

/* ── the dialog ────────────────────────────────────────────────────────── */

export function FixDialog({
  fix,
  contextTitle,
  onClose,
  onFinished,
}: {
  fix: FixDescriptor;
  /** The finding the user pressed the button on, for orientation. */
  contextTitle: string | null;
  onClose: () => void;
  /** Called once a repair has actually run, so the page can re-check. */
  onFinished: (outcome: FixOutcome) => void;
}) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [preview, setPreview] = useState<FixPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [stage, setStage] = useState<string>("Starting…");
  const [log, setLog] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<FixOutcome | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const safety = SAFETY_COPY[fix.safety];

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/doctor/fix?fixId=${encodeURIComponent(fix.id)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(await errorMessage(res, `The preview failed (${res.status}).`));
        const data = (await res.json()) as FixPreview;
        if (cancelled) return;
        setPreview(data);
        setPhase("preview");
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("preview");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fix.id]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const apply = useCallback(async () => {
    setPhase("applying");
    setLog([]);
    setStage("Starting…");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/doctor/fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fixId: fix.id, confirm: true }),
        signal: controller.signal,
      });

      if (!res.ok) {
        setError(await errorMessage(res, `The repair could not start (${res.status}).`));
        setPhase("error");
        return;
      }

      const seen: { outcome: FixOutcome | null; failed: boolean } = {
        outcome: null,
        failed: false,
      };
      await readEventStream<FixEvent>(
        res,
        (event) => {
          if (event.type === "stage") setStage(event.label);
          else if (event.type === "output") {
            setLog((prev) => {
              const next = [...prev, event.text];
              return next.length > 400 ? next.slice(-400) : next;
            });
          } else if (event.type === "outcome") {
            seen.outcome = event.outcome;
            setOutcome(event.outcome);
            setPhase("outcome");
          } else if (event.type === "error") {
            seen.failed = true;
            setError(event.message);
            setPhase("error");
          }
        },
        controller.signal
      );

      if (seen.outcome) {
        onFinished(seen.outcome);
      } else if (!seen.failed) {
        // A stream that ends without an outcome is a failure, not a success.
        setError("The repair ended without reporting a result, so nothing can be confirmed.");
        setPhase("error");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [fix.id, onFinished]);

  /* ── footer ── */

  const canApply =
    phase === "preview" &&
    !error &&
    (fix.safety !== "destructive" || acknowledged) &&
    (preview?.blockers.length ?? 0) === 0;

  const footer =
    phase === "outcome" || phase === "error" ? (
      <div className="flex justify-end">
        <Button size="sm" onClick={onClose} data-autofocus>
          Close
        </Button>
      </div>
    ) : phase === "applying" ? (
      <div className="flex items-center gap-3">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">{stage}</span>
      </div>
    ) : (
      <div className="flex flex-wrap items-center justify-end gap-2.5">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Not now
        </Button>
        <Button
          size="sm"
          variant={fix.safety === "destructive" ? "destructive" : "default"}
          onClick={apply}
          disabled={!canApply}
          data-doctor-confirm={fix.id}
        >
          {fix.safety === "safe" ? "Do it" : "Yes, make this change"}
        </Button>
      </div>
    );

  return (
    <Modal
      title={fix.label}
      subtitle={contextTitle ? `For: ${contextTitle}` : undefined}
      onClose={phase === "applying" ? () => {} : onClose}
      footer={footer}
      width="lg"
      tone={fix.safety === "destructive" ? "critical" : "neutral"}
    >
      {phase === "applying" ? (
        <div className="animate-in fade-in duration-200">
          <p className="text-sm leading-relaxed text-muted-foreground">{stage}</p>
          <div className="mt-4 max-h-72 overflow-y-auto rounded-xl border border-border-subtle bg-surface-inset p-3">
            {log.length === 0 ? (
              <p className="font-mono text-xs text-fg-subtle">Waiting for the command to speak…</p>
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-fg-secondary">
                {log.join("")}
              </pre>
            )}
          </div>
        </div>
      ) : phase === "outcome" && outcome ? (
        <OutcomeView outcome={outcome} />
      ) : phase === "error" ? (
        <div className="flex items-start gap-3">
          <X className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
          <p className="text-sm leading-relaxed text-danger-fg">{error}</p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={safety.tone}>{safety.pill}</Pill>
            {fix.requiresRestart && <Pill>Needs a restart afterwards</Pill>}
            {preview?.simulated && preview.kind === "dry-run" && (
              <Pill>Rehearsed for real, without changing anything</Pill>
            )}
          </div>

          <section>
            <h3 className="text-sm font-semibold text-foreground">What this does</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{fix.whatItDoes}</p>
          </section>

          {phase === "loading" ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Working out exactly what would change…
              </span>
            </div>
          ) : error ? (
            <div className="flex items-start gap-2.5 rounded-xl border border-danger-border bg-danger-bg px-4 py-3.5">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" />
              <p className="text-sm leading-relaxed text-danger-fg">{error}</p>
            </div>
          ) : preview ? (
            <>
              <section>
                <h3 className="text-sm font-semibold text-foreground">
                  {preview.simulated
                    ? "What will change"
                    : "What it claims it will fix"}
                </h3>
                {!preview.simulated && (
                  <p className="mt-1.5 text-xs leading-relaxed text-fg-subtle">
                    This command has no rehearsal mode, so Mission Control cannot show you the
                    result in advance. What follows is what OpenClaw says it will address — not a
                    simulation of it.
                  </p>
                )}
                {preview.changes.length > 0 ? (
                  <ul className="mt-2.5 space-y-2">
                    {preview.changes.map((c, i) => (
                      <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-fg-secondary">
                        <span
                          className="mt-[0.55rem] h-1 w-1 shrink-0 rounded-full bg-border-strong"
                          aria-hidden
                        />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted-foreground">
                    The rehearsal found nothing that would change.
                  </p>
                )}
              </section>

              {preview.blockers.length > 0 && (
                <section className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3.5">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-warning-fg">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    Not a good moment for this
                  </h3>
                  <ul className="mt-2 space-y-1.5">
                    {preview.blockers.map((b, i) => (
                      <li key={i} className="text-sm leading-relaxed text-warning-fg">
                        {b}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {preview.affects.length > 0 && (
                <section>
                  <h3 className="text-sm font-semibold text-foreground">
                    Findings this touches
                    {preview.affects.length > 1 ? ` (${preview.affects.length})` : ""}
                  </h3>
                  <ul className="mt-2.5 space-y-1.5">
                    {preview.affects.map((a) => (
                      <li key={a.id} className="text-sm leading-relaxed text-muted-foreground">
                        {a.title}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section>
                <h3 className="text-sm font-semibold text-foreground">Things to know first</h3>
                <ul className="mt-2.5 space-y-2">
                  {preview.sideEffects.map((s, i) => (
                    <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-fg-secondary">
                      <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-3 text-xs leading-relaxed text-fg-subtle">{safety.note}</p>
              </section>

              {fix.safety === "destructive" && (
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-danger-border bg-danger-bg px-4 py-3.5">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--danger)]"
                  />
                  <span className="text-sm leading-relaxed text-danger-fg">
                    I understand this cannot simply be undone, and I want to do it anyway.
                  </span>
                </label>
              )}

              <Disclosure label="Show the command" openLabel="Hide the command">
                <CodeLine className="break-all">{preview.command}</CodeLine>
                <p className="mt-2 text-xs leading-relaxed text-fg-subtle">
                  You do not need a terminal — the button above runs this for you. It is shown so
                  you can see exactly what will be run.
                </p>
              </Disclosure>
            </>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
