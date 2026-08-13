"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, CircleHelp, Clock3, MessageSquareText, SkipForward } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InteractionRequest } from "@/lib/awareness/types";
import { announceInteractionsChanged } from "@/lib/interaction-events";

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

type Tab = "active" | "all";

export function QuestionsView() {
  const [items, setItems] = useState<InteractionRequest[]>([]);
  const [tab, setTab] = useState<Tab>("active");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/interactions?status=${tab}&limit=100`, { cache: "no-store" });
      const payload = await response.json() as { interactions?: InteractionRequest[]; error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not load questions");
      setItems(payload.interactions || []);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    setLoading(true);
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openCount = useMemo(() => items.filter((item) => item.status === "open").length, [items]);

  async function act(id: string, action: "answer" | "skip", answer?: string) {
    setBusy(id);
    try {
      const response = await fetch("/api/interactions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id, answer }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "Could not update question");
      setAnswers((current) => ({ ...current, [id]: "" }));
      announceInteractionsChanged();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl space-y-6 px-5 py-8 md:px-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <CircleHelp className="h-5 w-5 text-fg-subtle" />
              <h1 className="text-2xl font-semibold tracking-tight">Questions</h1>
              {openCount > 0 && (
                <span className="rounded-full bg-foreground px-2 py-0.5 text-xs font-semibold text-background">
                  {openCount}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Background work waiting for your input. Answer here to resume it.
            </p>
          </div>
          <div className="inline-flex rounded-control border border-border bg-muted p-0.5">
            {(["active", "all"] as Tab[]).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setTab(value)}
                className={cn(
                  "rounded-control px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                  tab === value ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {value}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-control border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading ? (
          <div className="flex min-h-64 items-center justify-center" aria-label="Loading questions">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-border bg-card text-center">
            <Check className="mb-3 h-5 w-5 text-fg-subtle" />
            <h2 className="text-sm font-medium">Nothing needs your attention</h2>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              Background work will appear here only when an answer materially affects what happens next.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {items.map((item) => {
              const isOpen = item.status === "open";
              const answer = answers[item.id] || "";
              return (
                <article key={item.id} className="p-5" data-interaction-id={item.id}>
                  <div className="flex gap-4">
                    <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-control bg-muted text-fg-subtle">
                      <MessageSquareText className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h2 className="text-sm font-semibold text-foreground">{item.title}</h2>
                          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
                            <span className="capitalize">{item.source.kind}</span>
                            {item.source.label && <span>· {item.source.label}</span>}
                            <span className="inline-flex items-center gap-1"><Clock3 className="h-3 w-3" />{relativeTime(item.createdAt)}</span>
                          </div>
                        </div>
                        <span className={cn(
                          "rounded-full border px-2 py-0.5 text-xs capitalize",
                          isOpen ? "border-warning/30 bg-warning/10 text-warning" : "border-border text-muted-foreground",
                        )}>{item.status}</span>
                      </div>

                      {item.context && <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{item.context}</p>}
                      <p className="mt-3 text-[15px] font-medium leading-relaxed text-foreground">{item.question}</p>
                      {item.reason && <p className="mt-1 text-xs text-fg-subtle">{item.reason}</p>}

                      {isOpen ? (
                        <div className="mt-4 space-y-3">
                          {item.choices.length > 0 && (
                            <div className="flex flex-wrap gap-2">
                              {item.choices.map((choice) => (
                                <button
                                  key={choice.id}
                                  type="button"
                                  disabled={busy === item.id}
                                  onClick={() => void act(item.id, "answer", choice.value)}
                                  className="rounded-control border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-50"
                                >
                                  {choice.label}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              value={answer}
                              onChange={(event) => setAnswers((current) => ({ ...current, [item.id]: event.target.value }))}
                              onKeyDown={(event) => {
                                if (event.key === "Enter" && answer.trim() && busy !== item.id) void act(item.id, "answer", answer);
                              }}
                              placeholder="Type your answer…"
                              aria-label={`Answer: ${item.question}`}
                              className="min-w-0 flex-1 rounded-control border border-border bg-background px-3 py-2 text-sm outline-none focus:border-border-strong"
                            />
                            <button
                              type="button"
                              disabled={!answer.trim() || busy === item.id}
                              onClick={() => void act(item.id, "answer", answer)}
                              className="rounded-control bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
                            >
                              {busy === item.id ? "Sending…" : "Answer"}
                            </button>
                            <button
                              type="button"
                              disabled={busy === item.id}
                              onClick={() => void act(item.id, "skip")}
                              className="inline-flex items-center justify-center gap-1.5 rounded-control border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                            >
                              <SkipForward className="h-3.5 w-3.5" /> Skip
                            </button>
                          </div>
                        </div>
                      ) : item.answer ? (
                        <div className="mt-4 rounded-control bg-muted px-3 py-2 text-sm">
                          <span className="text-fg-subtle">Answer: </span>{item.answer}
                        </div>
                      ) : null}

                      {item.source.href && (
                        <Link href={item.source.href} className="mt-4 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                          Open source <ChevronRight className="h-3 w-3" />
                        </Link>
                      )}
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
