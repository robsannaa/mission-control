"use client";

/**
 * The one honest answer, at the top of the page.
 *
 * Everything here is derived from `health.state` first and the numbers second,
 * because the contract's first rule is that a null score must be rendered as
 * words. There is no code path in this component that can print a number when
 * `score === null`, and no path that says "healthy" for a snapshot that is
 * cached, stale, or came from a run that failed.
 *
 * While a check is running, this same card narrates it — phases tick over in
 * place rather than the page swapping to a different screen, so the user's eye
 * never loses the answer it is waiting for.
 */

import { useMemo } from "react";
import {
  ChevronDown,
  CircleAlert,
  FileText,
  Loader2,
  Play,
  RefreshCw,
  ShieldAlert,
  Check,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CodeLine, Disclosure, Panel, StatusDot, type Tone } from "./primitives";
import { describeAge, describeDuration, pluraliseSentence } from "./format";
import type { DoctorDiff, DoctorSnapshot, RunMode, RunPhase } from "./types";

type Verdict = {
  tone: Tone;
  eyebrow: string;
  headline: string;
  support: string;
  /** Primary call to action wording, when the state calls for one. */
  cta: string;
};

export function buildVerdict(
  snapshot: DoctorSnapshot,
  counts: { needsYou: number; consequences: number; informational: number }
): Verdict {
  const { health } = snapshot;

  if (health.state === "never-checked") {
    return {
      tone: "unknown",
      eyebrow: "Never checked",
      headline: "Your system has not been checked yet.",
      support:
        "Mission Control will not guess. A check takes about ten seconds, reads your settings and asks the running service how it is doing, and changes nothing.",
      cta: "Run the first check",
    };
  }

  if (health.state === "run-failed") {
    return {
      tone: "critical",
      eyebrow: "Could not check",
      headline: "The check could not finish.",
      support:
        "Something stopped the check part-way through, so there is no honest answer to give you yet. What went wrong is written out below.",
      cta: "Try again",
    };
  }

  if (health.state === "gateway-unreachable") {
    return {
      tone: "critical",
      eyebrow: "Cannot reach OpenClaw",
      headline: "Mission Control cannot reach the OpenClaw service.",
      support:
        "Nothing else on this page can be trusted until that connection is back, so no result is being shown as healthy.",
      cta: "Try again",
    };
  }

  const informationalLine =
    counts.informational > 0
      ? ` ${pluraliseSentence(counts.informational, "other finding is", "other findings are")} listed further down for reference; none of them is a problem.`
      : "";

  if (health.state === "stale") {
    const known =
      counts.needsYou > 0
        ? `${pluraliseSentence(counts.needsYou, "thing needed", "things needed")} your attention at the time.`
        : "Nothing needed your attention at the time.";
    return {
      tone: "unknown",
      eyebrow: `Last checked ${describeAge(health.ageMs)}`,
      headline: "This is how your system looked then, not now.",
      support: `${known} Anything could have changed since. Check again for an answer you can rely on.`,
      cta: "Check again",
    };
  }

  if (counts.needsYou === 0) {
    return {
      tone: "neutral",
      eyebrow: "All clear",
      headline: "Nothing needs your attention.",
      support: `Every check that ran came back without a problem.${informationalLine}`,
      cta: "Check again",
    };
  }

  const consequenceNote =
    counts.consequences > 0
      ? ` ${pluraliseSentence(counts.consequences, "further finding is", "further findings are")} a knock-on effect of those and will clear when they do.`
      : "";

  if (health.grade === "critical") {
    return {
      tone: "critical",
      eyebrow: "Something is broken",
      headline: `${pluraliseSentence(counts.needsYou, "thing needs", "things need")} you now.`,
      support: `These are not warnings — something is not working.${consequenceNote}${informationalLine}`,
      cta: "Check again",
    };
  }

  return {
    tone: "attention",
    eyebrow: "Needs attention",
    headline: `${pluraliseSentence(counts.needsYou, "thing needs", "things need")} you.`,
    support: `Nothing is broken right now.${consequenceNote}${informationalLine}`,
    cta: "Check again",
  };
}

/* ── run narration ─────────────────────────────────────────────────────── */

function PhaseRail({
  phases,
  elapsedMs,
  log,
}: {
  phases: RunPhase[];
  elapsedMs: number;
  log: string[];
}) {
  const total = phases[0]?.total ?? phases.length;
  const step = phases.reduce((max, p) => Math.max(max, p.index), 0);
  return (
    <div className="mt-5">
      <ol className="space-y-2.5">
        {phases.map((p) => (
          <li key={`${p.phase}-${p.index}`} className="flex items-start gap-2.5 text-sm">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
              {p.status === "running" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground" />
              ) : p.status === "ok" ? (
                <Check className="h-3.5 w-3.5 text-fg-subtle" />
              ) : (
                <CircleAlert className="h-3.5 w-3.5 text-danger-fg" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "leading-snug",
                  p.status === "running" ? "text-foreground" : "text-muted-foreground"
                )}
              >
                {p.label}
              </span>
              {p.detail ? (
                <span className="ml-2 text-xs text-fg-subtle">{p.detail}</span>
              ) : null}
            </span>
            {p.durationMs !== null && (
              <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                {describeDuration(p.durationMs)}
              </span>
            )}
          </li>
        ))}
      </ol>
      <p className="mt-4 text-xs tabular-nums text-fg-subtle">
        Step {step} of {total} · {describeDuration(elapsedMs)} elapsed
      </p>

      {log.length > 0 && (
        <Disclosure
          className="mt-4"
          label="Show what OpenClaw is printing"
          openLabel="Hide what OpenClaw is printing"
        >
          <CodeLine className="max-h-56 overflow-y-auto whitespace-pre-wrap break-words">
            {log.join("")}
          </CodeLine>
          <p className="mt-2 text-xs leading-relaxed text-fg-subtle">
            This is the raw output, exactly as the command produced it. It is not stored anywhere
            and disappears when the check finishes.
          </p>
        </Disclosure>
      )}
    </div>
  );
}

/* ── card ──────────────────────────────────────────────────────────────── */

export function VerdictCard({
  snapshot,
  diff,
  counts,
  running,
  runMode,
  phases,
  elapsedMs,
  runLog,
  onRun,
  onOpenReport,
  refreshing,
}: {
  snapshot: DoctorSnapshot;
  diff: DoctorDiff | null;
  counts: { needsYou: number; consequences: number; informational: number };
  running: boolean;
  runMode: RunMode | null;
  phases: RunPhase[];
  elapsedMs: number;
  runLog: string[];
  onRun: (mode: RunMode) => void;
  onOpenReport: () => void;
  refreshing: boolean;
}) {
  const verdict = useMemo(() => buildVerdict(snapshot, counts), [snapshot, counts]);
  const { health, provenance } = snapshot;

  const sourcesRan = Object.values(provenance).filter((s) => s.ran).length;
  const sourcesFailed = Object.values(provenance).filter((s) => s.ran && !s.ok).length;

  const lastMode = useMemo(() => {
    if (!provenance.legacy.ran) return "quick check";
    return provenance.legacy.invocation.includes("--deep") ? "deep check" : "full check";
  }, [provenance]);

  return (
    <Panel className="overflow-hidden p-6 md:p-8">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-5">
        {/* `basis-80` makes the action cluster wrap below the verdict rather
            than squeezing the sentence into a column two words wide. */}
        <div className="min-w-0 max-w-[46rem] flex-1 basis-80">
          <p className="flex items-center gap-2.5">
            <StatusDot
              tone={running ? "neutral" : verdict.tone}
              pulse={running || verdict.tone === "critical"}
            />
            <span className="eyebrow !text-fg-secondary">
              {running ? "Checking now" : verdict.eyebrow}
            </span>
          </p>

          <h2
            key={running ? "running" : verdict.headline}
            className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.02em] text-foreground animate-enter md:text-[1.75rem]"
          >
            {running
              ? runMode === "quick"
                ? "Reading your system…"
                : runMode === "deep"
                  ? "Running the deep check…"
                  : "Running the full check…"
              : verdict.headline}
          </h2>

          {running ? (
            <>
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
                {runMode === "quick"
                  ? "Nothing is being changed — this only reads."
                  : "This also applies OpenClaw's own safe migrations, so a few files on this machine will be tidied up as it goes."}
              </p>
              <PhaseRail phases={phases} elapsedMs={elapsedMs} log={runLog} />
            </>
          ) : (
            <>
              <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
                {verdict.support}
              </p>
              {health.checkedAt !== null && (
                <p className="mt-2.5 text-sm text-fg-subtle">
                  Checked {describeAge(health.ageMs)} with a {lastMode}.
                  {snapshot.cached && (health.ageMs ?? 0) > 90_000
                    ? " This is that stored result — nothing has been re-read since."
                    : ""}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            onClick={() => onRun("quick")}
            disabled={running}
            data-doctor-action="check"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : health.state === "never-checked" ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            )}
            {running ? "Checking…" : verdict.cta}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={running} aria-label="More checks">
                <ChevronDown className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel className="text-fg-subtle">
                Deeper checks — these change files
              </DropdownMenuLabel>
              <DropdownMenuItem
                className="flex-col items-start gap-1 py-2.5"
                onSelect={() => onRun("full")}
              >
                <span className="font-medium text-foreground">Full check</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Adds OpenClaw&rsquo;s own pass, which tidies up settings and leftover files as it
                  goes. About 15 seconds.
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="flex-col items-start gap-1 py-2.5"
                onSelect={() => onRun("deep")}
              >
                <span className="font-medium text-foreground">Deep check</span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  Everything in the full check, plus conversation gaps and who is connected right
                  now.
                </span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onOpenReport}>
                <FileText className="h-3.5 w-3.5" />
                Share a report
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Caveats are load-bearing: what was NOT verified, said out loud. */}
      {!running && health.caveats.length > 0 && (
        <ul
          className={cn(
            "mt-6 space-y-2 rounded-xl border px-4 py-3.5",
            verdict.tone === "critical"
              ? "border-danger-border bg-danger-bg"
              : "border-border-subtle bg-surface-subtle"
          )}
        >
          {health.caveats.map((c) => (
            <li
              key={c}
              className={cn(
                "flex gap-2.5 text-sm leading-relaxed",
                verdict.tone === "critical" ? "text-danger-fg" : "text-fg-secondary"
              )}
            >
              <ShieldAlert
                className={cn(
                  "mt-0.5 h-3.5 w-3.5 shrink-0",
                  verdict.tone === "critical" ? "text-danger-fg" : "text-fg-subtle"
                )}
              />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      )}

      {!running && health.state !== "never-checked" && (
        <div className="mt-7 border-t border-border-subtle pt-5">
          <div className="flex flex-wrap items-center gap-x-7 gap-y-3">
            {health.score !== null ? (
              <span className="flex items-baseline gap-2">
                <span className="text-2xl font-semibold tabular-nums leading-none text-foreground">
                  {health.score}
                </span>
                <span className="text-xs text-fg-subtle">out of 100</span>
              </span>
            ) : (
              <span className="text-sm font-medium text-fg-subtle">No score — nothing measured it</span>
            )}

            {diff?.scoreDelta !== null && diff?.scoreDelta !== undefined && diff.comparedTo && (
              <span className="text-sm tabular-nums text-muted-foreground">
                {diff.scoreDelta === 0
                  ? "unchanged since the last check"
                  : `${diff.scoreDelta > 0 ? "+" : "−"}${Math.abs(diff.scoreDelta)} since the last check`}
              </span>
            )}

            <span className="text-sm text-muted-foreground">
              {snapshot.summary.total} finding{snapshot.summary.total === 1 ? "" : "s"} from{" "}
              {sourcesRan} source{sourcesRan === 1 ? "" : "s"}
              {sourcesFailed > 0 ? ` · ${sourcesFailed} could not complete` : ""}
            </span>
          </div>

          {health.deductions.length > 0 && (
            <Disclosure
              className="mt-4"
              label="How this number was worked out"
              openLabel="How this number was worked out"
            >
              <ul className="divide-y divide-border-subtle rounded-xl border border-border-subtle">
                <li className="flex items-baseline justify-between gap-4 px-4 py-2.5">
                  <span className="text-sm text-muted-foreground">Starting point</span>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">100</span>
                </li>
                {health.deductions.map((d) => (
                  <li
                    key={d.reason}
                    className="flex items-baseline justify-between gap-4 px-4 py-2.5"
                  >
                    <span className="text-sm leading-relaxed text-fg-secondary">{d.reason}</span>
                    <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                      −{d.points}
                    </span>
                  </li>
                ))}
                <li className="flex items-baseline justify-between gap-4 bg-surface-subtle px-4 py-2.5">
                  <span className="text-sm font-medium text-foreground">Health score</span>
                  <span className="shrink-0 text-sm font-semibold tabular-nums text-foreground">
                    {health.score}
                  </span>
                </li>
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
                Findings that are only a knock-on effect of another finding are not charged twice,
                and findings Mission Control cannot explain in plain language are not counted at
                all.
              </p>
            </Disclosure>
          )}
        </div>
      )}
    </Panel>
  );
}
