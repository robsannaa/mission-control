"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { LoadingState, ContentLoadingState } from "@/components/ui/loading-state";

/* ── types ─────────────────────────────────────── */

type Hook = {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  enabled: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  events: string[];
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
};

type HooksData = {
  hooks: Hook[];
  hooksInternalEnabled: boolean;
  warning?: string;
  degraded?: boolean;
};

type HookDetail = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  emoji?: string;
  homepage?: string;
  events: string[];
  enabled: boolean;
  eligible: boolean;
  always: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
};

/* ── helpers ───────────────────────────────────── */

const EVENT_COLORS: Record<string, string> = {
  "command:new": "border-border-strong bg-muted-foreground/10 text-fg-secondary",
  "command:reset": "border-danger-border bg-danger-bg text-danger-fg",
  "command:stop": "border-danger-border bg-danger-bg text-danger-fg",
  command: "border-border-strong bg-muted-foreground/10 text-fg-secondary",
  "agent:bootstrap": "border-info-border bg-info-bg text-info-fg",
  "gateway:startup": "border-success-border bg-success-bg text-success-fg",
  "message:received": "border-warning-border bg-warning-bg text-warning-fg",
  "message:sent": "border-warning-border bg-warning-bg text-warning-fg",
  message: "border-warning-border bg-warning-bg text-warning-fg",
  tool_result_persist: "border-success-border bg-success-bg text-success-fg",
};

const SOURCE_LABELS: Record<string, string> = {
  bundled: "Bundled",
  workspace: "Workspace",
  managed: "Managed",
  plugin: "Plugin",
};

function hasMissingReqs(m: Hook["missing"]): boolean {
  return (
    (m.bins?.length || 0) > 0 ||
    (m.anyBins?.length || 0) > 0 ||
    (m.env?.length || 0) > 0 ||
    (m.config?.length || 0) > 0 ||
    (m.os?.length || 0) > 0
  );
}

function missingList(m: Hook["missing"]): string[] {
  const items: string[] = [];
  if (m.bins?.length) items.push(...m.bins.map((b) => `bin: ${b}`));
  if (m.anyBins?.length) items.push(`any of: ${m.anyBins.join(", ")}`);
  if (m.env?.length) items.push(...m.env.map((e) => `env: ${e}`));
  if (m.config?.length) items.push(...m.config.map((c) => `config: ${c}`));
  if (m.os?.length) items.push(`os: ${m.os.join(", ")}`);
  return items;
}

/* ── ui blocks ──────────────────────────────────── */

function Toggle({
  checked,
  onChange,
  disabled,
  size = "md",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}) {
  const dims = size === "sm" ? "h-4 w-7" : "h-5 w-9";
  const knob = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  const translate = size === "sm" ? "left-3.5" : "left-4";
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative shrink-0 rounded-full transition-colors duration-200",
        dims,
        checked ? "bg-success" : "bg-muted",
        disabled && "opacity-50 cursor-not-allowed",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 block rounded-full bg-card shadow-sm transition-transform duration-200",
          knob,
          checked ? translate : "left-0.5",
        )}
      />
    </button>
  );
}

function EventBadge({ event }: { event: string }) {
  const color = EVENT_COLORS[event] || "border-foreground/10 bg-foreground/[0.04] text-muted-foreground";
  return (
    <span className={cn("rounded-md border px-1.5 py-0.5 text-[10px] font-medium", color)}>
      {event}
    </span>
  );
}

function SourceBadge({ source, bundled }: { source: string; bundled: boolean }) {
  const label = bundled ? "Bundled" : SOURCE_LABELS[source] || source;
  return (
    <span
      className={cn(
        "rounded-md border px-1.5 py-0.5 text-[10px] font-medium",
        bundled
          ? "border-info-border bg-info-bg text-info-fg"
          : "border-foreground/10 bg-foreground/[0.04] text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function HookCard({
  hook,
  onToggle,
  onSelect,
  toggling,
}: {
  hook: Hook;
  onToggle: (name: string, enabled: boolean) => void;
  onSelect: (name: string) => void;
  toggling: string | null;
}) {
  const missing = hasMissingReqs(hook.missing);
  const isToggling = toggling === hook.name;
  return (
    <div
      className={cn(
        "glass-glow rounded-lg px-4 py-3.5 transition-colors",
        hook.enabled
          ? "border-success-border"
          : missing
            ? "border-warning-border"
            : "",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          onClick={() => onSelect(hook.name)}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex items-center gap-2">
            {hook.emoji && <span className="text-sm">{hook.emoji}</span>}
            <span className="text-sm font-semibold text-foreground">{hook.name}</span>
            <SourceBadge source={hook.source} bundled={hook.bundled} />
          </div>
          <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{hook.description}</p>
        </button>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {isToggling ? (
            <span className="flex items-center gap-0.5">
              <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:300ms]" />
            </span>
          ) : (
            <Toggle
              checked={hook.enabled}
              onChange={(v) => onToggle(hook.name, v)}
              disabled={!!toggling}
            />
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {hook.events?.map((e) => <EventBadge key={e} event={e} />)}
      </div>

      {missing && (
        <div className="mt-2 rounded-lg border border-warning-border bg-warning-bg px-2.5 py-1.5">
          <p className="text-[10px] font-medium uppercase tracking-wider text-warning-fg">
            Missing requirements
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {missingList(hook.missing).map((m) => (
              <span
                key={m}
                className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning-fg"
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function HookDetailPanel({
  detail,
  onClose,
}: {
  detail: HookDetail;
  onClose: () => void;
}) {
  const missing = hasMissingReqs(detail.missing);
  return (
    <div className="glass rounded-lg p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            {detail.emoji && <span className="text-lg">{detail.emoji}</span>}
            <h3 className="text-sm font-semibold text-foreground">{detail.name}</h3>
            {detail.enabled && (
              <span className="rounded-md border border-success-border bg-success-bg px-1.5 py-0.5 text-[10px] font-medium text-success-fg">
                enabled
              </span>
            )}
            {detail.always && (
              <span className="rounded-md border border-border-strong bg-muted-foreground/10 px-1.5 py-0.5 text-[10px] font-medium text-fg-secondary">
                always
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{detail.description}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-foreground/10 px-2.5 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        >
          Close
        </button>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="glass-subtle rounded-lg p-3">
          <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">Source</p>
          <p className="mt-1 text-xs text-foreground">{detail.bundled ? "Bundled" : detail.source}</p>
        </div>
        <div className="glass-subtle rounded-lg p-3">
          <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">Eligible</p>
          <p className={cn("mt-1 text-xs", detail.eligible ? "text-success-fg" : "text-warning-fg")}>
            {detail.eligible ? "Yes" : "No"}
          </p>
        </div>
        {detail.filePath && (
          <div className="sm:col-span-2 glass-subtle rounded-lg p-3">
            <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">File Path</p>
            <p className="mt-1 truncate text-xs font-mono text-fg-secondary">{detail.filePath}</p>
          </div>
        )}
      </div>

      <div className="mt-3">
        <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">Events</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {detail.events?.map((e) => <EventBadge key={e} event={e} />) || (
            <span className="text-xs text-fg-subtle">None</span>
          )}
        </div>
      </div>

      {(detail.requirements?.bins?.length > 0 ||
        detail.requirements?.anyBins?.length > 0 ||
        detail.requirements?.env?.length > 0 ||
        detail.requirements?.config?.length > 0 ||
        detail.requirements?.os?.length > 0) && (
        <div className="mt-3">
          <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">Requirements</p>
          <div className="mt-1.5 space-y-1 text-xs text-fg-secondary">
            {detail.requirements.bins?.length > 0 && (
              <p>Binaries: <span className="font-mono">{detail.requirements.bins.join(", ")}</span></p>
            )}
            {detail.requirements.anyBins?.length > 0 && (
              <p>Any of: <span className="font-mono">{detail.requirements.anyBins.join(", ")}</span></p>
            )}
            {detail.requirements.env?.length > 0 && (
              <p>Environment: <span className="font-mono">{detail.requirements.env.join(", ")}</span></p>
            )}
            {detail.requirements.config?.length > 0 && (
              <p>Config: <span className="font-mono">{detail.requirements.config.join(", ")}</span></p>
            )}
            {detail.requirements.os?.length > 0 && (
              <p>OS: <span className="font-mono">{detail.requirements.os.join(", ")}</span></p>
            )}
          </div>
        </div>
      )}

      {missing && (
        <div className="mt-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-warning-fg">
            Missing requirements
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {missingList(detail.missing).map((m) => (
              <span
                key={m}
                className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-[10px] text-warning-fg"
              >
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {detail.homepage && (
        <div className="mt-3">
          <a
            href={detail.homepage}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-fg-secondary underline underline-offset-2 hover:text-fg-secondary"
          >
            Documentation
          </a>
        </div>
      )}
    </div>
  );
}

/* ── main view ─────────────────────────────────── */

export function HooksView() {
  const [data, setData] = useState<HooksData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [togglingSystem, setTogglingSystem] = useState(false);
  const [enablingAll, setEnablingAll] = useState(false);
  const [selectedHook, setSelectedHook] = useState<string | null>(null);
  const [hookDetail, setHookDetail] = useState<HookDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "enabled" | "disabled">("all");
  const [toast, setToast] = useState<{ message: string; type: "ok" | "err" } | null>(null);

  const showToast = useCallback((message: string, type: "ok" | "err") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/hooks", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as HooksData;
      setData(json);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const fetchDetail = useCallback(async (name: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/hooks?action=info&name=${encodeURIComponent(name)}`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as HookDetail;
      setHookDetail(json);
    } catch {
      setHookDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const handleSelect = useCallback(
    (name: string) => {
      if (selectedHook === name) {
        setSelectedHook(null);
        setHookDetail(null);
      } else {
        setSelectedHook(name);
        void fetchDetail(name);
      }
    },
    [selectedHook, fetchDetail],
  );

  const handleToggle = useCallback(
    async (name: string, enabled: boolean) => {
      setToggling(name);
      try {
        const res = await fetch("/api/hooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: enabled ? "enable-hook" : "disable-hook",
            name,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        showToast(`${name} ${enabled ? "enabled" : "disabled"}`, "ok");
        await fetchData();
        if (selectedHook === name) void fetchDetail(name);
      } catch (err) {
        showToast(`Failed: ${err}`, "err");
      } finally {
        setToggling(null);
      }
    },
    [fetchData, fetchDetail, selectedHook, showToast],
  );

  const handleToggleSystem = useCallback(
    async (enabled: boolean) => {
      setTogglingSystem(true);
      try {
        const res = await fetch("/api/hooks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "toggle-system", enabled }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        showToast(`Hooks system ${enabled ? "enabled" : "disabled"}`, "ok");
        await fetchData();
      } catch (err) {
        showToast(`Failed: ${err}`, "err");
      } finally {
        setTogglingSystem(false);
      }
    },
    [fetchData, showToast],
  );

  const handleEnableAll = useCallback(async () => {
    if (!data?.hooks?.length) return;
    setEnablingAll(true);
    try {
      const names = data.hooks.map((h) => h.name);
      const res = await fetch("/api/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "enable-all", names }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      showToast(`All ${names.length} hooks enabled`, "ok");
      await fetchData();
    } catch (err) {
      showToast(`Failed: ${err}`, "err");
    } finally {
      setEnablingAll(false);
    }
  }, [data, fetchData, showToast]);

  const filteredHooks = useMemo(() => {
    if (!data?.hooks) return [];
    if (filter === "enabled") return data.hooks.filter((h) => h.enabled);
    if (filter === "disabled") return data.hooks.filter((h) => !h.enabled);
    return data.hooks;
  }, [data, filter]);

  const stats = useMemo(() => {
    if (!data?.hooks) return { total: 0, enabled: 0, disabled: 0, eligible: 0 };
    return {
      total: data.hooks.length,
      enabled: data.hooks.filter((h) => h.enabled).length,
      disabled: data.hooks.filter((h) => !h.enabled).length,
      eligible: data.hooks.filter((h) => h.eligible).length,
    };
  }, [data]);

  if (loading) {
    return (
      <SectionLayout>
        <ContentLoadingState size="lg" />
      </SectionLayout>
    );
  }

  if (error || !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <p className="text-sm">Failed to load hooks</p>
        <button
          type="button"
          onClick={() => {
            setLoading(true);
            void fetchData();
          }}
          className="rounded-lg border border-foreground/10 bg-card px-3 py-1.5 text-xs text-foreground hover:bg-muted"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title="Hooks"
        description="Event-driven automations for commands, agents, gateway, and messages."
        actions={
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              void fetchData();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
          >
            Refresh
          </button>
        }
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-4 pb-8">
        {/* Toast */}
        {toast && (
          <div
            className={cn(
              "fixed bottom-4 right-4 z-50 rounded-lg border px-4 py-2.5 text-xs font-medium shadow-lg transition-all",
              toast.type === "ok"
                ? "border-success-border bg-success-bg text-success-fg"
                : "border-danger-border bg-danger-bg text-danger-fg",
            )}
          >
            {toast.message}
          </div>
        )}

        {/* Degraded warning */}
        {data.degraded && (
          <div className="rounded-lg border border-warning-border bg-warning-bg px-4 py-2.5 text-xs text-warning-fg">
            {data.warning || "Could not reach gateway — showing cached data."}
          </div>
        )}

        {/* System toggle + stats */}
        <div className="glass rounded-lg p-5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-xs font-sans font-semibold text-foreground">Hooks Engine</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Master switch for the internal hooks system. When disabled, no hooks fire.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {togglingSystem ? (
                <span className="flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground/50 [animation-delay:300ms]" />
                </span>
              ) : (
                <Toggle
                  checked={data.hooksInternalEnabled}
                  onChange={handleToggleSystem}
                />
              )}
              <span className={cn(
                "text-xs font-medium",
                data.hooksInternalEnabled ? "text-success-fg" : "text-fg-subtle",
              )}>
                {data.hooksInternalEnabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="glass-subtle rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">Total</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{stats.total}</p>
            </div>
            <div className="rounded-lg border border-success-border bg-success-bg px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase tracking-widest text-success-fg">Enabled</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-success-fg">{stats.enabled}</p>
            </div>
            <div className="glass-subtle rounded-lg px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase tracking-widest text-fg-subtle">Disabled</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{stats.disabled}</p>
            </div>
            <div className="rounded-lg border border-info-border bg-info-bg px-3 py-2.5">
              <p className="text-[10px] font-medium uppercase tracking-widest text-info-fg">Eligible</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-info-fg">{stats.eligible}</p>
            </div>
          </div>

          {/* Enable All button */}
          {stats.disabled > 0 && (
            <div className="mt-4">
              <button
                type="button"
                onClick={handleEnableAll}
                disabled={enablingAll || !!toggling}
                className={cn(
                  "rounded-lg border px-4 py-2 text-xs font-medium transition-colors",
                  enablingAll
                    ? "border-foreground/10 bg-foreground/5 text-muted-foreground cursor-wait"
                    : "border-success-border bg-success-bg text-success-fg hover:bg-success-bg",
                )}
              >
                {enablingAll ? "Enabling all..." : `Enable all ${stats.total} hooks`}
              </button>
            </div>
          )}
        </div>

        {/* Filter tabs */}
        <div className="inline-flex rounded-lg border border-border bg-muted p-1">
          {(["all", "enabled", "disabled"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 capitalize",
                filter === f
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {f} {f === "all" ? `(${stats.total})` : f === "enabled" ? `(${stats.enabled})` : `(${stats.disabled})`}
            </button>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-12">
          <div className={cn(selectedHook ? "xl:col-span-7" : "xl:col-span-12")}>
            {filteredHooks.length === 0 ? (
              <div className="glass rounded-lg p-8 text-center">
                <p className="text-sm text-muted-foreground">
                  {filter === "all"
                    ? "No hooks discovered. Install hooks or check your gateway."
                    : `No ${filter} hooks.`}
                </p>
              </div>
            ) : (
              <div className="space-y-2.5">
                {filteredHooks.map((hook) => (
                  <HookCard
                    key={hook.name}
                    hook={hook}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                    toggling={toggling}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Detail panel */}
          {selectedHook && (
            <div className="xl:col-span-5">
              {detailLoading ? (
                <div className="glass rounded-lg p-8">
                  <LoadingState size="sm" />
                </div>
              ) : hookDetail ? (
                <HookDetailPanel
                  detail={hookDetail}
                  onClose={() => {
                    setSelectedHook(null);
                    setHookDetail(null);
                  }}
                />
              ) : (
                <div className="glass rounded-lg p-8 text-center">
                  <p className="text-xs text-muted-foreground">Could not load hook details.</p>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedHook(null);
                      setHookDetail(null);
                    }}
                    className="mt-2 text-xs text-fg-secondary underline underline-offset-2 hover:text-fg-secondary"
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </SectionBody>
    </SectionLayout>
  );
}
