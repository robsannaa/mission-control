"use client";

/**
 * Web Search — split into two views, because the page does two unrelated
 * jobs:
 *   - "Try it": search, read results in place, save what's worth keeping.
 *     Where someone actually spends time, so it's the default.
 *   - "Configure": provider choice, keys, on/off. Visited rarely, usually
 *     once — set up and forgotten.
 *
 * Rebuilt around three outcomes, not settings:
 *   1. changes here genuinely land in OpenClaw's config (writes go through
 *      the same `/api/config` control plane every other settings pane uses,
 *      so the same rate limit, restart planning and conflict handling apply);
 *   2. there is a real search box that proves it, using the actual agent
 *      `web_search` tool through the live gateway, with a real "read the
 *      page" and "save it into memory" underneath each result;
 *   3. everything is described by what a person gets, not what the field is
 *      called — cost, whether a key is needed, what happens without one.
 *
 * The provider list only ever offers what this OpenClaw can really run: the
 * status API filters the full documented catalog down to plugins that are
 * actually installed (`openclaw plugins list --json`), because setting an
 * uninstalled provider is rejected by config validation outright — proven
 * live while building this page, not assumed from the docs.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  RefreshCw,
  Globe,
  ExternalLink,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { requestRestart } from "@/lib/restart-store";
import { SearchPlayground } from "@/components/search/search-playground";
import type { AuthKind, ProviderMeta } from "@/components/search/providers";

/* ── types ──────────────────────────────────────── */

type ProviderStatus = ProviderMeta & {
  installed: true;
  ready: boolean | null;
  keySource: string | null;
  keyPreview: string | null;
  note?: string;
};

type StatusResponse = {
  ok: boolean;
  enabled: boolean;
  activeProviderId: string | null;
  autoResolvedProviderId: string | null;
  providers: ProviderStatus[];
  uninstalledCount: number;
  degraded: boolean;
  baseHash: string;
  error?: string;
};

type Notice = { tone: "success" | "error" | "info"; text: string };
type ActiveView = "try" | "configure";

/* ── small local bits (match the Doctor page's shared vocabulary) ─────── */

function StatusDot({ tone }: { tone: "neutral" | "attention" | "positive" | "unknown" }) {
  const cls =
    tone === "positive"
      ? "bg-success"
      : tone === "attention"
        ? "bg-warning"
        : tone === "unknown"
          ? "bg-fg-placeholder"
          : "bg-fg-subtle";
  return <span className={cn("inline-block h-2 w-2 shrink-0 rounded-full", cls)} aria-hidden />;
}

function Pill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "attention" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium leading-none",
        tone === "attention"
          ? "border-warning-border bg-warning-bg text-warning-fg"
          : "border-border bg-muted text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

/**
 * Fully-pilled segmented control — hairline border, flat surface, no
 * shadow. "Try it" is the default tab: configuration is a one-time job,
 * search-and-save is where this page earns its keep.
 */
function ViewSwitcher({ active, onChange }: { active: ActiveView; onChange: (v: ActiveView) => void }) {
  const tabs: { key: ActiveView; label: string }[] = [
    { key: "try", label: "Try it" },
    { key: "configure", label: "Configure" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Web Search views"
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-card p-0.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            "rounded-full px-4 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            active === tab.key
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

/* ── provider row ───────────────────────────────── */

function ProviderRow({
  meta,
  selected,
  expanded,
  busy,
  draft,
  onDraftChange,
  onSelect,
  onSave,
  onCollapse,
}: {
  meta: ProviderStatus;
  selected: boolean;
  expanded: boolean;
  busy: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  onSelect: () => void;
  onSave: () => void;
  onCollapse: () => void;
}) {
  const needsInput = meta.authKind === "key" || meta.authKind === "baseUrl";
  const canActivateDirectly = !needsInput || meta.ready === true;

  return (
    <div
      className={cn(
        "rounded-xl border transition-colors",
        selected ? "border-border-strong bg-card" : "border-border-subtle bg-card/60",
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        disabled={busy || (selected && !expanded)}
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          !selected && "hover:bg-accent",
        )}
      >
        <span
          className={cn(
            "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
            selected ? "border-foreground" : "border-border-strong",
          )}
          aria-hidden
        >
          {selected && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium text-foreground">{meta.label}</span>
            <Pill>{meta.cost}</Pill>
            {meta.authKind === "key" && meta.ready === false && <Pill tone="attention">Needs a key</Pill>}
            {meta.authKind === "baseUrl" && meta.ready === false && <Pill tone="attention">Needs a server address</Pill>}
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{meta.tagline}</span>
          {meta.note && <span className="mt-1 block text-xs leading-relaxed text-fg-subtle">{meta.note}</span>}
          {meta.ready === true && meta.keySource && (
            <span className="mt-1 block text-xs text-fg-subtle">Key found in {meta.keySource}.</span>
          )}
        </span>

        {busy ? (
          <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          !canActivateDirectly && (
            <ChevronRight
              className={cn("mt-0.5 h-4 w-4 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-90")}
            />
          )
        )}
      </button>

      {expanded && needsInput && (
        <div className="border-t border-border-subtle px-4 py-3">
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">{meta.detail}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              type={meta.authKind === "baseUrl" ? "url" : "password"}
              value={draft}
              onChange={(e) => onDraftChange(e.target.value)}
              placeholder={meta.authKind === "baseUrl" ? "https://searx.example.com" : `Paste your ${meta.label} API key`}
              disabled={busy}
              autoFocus
              className="min-w-0 flex-1"
            />
            <div className="flex shrink-0 gap-2">
              <Button type="button" size="sm" onClick={onSave} disabled={busy || !draft.trim()}>
                {busy ? "Saving…" : "Save & use this"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCollapse} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── main view ──────────────────────────────────── */

export function WebSearchView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeView: ActiveView = searchParams.get("view") === "configure" ? "configure" : "try";

  const setActiveView = useCallback(
    (view: ActiveView) => {
      const params = new URLSearchParams(searchParams.toString());
      if (view === "try") params.delete("view");
      else params.set("view", view);
      const qs = params.toString();
      router.replace(qs ? `/search?${qs}` : "/search", { scroll: false });
    },
    [router, searchParams],
  );

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [togglingEnabled, setTogglingEnabled] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/search/web/status", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data?.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setStatus(data as StatusResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const friendlyError = useCallback((message: string) => {
    const lower = message.toLowerCase();
    if (lower.includes("rate limit")) return "OpenClaw is briefly limiting config changes. Wait a few seconds and try again.";
    if (lower.includes("invalid config")) return "OpenClaw rejected that change. Mission Control tried to repair the config automatically, but it still didn't take.";
    if (lower.includes("hash") || lower.includes("conflict")) return "This changed somewhere else at the same moment. Refreshing — please try again.";
    return message;
  }, []);

  const applyPatch = useCallback(
    async (patch: Record<string, unknown>, savingKey: string, successText: string) => {
      if (!status?.baseHash) {
        setNotice({ tone: "error", text: "Still loading — try again in a moment." });
        return false;
      }
      setSavingId(savingKey);
      setNotice(null);
      try {
        const res = await fetch("/api/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch, baseHash: status.baseHash }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        if (data.restartRequired) {
          requestRestart("Web search configuration changed.");
          setNotice({ tone: "info", text: "Saved. This needs OpenClaw to restart to take effect — restarting now." });
        } else {
          setNotice({ tone: "success", text: successText });
        }
        await load();
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setNotice({ tone: "error", text: friendlyError(msg) });
        return false;
      } finally {
        setSavingId(null);
      }
    },
    [status?.baseHash, load, friendlyError],
  );

  const selectedId = status?.activeProviderId ?? "auto";

  const handleSelect = useCallback(
    async (meta: ProviderStatus) => {
      const needsInput = meta.authKind === "key" || meta.authKind === "baseUrl";
      if (needsInput && meta.ready !== true) {
        setExpandedId((cur) => (cur === meta.id ? null : meta.id));
        return;
      }
      setExpandedId(null);
      await applyPatch(
        {
          tools: { web: { search: { provider: meta.id } } },
          plugins: { entries: { [meta.pluginId]: { enabled: true } } },
        },
        meta.id,
        `Switched to ${meta.label}. It's live — try a search below.`,
      );
    },
    [applyPatch],
  );

  const handleSelectAuto = useCallback(async () => {
    setExpandedId(null);
    await applyPatch(
      { tools: { web: { search: { provider: null } } } },
      "auto",
      "OpenClaw will now pick automatically. It's live — try a search below.",
    );
  }, [applyPatch]);

  const handleSaveDraft = useCallback(
    async (meta: ProviderStatus) => {
      const value = (drafts[meta.id] || "").trim();
      if (!value) return;
      const configField = meta.authKind === "baseUrl" ? { baseUrl: value } : { apiKey: value };
      const ok = await applyPatch(
        {
          plugins: { entries: { [meta.pluginId]: { enabled: true, config: { webSearch: configField } } } },
          tools: { web: { search: { provider: meta.id } } },
        },
        meta.id,
        `Saved and switched to ${meta.label}. Try a search below to make sure it works.`,
      );
      if (ok) {
        setExpandedId(null);
        setDrafts((d) => ({ ...d, [meta.id]: "" }));
      }
    },
    [applyPatch, drafts],
  );

  const handleToggleEnabled = useCallback(
    async (next: boolean) => {
      setTogglingEnabled(true);
      await applyPatch(
        { tools: { web: { search: { enabled: next } } } },
        "enabled",
        next ? "Web search turned on." : "Web search turned off.",
      );
      setTogglingEnabled(false);
    },
    [applyPatch],
  );

  const activeProviderMeta = useMemo(
    () => status?.providers.find((p) => p.id === status.activeProviderId) || null,
    [status],
  );

  const headline = useMemo(() => {
    if (!status) return { tone: "neutral" as const, text: "" };
    if (!status.enabled) {
      return { tone: "neutral" as const, text: "Web search is turned off." };
    }
    if (status.activeProviderId === null) {
      if (status.autoResolvedProviderId) {
        const label = status.providers.find((p) => p.id === status.autoResolvedProviderId)?.label;
        return { tone: "positive" as const, text: `Web search is on, automatically using ${label}.` };
      }
      return { tone: "attention" as const, text: "Web search is on, but nothing is set up to answer yet." };
    }
    if (activeProviderMeta?.ready === true) {
      return { tone: "positive" as const, text: `Web search is on, using ${activeProviderMeta.label}.` };
    }
    if (activeProviderMeta?.ready === false) {
      return { tone: "attention" as const, text: `Web search is set to ${activeProviderMeta.label}, but it's missing a key.` };
    }
    return { tone: "neutral" as const, text: `Web search is set to ${activeProviderMeta?.label ?? status.activeProviderId}.` };
  }, [status, activeProviderMeta]);

  const searchDisabled = !status || !status.enabled || (status.activeProviderId === null ? !status.autoResolvedProviderId : activeProviderMeta?.ready === false);
  const searchDisabledReason = !status
    ? null
    : !status.enabled
      ? "Web search is turned off. Switch to Configure to turn it on."
      : searchDisabled
        ? "No provider is ready yet. Switch to Configure to pick one."
        : null;

  const groups = useMemo(() => {
    const providers = status?.providers || [];
    return {
      free: providers.filter((p) => p.authKind === "keyless" || p.authKind === "connection"),
      keyed: providers.filter((p) => p.authKind === "key"),
      hosted: providers.filter((p) => p.authKind === "baseUrl"),
    };
  }, [status]);

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Globe className="h-5 w-5 text-fg-secondary dark:text-foreground" />
            Web Search
          </span>
        }
        description="Let your agent look things up on the web before it answers, instead of relying only on what it already knows."
        meta={null}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ViewSwitcher active={activeView} onChange={setActiveView} />
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-card"
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Refresh
            </button>
          </div>
        }
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-5 pb-16">
        {loading && !status ? (
          <ContentLoadingState />
        ) : error && !status ? (
          <div className="rounded-xl border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg">{error}</div>
        ) : status ? (
          activeView === "try" ? (
            <>
              {/* Compact status strip — full control lives in Configure; this tab
                  only needs enough context to explain why search might not work. */}
              <div className="flex flex-wrap items-center gap-2">
                <StatusDot tone={headline.tone} />
                <span className="text-sm text-foreground">{headline.text}</span>
                {headline.tone !== "positive" && (
                  <button
                    type="button"
                    onClick={() => setActiveView("configure")}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
                  >
                    Set up
                    <ChevronRight className="h-3 w-3" />
                  </button>
                )}
              </div>

              <SearchPlayground disabled={Boolean(searchDisabled)} disabledReason={searchDisabledReason} />
            </>
          ) : (
            <>
              {/* Status */}
              <div className="rounded-2xl border border-border bg-card p-5 md:p-6">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2">
                      <StatusDot tone={headline.tone} />
                      <span className="text-base font-medium text-foreground">{headline.text}</span>
                    </p>
                    <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
                      {status.enabled
                        ? "When it's on, your agent can pull in current information from the web as part of its answers."
                        : "Your agent will only use what it already knows — nothing is fetched from the web."}
                    </p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2.5">
                    <span className="text-sm text-muted-foreground">{status.enabled ? "On" : "Off"}</span>
                    <Switch
                      checked={status.enabled}
                      disabled={togglingEnabled}
                      onCheckedChange={(v) => void handleToggleEnabled(v)}
                    />
                  </label>
                </div>
              </div>

              {notice && (
                <div
                  className={cn(
                    "rounded-xl border px-4 py-3 text-sm",
                    notice.tone === "success"
                      ? "border-success-border bg-success-bg text-success-fg"
                      : notice.tone === "error"
                        ? "border-danger-border bg-danger-bg text-danger-fg"
                        : "border-info-border bg-info-bg text-info-fg",
                  )}
                >
                  {notice.text}
                </div>
              )}

              {/* Providers */}
              <div>
                <h2 className="text-sm font-semibold text-foreground">Who does the searching</h2>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Pick one. Some work right away; others need a key from that provider first.
                </p>

                <div className="mt-3 space-y-3">
                  <div
                    className={cn(
                      "rounded-xl border px-4 py-3",
                      selectedId === "auto" ? "border-border-strong bg-card" : "border-border-subtle bg-card/60",
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => void handleSelectAuto()}
                      disabled={savingId !== null || selectedId === "auto"}
                      className="flex w-full items-start gap-3 text-left"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
                          selectedId === "auto" ? "border-foreground" : "border-border-strong",
                        )}
                      >
                        {selectedId === "auto" && <span className="h-1.5 w-1.5 rounded-full bg-foreground" />}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-sm font-medium text-foreground">Let OpenClaw choose (recommended)</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {status.autoResolvedProviderId
                            ? `Right now that means ${status.providers.find((p) => p.id === status.autoResolvedProviderId)?.label}.`
                            : "Nothing is set up yet, so this won't answer until you add a key to one option below."}
                        </span>
                      </span>
                      {savingId === "auto" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />}
                    </button>
                  </div>

                  {groups.free.length > 0 && (
                    <div className="space-y-2">
                      <p className="eyebrow px-1">No setup needed</p>
                      <div className="space-y-2">
                        {groups.free.map((p) => (
                          <ProviderRow
                            key={p.id}
                            meta={p}
                            selected={selectedId === p.id}
                            expanded={expandedId === p.id}
                            busy={savingId === p.id}
                            draft={drafts[p.id] || ""}
                            onDraftChange={(v) => setDrafts((d) => ({ ...d, [p.id]: v }))}
                            onSelect={() => void handleSelect(p)}
                            onSave={() => void handleSaveDraft(p)}
                            onCollapse={() => setExpandedId(null)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {groups.keyed.length > 0 && (
                    <div className="space-y-2">
                      <p className="eyebrow px-1">Bring your own key</p>
                      <div className="space-y-2">
                        {groups.keyed.map((p) => (
                          <ProviderRow
                            key={p.id}
                            meta={p}
                            selected={selectedId === p.id}
                            expanded={expandedId === p.id}
                            busy={savingId === p.id}
                            draft={drafts[p.id] || ""}
                            onDraftChange={(v) => setDrafts((d) => ({ ...d, [p.id]: v }))}
                            onSelect={() => void handleSelect(p)}
                            onSave={() => void handleSaveDraft(p)}
                            onCollapse={() => setExpandedId(null)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {groups.hosted.length > 0 && (
                    <div className="space-y-2">
                      <p className="eyebrow px-1">Self-hosted</p>
                      <div className="space-y-2">
                        {groups.hosted.map((p) => (
                          <ProviderRow
                            key={p.id}
                            meta={p}
                            selected={selectedId === p.id}
                            expanded={expandedId === p.id}
                            busy={savingId === p.id}
                            draft={drafts[p.id] || ""}
                            onDraftChange={(v) => setDrafts((d) => ({ ...d, [p.id]: v }))}
                            onSelect={() => void handleSelect(p)}
                            onSave={() => void handleSaveDraft(p)}
                            onCollapse={() => setExpandedId(null)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {status.uninstalledCount > 0 && (
                  <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
                    {status.uninstalledCount} more provider{status.uninstalledCount === 1 ? "" : "s"} (like Brave or
                    Exa) exist but need an extra install step on this OpenClaw before they can show up here.
                  </p>
                )}
                {status.degraded && (
                  <p className="mt-2 text-xs leading-relaxed text-warning-fg">
                    Mission Control couldn&rsquo;t check which providers are installed just now, so this list may be
                    incomplete.
                  </p>
                )}
              </div>

              <a
                href="https://docs.openclaw.ai/tools/web"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <ExternalLink className="h-3 w-3" />
                Read OpenClaw&rsquo;s web search documentation
              </a>
            </>
          )
        ) : null}
      </SectionBody>
    </SectionLayout>
  );
}
