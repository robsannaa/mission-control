"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Clock, CornerDownLeft, Loader2, RefreshCw, Reply, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import {
  channelLabel,
  confidenceLabel,
  formatDue,
  groupByDue,
  type Commitment,
  type CommitmentsResult,
} from "@/lib/commitments-types";

async function fetchCommitments(): Promise<CommitmentsResult> {
  const res = await fetch("/api/commitments?status=pending", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Failed to load commitments");
  return body as CommitmentsResult;
}

async function post(payload: Record<string, unknown>): Promise<CommitmentsResult | null> {
  const res = await fetch("/api/commitments", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(body?.error || "Action failed");
  return Array.isArray(body?.commitments) ? (body as CommitmentsResult) : null;
}

export function CommitmentsView() {
  const [data, setData] = useState<CommitmentsResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    try {
      const next = await fetchCommitments();
      setData(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    setNow(Date.now());
    void load();
  }, [load]);

  const commitments = data?.commitments ?? [];
  const groups = useMemo(() => (now ? groupByDue(commitments, now) : []), [commitments, now]);

  const apply = useCallback((next: CommitmentsResult | null) => {
    if (next) setData(next);
    else void load(true);
  }, [load]);

  return (
    <SectionLayout>
      <SectionHeader
        title="Commitments"
        description="Open loops your agent noticed and hasn't closed — things it offered or promised. Nudge, or let them go."
        meta={commitments.length > 0 ? `${commitments.length} open` : undefined}
        actions={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void load(true)}
            disabled={refreshing}
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
          </Button>
        }
      />
      <SectionBody width="content">
        {loading ? (
          <ContentLoadingState />
        ) : error ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-danger-border bg-danger-bg px-6 py-10 text-center">
            <p className="max-w-md text-sm text-danger-fg">{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="size-3.5" /> Retry
            </Button>
          </div>
        ) : commitments.length === 0 ? (
          <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border px-8 py-12 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-fg-secondary">
              <Check className="size-5" />
            </div>
            <h2 className="text-base font-semibold text-foreground">All caught up</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              No open loops right now. When your agent offers or promises something and it goes unanswered,
              it shows up here so nothing slips.
            </p>
          </div>
        ) : (
          <div className="space-y-7">
            {groups.map((g) => (
              <section key={g.bucket} className="space-y-2.5">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">{g.label}</h3>
                  <span className="text-xs text-fg-subtle">· {g.items.length}</span>
                </div>
                <div className="space-y-2.5">
                  {g.items.map((c) => (
                    <CommitmentCard key={c.id} commitment={c} overdue={g.bucket === "overdue"} onChanged={apply} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}

function CommitmentCard({
  commitment,
  overdue,
  onChanged,
}: {
  commitment: Commitment;
  overdue: boolean;
  onChanged: (next: CommitmentsResult | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [answering, setAnswering] = useState(false);
  const [answer, setAnswer] = useState("");
  const conf = confidenceLabel(commitment.confidence);
  const due = formatDue(commitment.dueWindow);
  const canAnswer = Boolean(commitment.sessionKey);

  const run = async (key: string, payload: Record<string, unknown>) => {
    setBusy(key);
    try {
      onChanged(await post(payload));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const submitAnswer = async () => {
    if (!answer.trim()) return;
    setBusy("answer");
    try {
      onChanged(await post({ action: "answer", commitment, answer: answer.trim() }));
      setAnswer("");
      setAnswering(false);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={cn("rounded-xl border bg-card p-4", overdue ? "border-warning-border" : "border-border")}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline">{channelLabel(commitment.channel)}</Badge>
            {commitment.agentId && commitment.agentId !== "main" && (
              <Badge variant="secondary">{commitment.agentId}</Badge>
            )}
            <Badge variant={conf.tone}>{conf.label} confidence</Badge>
            {due && (
              <span className="inline-flex items-center gap-1 text-xs text-fg-subtle">
                <Clock className="size-3" /> {due}
              </span>
            )}
          </div>
          {commitment.suggestedText && (
            <p className="text-sm font-medium leading-relaxed text-foreground">“{commitment.suggestedText}”</p>
          )}
          {commitment.reason && (
            <p className="text-xs leading-relaxed text-muted-foreground">{commitment.reason}</p>
          )}
        </div>
      </div>

      {answering ? (
        <div className="mt-3 space-y-2">
          <Textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submitAnswer();
            }}
            placeholder="Answer the agent — it'll pick this up and act on it…"
            rows={3}
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-xs text-fg-subtle">Goes straight to your agent · ⌘⏎ to send</span>
            <Button variant="ghost" size="sm" onClick={() => { setAnswering(false); setAnswer(""); }} disabled={busy !== null}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void submitAnswer()} disabled={busy !== null || !answer.trim()}>
              {busy === "answer" ? <Loader2 className="size-3.5 animate-spin" /> : <CornerDownLeft className="size-3.5" />}
              Answer here
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void run("dismiss", { action: "dismiss", ids: [commitment.id] })}
            disabled={busy !== null}
          >
            {busy === "dismiss" ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
            Dismiss
          </Button>
          {canAnswer && (
            <Button size="sm" onClick={() => setAnswering(true)} disabled={busy !== null}>
              <Reply className="size-3.5" /> Answer here
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
