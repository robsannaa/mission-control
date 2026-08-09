"use client";

import { useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Eye,
  EyeOff,
  KeyRound,
  ListMinus,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Shield,
  Variable,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock, useFocusTrap } from "@/hooks/use-modal-accessibility";
import {
  formatConfigValue,
  maskSecret,
  type ChangeEntry,
  type ChangeKind,
  type RestartPlan,
} from "./config-changes";

/**
 * "Exactly what will change" — the confirmation step before any config write.
 *
 * Every touched path is listed with its old and new value, removals first.
 * Secrets are masked until the operator asks to see them, values that resolve
 * from the environment are called out so nobody bakes `${VAR}` into its
 * expansion, and a restart is announced with its real consequence rather than
 * a generic warning.
 */

const KIND_META: Record<
  ChangeKind,
  { label: string; icon: typeof Plus; className: string; badge: string }
> = {
  removed: {
    label: "Removed",
    icon: Minus,
    className: "text-red-700 dark:text-red-300",
    badge:
      "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
  },
  changed: {
    label: "Changed",
    icon: Pencil,
    className: "text-amber-700 dark:text-amber-300",
    badge:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  added: {
    label: "Added",
    icon: Plus,
    className: "text-emerald-700 dark:text-emerald-300",
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
};

const ORDER: ChangeKind[] = ["removed", "changed", "added"];

function ValueChip({
  value,
  masked,
  tone,
}: {
  value: unknown;
  masked: boolean;
  tone: "before" | "after";
}) {
  const text = masked ? maskSecret(value) : formatConfigValue(value);
  return (
    <code
      className={cn(
        "inline-block max-w-full break-all rounded border px-1.5 py-0.5 font-mono text-xs",
        value === undefined
          ? "border-dashed border-foreground/15 text-muted-foreground/60"
          : tone === "before"
            ? "border-stone-200 bg-stone-50 text-stone-600 line-through decoration-stone-400/60 dark:border-[#2c343d] dark:bg-[#15191d] dark:text-[#a8b0ba]"
            : "border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200"
      )}
    >
      {text}
    </code>
  );
}

function ChangeRow({ entry, reveal }: { entry: ChangeEntry; reveal: boolean }) {
  const masked = entry.sensitive && !reveal;
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  return (
    <li
      data-testid="config-diff-row"
      data-change-path={entry.path}
      data-change-kind={entry.kind}
      className="flex gap-2.5 border-b border-foreground/5 px-4 py-2.5 last:border-b-0"
    >
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", meta.className)} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <code className="font-mono text-xs font-medium text-foreground/90">{entry.path}</code>
          {entry.sensitive && (
            <span title="Secret value" className="inline-flex items-center">
              <Shield className="h-3 w-3 text-amber-500" />
            </span>
          )}
          {entry.reloadKind === "restart" && (
            <span className="rounded border border-orange-500/30 bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-orange-700 dark:text-orange-300">
              restarts gateway
            </span>
          )}
          {entry.envSubstituted && (
            <span className="inline-flex items-center gap-1 rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
              <Variable className="h-2.5 w-2.5" />
              from environment
            </span>
          )}
          {entry.replaceConfirm && (
            <span className="inline-flex items-center gap-1 rounded border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:text-red-300">
              <ListMinus className="h-2.5 w-2.5" />
              list entries removed
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ValueChip value={entry.before} masked={masked} tone="before" />
          <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
          <ValueChip value={entry.after} masked={masked} tone="after" />
        </div>
      </div>
    </li>
  );
}

export function ConfigDiffPreview({
  open,
  entries,
  restart,
  authTokenMint,
  replacePaths,
  saving,
  savingLabel,
  onBack,
  onConfirm,
}: {
  open: boolean;
  entries: ChangeEntry[];
  restart: RestartPlan;
  authTokenMint: boolean;
  replacePaths: string[];
  saving: boolean;
  savingLabel?: string;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const [reveal, setReveal] = useState(false);
  const containerRef = useFocusTrap(open);
  useBodyScrollLock(open);

  if (!open) return null;

  const counts = {
    removed: entries.filter((e) => e.kind === "removed").length,
    changed: entries.filter((e) => e.kind === "changed").length,
    added: entries.filter((e) => e.kind === "added").length,
  };
  const hasSecrets = entries.some((e) => e.sensitive);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Review configuration changes"
    >
      <div
        ref={containerRef}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-2xl dark:border-[#2c343d] dark:bg-[#171a1d]"
      >
        {/* Header */}
        <div className="flex shrink-0 items-start gap-3 border-b border-foreground/10 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">
              Review {entries.length} change{entries.length === 1 ? "" : "s"}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Only these paths are sent to OpenClaw. Everything else stays exactly as it is.
            </p>
          </div>
          {hasSecrets && (
            <button
              type="button"
              onClick={() => setReveal((v) => !v)}
              className={cn(
                "flex shrink-0 items-center gap-1 rounded border px-2 py-1 text-xs transition-colors",
                reveal
                  ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                  : "border-foreground/10 text-muted-foreground hover:bg-muted/80"
              )}
            >
              {reveal ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {reveal ? "Hide secrets" : "Reveal secrets"}
            </button>
          )}
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to editing"
            className="shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Counters */}
        <div className="flex shrink-0 flex-wrap gap-1.5 border-b border-foreground/5 px-5 py-2.5">
          {ORDER.map((kind) =>
            counts[kind] > 0 ? (
              <span
                key={kind}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-xs font-medium",
                  KIND_META[kind].badge
                )}
              >
                {counts[kind]} {KIND_META[kind].label.toLowerCase()}
              </span>
            ) : null
          )}
        </div>

        {/* Warnings */}
        <div className="shrink-0 space-y-2 px-5 py-3 empty:hidden">
          {restart.required && (
            <div className="rounded-lg border border-orange-500/30 bg-orange-500/10 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-orange-800 dark:text-orange-200">
                <RefreshCw className="h-3.5 w-3.5" />
                The gateway will restart when you save
              </p>
              <p className="mt-1 text-xs leading-relaxed text-orange-800/90 dark:text-orange-200/90">
                {restart.paths.join(", ")} {restart.paths.length === 1 ? "needs" : "need"} a
                restart to take effect. Agents stop briefly, and if you are connected over the
                network you may be disconnected and have to reconnect.
                {restart.inferred &&
                  " (Reload behaviour for at least one path came from the documented reload table, not from the gateway itself.)"}
              </p>
            </div>
          )}
          {authTokenMint && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-red-800 dark:text-red-200">
                <KeyRound className="h-3.5 w-3.5" />
                A brand-new gateway access token will be generated
              </p>
              <p className="mt-1 text-xs leading-relaxed text-red-800/90 dark:text-red-200/90">
                Switching authentication to <code className="font-mono">token</code> without an
                existing token makes the server mint one. Every client using the old credentials —
                including other Mission Control sessions and any CLI — has to be given the new
                token before it can connect again.
              </p>
            </div>
          )}
          {replacePaths.length > 0 && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/5 px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-red-800 dark:text-red-200">
                <ListMinus className="h-3.5 w-3.5" />
                Entries will be removed from {replacePaths.length} list
                {replacePaths.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 font-mono text-xs leading-relaxed text-red-800/90 dark:text-red-200/90">
                {replacePaths.join(", ")}
              </p>
              <p className="mt-1 text-xs text-red-800/80 dark:text-red-200/80">
                Saving confirms the removal to the gateway. It cannot be undone from here.
              </p>
            </div>
          )}
          {restart.unknownPaths.length > 0 && !restart.required && (
            <div className="rounded-lg border border-foreground/10 bg-muted/50 px-3 py-2">
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Reload behaviour is still unknown for {restart.unknownPaths.length} path
                {restart.unknownPaths.length === 1 ? "" : "s"}, so a restart cannot be ruled out.
              </p>
            </div>
          )}
        </div>

        {/* Change list */}
        <div className="min-h-0 flex-1 overflow-y-auto border-t border-foreground/5">
          {entries.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-muted-foreground">
              Nothing to save — the draft matches the saved configuration.
            </p>
          ) : (
            <ul>
              {entries.map((entry) => (
                <ChangeRow key={entry.path} entry={entry} reveal={reveal} />
              ))}
            </ul>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-foreground/10 px-5 py-3">
          <button
            type="button"
            onClick={onBack}
            className="rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving || entries.length === 0}
            data-testid="config-diff-confirm"
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? (savingLabel ?? "Saving…") : "Save changes"}
          </button>
        </div>
      </div>
    </div>
  );
}
