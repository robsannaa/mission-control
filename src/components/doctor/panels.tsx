"use client";

/**
 * The three panels that keep the page honest:
 *
 * - **Vitals** — measured numbers that came back fine. Rendered as numbers, in
 *   ink, with no green ticks. A healthy system should read as quiet, not as a
 *   celebration.
 * - **Changes** — the time dimension. Never presented as complete while
 *   `diff.notComparable` has entries, because a source that did not run must
 *   not read as "fixed".
 * - **Coverage** — what was actually checked, which sources ran, and what was
 *   left unverified. `coverage.statement` is printed verbatim.
 */

import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  CircleAlert,
  CircleSlash,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Disclosure, Panel, QuietNote, SectionTitle } from "./primitives";
import { SOURCE_BLURB, SOURCE_LABEL, describeDuration, formatStamp } from "./format";
import type {
  DoctorCoverage,
  DoctorDiff,
  DoctorProvenance,
  DoctorVital,
} from "./types";

/* ── vitals ────────────────────────────────────────────────────────────── */

export function VitalsPanel({ vitals }: { vitals: DoctorVital[] }) {
  if (vitals.length === 0) return null;

  return (
    <Panel>
      <header className="px-5 pb-4 pt-5 md:px-6">
        <SectionTitle
          title="Measured right now"
          hint="Readings that came back fine. Listed so you can see them, not because anything wants you."
        />
      </header>
      {/* Hairlines come from per-cell borders, clipped at the edges. A gap-based
          grid would leave the container colour showing in an unfilled last row. */}
      <div className="overflow-hidden border-t border-border-subtle">
        <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {vitals.map((v) => (
            <div
              key={v.id}
              className="border-b border-r border-border-subtle px-5 py-4 md:px-6"
            >
              <p className="truncate text-xs text-fg-subtle" title={v.label}>
                {v.label}
              </p>
              <p
                className={cn(
                  "mt-1.5 text-lg font-semibold tabular-nums leading-tight tracking-[-0.01em]",
                  v.status === "ok" ? "text-foreground" : "text-fg-subtle"
                )}
              >
                {v.status === "ok" ? v.value : "Not measured"}
              </p>
              {v.detail && (
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{v.detail}</p>
              )}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* ── what changed ──────────────────────────────────────────────────────── */

export function ChangesPanel({
  diff,
  hasHistory,
  hour12,
}: {
  diff: DoctorDiff | null;
  hasHistory: boolean;
  hour12: boolean;
}) {
  if (!diff || !diff.comparedTo) {
    return (
      <Panel className="px-5 py-5 md:px-6">
        <SectionTitle
          title="What changed"
          hint={
            hasHistory
              ? "There is nothing to compare this check against yet."
              : "This is the first check on record, so there is nothing to compare it against. From the next one on, this panel will tell you what moved."
          }
        />
      </Panel>
    );
  }

  const nothingMoved =
    diff.newFindings.length === 0 &&
    diff.resolvedFindings.length === 0 &&
    diff.regressions.length === 0;

  return (
    <Panel className="px-5 py-5 md:px-6">
      <SectionTitle
        title="What changed"
        hint={`Compared with the check from ${formatStamp(diff.comparedTo.completedAt, hour12)}.`}
      />

      {nothingMoved ? (
        <QuietNote className="mt-4">
          Nothing appeared and nothing was resolved since then.
        </QuietNote>
      ) : (
        <div className="mt-5 space-y-5">
          {diff.regressions.length > 0 && (
            <ChangeGroup
              icon={<RotateCcw className="h-3.5 w-3.5 text-warning-fg" />}
              title="Came back after being gone"
              tone="attention"
              items={diff.regressions.map((r) => ({
                id: r.id,
                title: r.title,
                note: `last seen ${formatStamp(r.lastSeenAt, hour12)}`,
              }))}
            />
          )}
          {diff.newFindings.length > 0 && (
            <ChangeGroup
              icon={<ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />}
              title="New since the last check"
              items={diff.newFindings.map((f) => ({ id: f.id, title: f.title }))}
            />
          )}
          {diff.resolvedFindings.length > 0 && (
            <ChangeGroup
              icon={<ArrowDownRight className="h-3.5 w-3.5 text-muted-foreground" />}
              title="Gone since the last check"
              items={diff.resolvedFindings.map((f) => ({ id: f.id, title: f.title }))}
            />
          )}
        </div>
      )}

      {diff.notComparable.length > 0 && (
        <p className="mt-5 flex items-start gap-2.5 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3 text-sm leading-relaxed text-fg-secondary">
          <CircleSlash className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
          <span>
            This comparison leaves out {diff.notComparable.join(" and ")}, because that did not run
            in both checks. Anything it would have found is neither &ldquo;new&rdquo; nor
            &ldquo;gone&rdquo; here — it is simply unknown.
          </span>
        </p>
      )}
    </Panel>
  );
}

function ChangeGroup({
  icon,
  title,
  items,
  tone,
}: {
  icon: React.ReactNode;
  title: string;
  items: { id: string; title: string; note?: string }[];
  tone?: "attention";
}) {
  return (
    <div>
      <p
        className={cn(
          "flex items-center gap-2 text-xs font-medium",
          tone === "attention" ? "text-warning-fg" : "text-fg-subtle"
        )}
      >
        {icon}
        {title}
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((item) => (
          <li key={item.id} className="text-sm leading-relaxed text-fg-secondary">
            {item.title}
            {item.note && <span className="ml-2 text-xs text-fg-subtle">({item.note})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ── coverage & provenance ─────────────────────────────────────────────── */

const SOURCE_ORDER: (keyof DoctorProvenance)[] = [
  "lint",
  "legacy",
  "securityAudit",
  "secretsAudit",
  "runtime",
];

export function CoveragePanel({
  coverage,
  provenance,
}: {
  coverage: DoctorCoverage;
  provenance: DoctorProvenance;
}) {
  const failed = SOURCE_ORDER.filter((k) => provenance[k].ran && !provenance[k].ok);

  return (
    <Panel>
      <header className="px-5 pb-4 pt-5 md:px-6">
        <SectionTitle
          title="What was actually checked"
          hint="So a quiet page is never mistaken for a thorough one."
        />
        <p className="mt-3.5 max-w-prose text-sm leading-relaxed text-fg-secondary">
          {coverage.statement}
        </p>

        {coverage.unverifiedFamilies.length > 0 && (
          <div className="mt-4 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3.5">
            <p className="flex items-center gap-2 text-sm font-medium text-warning-fg">
              <AlertTriangle className="h-3.5 w-3.5" />
              {coverage.unverifiedFamilies.length} area
              {coverage.unverifiedFamilies.length === 1 ? " was" : "s were"} not verified at all
            </p>
            <p className="mt-1.5 text-sm leading-relaxed text-fg-secondary">
              These are not healthy — they are unchecked. A full check covers them.
            </p>
            <ul className="mt-3 space-y-1.5">
              {coverage.unverifiedFamilies.map((f) => (
                <li key={f.id} className="text-sm leading-relaxed text-muted-foreground">
                  <span className="font-medium text-foreground">{f.label}</span>
                  {" — "}
                  {f.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {failed.length > 0 && (
          <div className="mt-4 rounded-xl border border-danger-border bg-danger-bg px-4 py-3.5">
            <p className="flex items-center gap-2 text-sm font-medium text-danger-fg">
              <CircleAlert className="h-3.5 w-3.5" />
              {failed.length} source{failed.length === 1 ? "" : "s"} could not complete
            </p>
            <p className="mt-1 text-sm leading-relaxed text-danger-fg/90">
              Whatever those would have found is missing from this page.
            </p>
          </div>
        )}
      </header>

      <ul className="divide-y divide-border-subtle border-t border-border-subtle">
        {SOURCE_ORDER.map((key) => {
          const run = provenance[key];
          const state = !run.ran ? "skipped" : run.ok ? "ok" : "failed";
          return (
            <li key={key} className="flex items-start gap-4 px-5 py-3.5 md:px-6">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug text-foreground">
                  {SOURCE_LABEL[key]}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  {SOURCE_BLURB[key]}
                </p>
                {run.error && (
                  <p className="mt-1.5 text-xs leading-relaxed text-danger-fg">{run.error}</p>
                )}
              </div>
              <div className="shrink-0 text-right">
                <p
                  className={cn(
                    "text-xs font-medium",
                    state === "ok"
                      ? "text-muted-foreground"
                      : state === "failed"
                        ? "text-danger-fg"
                        : "text-fg-subtle"
                  )}
                >
                  {state === "ok" ? "Completed" : state === "failed" ? "Failed" : "Did not run"}
                </p>
                {run.ran && (
                  <p className="mt-0.5 text-xs tabular-nums text-fg-subtle">
                    {describeDuration(run.durationMs)}
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="border-t border-border-subtle px-5 py-4 md:px-6">
        <Disclosure label="Show the exact commands" openLabel="Hide the exact commands">
          <dl className="space-y-3">
            {SOURCE_ORDER.map((key) => (
              <div key={key}>
                <dt className="text-xs text-fg-subtle">{SOURCE_LABEL[key]}</dt>
                <dd className="mt-1 overflow-x-auto rounded-md border border-border-subtle bg-surface-inset px-3 py-2 font-mono text-xs text-fg-secondary">
                  {provenance[key].invocation || "— never invoked —"}
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      </div>
    </Panel>
  );
}
