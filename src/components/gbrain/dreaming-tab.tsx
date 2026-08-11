"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  CheckCircle2,
  Loader2,
  Minus,
  Moon,
  Play,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { runGbrainCommand } from "./api";
import { parseJobsList, parseJobsStats, type JobRow } from "./parse";
import { CodeLine, Disclosure, EmptyState, Panel, Pill, SegmentedControl, StatusDot, type Tone } from "./primitives";
import type { DreamResult, Overview } from "./types";

const JOB_STATUS_FILTERS = ["all", "waiting", "active", "done", "failed", "dead"] as const;
type JobStatusFilter = (typeof JOB_STATUS_FILTERS)[number];

function jobStatusTone(status: string): Tone {
  const s = status.toLowerCase();
  if (s === "failed" || s === "dead") return "critical";
  if (s === "active" || s === "waiting") return "attention";
  if (s === "done") return "positive";
  return "neutral";
}

function phaseIcon(status: string) {
  if (status === "ok") return <Check className="h-3.5 w-3.5 text-success-fg" />;
  if (status === "error") return <XCircle className="h-3.5 w-3.5 text-danger-fg" />;
  if (status === "skipped") return <Minus className="h-3.5 w-3.5 text-fg-subtle" />;
  return <Minus className="h-3.5 w-3.5 text-fg-subtle" />;
}

function phaseLabel(phase: string): string {
  return phase
    .replace(/^cycle\./, "")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function totalLabel(key: string): string {
  return key.replace(/_/g, " ").replace(/count$/, "").trim();
}

/** Renders one `dream` (dry-run or real) result: phase-by-phase, plus non-zero totals. */
function DreamResultView({ result, dryRun }: { result: DreamResult; dryRun: boolean }) {
  const phases = result.phases ?? [];
  const totals = Object.entries(result.totals ?? {}).filter(([, v]) => v > 0);
  const ranPhases = phases.filter((p) => p.status !== "skipped");

  return (
    <div className="mt-4 space-y-4 border-t border-border-subtle pt-4">
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <Pill tone={dryRun ? "neutral" : "positive"}>{dryRun ? "preview only — nothing changed" : "applied"}</Pill>
        <span>{ranPhases.length} of {phases.length} phases did something</span>
        {typeof result.duration_ms === "number" && <span>{result.duration_ms}ms</span>}
      </div>

      {totals.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {totals.map(([k, v]) => (
            <Pill key={k} tone="positive">
              <span className="font-semibold tabular-nums">{v}</span> {totalLabel(k)}
            </Pill>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing to change right now — the brain is caught up.</p>
      )}

      <Disclosure label={`Show all ${phases.length} phases`} openLabel="Hide phases">
        <ol className="space-y-1.5">
          {phases.map((p) => (
            <li key={p.phase} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">{phaseIcon(p.status)}</span>
              <span className="min-w-0 flex-1">
                <span className={cn("font-medium", p.status === "skipped" ? "text-fg-subtle" : "text-foreground")}>
                  {phaseLabel(p.phase)}
                </span>
                {p.summary && <span className="ml-2 text-xs text-muted-foreground">{p.summary}</span>}
              </span>
            </li>
          ))}
        </ol>
      </Disclosure>
    </div>
  );
}

function DreamCard() {
  const [dryResult, setDryResult] = useState<DreamResult | null>(null);
  const [realResult, setRealResult] = useState<DreamResult | null>(null);
  const [running, setRunning] = useState<"dry" | "real" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReal, setConfirmingReal] = useState(false);

  const runDry = useCallback(async () => {
    setRunning("dry");
    setError(null);
    const d = await runGbrainCommand("dream-dry");
    if (d.ok) setDryResult((d.json as DreamResult) ?? null);
    else setError(d.error || "Preview failed");
    setRunning(null);
  }, []);

  const runReal = useCallback(async () => {
    if (!confirmingReal) {
      setConfirmingReal(true);
      return;
    }
    setConfirmingReal(false);
    setRunning("real");
    setError(null);
    const d = await runGbrainCommand("dream");
    if (d.ok) setRealResult((d.json as DreamResult) ?? null);
    else setError(d.error || "Dream cycle failed");
    setRunning(null);
  }, [confirmingReal]);

  const shown = realResult ?? dryResult;

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-subtle">
            <Moon className="h-4.5 w-4.5 text-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Dream — the overnight maintenance cycle</p>
            <p className="mt-0.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
              Link and timeline extraction, salience recompute, orphan detection, embedding refresh, and cleanup —
              the same cycle Autopilot runs continuously while you&rsquo;re away.
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => void runDry()} disabled={running !== null}>
            {running === "dry" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Preview
          </Button>
          <Button
            type="button"
            size="sm"
            variant={confirmingReal ? "destructive" : "default"}
            onClick={() => void runReal()}
            disabled={running !== null}
          >
            {running === "real" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {confirmingReal ? "Confirm — run now" : "Run now"}
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-3 flex items-start gap-1.5 text-xs text-danger-fg">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {error}
        </p>
      )}
      {shown && <DreamResultView result={shown} dryRun={shown === dryResult && shown !== realResult} />}
    </Panel>
  );
}

function AutopilotCard() {
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checked, setChecked] = useState(false);

  const check = useCallback(async () => {
    setLoading(true);
    const d = await runGbrainCommand("autopilot");
    setStatus(d.ok ? d.stdout || "(no output)" : d.error || "Could not check.");
    setChecked(true);
    setLoading(false);
  }, []);

  return (
    <Panel className="p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-subtle">
          <Bot className="h-4.5 w-4.5 text-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold text-foreground">Autopilot</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void check()} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Check status
            </Button>
          </div>
          <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
            A daemon that runs Dream continuously instead of once — install it and the brain maintains itself with
            no cron job to babysit.
          </p>
          {checked && <CodeLine className="mt-3">{status}</CodeLine>}
        </div>
      </div>
    </Panel>
  );
}

function QueueWarning({ text }: { text: string }) {
  const [restarting, setRestarting] = useState(false);
  const [done, setDone] = useState(false);
  const isWedged = /wedged/i.test(text);

  const restartWorker = useCallback(async () => {
    setRestarting(true);
    await runGbrainCommand("jobs-supervisor-stop");
    await runGbrainCommand("jobs-supervisor-start");
    setRestarting(false);
    setDone(true);
  }, []);

  return (
    <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-warning-fg">{text}</p>
          {isWedged && (
            <Button type="button" size="xs" variant="outline" className="mt-2" onClick={() => void restartWorker()} disabled={restarting}>
              {restarting ? <Loader2 className="h-3 w-3 animate-spin" /> : done ? <CheckCircle2 className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
              {done ? "Worker restarted" : "Restart worker"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function JobRowActions({ job, onChanged }: { job: JobRow; onChanged: () => void }) {
  const [busy, setBusy] = useState<"retry" | "cancel" | null>(null);
  const canRetry = job.status === "failed" || job.status === "dead";
  const canCancel = job.status === "waiting" || job.status === "active";

  const act = useCallback(async (kind: "retry" | "cancel") => {
    setBusy(kind);
    await runGbrainCommand(kind === "retry" ? "jobs-retry" : "jobs-cancel", { id: job.id });
    setBusy(null);
    onChanged();
  }, [job.id, onChanged]);

  if (!canRetry && !canCancel) return null;
  return (
    <div className="flex items-center gap-1">
      {canRetry && (
        <button
          type="button"
          onClick={() => void act("retry")}
          disabled={busy !== null}
          className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title="Retry"
          aria-label="Retry job"
        >
          {busy === "retry" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
        </button>
      )}
      {canCancel && (
        <button
          type="button"
          onClick={() => void act("cancel")}
          disabled={busy !== null}
          className="rounded-md p-1 text-fg-subtle transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          title="Cancel"
          aria-label="Cancel job"
        >
          {busy === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
        </button>
      )}
    </div>
  );
}

function MinionsQueue({ overview }: { overview: Overview | null }) {
  // Manual refreshes (below) win once they've happened; until then this
  // derives straight from the overview the parent already fetched — no
  // effect needed to keep it in sync when the parent refreshes.
  const [manualJobsText, setManualJobsText] = useState<string | undefined>(undefined);
  const jobsText = manualJobsText ?? overview?.jobs;
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<JobStatusFilter>("all");
  const [rows, setRows] = useState<JobRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [retryId, setRetryId] = useState("");

  const summary = useMemo(() => parseJobsStats(jobsText), [jobsText]);

  const refreshStats = useCallback(async () => {
    setRefreshing(true);
    const d = await runGbrainCommand("jobs-stats");
    if (d.ok) setManualJobsText(d.stdout);
    setRefreshing(false);
  }, []);

  const loadRows = useCallback(async (status: JobStatusFilter) => {
    setRowsLoading(true);
    const values: Record<string, string> = status === "all" ? { limit: "25" } : { status, limit: "25" };
    const d = await runGbrainCommand("jobs-list", values);
    setRows(d.ok ? parseJobsList(d.stdout) : []);
    setRowsLoading(false);
  }, []);

  // Mount-only initial job-list load, self-contained (no external deps) —
  // the status filter below triggers its own reload from the SegmentedControl
  // handler instead of a reactive effect.
  useEffect(() => {
    let cancelled = false;
    void runGbrainCommand("jobs-list", { limit: "25" }).then((d) => {
      if (cancelled) return;
      setRows(d.ok ? parseJobsList(d.stdout) : []);
      setRowsLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const onFilterChange = useCallback((next: JobStatusFilter) => {
    setFilter(next);
    void loadRows(next);
  }, [loadRows]);

  const refreshAll = useCallback(() => {
    void refreshStats();
    void loadRows(filter);
  }, [refreshStats, loadRows, filter]);

  const retryById = useCallback(async () => {
    if (!retryId.trim()) return;
    await runGbrainCommand("jobs-retry", { id: retryId.trim() });
    setRetryId("");
    refreshAll();
  }, [retryId, refreshAll]);

  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-subtle">
            <Wrench className="h-4.5 w-4.5 text-foreground" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">Minions — the background job queue</p>
            <p className="mt-0.5 text-sm text-muted-foreground">Facts get absorbed here, off the main thread.</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={refreshAll} disabled={refreshing}>
          <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {summary && (summary.waiting != null || summary.active != null) && (
        <div className="mt-4 flex flex-wrap gap-4 border-t border-border-subtle pt-4">
          <div className="flex items-center gap-2">
            <StatusDot tone={summary.waiting ? "attention" : "neutral"} />
            <span className="text-sm text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">{summary.waiting ?? 0}</span> waiting
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusDot tone={summary.active ? "positive" : "neutral"} pulse={Boolean(summary.active)} />
            <span className="text-sm text-muted-foreground">
              <span className="font-medium tabular-nums text-foreground">{summary.active ?? 0}</span> active
            </span>
          </div>
          {summary.stalled != null && (
            <div className="flex items-center gap-2">
              <StatusDot tone={summary.stalled ? "critical" : "neutral"} />
              <span className="text-sm text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground">{summary.stalled}</span> stalled
              </span>
            </div>
          )}
        </div>
      )}

      {summary && summary.rows.length > 0 && (
        <div className="mt-4 overflow-x-auto rounded-lg border border-border-subtle">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-left text-xs text-fg-subtle">
                <th className="px-3 py-2 font-medium">Handler</th>
                <th className="px-3 py-2 font-medium text-right">Total</th>
                <th className="px-3 py-2 font-medium text-right">Done</th>
                <th className="px-3 py-2 font-medium text-right">Failed</th>
                <th className="px-3 py-2 font-medium text-right">Dead</th>
                <th className="px-3 py-2 font-medium text-right">Avg time</th>
              </tr>
            </thead>
            <tbody>
              {summary.rows.map((r) => (
                <tr key={r.type} className="border-b border-border-subtle last:border-b-0">
                  <td className="px-3 py-2 font-medium text-foreground">{r.type}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.total}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-success-fg">{r.done}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", r.failed ? "text-danger-fg" : "text-muted-foreground")}>{r.failed}</td>
                  <td className={cn("px-3 py-2 text-right tabular-nums", r.dead ? "text-danger-fg" : "text-muted-foreground")}>{r.dead}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{r.avgTime}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary?.warnings.map((w, i) => (
        <div key={i} className="mt-4">
          <QueueWarning text={w} />
        </div>
      ))}

      {/* Job list browser */}
      <div className="mt-5 border-t border-border-subtle pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            options={JOB_STATUS_FILTERS.map((s) => ({ value: s, label: s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1) }))}
            value={filter}
            onChange={onFilterChange}
          />
          <div className="flex items-center gap-1.5">
            <Input value={retryId} onChange={(e) => setRetryId(e.target.value)} placeholder="job id" className="h-8 w-24 text-xs" />
            <Button type="button" size="xs" variant="outline" onClick={() => void retryById()} disabled={!retryId.trim()}>
              Retry
            </Button>
          </div>
        </div>

        <div className="mt-3">
          {rowsLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading jobs…
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="No jobs here" description="Nothing in this queue right now." className="py-8" />
          ) : (
            <ul className="divide-y divide-border-subtle rounded-lg border border-border-subtle">
              {rows.map((job) => (
                <li key={job.id} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                  <StatusDot tone={jobStatusTone(job.status)} pulse={job.status === "active"} />
                  <span className="w-10 shrink-0 font-mono text-xs text-fg-subtle">#{job.id}</span>
                  <span className="min-w-0 flex-1 truncate font-medium text-foreground">{job.name}</span>
                  <Pill tone={jobStatusTone(job.status)} className="shrink-0">{job.status}</Pill>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">{job.created}</span>
                  <JobRowActions job={job} onChanged={refreshAll} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

export function DreamingTab({ overview }: { overview: Overview | null }) {
  return (
    <div className="space-y-5">
      <DreamCard />
      <AutopilotCard />
      <MinionsQueue overview={overview} />
    </div>
  );
}
