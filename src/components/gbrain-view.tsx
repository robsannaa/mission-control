"use client";

/**
 * G-Brain — a full window onto the standalone knowledge brain installed on this
 * machine. Everything is driven through /api/g-brain, which shells out to the
 * `gbrain` binary (there is no gateway RPC for it).
 *
 * Three surfaces:
 *  - Overview: health, category scores, brain stats, background-job queue.
 *  - Auto-jobs: the things the brain does on its own — dreaming (overnight
 *    maintenance), the autopilot daemon, and the Minions job queue.
 *  - Explore: the full command catalog, grouped — run any command with its args
 *    and read the raw output, so nothing G-Brain supports is out of reach.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkles, Moon, Cog, Activity, Play, Loader2, AlertTriangle, CheckCircle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

/* ── client mirrors of the API shapes ── */

type GbrainArg = { name: string; flag?: string; placeholder?: string; required?: boolean };
type GbrainCommand = {
  id: string;
  label: string;
  category: string;
  description: string;
  args?: GbrainArg[];
  mutates?: boolean;
  dangerous?: boolean;
  json?: boolean;
};

type DoctorCheck = { name: string; status: string; message: string; category?: string };
type Doctor = {
  status?: string;
  health_score?: number;
  category_scores?: Record<string, number>;
  checks?: DoctorCheck[];
  top_issues?: { name: string; status: string; fix: string }[];
};

type Overview = {
  installed: boolean;
  detection?: { engine?: string; schemaPack?: string; home?: string };
  doctor?: Doctor | null;
  doctorError?: string | null;
  stats?: string;
  jobs?: string;
  jobsError?: string | null;
  health?: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  overview: "Overview & health",
  "auto-jobs": "Auto-jobs (dreaming, autopilot, minions)",
  search: "Search & ask",
  pages: "Pages",
  links: "Links & graph",
  timeline: "Timeline & salience",
  sources: "Sources",
  code: "Code indexing",
  brain: "Ideation",
  maintenance: "Maintenance",
  integration: "OpenClaw integration",
};

const CATEGORY_ORDER = [
  "overview", "auto-jobs", "search", "pages", "links",
  "timeline", "sources", "code", "brain", "maintenance", "integration",
];

type Tab = "overview" | "auto-jobs" | "explore";

export function GBrainView() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [commands, setCommands] = useState<GbrainCommand[]>([]);
  const [loading, setLoading] = useState(true);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/g-brain?action=overview", { cache: "no-store" });
      setOverview(await res.json());
    } catch {
      setOverview({ installed: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    fetch("/api/g-brain?action=catalog", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setCommands(Array.isArray(d?.commands) ? d.commands : []))
      .catch(() => setCommands([]));
  }, [loadOverview]);

  const doctor = overview?.doctor ?? null;

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 px-5 py-6 sm:px-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-muted/40">
            <Sparkles className="h-5 w-5 text-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-foreground">G-Brain</h1>
            <p className="text-sm text-muted-foreground">
              Your personal knowledge brain, running locally
              {overview?.detection?.engine ? ` on ${overview.detection.engine}` : ""}
              {overview?.detection?.schemaPack ? ` · ${overview.detection.schemaPack}` : ""}.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadOverview()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border-subtle px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border-subtle">
        {([
          ["overview", "Overview", Activity],
          ["auto-jobs", "Auto-jobs", Moon],
          ["explore", "Explore", Cog],
        ] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors",
              tab === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && <OverviewPanel overview={overview} doctor={doctor} loading={loading} />}
        {tab === "auto-jobs" && <AutoJobsPanel overview={overview} commands={commands} />}
        {tab === "explore" && <ExplorePanel commands={commands} />}
      </div>
    </div>
  );
}

/* ── Overview ── */

function OverviewPanel({ overview, doctor, loading }: { overview: Overview | null; doctor: Doctor | null; loading: boolean }) {
  if (loading && !overview) return <PanelLoading />;
  const score = doctor?.health_score;
  const scoreTone = score == null ? "text-muted-foreground" : score >= 90 ? "text-success-fg" : score >= 70 ? "text-warning-fg" : "text-danger-fg";
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Health</p>
          <p className={cn("mt-1 text-3xl font-semibold tabular-nums", scoreTone)}>{score ?? "—"}</p>
          <p className="text-xs text-muted-foreground">{doctor?.status ?? "unknown"}</p>
        </Card>
        <Card className="sm:col-span-2">
          <p className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Category scores</p>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1.5">
            {Object.entries(doctor?.category_scores ?? {}).map(([k, v]) => (
              <div key={k} className="flex items-center gap-1.5 text-sm">
                <span className="capitalize text-muted-foreground">{k}</span>
                <span className="font-medium tabular-nums text-foreground">{v}</span>
              </div>
            ))}
            {!doctor?.category_scores && <span className="text-sm text-muted-foreground">—</span>}
          </div>
        </Card>
      </div>

      {doctor?.top_issues && doctor.top_issues.length > 0 && (
        <Card>
          <p className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Top issues</p>
          <ul className="mt-2 space-y-2">
            {doctor.top_issues.map((issue, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {issue.status === "error"
                  ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
                  : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" />}
                <span className="min-w-0">
                  <span className="font-medium text-foreground">{issue.name}</span>
                  <span className="text-muted-foreground"> — {issue.fix}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Brain statistics</p>
          <Pre text={overview?.stats} />
        </Card>
        <Card>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Background jobs</p>
          <Pre text={overview?.jobs} />
        </Card>
      </div>
    </div>
  );
}

/* ── Auto-jobs (dreaming / autopilot / minions) ── */

function AutoJobsPanel({ overview, commands }: { overview: Overview | null; commands: GbrainCommand[] }) {
  const jobCmds = commands.filter((c) => c.category === "auto-jobs");
  return (
    <div className="space-y-5">
      <Card>
        <div className="flex items-start gap-3">
          <Moon className="mt-0.5 h-5 w-5 shrink-0 text-foreground" />
          <div>
            <p className="text-sm font-semibold text-foreground">Dreaming & autopilot</p>
            <p className="text-sm text-muted-foreground">
              G-Brain maintains itself. <span className="font-medium text-foreground">Dream</span> is the overnight
              maintenance cycle (link/timeline extraction, salience, cleanup); <span className="font-medium text-foreground">autopilot</span> runs
              it continuously; and <span className="font-medium text-foreground">Minions</span> is the background job queue that absorbs facts.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Job queue</p>
        <Pre text={overview?.jobs} />
      </Card>

      <div className="grid grid-cols-1 gap-3">
        {jobCmds.map((c) => <CommandRunner key={c.id} command={c} />)}
      </div>
    </div>
  );
}

/* ── Explore: the full catalog ── */

function ExplorePanel({ commands }: { commands: GbrainCommand[] }) {
  const grouped = useMemo(() => {
    const by: Record<string, GbrainCommand[]> = {};
    for (const c of commands) (by[c.category] ??= []).push(c);
    return by;
  }, [commands]);

  if (commands.length === 0) return <PanelLoading />;

  return (
    <div className="space-y-6">
      {CATEGORY_ORDER.filter((cat) => grouped[cat]?.length).map((cat) => (
        <section key={cat}>
          <h2 className="mb-2 text-sm font-semibold text-foreground">{CATEGORY_LABELS[cat] ?? cat}</h2>
          <div className="grid grid-cols-1 gap-3">
            {grouped[cat].map((c) => <CommandRunner key={c.id} command={c} />)}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ── one runnable command ── */

function CommandRunner({ command }: { command: GbrainCommand }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = useCallback(async (confirm = false) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/g-brain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: command.id, values, confirm }),
      });
      const d = await res.json();
      if (d.needsConfirm) {
        if (typeof window !== "undefined" && window.confirm(`${command.label} is destructive. Run it?`)) {
          return run(true);
        }
        setError("Cancelled.");
        return;
      }
      if (d.ok) {
        setOutput(d.json ? JSON.stringify(d.json, null, 2) : (d.stdout || "(no output)"));
      } else {
        setError(d.error || "Command failed");
        setOutput(d.stdout || null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [command.id, command.label, values]);

  return (
    <div className="rounded-xl border border-border-subtle bg-card p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{command.label}</span>
            {command.mutates && (
              <span className={cn("rounded-full px-1.5 py-0.5 text-[10px] font-medium", command.dangerous ? "bg-danger-bg text-danger-fg" : "bg-warning-bg text-warning-fg")}>
                {command.dangerous ? "destructive" : "writes"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{command.description}</p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={() => void run()}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          Run
        </button>
      </div>

      {command.args && command.args.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {command.args.map((a) => (
            <input
              key={a.name}
              value={values[a.name] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
              placeholder={`${a.placeholder ?? a.name}${a.required ? " *" : ""}`}
              className="min-w-[8rem] flex-1 rounded-lg border border-border-subtle bg-muted/30 px-2.5 py-1.5 text-xs text-foreground placeholder:text-fg-subtle focus:border-border-strong focus:outline-none"
            />
          ))}
        </div>
      )}

      {error && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-danger-fg">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {output != null && (
        <div className="mt-2">
          {!error && (
            <p className="mb-1 flex items-center gap-1 text-[11px] text-success-fg">
              <CheckCircle className="h-3 w-3" /> done
            </p>
          )}
          <Pre text={output} max />
        </div>
      )}
    </div>
  );
}

/* ── small building blocks ── */

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-xl border border-border-subtle bg-card p-4", className)}>{children}</div>;
}

function Pre({ text, max }: { text?: string | null; max?: boolean }) {
  if (!text) return <p className="text-sm text-muted-foreground">—</p>;
  return (
    <pre className={cn(
      "overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-2.5 text-[11px] leading-relaxed text-fg-secondary",
      max && "max-h-72 overflow-y-auto",
    )}>
      {text}
    </pre>
  );
}

function PanelLoading() {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Loading G-Brain…
    </div>
  );
}
