"use client";

/**
 * The Doctor page.
 *
 * ## What this page is for
 *
 * One honest answer to "is my system healthy, and when was that actually
 * checked?", followed by findings that explain themselves and repairs the user
 * can see before they commit to them. It is built for someone who has never
 * opened a terminal: no shell command appears anywhere without being asked for,
 * and every finding says what is wrong, why it matters, and what happens if it
 * is left alone.
 *
 * ## The rules it will not break
 *
 * These come from the server contract, and each one exists because breaking it
 * would make the page lie:
 *
 * 1. `health.score === null` renders words, never a number.
 * 2. `cached: true` shows the true age. A stored result never reads as a fresh
 *    look.
 * 3. `fix.blocked !== null` gets no button, and the reason is shown.
 * 4. Anything not `safe` shows what it does and its side effects *before* the
 *    control that runs it; `destructive` is never a single click.
 * 5. `outcome.status === "still-present"` is a failure, whatever the exit code
 *    said.
 * 6. `health.caveats` and `coverage.unverifiedFamilies` are always rendered.
 * 7. A diff with `notComparable` entries is never presented as complete.
 * 8. Background polling uses `?peek=1`, which never starts a subprocess. Only a
 *    deliberate action refreshes or runs.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import {
  getTimeFormatServerSnapshot,
  getTimeFormatSnapshot,
  is12HourTimeFormat,
  subscribeTimeFormatPreference,
} from "@/lib/time-format-preference";
import { Panel, QuietNote, SectionTitle } from "@/components/doctor/primitives";
import { VerdictCard } from "@/components/doctor/verdict-card";
import {
  FindingCard,
  InformationalRow,
  PreventionRow,
} from "@/components/doctor/finding-card";
import { ChangesPanel, CoveragePanel, VitalsPanel } from "@/components/doctor/panels";
import { HistoryPanel } from "@/components/doctor/history-panel";
import { FixDialog } from "@/components/doctor/fix-dialog";
import { GuideDialog } from "@/components/doctor/guide-dialog";
import { ReportDialog } from "@/components/doctor/report-dialog";
import { RunConfirmDialog } from "@/components/doctor/run-confirm-dialog";
import { errorMessage, readEventStream } from "@/components/doctor/sse";
import type {
  DoctorFinding,
  DoctorHistoryResponse,
  DoctorStatusResponse,
  FixDescriptor,
  FixOutcome,
  FixPlanSummary,
  RunEvent,
  RunMode,
  RunPhase,
} from "@/components/doctor/types";

/** How often the page re-reads the stored snapshot. Never runs anything. */
const PEEK_INTERVAL_MS = 45_000;

type Dialog =
  | { kind: "fix"; fix: FixDescriptor; contextTitle: string | null }
  | { kind: "guide"; finding: DoctorFinding }
  | { kind: "report" }
  | { kind: "confirm-run"; mode: Exclude<RunMode, "quick"> }
  | null;

export function DoctorView() {
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot
  );
  const hour12 = is12HourTimeFormat(timeFormat);

  const [status, setStatus] = useState<DoctorStatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [initialising, setInitialising] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [history, setHistory] = useState<DoctorHistoryResponse | null>(null);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLimit, setHistoryLimit] = useState(12);

  const [fixes, setFixes] = useState<Record<string, FixPlanSummary>>({});

  const [running, setRunning] = useState(false);
  const [runMode, setRunMode] = useState<RunMode | null>(null);
  const [phases, setPhases] = useState<RunPhase[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [runError, setRunError] = useState<string | null>(null);
  /** Live command output. Held in memory only — it is not redacted. */
  const [runLog, setRunLog] = useState<string[]>([]);

  const [dialog, setDialog] = useState<Dialog>(null);

  const runAbortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const runningRef = useRef(false);

  /* ── reads ─────────────────────────────────────────────────────────── */

  const loadStatus = useCallback(
    async (kind: "initial" | "peek" | "refresh") => {
      if (kind === "refresh") setRefreshing(true);
      try {
        const query = kind === "peek" ? "?peek=1" : kind === "refresh" ? "?refresh=1" : "";
        const res = await fetch(`/api/doctor/status${query}`, { cache: "no-store" });
        if (!res.ok) throw new Error(await errorMessage(res, `The check could not be read (${res.status}).`));
        const data = (await res.json()) as DoctorStatusResponse;
        // A run in flight owns the snapshot; a background peek must not stomp on
        // the narration the user is watching.
        if (runningRef.current && kind === "peek") return;
        setStatus(data);
        setStatusError(null);
      } catch (err) {
        if (kind !== "peek") setStatusError(err instanceof Error ? err.message : String(err));
      } finally {
        if (kind === "refresh") setRefreshing(false);
        if (kind === "initial") setInitialising(false);
      }
    },
    []
  );

  const loadHistory = useCallback(async (limit: number) => {
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/doctor/history?summary=1&limit=${limit}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      setHistory((await res.json()) as DoctorHistoryResponse);
    } catch {
      // History is a nicety; its absence must not break the page.
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus("initial");
  }, [loadStatus]);

  useEffect(() => {
    void loadHistory(historyLimit);
  }, [loadHistory, historyLimit]);

  useEffect(() => {
    fetch("/api/doctor/fix", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { fixes: FixPlanSummary[] } | null) => {
        if (!data) return;
        setFixes(Object.fromEntries(data.fixes.map((f) => [f.id, f])));
      })
      .catch(() => {});
  }, []);

  // Background poll. `peek=1` only ever reads what is already stored, so this
  // can never start a subprocess on the user's machine — it just notices when
  // something else (another tab, a repair, a scheduled run) has moved on.
  useEffect(() => {
    const id = setInterval(() => {
      if (!runningRef.current) void loadStatus("peek");
    }, PEEK_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible" && !runningRef.current) {
        void loadStatus("peek");
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadStatus]);

  useEffect(
    () => () => {
      runAbortRef.current?.abort();
      if (timerRef.current) clearInterval(timerRef.current);
    },
    []
  );

  /* ── running a check ───────────────────────────────────────────────── */

  const runNow = useCallback(
    async (mode: RunMode) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      setRunMode(mode);
      setPhases([]);
      setRunLog([]);
      setRunError(null);
      setElapsedMs(0);

      const startedAt = Date.now();
      timerRef.current = setInterval(() => setElapsedMs(Date.now() - startedAt), 100);

      const controller = new AbortController();
      runAbortRef.current = controller;

      try {
        const res = await fetch("/api/doctor/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode, acknowledgeMutation: mode !== "quick" }),
          signal: controller.signal,
        });

        if (!res.ok) {
          setRunError(
            res.status === 409
              ? "A check is already running somewhere else. Give it a moment and try again."
              : res.status === 403
                ? "This installation is set to read-only, so that check is not available here."
                : await errorMessage(res, `The check could not start (${res.status}).`)
          );
          return;
        }

        await readEventStream<RunEvent>(
          res,
          (event) => {
            if (event.type === "phase") {
              setPhases((prev) => [
                ...prev.filter((p) => p.phase !== event.phase),
                {
                  phase: event.phase,
                  label: event.label,
                  index: event.index,
                  total: event.total,
                  status: "running",
                  durationMs: null,
                  detail: null,
                },
              ]);
            } else if (event.type === "phase-done") {
              setPhases((prev) =>
                prev.map((p) =>
                  p.phase === event.phase
                    ? {
                        ...p,
                        status: event.ok ? "ok" : "failed",
                        durationMs: event.durationMs,
                        detail: event.detail ?? null,
                      }
                    : p
                )
              );
            } else if (event.type === "output") {
              setRunLog((prev) => {
                const next = [...prev, event.text];
                return next.length > 300 ? next.slice(-300) : next;
              });
            } else if (event.type === "snapshot") {
              setStatus((prev) => ({
                ...event.snapshot,
                diff: event.diff,
                trend: prev?.trend ?? [],
              }));
              setStatusError(null);
            } else if (event.type === "error") {
              setRunError(event.message);
            }
          },
          controller.signal
        );
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setRunError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (timerRef.current) clearInterval(timerRef.current);
        runningRef.current = false;
        setRunning(false);
        runAbortRef.current = null;
        // The run event carries no trend, so read it back once we are idle.
        void loadStatus("peek");
        void loadHistory(historyLimit);
      }
    },
    [loadStatus, loadHistory, historyLimit]
  );

  const requestRun = useCallback(
    (mode: RunMode) => {
      if (mode === "quick") void runNow("quick");
      else setDialog({ kind: "confirm-run", mode });
    },
    [runNow]
  );

  /* ── repairs ───────────────────────────────────────────────────────── */

  const openFix = useCallback((finding: DoctorFinding) => {
    if (!finding.fix || finding.fix.blocked) return;
    setDialog({ kind: "fix", fix: finding.fix, contextTitle: finding.title });
  }, []);

  const openGuide = useCallback((finding: DoctorFinding) => {
    setDialog({ kind: "guide", finding });
  }, []);

  const onFixFinished = useCallback(
    (_outcome: FixOutcome) => {
      // The server invalidates its cache after any outcome, so this is a real
      // re-check rather than a re-read of what we already had.
      void loadStatus("refresh");
      void loadHistory(historyLimit);
    },
    [loadStatus, loadHistory, historyLimit]
  );

  /* ── grouping ──────────────────────────────────────────────────────── */

  const grouped = useMemo(() => {
    const findings = status?.findings ?? [];
    const ids = new Set(findings.map((f) => f.id));
    const isConsequence = (f: DoctorFinding) => f.causedBy !== null && ids.has(f.causedBy);

    const roots = findings.filter((f) => !isConsequence(f));
    const needsYou = roots.filter((f) => !f.informational && f.severity !== "info");
    const informational = roots.filter((f) => f.informational || f.severity === "info");
    const consequenceCount = findings.filter(
      (f) => isConsequence(f) && !f.informational && f.severity !== "info"
    ).length;

    const consequencesOf = (id: string) => findings.filter((f) => f.causedBy === id);

    return { needsYou, informational, consequenceCount, consequencesOf };
  }, [status]);

  const fixDescriptors = useMemo<Record<string, FixDescriptor>>(() => fixes, [fixes]);

  /* ── render ────────────────────────────────────────────────────────── */

  return (
    <SectionLayout>
      <SectionHeader
        title="Doctor"
        description="What Mission Control can actually tell you about the health of this installation — and what it cannot."
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-6 pb-16">
        {initialising && !status ? (
          <LoadingVerdict />
        ) : statusError && !status ? (
          <Panel className="px-6 py-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Mission Control could not read your system&rsquo;s health
                </h2>
                <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
                  {statusError}
                </p>
              </div>
            </div>
          </Panel>
        ) : status ? (
          <>
            <VerdictCard
              snapshot={status}
              diff={status.diff}
              counts={{
                needsYou: grouped.needsYou.length,
                consequences: grouped.consequenceCount,
                informational: grouped.informational.length,
              }}
              running={running}
              runMode={runMode}
              phases={phases}
              elapsedMs={elapsedMs}
              runLog={runLog}
              onRun={requestRun}
              onOpenReport={() => setDialog({ kind: "report" })}
              refreshing={refreshing}
            />

            {runError && (
              <Panel className="flex items-start gap-3 border-danger-border px-5 py-4 md:px-6">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger-fg" />
                <p className="text-sm leading-relaxed text-danger-fg">{runError}</p>
              </Panel>
            )}

            {grouped.needsYou.length > 0 && (
              <section className="space-y-3">
                <SectionTitle
                  title="Needs you"
                  hint="Each of these is something a person has to decide about. Nothing here changes until you press something."
                />
                <div className="space-y-3 stagger-cards">
                  {grouped.needsYou.map((finding) => (
                    <FindingCard
                      key={finding.id}
                      finding={finding}
                      consequences={grouped.consequencesOf(finding.id)}
                      onFix={openFix}
                      onGuide={openGuide}
                      busy={running}
                    />
                  ))}
                </div>
              </section>
            )}

            {status.prevention.length > 0 && (
              <Panel>
                <header className="px-5 pb-3 pt-5 md:px-6">
                  <SectionTitle
                    title="Worth heading off"
                    hint="Nothing is broken here yet. These are the things that break next if nobody looks."
                  />
                </header>
                <div className="divide-y divide-border-subtle border-t border-border-subtle">
                  {status.prevention.map((finding) => (
                    <PreventionRow
                      key={finding.id}
                      finding={finding}
                      onFix={openFix}
                      onGuide={openGuide}
                      busy={running}
                    />
                  ))}
                </div>
              </Panel>
            )}

            {/* Nothing has ever been checked here, so "what changed" would be
                a panel about the absence of a comparison. */}
            {status.health.checkedAt !== null && (
              <ChangesPanel
                diff={status.diff}
                hasHistory={(history?.total ?? 0) > 0}
                hour12={hour12}
              />
            )}

            <VitalsPanel vitals={status.vitals} />

            {grouped.informational.length > 0 && (
              <Panel>
                <header className="px-5 pb-4 pt-5 md:px-6">
                  <SectionTitle
                    title="Everything else it noticed"
                    hint="Real findings that are not problems. They are here so nothing is hidden from you, not because anything is wrong."
                  />
                </header>
                <div className="divide-y divide-border-subtle border-t border-border-subtle">
                  {grouped.informational.map((finding) => (
                    <InformationalRow
                      key={finding.id}
                      finding={finding}
                      onFix={openFix}
                      onGuide={openGuide}
                      busy={running}
                    />
                  ))}
                </div>
              </Panel>
            )}

            {grouped.needsYou.length === 0 &&
              grouped.informational.length === 0 &&
              status.health.state === "checked" && (
                <Panel className="px-5 py-6 md:px-6">
                  <SectionTitle title="Findings" />
                  <QuietNote className="mt-2">
                    Nothing was reported by any source that ran. The panel below shows exactly which
                    sources those were.
                  </QuietNote>
                </Panel>
              )}

            <CoveragePanel coverage={status.coverage} provenance={status.provenance} />

            <HistoryPanel
              history={history}
              trend={status.trend}
              hour12={hour12}
              loading={historyLoading}
              onLoadMore={() => setHistoryLimit((n) => Math.min(50, n + 12))}
            />
          </>
        ) : null}
      </SectionBody>

      {dialog?.kind === "fix" && (
        <FixDialog
          fix={dialog.fix}
          contextTitle={dialog.contextTitle}
          onClose={() => setDialog(null)}
          onFinished={onFixFinished}
        />
      )}

      {dialog?.kind === "guide" && (
        <GuideDialog
          finding={dialog.finding}
          fixes={fixDescriptors}
          onClose={() => setDialog(null)}
          onRunFix={(fix, contextTitle) => setDialog({ kind: "fix", fix, contextTitle })}
        />
      )}

      {dialog?.kind === "report" && <ReportDialog onClose={() => setDialog(null)} />}

      {dialog?.kind === "confirm-run" && (
        <RunConfirmDialog
          mode={dialog.mode}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const mode = dialog.mode;
            setDialog(null);
            void runNow(mode);
          }}
          onChooseQuick={() => {
            setDialog(null);
            void runNow("quick");
          }}
        />
      )}
    </SectionLayout>
  );
}

/* ── first paint ───────────────────────────────────────────────────────── */

/**
 * The first read may genuinely be running a read-only collection on the server,
 * which takes a few seconds. Saying so beats a skeleton that implies the answer
 * is already known.
 */
function LoadingVerdict() {
  return (
    <Panel className="p-6 md:p-8">
      <p className="flex items-center gap-2.5">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
        <span className="eyebrow !text-fg-secondary">Checking</span>
      </p>
      <h2 className="mt-3 text-2xl font-semibold leading-tight tracking-[-0.02em] text-foreground md:text-[1.75rem]">
        Reading your system…
      </h2>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
        Mission Control is asking OpenClaw how things are. Nothing is being changed.
      </p>
      <div className="mt-7 space-y-2.5">
        <div className="h-3 w-2/3 animate-pulse rounded-full bg-muted" />
        <div className="h-3 w-1/2 animate-pulse rounded-full bg-muted" />
      </div>
    </Panel>
  );
}
