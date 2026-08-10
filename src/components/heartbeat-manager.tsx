"use client";

/**
 * Heartbeat: a scheduled check-in your agent runs on its own, so you find out
 * about things that need you without asking every few minutes yourself.
 *
 * This component is deliberately thin — it fetches, holds draft state, and
 * wires actions to `/api/heartbeat`. The actual page is composed from
 * `src/components/heartbeat/*`, each piece named for what a person sees, not
 * for the config path it edits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";
import { GetStartedCard } from "@/components/heartbeat/get-started-card";
import { ScheduleCard } from "@/components/heartbeat/schedule-card";
import { WakeNowCard } from "@/components/heartbeat/wake-now-card";
import { AdvancedSection } from "@/components/heartbeat/advanced-section";
import { HeartbeatSkeleton } from "@/components/heartbeat/skeleton";
import {
  buildHeartbeatConfig,
  emptyForm,
  formatErrorMessage,
  isTurnedOff,
  parseEditorState,
  pretty,
} from "@/components/heartbeat/lib";
import type {
  ChannelOption,
  EditorState,
  HeartbeatApiState,
  HeartbeatEvent,
  ModelOption,
  Toast,
} from "@/components/heartbeat/types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type RawModelRow = { key: string; name: string; local: boolean; available: boolean };

function parseModelRows(payload: unknown): RawModelRow[] {
  const rows = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  return rows
    .filter(isRecord)
    .map((row) => {
      const key = typeof row.key === "string" ? row.key : "";
      if (!key) return null;
      return {
        key,
        name: typeof row.name === "string" && row.name.trim() ? row.name : key,
        local: row.local === true,
        available: row.available === true,
      } satisfies RawModelRow;
    })
    .filter((row): row is RawModelRow => Boolean(row));
}

function parseChannelOptions(payload: unknown): ChannelOption[] {
  const rows = isRecord(payload) && Array.isArray(payload.channels) ? payload.channels : [];
  return rows
    .filter(isRecord)
    .filter((row) => {
      const channel = typeof row.channel === "string" ? row.channel.trim() : "";
      if (!channel) return false;
      const enabled = row.enabled === true;
      const configured = row.configured === true;
      const accounts = Array.isArray(row.accounts) ? row.accounts.length : 0;
      const statuses = Array.isArray(row.statuses) ? row.statuses : [];
      const hasLiveStatus = statuses.some(
        (s) => isRecord(s) && (s.connected === true || typeof s.status === "string")
      );
      return enabled && (configured || accounts > 0 || hasLiveStatus);
    })
    .map((row) => ({
      value: String(row.channel).trim(),
      label:
        typeof row.label === "string" && row.label.trim()
          ? row.label.trim()
          : String(row.channel).trim(),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function HeartbeatManager() {
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [data, setData] = useState<HeartbeatApiState | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [degraded, setDegraded] = useState(false);

  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [channelOptions, setChannelOptions] = useState<ChannelOption[]>([]);
  const [lastEvent, setLastEvent] = useState<HeartbeatEvent>(null);

  const [defaultsEditor, setDefaultsEditor] = useState<EditorState>({
    form: emptyForm(),
    extras: {},
    activeHoursExtras: {},
    extrasJson: "",
  });
  const [agentEditors, setAgentEditors] = useState<Record<string, EditorState>>({});
  const [visibilityEditor, setVisibilityEditor] = useState("");

  const [wakeMode, setWakeMode] = useState<"now" | "next-heartbeat">("now");
  const [wakeText, setWakeText] = useState("");

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const justSavedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCadenceRef = useRef("30m");

  const flash = useCallback((message: string, type: "success" | "error") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const flashSaved = useCallback(() => {
    if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
    setJustSaved(true);
    justSavedTimer.current = setTimeout(() => setJustSaved(false), 3200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (justSavedTimer.current) clearTimeout(justSavedTimer.current);
    };
  }, []);

  const hydrateEditors = useCallback((payload: HeartbeatApiState) => {
    const editor = parseEditorState(payload.defaultsHeartbeat);
    setDefaultsEditor(editor);
    if (payload.defaultsHeartbeat && !isTurnedOff(editor.form.every || "30m")) {
      lastCadenceRef.current = editor.form.every || "30m";
    }
    const nextAgents: Record<string, EditorState> = {};
    for (const agent of payload.agents || []) {
      nextAgents[agent.id] = parseEditorState(agent.heartbeat);
    }
    setAgentEditors(nextAgents);
    setVisibilityEditor(pretty(payload.visibility || { defaults: null, channels: {} }));
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setWarning(null);
    setDegraded(false);
    try {
      const [heartbeatRes, modelsStatusRes, modelsAllRes, channelsRes] = await Promise.allSettled([
        fetch("/api/heartbeat", { cache: "no-store" }),
        fetch("/api/models?scope=status", { cache: "no-store" }),
        fetch("/api/models?scope=all", { cache: "no-store" }),
        fetch("/api/channels", { cache: "no-store" }),
      ]);

      const warnings: string[] = [];
      let isDegraded = false;

      if (heartbeatRes.status !== "fulfilled") {
        throw new Error("Could not reach Mission Control's server.");
      }
      const payload = (await heartbeatRes.value.json()) as HeartbeatApiState & { warning?: unknown };
      if (!heartbeatRes.value.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${heartbeatRes.value.status}`);
      }
      if (typeof payload.warning === "string" && payload.warning.trim()) {
        warnings.push(payload.warning.trim());
      }
      if (payload.degraded) isDegraded = true;
      setData(payload);
      hydrateEditors(payload);

      let statusPayload: unknown = null;
      let allPayload: unknown = null;
      if (modelsStatusRes.status === "fulfilled") {
        statusPayload = await modelsStatusRes.value.json().catch(() => null);
      } else {
        warnings.push("Could not load available models.");
        isDegraded = true;
      }
      if (modelsAllRes.status === "fulfilled") {
        allPayload = await modelsAllRes.value.json().catch(() => null);
      } else {
        warnings.push("Could not load the full model catalog.");
        isDegraded = true;
      }
      const statusRows = parseModelRows(statusPayload);
      const allRows = parseModelRows(allPayload).filter((row) => row.local);
      const merged = new Map<string, RawModelRow>();
      for (const row of [...statusRows, ...allRows]) {
        const prev = merged.get(row.key);
        merged.set(row.key, prev ? { ...prev, local: prev.local || row.local } : row);
      }
      setModelOptions(
        [...merged.values()]
          .map((row) => {
            const tags = [row.local && "local", row.available && "available"].filter(Boolean);
            return {
              value: row.key,
              label: `${row.name}${tags.length ? ` · ${tags.join(", ")}` : ""}`,
            };
          })
          .sort((a, b) => a.label.localeCompare(b.label))
      );

      if (channelsRes.status === "fulfilled") {
        const channelsPayload = await channelsRes.value.json().catch(() => null);
        setChannelOptions(parseChannelOptions(channelsPayload));
      } else {
        warnings.push("Could not load connected apps.");
        isDegraded = true;
      }

      setWarning(warnings.length > 0 ? warnings.join(" · ") : null);
      setDegraded(isDegraded);
    } catch (err) {
      const message = formatErrorMessage(err);
      setWarning(message);
      setDegraded(true);
      flash(message, "error");
    } finally {
      setLoading(false);
    }
  }, [flash, hydrateEditors]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const isConfiguredForLastEvent = Boolean(
    data && (data.defaultsHeartbeat || data.agents.some((a) => a.heartbeat))
  );

  // Fetched separately and lazily: this one hits the OpenClaw CLI under the
  // hood and can take a couple of seconds, so it must never hold up the main
  // page. It is also only useful before heartbeat is configured — the proof
  // that "this is already running, it just has nowhere to send things" — so
  // there's no reason to fetch it once a real schedule exists.
  useEffect(() => {
    if (!data || isConfiguredForLastEvent) return;
    let cancelled = false;
    fetch("/api/heartbeat/last-event", { cache: "no-store" })
      .then((res) => res.json())
      .then((payload) => {
        if (!cancelled && isRecord(payload) && payload.ok) {
          setLastEvent((payload.lastEvent as HeartbeatEvent) ?? null);
        }
      })
      .catch(() => {
        // Purely decorative — the empty state reads fine without it.
      });
    return () => {
      cancelled = true;
    };
  }, [data, isConfiguredForLastEvent]);

  const runSave = useCallback(
    async (busy: string, body: Record<string, unknown>, successMessage?: string) => {
      setBusyKey(busy);
      try {
        const res = await fetch("/api/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await res.json()) as HeartbeatApiState & { error?: string };
        if (!res.ok || payload.ok === false) {
          throw new Error(payload.error || `HTTP ${res.status}`);
        }
        setData(payload);
        hydrateEditors(payload);
        if (successMessage) flash(successMessage, "success");
        return true;
      } catch (err) {
        flash(formatErrorMessage(err), "error");
        return false;
      } finally {
        setBusyKey(null);
      }
    },
    [flash, hydrateEditors]
  );

  const persistDefaults = useCallback(
    async (editorOverride?: EditorState, successMessage?: string) => {
      const editor = editorOverride || defaultsEditor;
      try {
        const heartbeat = buildHeartbeatConfig(editor);
        const ok = await runSave("save-defaults", { action: "save-defaults", heartbeat });
        if (ok) {
          if (successMessage) flash(successMessage, "success");
          else flashSaved();
        }
      } catch (err) {
        flash(formatErrorMessage(err), "error");
      }
    },
    [defaultsEditor, flash, flashSaved, runSave]
  );

  const activateFromScratch = useCallback(
    async (opts: { every: string; target: string }) => {
      setBusyKey("activate");
      try {
        const heartbeat: Record<string, unknown> = { every: opts.every || "30m" };
        if (opts.target && opts.target !== "none") heartbeat.target = opts.target;
        else heartbeat.target = "none";
        const ok = await runSave("save-defaults", { action: "save-defaults", heartbeat });
        if (ok) flash("Heartbeat is on.", "success");
      } finally {
        setBusyKey(null);
      }
    },
    [flash, runSave]
  );

  const toggleHeartbeat = useCallback(() => {
    const currentlyOn = !isTurnedOff(defaultsEditor.form.every || "30m");
    if (currentlyOn) {
      lastCadenceRef.current = defaultsEditor.form.every || "30m";
    }
    const nextEvery = currentlyOn ? "0m" : lastCadenceRef.current || "30m";
    const nextEditor: EditorState = {
      ...defaultsEditor,
      form: { ...defaultsEditor.form, every: nextEvery },
    };
    setDefaultsEditor(nextEditor);
    void persistDefaults(nextEditor, currentlyOn ? "Heartbeat is off." : "Heartbeat is on.");
  }, [defaultsEditor, persistDefaults]);

  const saveAgent = useCallback(
    async (agentId: string) => {
      const editor = agentEditors[agentId];
      if (!editor) return;
      try {
        const heartbeat = buildHeartbeatConfig(editor);
        await runSave(
          `save-agent:${agentId}`,
          { action: "save-agent", agentId, heartbeat },
          "Custom schedule saved."
        );
      } catch (err) {
        flash(formatErrorMessage(err), "error");
      }
    },
    [agentEditors, flash, runSave]
  );

  const clearAgent = useCallback(
    (agentId: string) => {
      void runSave(
        `clear-agent:${agentId}`,
        { action: "save-agent", agentId, heartbeat: null },
        "Back to the main schedule."
      );
    },
    [runSave]
  );

  const saveVisibility = useCallback(async () => {
    try {
      const parsed = JSON.parse(visibilityEditor) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Must be a JSON object");
      }
      await runSave(
        "save-visibility",
        { action: "save-visibility", visibility: parsed },
        "Visibility settings saved."
      );
    } catch (err) {
      flash(formatErrorMessage(err), "error");
    }
  }, [flash, runSave, visibilityEditor]);

  const formatVisibilityJson = useCallback(() => {
    try {
      setVisibilityEditor(pretty(JSON.parse(visibilityEditor) as unknown));
    } catch (err) {
      flash(formatErrorMessage(err), "error");
    }
  }, [flash, visibilityEditor]);

  const wakeNow = useCallback(async () => {
    setBusyKey("wake-now");
    try {
      const res = await fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "wake-now",
          mode: wakeMode,
          text: wakeText.trim() || "Check for urgent follow-ups",
        }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      flash(
        wakeMode === "now" ? "Checking in now." : "It'll check at the next scheduled run.",
        "success"
      );
    } catch (err) {
      flash(formatErrorMessage(err), "error");
    } finally {
      setBusyKey(null);
    }
  }, [flash, wakeMode, wakeText]);

  const sortedAgents = useMemo(() => {
    if (!data?.agents) return [];
    return [...data.agents].sort((a, b) => a.name.localeCompare(b.name));
  }, [data]);

  const channelLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const opt of channelOptions) map.set(opt.value, opt.label);
    return map;
  }, [channelOptions]);

  const isConfigured = useMemo(() => {
    if (!data) return false;
    return Boolean(data.defaultsHeartbeat) || data.agents.some((a) => Boolean(a.heartbeat));
  }, [data]);

  const isOn = !isTurnedOff(defaultsEditor.form.every || "30m");

  if (loading && !data) {
    return <HeartbeatSkeleton />;
  }

  if (!data) {
    return (
      <div className="rounded-2xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
        Couldn&rsquo;t load heartbeat settings. Try refreshing the page.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div
          className={`flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-sm ${
            toast.type === "success"
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-danger-border bg-danger-bg text-danger-fg"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span>{toast.message}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <ApiWarningBadge warning={warning} degraded={degraded} />
        {data.docsUrl && (
          <a
            href={data.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-control border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
          >
            Docs
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <button
          type="button"
          onClick={() => void fetchAll()}
          disabled={Boolean(busyKey)}
          className="inline-flex items-center gap-1 rounded-control border border-border px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </button>
      </div>

      {isConfigured ? (
        <ScheduleCard
          editor={defaultsEditor}
          onChange={setDefaultsEditor}
          isOn={isOn}
          onToggle={toggleHeartbeat}
          channelOptions={channelOptions}
          channelLabels={channelLabels}
          onSave={() => void persistDefaults()}
          busy={busyKey === "save-defaults"}
          justSaved={justSaved}
        />
      ) : (
        <GetStartedCard
          lastEvent={lastEvent}
          channelOptions={channelOptions}
          busy={busyKey === "activate"}
          onActivate={(opts) => void activateFromScratch(opts)}
        />
      )}

      <WakeNowCard
        mode={wakeMode}
        onModeChange={setWakeMode}
        text={wakeText}
        onTextChange={setWakeText}
        onTrigger={() => void wakeNow()}
        busy={busyKey === "wake-now"}
      />

      <AdvancedSection
        defaultsEditor={defaultsEditor}
        onDefaultsChange={setDefaultsEditor}
        agents={sortedAgents}
        agentEditors={agentEditors}
        onAgentChange={(agentId, next) =>
          setAgentEditors((prev) => ({ ...prev, [agentId]: next }))
        }
        onAgentSave={(agentId) => void saveAgent(agentId)}
        onAgentClear={(agentId) => clearAgent(agentId)}
        channelOptions={channelOptions}
        modelOptions={modelOptions}
        visibilityJson={visibilityEditor}
        onVisibilityChange={setVisibilityEditor}
        onVisibilitySave={() => void saveVisibility()}
        onVisibilityFormat={formatVisibilityJson}
        busy={Boolean(busyKey)}
      />
    </div>
  );
}
