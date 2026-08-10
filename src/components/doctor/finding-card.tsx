"use client";

/**
 * A finding, told as three sentences: what is wrong, why it matters to you, and
 * what happens if you leave it.
 *
 * Structural rules taken straight from the API contract:
 *
 * - `fix.blocked !== null` renders the reason and **no button**. OpenClaw has
 *   already tried and declined; offering a button would be a lie.
 * - Findings with `causedBy` are never top-level rows. They are folded into the
 *   card for their cause, under "fixing this also clears".
 * - `confidence: "parsed"` is marked as less certain than `"structured"`,
 *   because the wording came out of human-readable text and is not a contract.
 * - Machine output lives behind a disclosure. A person reading the page should
 *   never meet a shell command unless they went looking for one.
 */

import { useState } from "react";
import { ChevronRight, Info, Wrench, BookOpen, Ban, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Disclosure, StatusDot, type Tone } from "./primitives";
import { confidenceCaveat, confidenceLabel } from "./format";
import type { DoctorFinding } from "./types";

export function severityTone(finding: DoctorFinding): Tone {
  if (finding.informational) return "neutral";
  if (finding.severity === "error") return "critical";
  if (finding.severity === "warning") return "attention";
  return "neutral";
}

/* ── shared detail block ───────────────────────────────────────────────── */

function TechnicalDetail({ finding }: { finding: DoctorFinding }) {
  const caveat = confidenceCaveat(finding.confidence);
  return (
    <div className="space-y-4">
      {finding.evidence.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-fg-subtle">
            What OpenClaw reported, word for word
          </p>
          {/* One frame, divided rows — a box per line turns a long evidence
              list into a wall of borders. */}
          <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-surface-inset">
            {finding.evidence.map((line, i) => (
              <p
                key={i}
                className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-relaxed text-fg-secondary"
              >
                {line}
              </p>
            ))}
          </div>
        </div>
      )}

      {finding.paths.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium text-fg-subtle">Where</p>
          <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border-subtle bg-surface-inset">
            {finding.paths.map((p) => (
              <p
                key={p}
                className="break-all px-3 py-2 font-mono text-xs leading-relaxed text-fg-secondary"
              >
                {p}
              </p>
            ))}
          </div>
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 text-xs">
        <dt className="text-fg-subtle">Check</dt>
        <dd className="font-mono text-fg-secondary">{finding.checkId}</dd>
        <dt className="text-fg-subtle">Told to us by</dt>
        <dd className="text-fg-secondary">{confidenceLabel(finding.confidence)}</dd>
        {finding.mergedFrom.length > 0 && (
          <>
            <dt className="text-fg-subtle">Also confirmed by</dt>
            <dd className="text-fg-secondary">{finding.mergedFrom.join(", ")}</dd>
          </>
        )}
      </dl>

      {caveat && <p className="text-xs leading-relaxed text-fg-subtle">{caveat}</p>}

      {finding.docs && (
        <a
          href={finding.docs}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground underline-offset-4 hover:underline"
        >
          Read OpenClaw&rsquo;s documentation
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

/* ── actions ───────────────────────────────────────────────────────────── */

function FindingActions({
  finding,
  onFix,
  onGuide,
  busy,
}: {
  finding: DoctorFinding;
  onFix: (finding: DoctorFinding) => void;
  onGuide: (finding: DoctorFinding) => void;
  busy: boolean;
}) {
  const fix = finding.fix;
  const blocked = fix?.blocked ?? null;
  const hasGuide = finding.guide.length > 0;

  if (!fix && !hasGuide) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2.5">
      {fix && !blocked && (
        <Button
          size="sm"
          variant={fix.safety === "safe" ? "default" : "outline"}
          onClick={() => onFix(finding)}
          disabled={busy}
          data-doctor-fix={fix.id}
        >
          <Wrench className="h-3.5 w-3.5" />
          {fix.safety === "safe" ? fix.label : `${fix.label}…`}
        </Button>
      )}

      {hasGuide && (
        <Button size="sm" variant={fix && !blocked ? "ghost" : "outline"} onClick={() => onGuide(finding)}>
          <BookOpen className="h-3.5 w-3.5" />
          Walk me through it
        </Button>
      )}

      {fix && !blocked && fix.requiresRestart && (
        <span className="text-xs text-fg-subtle">Takes effect after a restart</span>
      )}
    </div>
  );
}

function BlockedNote({ reason }: { reason: string }) {
  return (
    <div className="mt-4 flex gap-2.5 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3">
      <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
      <div className="min-w-0">
        <p className="text-sm font-medium text-fg-secondary">
          There is no button for this one right now
        </p>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{reason}</p>
      </div>
    </div>
  );
}

/* ── the card ──────────────────────────────────────────────────────────── */

export function FindingCard({
  finding,
  consequences,
  onFix,
  onGuide,
  busy,
}: {
  finding: DoctorFinding;
  consequences: DoctorFinding[];
  onFix: (finding: DoctorFinding) => void;
  onGuide: (finding: DoctorFinding) => void;
  busy: boolean;
}) {
  const tone = severityTone(finding);
  const blocked = finding.fix?.blocked ?? null;

  return (
    <article
      className={cn(
        "overflow-hidden rounded-2xl border bg-card transition-colors",
        tone === "critical" ? "border-danger-border" : "border-border"
      )}
    >
      <div className="p-5 md:p-6">
        <div className="flex items-start gap-3.5">
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <StatusDot tone={tone} />
              <span className="text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.08em] text-fg-subtle">
                {finding.family}
              </span>
              {/* `parsed` came out of human-readable output, so the page says so
                  at a glance rather than only inside the technical disclosure. */}
              {finding.confidence === "parsed" && (
                <span
                  title={confidenceCaveat("parsed") ?? undefined}
                  className="rounded-full border border-border px-2 py-0.5 text-[0.6875rem] font-medium leading-none text-fg-subtle"
                >
                  less certain
                </span>
              )}
            </p>
            <h3 className="mt-2.5 text-[0.9375rem] font-semibold leading-snug tracking-[-0.01em] text-foreground">
              {finding.title}
            </h3>

            <p className="mt-2.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
              {finding.explanation}
            </p>

            {finding.impact && (
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-fg-secondary">
                <span className="font-medium text-foreground">If you leave it: </span>
                {finding.impact}
              </p>
            )}

            {blocked && <BlockedNote reason={blocked.reason} />}

            <FindingActions finding={finding} onFix={onFix} onGuide={onGuide} busy={busy} />

            <Disclosure className="mt-4" label="Show the technical detail" openLabel="Hide the technical detail">
              <TechnicalDetail finding={finding} />
            </Disclosure>
          </div>
        </div>
      </div>

      {consequences.length > 0 && (
        <div className="border-t border-border-subtle bg-surface-subtle px-5 py-4 md:px-6">
          <p className="text-xs font-medium text-fg-subtle">
            Fixing this also clears {consequences.length} other finding
            {consequences.length === 1 ? "" : "s"}, reported separately:
          </p>
          <ul className="mt-2.5 space-y-2.5">
            {consequences.map((c) => (
              <li key={c.id} className="flex gap-2.5">
                <span className="mt-[0.4rem] h-px w-3 shrink-0 bg-border-strong" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium leading-snug text-fg-secondary">{c.title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {c.explanation}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/* ── the quiet variant ─────────────────────────────────────────────────── */

/**
 * Informational findings collapse to a single line. They are real, they are
 * shown, and they do not shout — which is the whole point of separating them
 * from the ones that want a person.
 */
export function InformationalRow({
  finding,
  onFix,
  onGuide,
  busy,
}: {
  finding: DoctorFinding;
  onFix: (finding: DoctorFinding) => void;
  onGuide: (finding: DoctorFinding) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const blocked = finding.fix?.blocked ?? null;

  return (
    <div className="group">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:px-6"
      >
        <ChevronRight
          className={cn(
            "mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle transition-transform duration-200",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 text-sm leading-snug text-fg-secondary">
          {finding.title}
        </span>
        <span className="shrink-0 text-xs text-fg-subtle">{finding.family}</span>
      </button>

      <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-250 ease-out",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
        )}
      >
        <div className="overflow-hidden">
          <div className="px-5 pb-5 pl-[3.25rem] md:px-6 md:pl-[3.5rem]">
            <p className="max-w-prose whitespace-pre-line text-sm leading-relaxed text-muted-foreground">
              {finding.explanation}
            </p>
            {finding.impact && (
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-fg-secondary">
                {finding.impact}
              </p>
            )}
            {blocked && <BlockedNote reason={blocked.reason} />}
            <FindingActions finding={finding} onFix={onFix} onGuide={onGuide} busy={busy} />
            <Disclosure
              className="mt-4"
              label="Show the technical detail"
              openLabel="Hide the technical detail"
            >
              <TechnicalDetail finding={finding} />
            </Disclosure>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── prevention ────────────────────────────────────────────────────────── */

/** Not broken yet. Same data shape, different promise: this is a heads-up. */
export function PreventionRow({
  finding,
  onFix,
  onGuide,
  busy,
}: {
  finding: DoctorFinding;
  onFix: (finding: DoctorFinding) => void;
  onGuide: (finding: DoctorFinding) => void;
  busy: boolean;
}) {
  return (
    <div className="flex items-start gap-3.5 px-5 py-4 md:px-6">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold leading-snug text-foreground">{finding.title}</h3>
        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
          {finding.explanation}
        </p>
        {finding.impact && (
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-fg-secondary">
            {finding.impact}
          </p>
        )}
        <FindingActions finding={finding} onFix={onFix} onGuide={onGuide} busy={busy} />
      </div>
    </div>
  );
}
