"use client";

import { useCallback, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ChevronDown,
  ChevronUp,
  Clock,
  DollarSign,
  ExternalLink,
  RefreshCw,
  TrendingUp,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { InlineSpinner } from "@/components/ui/loading-state";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { getFriendlyModelName, getProviderDisplayName } from "@/lib/model-metadata";
import type {
  ProviderBillingFreshness,
  ProviderBillingProviderSnapshot,
  UsageApiResponse,
  UsageWindow,
} from "@/lib/usage-types";

/* ── Formatters ─────────────────────────────────── */

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

function formatUsd(usd: number | null): string {
  if (usd === null) return "—";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function formatAge(ms: number | null): string {
  if (ms === null) return "unknown";
  const ageMs = Date.now() - ms;
  if (ageMs < 60_000) return "just now";
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`;
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`;
  return `${Math.floor(ageMs / 86_400_000)}d ago`;
}

/* ── Window config ──────────────────────────────── */

const WINDOWS: { id: UsageWindow; label: string }[] = [
  { id: "last1h", label: "Last Hour" },
  { id: "last24h", label: "Last 24h" },
  { id: "last7d", label: "Last 7 Days" },
  { id: "allTime", label: "All Time" },
];

/* ── Skeleton ───────────────────────────────────── */

function SkeletonBox({ className }: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-xl bg-muted", className)} />
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      {/* Hero stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <SkeletonBox key={i} className="h-28 border border-border" />
        ))}
      </div>
      {/* Table skeletons */}
      <SkeletonBox className="h-64 border border-border" />
      <SkeletonBox className="h-48 border border-border" />
    </div>
  );
}

/* ── Freshness dot ──────────────────────────────── */

function FreshnessDot({ freshness }: { freshness: ProviderBillingFreshness }) {
  return (
    <span className="relative flex h-2 w-2 shrink-0">
      {freshness === "fresh" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-40" />
      )}
      <span
        className={cn(
          "relative inline-flex h-2 w-2 rounded-full",
          freshness === "fresh"
            ? "bg-success"
            : freshness === "stale"
              ? "bg-warning"
              : "bg-border-strong",
        )}
      />
    </span>
  );
}

function ProviderLogo({ provider, name }: { provider: string; name: string }) {
  const cls = "h-5 w-5";
  if (provider === "openrouter") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    );
  }
  if (provider === "openai") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" />
      </svg>
    );
  }
  if (provider === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" className={cls} fill="currentColor">
        <path d="M13.827 3.52h3.603L24 20.48h-3.603l-6.57-16.96zm-7.258 0h3.767L16.906 20.48h-3.674l-1.343-3.461H5.017l-1.344 3.46H0l6.569-16.96zm2.327 5.093L6.453 14.58h4.886L8.896 8.613z" />
      </svg>
    );
  }
  return <span className="text-sm font-bold">{name.charAt(0).toUpperCase()}</span>;
}

/* ── Section sub-heading ────────────────────────── */

function SubHeading({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">{children}</h2>
      {count !== undefined && (
        <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[11px] font-medium text-fg-subtle">
          {count}
        </span>
      )}
    </div>
  );
}

/* ── Progress bar ───────────────────────────────── */

function ProgressBar({ value, max, className }: { value: number; max: number; className?: string }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-secondary", className)}>
      <div
        className="h-full rounded-full bg-success transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/* ── Hero stat card ─────────────────────────────── */

type StatCardProps = {
  label: string;
  value: string;
  sub?: string;
};

function StatCard({ label, value, sub }: StatCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">{label}</span>
      <div>
        <p className="text-2xl font-bold tracking-tight text-foreground">{value}</p>
        {sub && <p className="mt-1 text-[11px] text-fg-subtle">{sub}</p>}
      </div>
    </div>
  );
}

/* ── Window pill switcher ───────────────────────── */

function WindowSelector({
  active,
  onChange,
}: {
  active: UsageWindow;
  onChange: (w: UsageWindow) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-lg border border-border bg-muted p-1">
      {WINDOWS.map((w) => (
        <button
          key={w.id}
          type="button"
          onClick={() => onChange(w.id)}
          className={cn(
            "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
            active === w.id
              ? "bg-secondary text-foreground shadow-sm"
              : "text-fg-subtle hover:text-muted-foreground",
          )}
        >
          {w.label}
        </button>
      ))}
    </div>
  );
}

/* ── Empty state ────────────────────────────────── */

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-10 text-center">
      <BarChart3 className="h-8 w-8 text-fg-placeholder" />
      <p className="text-sm text-fg-subtle">{message}</p>
    </div>
  );
}

/* ── Token Usage by Model table ─────────────────── */

type ModelRow = UsageApiResponse["liveTelemetry"]["byModel"][number];

function ModelUsageTable({ rows }: { rows: ModelRow[] }) {
  const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
  const maxTokens = sorted[0]?.totalTokens ?? 1;

  if (sorted.length === 0) return <EmptyState message="No model usage recorded yet." />;

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border bg-muted text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
            <th className="px-4 py-2.5 text-left">Model</th>
            <th className="hidden px-4 py-2.5 text-right sm:table-cell">Sessions</th>
            <th className="whitespace-nowrap px-4 py-2.5 text-right">Input</th>
            <th className="whitespace-nowrap px-4 py-2.5 text-right">Output</th>
            <th className="whitespace-nowrap px-4 py-2.5 text-right">Est. Cost (Local)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((row) => {
            const friendly = getFriendlyModelName(row.fullModel);
            const provider = getProviderDisplayName(row.provider);
            return (
              <tr
                key={row.fullModel}
                className="transition-colors hover:bg-muted"
              >
                <td className="min-w-0 px-4 py-3">
                  <p className="truncate text-sm font-medium text-foreground">{friendly}</p>
                  <p className="mt-0.5 truncate text-[11px] text-fg-subtle">{provider}</p>
                  <ProgressBar
                    value={row.totalTokens}
                    max={maxTokens}
                    className="mt-1.5 max-w-[200px]"
                  />
                </td>
                <td className="hidden px-4 py-3 text-right text-sm text-muted-foreground sm:table-cell">
                  {formatNumber(row.sessions)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                  {formatCompact(row.inputTokens)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-muted-foreground">
                  {formatCompact(row.outputTokens)}
                </td>
                <td className="px-4 py-3 text-right font-mono text-xs text-success-fg">
                  {formatUsd(row.estimatedCostUsd)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Token Usage by Agent table ─────────────────── */

type AgentRow = UsageApiResponse["liveTelemetry"]["byAgent"][number];

function AgentUsageTable({ rows }: { rows: AgentRow[] }) {
  const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
  const maxTokens = sorted[0]?.totalTokens ?? 1;

  if (sorted.length === 0) return <EmptyState message="No agent usage recorded yet." />;

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-4 border-b border-border bg-muted px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        <span>Agent</span>
        <span className="text-right">Sessions</span>
        <span className="text-right">Total Tokens</span>
        <span className="text-right">Est. Cost</span>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border">
        {sorted.map((row) => (
          <div
            key={row.agentId}
            className="group grid grid-cols-[1fr_auto_auto_auto] items-center gap-x-4 px-4 py-3 transition-colors hover:bg-muted"
          >
            <div className="min-w-0">
              <p className="truncate font-mono text-sm text-foreground">{row.agentId}</p>
              <ProgressBar
                value={row.totalTokens}
                max={maxTokens}
                className="mt-1.5 max-w-[200px]"
              />
            </div>
            <span className="text-right text-sm text-muted-foreground">{formatNumber(row.sessions)}</span>
            <span className="text-right font-mono text-xs text-muted-foreground">
              {formatCompact(row.totalTokens)}
            </span>
            <span className="text-right font-mono text-xs text-success-fg">
              {formatUsd(row.estimatedCostUsd)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Provider Billing card ───────────────────────── */

function ProviderBillingCard({
  p,
  onCredentialSaved,
}: {
  p: ProviderBillingProviderSnapshot;
  onCredentialSaved?: () => void;
}) {
  const [credentialDraft, setCredentialDraft] = useState("");
  const [teamIdDraft, setTeamIdDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveOk, setSaveOk] = useState<string | null>(null);
  const displayName = getProviderDisplayName(p.provider);
  const statusLabel = !p.available
    ? "Setup needed"
    : p.billingMode === "estimate_only"
      ? "Estimate only"
      : p.rows.length === 0
        ? "No invoice rows yet"
        : "Invoice-grade";

  const statusTone = !p.available
    ? "border-warning-border bg-warning-bg text-warning-fg"
    : p.billingMode === "estimate_only"
      ? "border-info-border bg-info-bg text-info-fg"
      : p.rows.length === 0
        ? "border-border-strong bg-muted-foreground/10 text-fg-secondary"
        : "border-success-border bg-success-bg text-success-fg";

  const guidance = !p.available
    ? p.reason || "Billing collector is not configured."
    : p.reason || p.setupHint;

  const secondaryCredentialKey = p.provider === "xai" ? "XAI_TEAM_ID" : null;

  async function saveCredentials() {
    if (!p.requiredCredential || !credentialDraft.trim()) {
      setSaveError(`Enter ${p.requiredCredential || "credential"} first.`);
      return;
    }
    if (secondaryCredentialKey && !teamIdDraft.trim()) {
      setSaveError(`Enter ${secondaryCredentialKey} first.`);
      return;
    }

    setSaving(true);
    setSaveError(null);
    setSaveOk(null);
    try {
      const values: Record<string, string> = {
        [p.requiredCredential]: credentialDraft.trim(),
      };
      if (secondaryCredentialKey) {
        values[secondaryCredentialKey] = teamIdDraft.trim();
      }
      const res = await fetch(`/api/usage/providers/${p.provider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-credentials", values }),
        signal: AbortSignal.timeout(12000),
      });
      const data = await res.json();
      if (!data.ok) {
        throw new Error(String(data.error || "Failed to save credentials"));
      }
      setCredentialDraft("");
      setTeamIdDraft("");
      setSaveOk("Saved. Usage collectors will refresh shortly.");
      onCredentialSaved?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save credentials");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-4">
      {/* Avatar */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-secondary text-muted-foreground">
          <ProviderLogo provider={p.provider} name={displayName} />
        </div>

      {/* Name + freshness */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <FreshnessDot freshness={p.freshness} />
            <span className="text-sm font-semibold text-foreground">{displayName}</span>
            <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-medium", statusTone)}>
              {statusLabel}
            </span>
          </div>
          <p className="mt-0.5 text-[11px] text-fg-subtle">
            Updated{" "}
            {p.latestBucketStartMs !== null ? formatAge(p.latestBucketStartMs) : "never"}
          </p>
        </div>

        {/* Spend columns */}
        <div className="hidden gap-6 sm:flex">
          <div className="text-right">
            <p className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
              Current Month
            </p>
            <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
              {formatUsd(p.currentMonthUsd)}
            </p>
          </div>
          <div className="text-right">
            <p className="text-[10px] font-medium uppercase tracking-wide text-fg-subtle">
              Last 30 Days
            </p>
            <p className="mt-0.5 font-mono text-sm font-semibold text-foreground">
              {formatUsd(p.totalUsd30d)}
            </p>
          </div>
        </div>

        {/* Mobile spend */}
        <div className="flex flex-col items-end gap-0.5 sm:hidden">
          <p className="font-mono text-sm font-semibold text-foreground">
            {formatUsd(p.currentMonthUsd)}
          </p>
          <p className="text-[10px] text-fg-subtle">this month</p>
        </div>
      </div>

      {(guidance || (!p.available && p.requiredCredential) || p.docsUrl) && (
        <div className="rounded-lg border border-border bg-background px-3 py-2.5">
          {guidance && <p className="text-xs text-muted-foreground">{guidance}</p>}
          {!p.available && p.requiredCredential && (
            <p className="mt-1.5 text-xs text-warning-fg">
              Add <code className="font-mono">{p.requiredCredential}</code> to unlock real provider billing.
            </p>
          )}
          {p.docsUrl && (
            <a
              href={p.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-flex items-center gap-1 text-xs text-foreground hover:underline"
            >
              Provider billing docs
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
          <p className="mt-1 text-[11px] text-fg-subtle">
            Billing mode: {p.billingMode === "invoice_api" ? "Invoice API" : "Estimate only"}
          </p>

          {!p.available && p.requiredCredential && (
            <div className="mt-2 space-y-2">
              <input
                type="password"
                value={credentialDraft}
                onChange={(e) => setCredentialDraft(e.target.value)}
                placeholder={`Enter ${p.requiredCredential}`}
                disabled={saving}
                className="w-full rounded-md border border-border bg-muted px-2.5 py-2 text-xs text-foreground placeholder:text-fg-subtle focus:border-success-border/40 focus:outline-none"
              />
              {secondaryCredentialKey && (
                <input
                  type="text"
                  value={teamIdDraft}
                  onChange={(e) => setTeamIdDraft(e.target.value)}
                  placeholder={`Enter ${secondaryCredentialKey}`}
                  disabled={saving}
                  className="w-full rounded-md border border-border bg-muted px-2.5 py-2 text-xs text-foreground placeholder:text-fg-subtle focus:border-success-border/40 focus:outline-none"
                />
              )}
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => {
                    void saveCredentials();
                  }}
                  disabled={saving}
                  className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-60"
                >
                  {saving ? "Saving..." : "Save credential"}
                </button>
              </div>
              {saveError && <p className="text-xs text-danger-fg">{saveError}</p>}
              {saveOk && <p className="text-xs text-success-fg">{saveOk}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Estimated Spend by Model table ─────────────── */

type SpendRow = UsageApiResponse["estimatedSpend"]["byModel"][number];

function EstimatedSpendTable({ rows }: { rows: SpendRow[] }) {
  const sorted = [...rows]
    .filter((r) => r.usd !== null)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  if (sorted.length === 0) return <EmptyState message="No spend data available." />;

  const maxUsd = sorted[0]?.usd ?? 1;

  return (
    <div className="overflow-hidden rounded-xl border border-border">
      {/* Header */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-4 border-b border-border bg-muted px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle">
        <span>Model</span>
        <span className="text-right">Coverage</span>
        <span className="text-right">Est. Spend</span>
      </div>

      {/* Rows */}
      <div className="divide-y divide-border">
        {sorted.map((row) => {
          const friendly = getFriendlyModelName(row.fullModel);
          return (
            <div
              key={row.fullModel}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 px-4 py-3 transition-colors hover:bg-muted"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{friendly}</p>
                <ProgressBar
                  value={row.usd ?? 0}
                  max={maxUsd}
                  className="mt-1.5 max-w-[200px]"
                />
              </div>
              <span className="text-right text-xs text-fg-subtle">
                {row.coveragePct > 0 ? `${Math.round(row.coveragePct)}%` : "—"}
              </span>
              <span className="text-right font-mono text-sm font-semibold text-success-fg">
                {formatUsd(row.usd)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Diagnostics panel ──────────────────────────── */

function DiagnosticsPanel({
  warnings,
  sourceErrors,
}: {
  warnings: string[];
  sourceErrors: Array<{ source: string; error: string }>;
}) {
  const [open, setOpen] = useState(false);
  const total = warnings.length + sourceErrors.length;
  if (total === 0) return null;

  return (
    <div className="rounded-xl border border-warning-border bg-warning-bg">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning-fg" />
        <span className="flex-1 text-sm font-medium text-warning-fg">
          {total} diagnostic{total !== 1 ? "s" : ""} detected
        </span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-warning-fg" />
        ) : (
          <ChevronDown className="h-4 w-4 text-warning-fg" />
        )}
      </button>

      {open && (
        <div className="space-y-2 border-t border-warning-border px-4 pb-4 pt-3">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-warning-fg">
                warn
              </span>
              <p className="text-xs text-muted-foreground">{w}</p>
            </div>
          ))}
          {sourceErrors.map((e, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-danger-fg">
                error
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-fg-secondary">{e.source}</p>
                <p className="text-xs text-muted-foreground">{e.error}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Refresh button ─────────────────────────────── */

function RefreshButton({
  loading,
  onClick,
}: {
  loading: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground disabled:opacity-50"
    >
      {loading ? <InlineSpinner /> : <RefreshCw className="h-3.5 w-3.5" />}
      Refresh
    </button>
  );
}

/* ── Main view ──────────────────────────────────── */

export function UsageView() {
  const [data, setData] = useState<UsageApiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeWindow, setActiveWindow] = useState<UsageWindow>("last24h");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/usage", { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return;
      const json: UsageApiResponse = await res.json();
      setData(json);
    } catch {
      // Silently ignore — next poll will retry
    } finally {
      setLoading(false);
    }
  }, []);

  useSmartPoll(fetchData, { intervalMs: 30_000 });

  /* Derived data */
  const totals = data?.liveTelemetry.totals;
  const windowBucket = data?.liveTelemetry.windows[activeWindow];
  const windowSpend = data?.estimatedSpend.windows[activeWindow];
  const byModel = data?.liveTelemetry.byModel ?? [];
  const byAgent = data?.liveTelemetry.byAgent ?? [];
  const configuredBillingProviders = new Set(
    (data?.providerBilling.configuredProviders ?? []).map((provider) => provider.toLowerCase()),
  );
  const providerBillingRows = (data?.providerBilling.providers ?? []).filter((provider) =>
    configuredBillingProviders.has(provider.provider.toLowerCase()),
  );
  const spendByModel = data?.estimatedSpend.byModel ?? [];
  const diagnostics = data?.diagnostics;
  const providerInvoiceCurrentMonthUsd = providerBillingRows.reduce(
    (sum, provider) => sum + (provider.currentMonthUsd ?? 0),
    0,
  );
  const hasProviderInvoiceTotals = providerBillingRows.some((provider) => provider.currentMonthUsd !== null);
  const headlineCostUsd = hasProviderInvoiceTotals
    ? providerInvoiceCurrentMonthUsd
    : data?.estimatedSpend.totalUsd ?? null;
  const hasWindowActivity = Boolean(
    windowBucket &&
      (windowBucket.sessions > 0 ||
        windowBucket.totalTokens > 0 ||
        windowBucket.inputTokens > 0 ||
        windowBucket.outputTokens > 0),
  );
  const showingWindowFallback = !hasWindowActivity;
  const displayWindowSessions = hasWindowActivity
    ? (windowBucket?.sessions ?? 0)
    : (totals?.sessions ?? 0);
  const displayWindowTotalTokens = hasWindowActivity
    ? (windowBucket?.totalTokens ?? 0)
    : (totals?.totalTokens ?? 0);
  const displayWindowInputTokens = hasWindowActivity
    ? (windowBucket?.inputTokens ?? 0)
    : (totals?.inputTokens ?? 0);
  const displayWindowOutputTokens = hasWindowActivity
    ? (windowBucket?.outputTokens ?? 0)
    : (totals?.outputTokens ?? 0);

  const asOf = data?.asOfMs ?? null;

  return (
    <SectionLayout>
      <SectionHeader
        title="Usage"
        description="Token consumption, estimated spend, and provider billing."
        meta={asOf ? `As of ${formatAge(asOf)}` : undefined}
        bordered
        actions={<RefreshButton loading={loading} onClick={() => void fetchData()} />}
      />

      <SectionBody width="wide" padding="regular">
        {data === null ? (
          <LoadingSkeleton />
        ) : (
          <div className="space-y-8">

            {/* ── Hero stat cards ── */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Total Tokens"
                value={totals ? formatCompact(totals.totalTokens) : "—"}
                sub={
                  totals
                    ? `${formatCompact(totals.inputTokens)} in / ${formatCompact(totals.outputTokens)} out`
                    : undefined
                }
              />
              <StatCard
                label={hasProviderInvoiceTotals ? "Current Month Cost" : "Estimated Cost"}
                value={formatUsd(headlineCostUsd)}
                sub={
                  hasProviderInvoiceTotals
                    ? `Provider invoice totals (${providerBillingRows.filter((provider) => provider.currentMonthUsd !== null).length})`
                    : data.coverage.estimatedPricingCoveragePct > 0
                      ? `${Math.round(data.coverage.estimatedPricingCoveragePct)}% coverage`
                      : "No pricing data — subscription auth doesn't expose costs"
                }
              />
              <StatCard
                label="Sessions"
                value={totals ? formatNumber(totals.sessions) : "—"}
                sub={totals ? `${formatNumber(totals.agents)} agent${totals.agents !== 1 ? "s" : ""}` : undefined}
              />
              <StatCard
                label="Active Models"
                value={totals ? formatNumber(totals.models) : "—"}
                sub={byModel.length > 0 ? `Across ${new Set(byModel.map((m) => m.provider)).size} provider${new Set(byModel.map((m) => m.provider)).size !== 1 ? "s" : ""}` : undefined}
              />
            </div>

            {/* ── Time window + window stats ── */}
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <SubHeading>
                  <span className="flex items-center gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    Usage Window
                  </span>
                </SubHeading>
                <WindowSelector active={activeWindow} onChange={setActiveWindow} />
              </div>
              <p className="text-xs text-muted-foreground">
                Window stats are local telemetry estimates and may differ from provider invoices.
              </p>

              {windowBucket && (
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <div className="rounded-xl border border-border bg-card p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
                      Sessions
                    </p>
                    <p className="mt-1 text-lg font-bold text-foreground">
                      {formatNumber(displayWindowSessions)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
                      Total Tokens
                    </p>
                    <p className="mt-1 text-lg font-bold text-foreground">
                      {formatCompact(displayWindowTotalTokens)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
                      Input Tokens
                    </p>
                    <p className="mt-1 text-lg font-bold text-foreground">
                      {formatCompact(displayWindowInputTokens)}
                    </p>
                  </div>
                  <div className="rounded-xl border border-border bg-card p-3">
                    <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
                      Output Tokens
                    </p>
                    <p className="mt-1 text-lg font-bold text-foreground">
                      {formatCompact(displayWindowOutputTokens)}
                    </p>
                  </div>
                  {windowSpend?.usd !== null && windowSpend !== undefined && (
                    <div className="col-span-2 rounded-xl border border-border bg-card p-3 sm:col-span-4">
                      <div className="flex items-center justify-between">
                        <p className="text-[10px] font-medium uppercase tracking-wider text-fg-subtle">
                          Estimated Spend
                        </p>
                        {windowSpend.coveragePct > 0 && (
                          <span className="rounded-full border border-border bg-secondary px-2 py-0.5 text-[10px] text-fg-subtle">
                            {Math.round(windowSpend.coveragePct)}% coverage
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-lg font-bold text-success-fg">
                        {formatUsd(windowSpend.usd)}
                      </p>
                    </div>
                  )}
                </div>
              )}
              {showingWindowFallback && (
                <p className="text-xs text-muted-foreground">
                  No recent activity in this time window yet. Showing overall totals instead.
                </p>
              )}
            </div>

            {/* ── Token Usage by Model ── */}
            <div>
              <SubHeading count={byModel.length}>
                <span className="flex items-center gap-1.5">
                  <BarChart3 className="h-3.5 w-3.5" />
                  Token Usage by Model
                </span>
              </SubHeading>
              <p className="mb-2 text-xs text-muted-foreground">
                Costs in this table are estimated from local usage, not invoice-grade billing.
              </p>
              <ModelUsageTable rows={byModel} />
            </div>

            {/* ── Token Usage by Agent ── */}
            <div>
              <SubHeading count={byAgent.length}>
                <span className="flex items-center gap-1.5">
                  <Users className="h-3.5 w-3.5" />
                  Token Usage by Agent
                </span>
              </SubHeading>
              <AgentUsageTable rows={byAgent} />
            </div>

            {/* ── Provider Billing ── */}
            {providerBillingRows.length > 0 && (
              <div>
                <SubHeading count={providerBillingRows.length}>
                  <span className="flex items-center gap-1.5">
                    <DollarSign className="h-3.5 w-3.5" />
                    Provider Billing
                  </span>
                </SubHeading>
                <div className="space-y-2">
                  {providerBillingRows.map((p) => (
                    <ProviderBillingCard
                      key={p.provider}
                      p={p}
                      onCredentialSaved={() => {
                        void fetchData();
                      }}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Estimated Spend by Model ── */}
            {spendByModel.length > 0 && (
              <div>
                <SubHeading>
                  <span className="flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5" />
                    Estimated Spend by Model
                  </span>
                </SubHeading>
                <EstimatedSpendTable rows={spendByModel} />
              </div>
            )}

            {/* ── Diagnostics ── */}
            {diagnostics && (
              <DiagnosticsPanel
                warnings={diagnostics.warnings}
                sourceErrors={diagnostics.sourceErrors}
              />
            )}

          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
