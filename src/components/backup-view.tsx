"use client";

import { useCallback, useEffect, useState } from "react";
import { Archive, CheckCircle2, Copy, Loader2, ShieldCheck, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import type { BackupResult } from "@/lib/backup-types";

export function BackupView() {
  const [plan, setPlan] = useState<BackupResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<BackupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [verifyPath, setVerifyPath] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{ ok: boolean; raw: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/backup", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Failed to load backup plan");
      setPlan(body as BackupResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const body = await res.json();
      if (!res.ok || body?.ok === false) throw new Error(body?.error || "Backup failed");
      setCreated(body as BackupResult);
      if (body.archivePath) setVerifyPath(body.archivePath);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const verify = async () => {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch("/api/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", path: verifyPath }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Verify failed");
      setVerifyResult({ ok: Boolean(body.ok), raw: String(body.raw || "") });
    } catch (e) {
      setVerifyResult({ ok: false, raw: e instanceof Error ? e.message : String(e) });
    } finally {
      setVerifying(false);
    }
  };

  return (
    <SectionLayout>
      <SectionHeader
        title="Backup"
        description="Capture your whole OpenClaw state — config, credentials, sessions, and workspaces — into a single verifiable archive."
      />
      <SectionBody width="content">
        {loading ? (
          <ContentLoadingState />
        ) : (
          <div className="space-y-5">
            {/* Create */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-start gap-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-fg-secondary">
                  <Archive className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-sm font-semibold text-foreground">Create a backup</h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Writes a timestamped <span className="font-mono">.tar.gz</span> archive you can keep or move
                    somewhere safe. It includes sessions and workspaces, so it can be large — you'll get the full
                    path when it's done.
                  </p>
                  {plan && plan.included.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {plan.included.map((e) => (
                        <Badge key={e.label} variant="secondary" className="font-mono">
                          {e.label}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
                <Button onClick={() => void create()} disabled={creating}>
                  {creating ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
                  {creating ? "Backing up…" : "Create backup"}
                </Button>
              </div>

              {created && created.archivePath && (
                <div className="mt-4 space-y-2 rounded-lg border border-success-border bg-success-bg p-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-success-fg">
                    <CheckCircle2 className="size-4" /> Backup written
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-card/60 px-2 py-1 font-mono text-xs text-foreground">
                      {created.archivePath}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Copy path"
                      onClick={() => created.archivePath && navigator.clipboard?.writeText(created.archivePath)}
                    >
                      <Copy className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {/* Verify */}
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-fg-subtle" />
                <h2 className="text-sm font-semibold text-foreground">Verify an archive</h2>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Check that an archive and its embedded manifest are intact before you rely on it.
              </p>
              <div className="mt-3 flex gap-2">
                <Input
                  value={verifyPath}
                  onChange={(e) => setVerifyPath(e.target.value)}
                  placeholder="/path/to/…-openclaw-backup.tar.gz"
                  className="font-mono"
                />
                <Button variant="outline" onClick={() => void verify()} disabled={verifying || !verifyPath.trim()}>
                  {verifying ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                  Verify
                </Button>
              </div>
              {verifyResult && (
                <div
                  className={
                    verifyResult.ok
                      ? "mt-3 flex items-start gap-2 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-xs text-success-fg"
                      : "mt-3 flex items-start gap-2 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg"
                  }
                >
                  {verifyResult.ok ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <XCircle className="mt-0.5 size-3.5 shrink-0" />
                  )}
                  <span className="whitespace-pre-wrap break-words font-mono">{verifyResult.raw.trim() || (verifyResult.ok ? "Archive is valid." : "Archive failed verification.")}</span>
                </div>
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
