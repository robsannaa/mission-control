"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, Plus, RefreshCw, ShieldCheck, Sparkles, X, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { cn } from "@/lib/utils";
import {
  allowlistFor,
  deriveMode,
  type ApprovalsSnapshot,
  type ExecMode,
} from "@/lib/exec-approvals-types";

async function fetchApprovals(): Promise<ApprovalsSnapshot> {
  const res = await fetch("/api/approvals", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Failed to load approvals");
  return body as ApprovalsSnapshot;
}

async function post(payload: Record<string, unknown>): Promise<ApprovalsSnapshot> {
  const res = await fetch("/api/approvals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok || body?.ok === false) throw new Error(body?.error || "Action failed");
  return body as ApprovalsSnapshot;
}

export function ApprovalsView() {
  const [snap, setSnap] = useState<ApprovalsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pattern, setPattern] = useState("");
  const [addingPattern, setAddingPattern] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnap(await fetchApprovals());
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

  const mode: ExecMode = snap ? deriveMode(snap) : "autonomous";
  const autonomous = mode === "autonomous";
  const allowlist = snap ? allowlistFor(snap, "*") : [];

  const setMode = async (next: ExecMode) => {
    setSaving(true);
    setError(null);
    try {
      setSnap(await post({ action: "set-mode", mode: next }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const addPattern = async () => {
    if (!pattern.trim()) return;
    setAddingPattern(true);
    try {
      setSnap(await post({ action: "allowlist-add", pattern: pattern.trim(), agent: "*" }));
      setPattern("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddingPattern(false);
    }
  };

  const removePattern = async (p: string) => {
    try {
      setSnap(await post({ action: "allowlist-remove", pattern: p, agent: "*" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <SectionLayout>
      <SectionHeader
        title="Approvals"
        description="Decide how much your agents can do on their own — run freely, or ask before acting."
        actions={
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} aria-label="Refresh" title="Refresh">
            <RefreshCw className="size-4" />
          </Button>
        }
      />
      <SectionBody width="content">
        {loading ? (
          <ContentLoadingState />
        ) : (
          <div className="space-y-5">
            {/* Autonomous headline */}
            <div
              className={cn(
                "rounded-xl border p-5 transition-colors",
                autonomous ? "border-accent-brand-border bg-accent-brand-subtle/40" : "border-border bg-card",
              )}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      "flex size-10 shrink-0 items-center justify-center rounded-lg",
                      autonomous ? "bg-accent-brand-subtle text-accent-brand-text" : "bg-secondary text-fg-secondary",
                    )}
                  >
                    {autonomous ? <Zap className="size-5" /> : <ShieldCheck className="size-5" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-foreground">Autonomous mode</h2>
                      <Badge variant={autonomous ? "success" : "secondary"}>{autonomous ? "On" : "Off"}</Badge>
                    </div>
                    <p className="mt-1 max-w-lg text-xs leading-relaxed text-muted-foreground">
                      {autonomous
                        ? "Your agent runs tools and commands without stopping to ask. It never blocks waiting for approval — ideal for unattended cron and background work."
                        : "Your agent asks before running anything that isn't on the allowlist below. Safer, but it will pause and wait for you."}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={autonomous}
                  disabled={saving}
                  onCheckedChange={(v) => void setMode(v ? "autonomous" : "guarded")}
                  aria-label="Toggle autonomous mode"
                />
              </div>
              {autonomous && (
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  Full autonomy means the agent can run any command on this host. Use it when you trust the agent
                  and its inputs.
                </p>
              )}
              {saving && (
                <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Applying…
                </p>
              )}
            </div>

            {/* Effective policy */}
            {snap?.scopes?.length ? (
              <div className="rounded-xl border border-border bg-card p-5">
                <h3 className="text-sm font-semibold text-foreground">Effective policy</h3>
                <p className="mt-1 text-xs text-muted-foreground">{snap.note}</p>
                <dl className="mt-3 grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
                  {snap.scopes.map((s) => (
                    <div key={s.scopeLabel} className="contents">
                      <dt className="font-mono text-xs text-fg-subtle">{s.scopeLabel}</dt>
                      <dd className="flex flex-wrap gap-1.5">
                        <Badge variant="outline">mode: {s.mode?.effective ?? "—"}</Badge>
                        <Badge variant="outline">security: {s.security?.effective ?? "—"}</Badge>
                        <Badge variant="outline">ask: {s.ask?.effective ?? "—"}</Badge>
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : null}

            {/* Allowlist */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-fg-subtle" />
                <h3 className="text-sm font-semibold text-foreground">Allowlist</h3>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Commands matching these glob patterns run without asking, even in guarded mode. Example:{" "}
                <span className="font-mono">git *</span> or <span className="font-mono">npm run *</span>.
              </p>
              <div className="mt-3 flex gap-2">
                <Input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void addPattern()}
                  placeholder="e.g. git *"
                  className="font-mono"
                />
                <Button variant="outline" onClick={() => void addPattern()} disabled={addingPattern || !pattern.trim()}>
                  {addingPattern ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                  Add
                </Button>
              </div>
              {allowlist.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {allowlist.map((p) => (
                    <span
                      key={p}
                      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-1 font-mono text-xs text-fg-secondary"
                    >
                      {p}
                      <button
                        type="button"
                        onClick={() => void removePattern(p)}
                        className="text-fg-subtle hover:text-danger-fg"
                        aria-label={`Remove ${p}`}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-xs text-fg-subtle">No allowlist patterns yet.</p>
              )}
            </div>

            {error && (
              <p className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
                {error}
              </p>
            )}
          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
