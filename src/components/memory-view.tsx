"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  BrainCircuit,
  Check,
  ChevronDown,
  CircleCheck,
  Database,
  Layers,
  Loader2,
  Moon,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import {
  isBarrenReflection,
  scoreTone,
  type MemoryEntry,
  type MemorySnapshot,
  type PromotionCandidate,
  type Reflection,
} from "@/lib/memory-native-types";

async function fetchSnapshot(): Promise<MemorySnapshot> {
  const res = await fetch("/api/memory", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Failed to load memory");
  return body as MemorySnapshot;
}

async function post(payload: Record<string, unknown>): Promise<MemorySnapshot | null> {
  const res = await fetch("/api/memory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(body?.error || "Action failed");
  return Array.isArray(body?.entries) ? (body as MemorySnapshot) : null;
}

type Editing = { mode: "new" } | { mode: "edit"; entry: MemoryEntry } | null;

interface EngineStatus {
  provider?: string;
  model?: string;
  dims: number | null;
  files: number;
  chunks: number;
  dirty: boolean;
  ollama: boolean;
}

export function MemoryView() {
  const [snap, setSnap] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [showReflections, setShowReflections] = useState(false);
  const [engine, setEngine] = useState<EngineStatus | null>(null);

  // The index/embeddings engine — memory and vectors are ONE system in
  // OpenClaw, so the engine lives on this page too. Refetched after any change.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/vector?scope=status", { cache: "no-store" });
        const d = await res.json();
        if (!active || !res.ok) return;
        const s = d?.agents?.[0]?.status;
        if (s) {
          setEngine({
            provider: s.provider,
            model: s.model,
            dims: s.vector?.dims ?? null,
            files: s.files ?? 0,
            chunks: s.chunks ?? 0,
            dirty: Boolean(s.dirty),
            ollama: Boolean(d?.providerAvailability?.ollama?.reachable),
          });
        }
      } catch {
        /* engine card is best-effort */
      }
    })();
    return () => {
      active = false;
    };
  }, [snap]);

  const load = useCallback(async (soft = false) => {
    if (!soft) setLoading(true);
    try {
      setSnap(await fetchSnapshot());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback((next: MemorySnapshot | null) => {
    if (next) setSnap(next);
    else void load(true);
  }, [load]);

  const entries = snap?.entries ?? [];
  const candidates = snap?.candidates ?? [];
  const reflections = snap?.reflections ?? [];
  const status = snap?.status ?? null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter((e) => e.heading.toLowerCase().includes(q) || e.body.toLowerCase().includes(q));
  }, [entries, query]);

  const run = async (key: string, payload: Record<string, unknown>) => {
    setBusy(key);
    try {
      apply(await post(payload));
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionLayout>
      <SectionHeader
        title="Memory"
        description="What your agent actually remembers about you and your work — kept in plain files it reads, nothing invented."
        meta={
          status
            ? `${entries.length} memories · ${status.files} files, ${status.chunks} chunks indexed${status.model ? ` · ${status.model}` : ""}`
            : `${entries.length} memories`
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void run("reindex", { action: "reindex" })}
              disabled={busy !== null}
              title="Rebuild the semantic index"
            >
              {busy === "reindex" ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              Reindex
            </Button>
            <Button onClick={() => setEditing({ mode: "new" })}>
              <Plus className="size-4" /> Add memory
            </Button>
          </>
        }
      />

      <SectionBody width="content">
        {loading ? (
          <ContentLoadingState />
        ) : error ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : (
          <div className="space-y-8">
            {/* Promotion pipeline — only when the agent has recalls pending. */}
            {candidates.length > 0 && (
              <PromotionSection
                candidates={candidates}
                busy={busy === "promote"}
                onPromote={() => void run("promote", { action: "promote" })}
              />
            )}

            {/* The memories */}
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                  <BrainCircuit className="size-3.5" /> Remembered
                </h3>
                <div className="relative w-56">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search memories…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>
              </div>

              {filtered.length === 0 ? (
                <EmptyMemories hasQuery={Boolean(query.trim())} onAdd={() => setEditing({ mode: "new" })} />
              ) : (
                <div className="space-y-2.5">
                  {filtered.map((entry) => (
                    <MemoryCard
                      key={entry.id}
                      entry={entry}
                      onEdit={() => setEditing({ mode: "edit", entry })}
                      onDelete={() => void run(`del:${entry.id}`, { action: "delete", id: entry.id })}
                      deleting={busy === `del:${entry.id}`}
                    />
                  ))}
                </div>
              )}
            </section>

            {/* Reflections (DREAMS.md) */}
            {reflections.length > 0 && (
              <ReflectionsSection
                reflections={reflections}
                open={showReflections}
                onToggle={() => setShowReflections((v) => !v)}
              />
            )}

            {/* Index engine — memory and vectors are one system in OpenClaw. */}
            {engine && (
              <IndexSection
                engine={engine}
                busyKey={busy}
                onReindex={(force) => void run(force ? "force" : "reindex", { action: "reindex", force })}
              />
            )}
          </div>
        )}
      </SectionBody>

      <MemoryEditor
        editing={editing}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          setEditing(null);
          apply(next);
        }}
      />
    </SectionLayout>
  );
}

// ── memory card ───────────────────────────────────────────────────────────────

function MemoryCard({
  entry,
  onEdit,
  onDelete,
  deleting,
}: {
  entry: MemoryEntry;
  onEdit: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const long = entry.body.length > 320;

  return (
    <div className="group rounded-xl border border-border bg-card p-4 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-3">
        <h4 className="min-w-0 flex-1 text-sm font-semibold text-foreground">{entry.heading}</h4>
        <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label="Edit" title="Edit">
            <Pencil className="size-3.5" />
          </Button>
          {confirm ? (
            <>
              <Button variant="ghost" size="icon-sm" onClick={() => setConfirm(false)} aria-label="Cancel">
                <X className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="text-danger-fg"
                onClick={onDelete}
                disabled={deleting}
                aria-label="Confirm delete"
                title="Confirm delete"
              >
                {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="text-fg-subtle hover:text-danger-fg"
              onClick={() => setConfirm(true)}
              aria-label="Delete"
              title="Delete"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <p
        className={cn(
          "mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted-foreground",
          !expanded && long && "line-clamp-4",
        )}
      >
        {entry.body}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1.5 text-xs font-medium text-fg-subtle hover:text-foreground"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

// ── promotion pipeline ──────────────────────────────────────────────────────────

function PromotionSection({
  candidates,
  busy,
  onPromote,
}: {
  candidates: PromotionCandidate[];
  busy: boolean;
  onPromote: () => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-accent-brand-border bg-accent-brand-subtle/40 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Sparkles className="size-4 text-accent-brand-text" /> Pending promotion
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {candidates.length} recent recall{candidates.length === 1 ? "" : "s"} the agent ranked worth keeping.
          </p>
        </div>
        <Button size="sm" onClick={onPromote} disabled={busy}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          Promote all
        </Button>
      </div>
      <div className="space-y-2">
        {candidates.map((c) => (
          <div key={c.key} className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
            <Badge variant={scoreTone(c.score)} className="mt-0.5 shrink-0 tabular-nums">
              {c.score != null ? c.score.toFixed(2) : "—"}
            </Badge>
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">{c.snippet || c.key}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

// ── reflections (DREAMS.md) ──────────────────────────────────────────────────────

function ReflectionsSection({
  reflections,
  open,
  onToggle,
}: {
  reflections: Reflection[];
  open: boolean;
  onToggle: () => void;
}) {
  const real = reflections.filter((r) => !isBarrenReflection(r));
  const shown = open ? reflections : real.slice(0, 4);
  return (
    <section className="space-y-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle hover:text-foreground"
      >
        <Moon className="size-3.5" /> Reflections
        <span className="text-fg-subtle/70">· {reflections.length}</span>
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </button>
      <p className="text-xs text-muted-foreground">
        What your agent synthesised while “dreaming” — periodic REM reflections over its own history.
      </p>
      <div className="space-y-2">
        {shown.map((r) => (
          <div key={r.id} className="rounded-xl border border-border bg-card px-4 py-3">
            {r.timestamp && <p className="text-[11px] font-medium text-fg-subtle">{r.timestamp}</p>}
            <p
              className={cn(
                "mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed",
                isBarrenReflection(r) ? "italic text-fg-subtle" : "text-foreground",
              )}
            >
              {r.text}
            </p>
          </div>
        ))}
      </div>
      {!open && real.length > shown.length && (
        <button type="button" onClick={onToggle} className="text-xs font-medium text-fg-subtle hover:text-foreground">
          Show all {reflections.length} reflections
        </button>
      )}
    </section>
  );
}

// ── index engine (memory == vectors in OpenClaw) ────────────────────────────────

function IndexSection({
  engine,
  busyKey,
  onReindex,
}: {
  engine: EngineStatus;
  busyKey: string | null;
  onReindex: (force: boolean) => void;
}) {
  const reindexing = busyKey === "reindex" || busyKey === "force";
  const rows: Array<[string, React.ReactNode]> = [
    ["Provider", engine.provider || "—"],
    ["Model", <span key="m" className="font-mono text-xs">{engine.model || "—"}</span>],
    ["Dimensions", engine.dims ? `${engine.dims}-d` : "—"],
    ["Documents", engine.files],
    ["Chunks", engine.chunks],
  ];
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
          <Layers className="size-3.5" /> Index &amp; embeddings
        </h3>
        <Link
          href="/vectors"
          className="inline-flex items-center gap-1 text-xs font-medium text-fg-subtle hover:text-foreground"
        >
          Advanced settings <ArrowUpRight className="size-3" />
        </Link>
      </div>
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {engine.dirty ? (
              <Badge variant="warning">Index stale — reindex to catch up</Badge>
            ) : (
              <Badge variant="success">
                <CircleCheck className="size-3" /> Up to date
              </Badge>
            )}
            {engine.provider === "ollama" && !engine.ollama && (
              <Badge variant="destructive">Ollama unreachable</Badge>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => onReindex(false)} disabled={reindexing}>
              {busyKey === "reindex" ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Reindex
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onReindex(true)} disabled={reindexing}>
              {busyKey === "force" ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
              Full rebuild
            </Button>
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {rows.map(([k, v], i) => (
            <div key={i} className="flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
              <dt className="text-fg-subtle">{k}</dt>
              <dd className="truncate text-right font-medium text-foreground">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
          Your memories are chunked and embedded into a searchable vector index — the same store your agent recalls
          from. Memory and vectors are one system.
        </p>
      </div>
    </section>
  );
}

// ── add / edit ────────────────────────────────────────────────────────────────

function MemoryEditor({
  editing,
  onClose,
  onSaved,
}: {
  editing: Editing;
  onClose: () => void;
  onSaved: (next: MemorySnapshot | null) => void;
}) {
  const open = editing !== null;
  const isEdit = editing?.mode === "edit";
  const [heading, setHeading] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    if (editing?.mode === "edit") {
      setHeading(editing.entry.heading);
      setBody(editing.entry.body);
    } else {
      setHeading("");
      setBody("");
    }
    setErr(null);
  }, [open, editing]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const payload =
        editing?.mode === "edit"
          ? { action: "update", id: editing.entry.id, heading, body }
          : { action: "add", heading, body };
      onSaved(await post(payload));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle>{isEdit ? "Edit memory" : "Add a memory"}</SheetTitle>
          <SheetDescription>
            This is written straight into MEMORY.md — the file your agent reads. Keep it a clear, standalone fact
            or rule.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-fg-secondary">Title</span>
            <Input value={heading} onChange={(e) => setHeading(e.target.value)} placeholder="e.g. Response style" />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-fg-secondary">Memory</span>
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="What should the agent remember? Markdown is fine."
              rows={10}
              className="font-[inherit]"
            />
          </label>
          {err && (
            <p className="flex items-start gap-2 rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {err}
            </p>
          )}
        </div>
        <SheetFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-4">
          <SheetClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </SheetClose>
          <Button size="sm" onClick={() => void save()} disabled={saving || !heading.trim() || !body.trim()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            {isEdit ? "Save" : "Remember this"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── states ────────────────────────────────────────────────────────────────────

function EmptyMemories({ hasQuery, onAdd }: { hasQuery: boolean; onAdd: () => void }) {
  return (
    <div className="mx-auto mt-4 flex max-w-md flex-col items-center gap-3 rounded-xl border border-dashed border-border px-8 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-fg-secondary">
        <Database className="size-5" />
      </div>
      <h2 className="text-base font-semibold text-foreground">
        {hasQuery ? "No memories match" : "Nothing remembered yet"}
      </h2>
      <p className="text-sm leading-relaxed text-muted-foreground">
        {hasQuery
          ? "Try a different search."
          : "Your agent hasn't stored anything durable yet. Add a fact or rule, or let it promote what it learns over time."}
      </p>
      {!hasQuery && (
        <Button onClick={onAdd}>
          <Plus className="size-4" /> Add your first memory
        </Button>
      )}
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-danger-border bg-danger-bg px-6 py-10 text-center">
      <AlertTriangle className="size-6 text-danger-fg" />
      <p className="max-w-md text-sm text-danger-fg">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3.5" /> Retry
      </Button>
    </div>
  );
}
