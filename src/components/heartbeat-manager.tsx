"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Heart,
  Play,
  RefreshCw,
  Save,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { requestRestart } from "@/lib/restart-store";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";

type JsonObject = Record<string, unknown>;
type TriState = "" | "true" | "false";

type HeartbeatAgent = {
  id: string;
  name: string;
  heartbeat: JsonObject | null;
};

type VisibilityPayload = {
  defaults: JsonObject | null;
  channels: Record<
    string,
    { heartbeat: JsonObject | null; accounts: Record<string, JsonObject | null> }
  >;
};

type HeartbeatPayload = {
  ok: boolean;
  docsUrl: string;
  defaultsHeartbeat: JsonObject | null;
  effectiveDefaultsHeartbeat: JsonObject | null;
  agents: HeartbeatAgent[];
  visibility: VisibilityPayload;
  stats: {
    agentsTotal: number;
    agentsWithOverrides: number;
    channelsWithOverrides: number;
  };
  error?: string;
};

type Toast = { type: "success" | "error"; message: string };

type HeartbeatForm = {
  every: string;
  model: string;
  prompt: string;
  target: string;
  to: string;
  askFirst: TriState;
  showSleepStatus: TriState;
  showNoMessageStatus: TriState;
  showMessage: TriState;
  showThinking: TriState;
  showModelName: TriState;
  showUsage: TriState;
  showDuration: TriState;
  showGoal: TriState;
  showNextRunTime: TriState;
  sleepMessage: string;
  awakeMessage: string;
  quietMessage: string;
  activeEnabled: boolean;
  activeStart: string;
  activeEnd: string;
  activeTimezone: string;
  activeDays: string[];
};

type EditorState = {
  form: HeartbeatForm;
  extras: JsonObject;
  activeHoursExtras: JsonObject;
  extrasJson: string;
};

type ModelOption = {
  value: string;
  label: string;
};

type DeliveryTargetOption = {
  value: string;
  channel: string;
  source: string;
};

type RawModelRow = {
  key: string;
  name: string;
  local: boolean;
  available: boolean;
};

const CUSTOM_OPTION = "__custom__";

const BOOLEAN_KEYS = [
  "askFirst",
  "showSleepStatus",
  "showNoMessageStatus",
  "showMessage",
  "showThinking",
  "showModelName",
  "showUsage",
  "showDuration",
  "showGoal",
  "showNextRunTime",
] as const;

const STRING_KEYS = [
  "every",
  "model",
  "prompt",
  "target",
  "to",
  "sleepMessage",
  "awakeMessage",
  "quietMessage",
] as const;

const ACTIVE_DAYS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
  { value: "saturday", label: "Sat" },
  { value: "sunday", label: "Sun" },
] as const;

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry after\s+(\d+(?:\.\d+)?)s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds);
}

function formatErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || "");
  const retryAfterSeconds = parseRetryAfterSeconds(raw);
  if (retryAfterSeconds) {
    return `Gateway is busy right now. Please retry in about ${retryAfterSeconds}s.`;
  }

  const lower = raw.toLowerCase();
  if (
    lower.includes("gateway closed") ||
    lower.includes("1006") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up") ||
    lower.includes("timed out")
  ) {
    return "Connection to OpenClaw Gateway was interrupted. It usually recovers in a few seconds.";
  }

  const gatewayCallMatch = raw.match(/Gateway call failed:\s*Error:\s*([^\n]+)/i);
  if (gatewayCallMatch?.[1]) return gatewayCallMatch[1].trim();

  const gatewayWakeMatch = raw.match(/Gateway wake failed \(\d+\):\s*([^\n]+)/i);
  if (gatewayWakeMatch?.[1]) return gatewayWakeMatch[1].trim();

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("Error: Command failed:"));
  if (lines.length > 0) return lines[0].replace(/^Error:\s*/i, "");

  return "Something went wrong while saving heartbeat settings.";
}

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

function parseAvailableChannels(payload: unknown): string[] {
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
    .map((row) => String(row.channel).trim())
    .sort((a, b) => a.localeCompare(b));
}

function emptyForm(): HeartbeatForm {
  return {
    every: "",
    model: "",
    prompt: "",
    target: "",
    to: "",
    askFirst: "",
    showSleepStatus: "",
    showNoMessageStatus: "",
    showMessage: "",
    showThinking: "",
    showModelName: "",
    showUsage: "",
    showDuration: "",
    showGoal: "",
    showNextRunTime: "",
    sleepMessage: "",
    awakeMessage: "",
    quietMessage: "",
    activeEnabled: false,
    activeStart: "",
    activeEnd: "",
    activeTimezone: "",
    activeDays: [],
  };
}

function parseTri(value: unknown): TriState {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

function toTri(value: TriState): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseEditorState(source: JsonObject | null): EditorState {
  const form = emptyForm();
  const extras: JsonObject = {};
  const activeHoursExtras: JsonObject = {};

  if (!source) {
    return { form, extras, activeHoursExtras, extrasJson: "" };
  }

  const knownBoolean = new Set<string>(BOOLEAN_KEYS);
  const knownString = new Set<string>(STRING_KEYS);
  const knownTopLevel = new Set<string>([...BOOLEAN_KEYS, ...STRING_KEYS, "activeHours"]);

  for (const [key, value] of Object.entries(source)) {
    if (knownString.has(key)) {
      if (typeof value === "string") {
        (form as unknown as Record<string, string>)[key] = value;
      }
      continue;
    }
    if (knownBoolean.has(key)) {
      (form as unknown as Record<string, TriState>)[key] = parseTri(value);
      continue;
    }
    if (key === "activeHours") {
      if (isRecord(value)) {
        form.activeEnabled = true;
        if (typeof value.start === "string") form.activeStart = value.start;
        if (typeof value.end === "string") form.activeEnd = value.end;
        if (typeof value.timezone === "string") form.activeTimezone = value.timezone;
        if (Array.isArray(value.days)) {
          form.activeDays = value.days
            .map((v) => String(v).toLowerCase().trim())
            .filter((v) => ACTIVE_DAYS.some((d) => d.value === v));
        }
        for (const [subKey, subValue] of Object.entries(value)) {
          if (
            subKey !== "start" &&
            subKey !== "end" &&
            subKey !== "timezone" &&
            subKey !== "days"
          ) {
            activeHoursExtras[subKey] = subValue;
          }
        }
      }
      continue;
    }
    if (!knownTopLevel.has(key)) {
      extras[key] = value;
    }
  }

  return {
    form,
    extras,
    activeHoursExtras,
    extrasJson: Object.keys(extras).length > 0 ? pretty(extras) : "",
  };
}

function parseExtrasJson(text: string): JsonObject {
  const raw = text.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Advanced options must be a JSON object");
  }
  return parsed as JsonObject;
}

function buildHeartbeatPayload(editor: EditorState): JsonObject | null {
  const out: JsonObject = {
    ...parseExtrasJson(editor.extrasJson),
  };

  for (const key of STRING_KEYS) {
    const value = editor.form[key].trim();
    if (value) out[key] = value;
  }

  for (const key of BOOLEAN_KEYS) {
    const value = toTri(editor.form[key]);
    if (typeof value === "boolean") out[key] = value;
  }

  if (editor.form.activeEnabled) {
    const activeHours: JsonObject = { ...editor.activeHoursExtras };
    if (editor.form.activeStart.trim()) activeHours.start = editor.form.activeStart.trim();
    if (editor.form.activeEnd.trim()) activeHours.end = editor.form.activeEnd.trim();
    if (editor.form.activeTimezone.trim()) {
      activeHours.timezone = editor.form.activeTimezone.trim();
    }
    if (editor.form.activeDays.length > 0) {
      activeHours.days = editor.form.activeDays;
    }
    if (Object.keys(activeHours).length > 0) out.activeHours = activeHours;
  }

  if (Object.keys(out).length === 0) return null;
  return out;
}

function applyTemplate(form: HeartbeatForm, id: "basic" | "business" | "monitor"): HeartbeatForm {
  const next = { ...form };
  if (id === "basic") {
    next.every = next.every || "1h";
    next.prompt = next.prompt || "Check for urgent follow-ups and important updates.";
    next.askFirst = next.askFirst || "false";
    return next;
  }
  if (id === "business") {
    next.every = "30m";
    next.prompt = "Run focused heartbeat checks during business hours.";
    next.activeEnabled = true;
    next.activeStart = "09:00";
    next.activeEnd = "18:00";
    next.activeTimezone = next.activeTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    next.activeDays = ["monday", "tuesday", "wednesday", "thursday", "friday"];
    next.showNoMessageStatus = "false";
    return next;
  }
  next.every = "15m";
  next.prompt = "Monitor for failures or urgent alerts and report immediately.";
  next.showThinking = "false";
  next.showUsage = "false";
  return next;
}

function triLabel(key: string): string {
  switch (key) {
    case "askFirst":
      return "Ask before sending";
    case "showSleepStatus":
      return "Show sleep status";
    case "showNoMessageStatus":
      return "Show no-message status";
    case "showMessage":
      return "Show message body";
    case "showThinking":
      return "Show thinking details";
    case "showModelName":
      return "Show model name";
    case "showUsage":
      return "Show usage metrics";
    case "showDuration":
      return "Show run duration";
    case "showGoal":
      return "Show goal";
    case "showNextRunTime":
      return "Show next run time";
    default:
      return key;
  }
}

function TriSelect({
  value,
  onChange,
}: {
  value: TriState;
  onChange: (value: TriState) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as TriState)}
      className="rounded-lg border border-foreground/10 bg-muted/40 px-2 py-1.5 text-xs text-foreground outline-none"
    >
      <option value="">Inherit</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}

function HeartbeatFormFields({
  editor,
  onChange,
  modelOptions,
  targetOptions,
  recipientOptions,
  compact = false,
}: {
  editor: EditorState;
  onChange: (next: EditorState) => void;
  modelOptions: ModelOption[];
  targetOptions: string[];
  recipientOptions: DeliveryTargetOption[];
  compact?: boolean;
}) {
  const setForm = useCallback(
    (patch: Partial<HeartbeatForm>) => {
      onChange({
        ...editor,
        form: {
          ...editor.form,
          ...patch,
        },
      });
    },
    [editor, onChange]
  );

  const hasKnownModel = modelOptions.some((opt) => opt.value === editor.form.model);
  const modelSelectValue =
    !editor.form.model || hasKnownModel ? editor.form.model : CUSTOM_OPTION;

  const hasKnownTarget = targetOptions.includes(editor.form.target);
  const targetSelectValue = hasKnownTarget ? editor.form.target : "";

  const hasKnownRecipient = recipientOptions.some((opt) => opt.value === editor.form.to);
  const recipientSelectValue =
    !editor.form.to || hasKnownRecipient ? editor.form.to : CUSTOM_OPTION;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Every</label>
          <input
            value={editor.form.every}
            onChange={(e) => setForm({ every: e.target.value })}
            placeholder="1h"
            className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Model</label>
          <select
            value={modelSelectValue}
            onChange={(e) => {
              const next = e.target.value;
              if (next === CUSTOM_OPTION) {
                if (hasKnownModel || !editor.form.model) {
                  setForm({ model: "" });
                }
                return;
              }
              setForm({ model: next });
            }}
            className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
          >
            <option value="">Use inherited/default</option>
            {modelOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
            <option value={CUSTOM_OPTION}>
              {hasKnownModel || !editor.form.model ? "Custom model..." : `Custom: ${editor.form.model}`}
            </option>
          </select>
          {modelSelectValue === CUSTOM_OPTION && (
            <input
              value={editor.form.model}
              onChange={(e) => setForm({ model: e.target.value })}
              placeholder="provider/model"
              className="mt-2 w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
            />
          )}
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Prompt</label>
        <textarea
          value={editor.form.prompt}
          onChange={(e) => setForm({ prompt: e.target.value })}
          rows={compact ? 2 : 3}
          placeholder="Check for urgent updates and summarize what matters."
          className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Target (optional)</label>
          <select
            value={targetSelectValue}
            onChange={(e) => {
              const next = e.target.value;
              setForm({ target: next });
            }}
            className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
          >
            <option value="">No specific target</option>
            {targetOptions.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Recipient (optional)</label>
          <select
            value={recipientSelectValue}
            onChange={(e) => {
              const next = e.target.value;
              if (next === CUSTOM_OPTION) {
                if (hasKnownRecipient || !editor.form.to) {
                  setForm({ to: "" });
                }
                return;
              }
              const match = recipientOptions.find((opt) => opt.value === next);
              if (match?.channel) {
                setForm({ to: next, target: editor.form.target || match.channel });
              } else {
                setForm({ to: next });
              }
            }}
            className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
          >
            <option value="">No recipient</option>
            {recipientOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.value}
                {opt.channel ? ` (${opt.channel})` : ""}
              </option>
            ))}
            <option value={CUSTOM_OPTION}>
              {hasKnownRecipient || !editor.form.to ? "Custom recipient..." : `Custom: ${editor.form.to}`}
            </option>
          </select>
          {recipientSelectValue === CUSTOM_OPTION && (
            <input
              value={editor.form.to}
              onChange={(e) => setForm({ to: e.target.value })}
              placeholder="channel:destination"
              className="mt-2 w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
            />
          )}
        </div>
      </div>

      <div className="rounded-lg border border-foreground/10 bg-muted/25 p-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">Active Hours</p>
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={editor.form.activeEnabled}
              onChange={(e) => setForm({ activeEnabled: e.target.checked })}
              className="h-3.5 w-3.5 rounded border-foreground/20 bg-transparent"
            />
            Enable
          </label>
        </div>

        {editor.form.activeEnabled && (
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Start</label>
                <input
                  value={editor.form.activeStart}
                  onChange={(e) => setForm({ activeStart: e.target.value })}
                  placeholder="08:00"
                  className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">End</label>
                <input
                  value={editor.form.activeEnd}
                  onChange={(e) => setForm({ activeEnd: e.target.value })}
                  placeholder="22:00"
                  className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Timezone</label>
                <input
                  value={editor.form.activeTimezone}
                  onChange={(e) => setForm({ activeTimezone: e.target.value })}
                  placeholder="America/New_York"
                  className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
                />
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Days</label>
              <div className="flex flex-wrap gap-1.5">
                {ACTIVE_DAYS.map((day) => {
                  const selected = editor.form.activeDays.includes(day.value);
                  return (
                    <button
                      key={day.value}
                      type="button"
                      onClick={() => {
                        const next = selected
                          ? editor.form.activeDays.filter((d) => d !== day.value)
                          : [...editor.form.activeDays, day.value];
                        setForm({ activeDays: next });
                      }}
                      className={`rounded-md border px-2 py-1 text-[11px] ${
                        selected
                          ? "border-border bg-muted-foreground/15 text-fg-secondary"
                          : "border-foreground/10 text-muted-foreground hover:bg-muted/50"
                      }`}
                    >
                      {day.label}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {!compact && (
        <>
          <div className="rounded-lg border border-foreground/10 bg-muted/25 p-3">
            <p className="mb-2 text-xs font-medium text-foreground">Display And Delivery Behavior</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {BOOLEAN_KEYS.map((key) => (
                <div key={key} className="flex items-center justify-between gap-2 rounded border border-foreground/10 px-2 py-1.5">
                  <span className="text-xs text-muted-foreground">{triLabel(key)}</span>
                  <TriSelect
                    value={editor.form[key]}
                    onChange={(value) => setForm({ [key]: value } as Partial<HeartbeatForm>)}
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Sleep Message</label>
              <input
                value={editor.form.sleepMessage}
                onChange={(e) => setForm({ sleepMessage: e.target.value })}
                placeholder="Sleeping until active hours"
                className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Awake Message</label>
              <input
                value={editor.form.awakeMessage}
                onChange={(e) => setForm({ awakeMessage: e.target.value })}
                placeholder="Heartbeat resumed"
                className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">Quiet Message</label>
              <input
                value={editor.form.quietMessage}
                onChange={(e) => setForm({ quietMessage: e.target.value })}
                placeholder="No urgent updates"
                className="w-full rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export function HeartbeatManager() {
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [data, setData] = useState<HeartbeatPayload | null>(null);
  const [heartbeatWarning, setHeartbeatWarning] = useState<string | null>(null);
  const [heartbeatDegraded, setHeartbeatDegraded] = useState(false);
  const [lookupWarning, setLookupWarning] = useState<string | null>(null);
  const [lookupDegraded, setLookupDegraded] = useState(false);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [targetOptions, setTargetOptions] = useState<string[]>([]);
  const [recipientOptions, setRecipientOptions] = useState<DeliveryTargetOption[]>([]);

  const [defaultsEditor, setDefaultsEditor] = useState<EditorState>({
    form: emptyForm(),
    extras: {},
    activeHoursExtras: {},
    extrasJson: "",
  });
  const [agentEditors, setAgentEditors] = useState<Record<string, EditorState>>({});
  const [visibilityEditor, setVisibilityEditor] = useState("");

  const [showAdvancedDefaults, setShowAdvancedDefaults] = useState(false);
  const [showVisibilityAdvanced, setShowVisibilityAdvanced] = useState(false);

  const [wakeMode, setWakeMode] = useState<"now" | "next-heartbeat">("now");
  const [wakeText, setWakeText] = useState("Check for urgent follow-ups");

  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flash = useCallback((message: string, type: "success" | "error") => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const hydrateEditors = useCallback((payload: HeartbeatPayload) => {
    setDefaultsEditor(parseEditorState(payload.defaultsHeartbeat));
    const nextAgents: Record<string, EditorState> = {};
    for (const agent of payload.agents || []) {
      nextAgents[agent.id] = parseEditorState(agent.heartbeat);
    }
    setAgentEditors(nextAgents);
    setVisibilityEditor(pretty(payload.visibility || { defaults: null, channels: {} }));
  }, []);

  const hydrateModelOptions = useCallback(
    (statusPayload: unknown, allPayload: unknown) => {
      const statusRows = parseModelRows(statusPayload);
      const allRows = parseModelRows(allPayload).filter((row) => row.local);
      const merged = new Map<string, RawModelRow>();

      for (const row of [...statusRows, ...allRows]) {
        const prev = merged.get(row.key);
        if (!prev) {
          merged.set(row.key, row);
          continue;
        }
        merged.set(row.key, {
          key: row.key,
          name: prev.name || row.name || row.key,
          local: prev.local || row.local,
          available: prev.available || row.available,
        });
      }

      const next = [...merged.values()]
        .map((row) => {
          const tags: string[] = [];
          if (row.local) tags.push("local");
          if (row.available) tags.push("available");
          const suffix = tags.length > 0 ? ` · ${tags.join(", ")}` : "";
          return {
            value: row.key,
            label: `${row.name} (${row.key})${suffix}`,
          } satisfies ModelOption;
        })
        .sort((a, b) => a.label.localeCompare(b.label));

      setModelOptions(next);
    },
    []
  );

  const hydrateDeliveryOptions = useCallback((payload: unknown, availableChannels: Set<string>) => {
    const rows = isRecord(payload) && Array.isArray(payload.targets) ? payload.targets : [];
    const recipientMap = new Map<string, DeliveryTargetOption>();

    for (const row of rows) {
      if (!isRecord(row)) continue;
      const value = typeof row.target === "string" ? row.target : "";
      if (!value) continue;
      const channel = typeof row.channel === "string" ? row.channel.trim() : "";
      if (availableChannels.size > 0 && channel && !availableChannels.has(channel)) {
        continue;
      }
      const source = typeof row.source === "string" ? row.source : "";
      recipientMap.set(value, { value, channel, source });
    }

    const recipients = [...recipientMap.values()].sort((a, b) => {
      if (a.channel !== b.channel) return a.channel.localeCompare(b.channel);
      return a.value.localeCompare(b.value);
    });

    setRecipientOptions(recipients);
  }, []);

  const fetchLookups = useCallback(async () => {
    const warnings: string[] = [];
    let degraded = false;
    const [modelsStatusRes, modelsAllRes, targetsRes, channelsRes] = await Promise.allSettled([
      fetch("/api/models?scope=status", { cache: "no-store" }),
      fetch("/api/models?scope=all", { cache: "no-store" }),
      fetch("/api/cron?action=targets", { cache: "no-store" }),
      fetch("/api/channels", { cache: "no-store" }),
    ]);

    let statusPayload: unknown = null;
    let allPayload: unknown = null;
    let availableChannels = new Set<string>();

    if (modelsStatusRes.status === "fulfilled") {
      try {
        statusPayload = await modelsStatusRes.value.json();
        if (
          isRecord(statusPayload) &&
          typeof statusPayload.warning === "string" &&
          statusPayload.warning.trim()
        ) {
          warnings.push(`models status: ${statusPayload.warning.trim()}`);
        }
        if (isRecord(statusPayload) && statusPayload.degraded === true) {
          degraded = true;
        }
      } catch {
        // ignore parse failures
      }
    } else {
      warnings.push("models status request failed");
      degraded = true;
    }

    if (modelsAllRes.status === "fulfilled") {
      try {
        allPayload = await modelsAllRes.value.json();
        if (
          isRecord(allPayload) &&
          typeof allPayload.warning === "string" &&
          allPayload.warning.trim()
        ) {
          warnings.push(`models catalog: ${allPayload.warning.trim()}`);
        }
        if (isRecord(allPayload) && allPayload.degraded === true) {
          degraded = true;
        }
      } catch {
        // ignore parse failures
      }
    } else {
      warnings.push("models catalog request failed");
      degraded = true;
    }

    hydrateModelOptions(statusPayload, allPayload);

    if (channelsRes.status === "fulfilled") {
      try {
        const payload = await channelsRes.value.json();
        if (isRecord(payload) && typeof payload.warning === "string" && payload.warning.trim()) {
          warnings.push(`channels: ${payload.warning.trim()}`);
        }
        if (isRecord(payload) && payload.degraded === true) {
          degraded = true;
        }
        const channels = parseAvailableChannels(payload);
        setTargetOptions(channels);
        availableChannels = new Set(channels);
      } catch {
        // ignore parse failures
      }
    } else {
      warnings.push("channels request failed");
      degraded = true;
    }

    if (targetsRes.status === "fulfilled") {
      try {
        const payload = await targetsRes.value.json();
        if (isRecord(payload) && typeof payload.warning === "string" && payload.warning.trim()) {
          warnings.push(`targets: ${payload.warning.trim()}`);
        }
        if (isRecord(payload) && payload.degraded === true) {
          degraded = true;
        }
        hydrateDeliveryOptions(payload, availableChannels);
      } catch {
        // ignore parse failures
      }
    } else {
      warnings.push("targets request failed");
      degraded = true;
    }

    setLookupWarning(warnings.length > 0 ? warnings.join(" | ") : null);
    setLookupDegraded(degraded);
  }, [hydrateDeliveryOptions, hydrateModelOptions]);

  const fetchHeartbeat = useCallback(async () => {
    setLoading(true);
    setHeartbeatWarning(null);
    setHeartbeatDegraded(false);
    try {
      const [heartbeatRes] = await Promise.all([
        fetch("/api/heartbeat", { cache: "no-store" }),
        fetchLookups(),
      ]);
      const res = heartbeatRes;
      const payload = (await res.json()) as HeartbeatPayload & {
        warning?: unknown;
        degraded?: unknown;
        error?: string;
      };
      setHeartbeatWarning(
        typeof payload.warning === "string" && payload.warning.trim()
          ? payload.warning.trim()
          : null
      );
      setHeartbeatDegraded(Boolean(payload.degraded));
      if (!res.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      setData(payload);
      hydrateEditors(payload);
    } catch (err) {
      const prettyError = formatErrorMessage(err);
      flash(prettyError, "error");
      setHeartbeatWarning(prettyError);
      setHeartbeatDegraded(true);
    } finally {
      setLoading(false);
    }
  }, [fetchLookups, flash, hydrateEditors]);

  const combinedWarning = useMemo(() => {
    const parts = [heartbeatWarning, lookupWarning]
      .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
      .map((part) => part.trim());
    return parts.length > 0 ? parts.join(" | ") : null;
  }, [heartbeatWarning, lookupWarning]);
  const combinedDegraded = heartbeatDegraded || lookupDegraded;
  const busyMessage = useMemo(() => {
    if (!busyKey) return null;
    if (busyKey === "wake-now") {
      return "Sending wake event... this can take a few seconds if the gateway is busy.";
    }
    return "Saving heartbeat settings... this can take a few seconds if the gateway is busy.";
  }, [busyKey]);

  useEffect(() => {
    void fetchHeartbeat();
  }, [fetchHeartbeat]);

  const runSave = useCallback(
    async (
      busy: string,
      body: Record<string, unknown>,
      successMessage: string,
      restartMessage?: string
    ) => {
      setBusyKey(busy);
      try {
        const res = await fetch("/api/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await res.json()) as HeartbeatPayload & { error?: string };
        if (!res.ok || payload.ok === false) {
          throw new Error(payload.error || `HTTP ${res.status}`);
        }
        setData(payload);
        hydrateEditors(payload);
        flash(successMessage, "success");
        if (restartMessage) requestRestart(restartMessage);
      } catch (err) {
        flash(formatErrorMessage(err), "error");
      } finally {
        setBusyKey(null);
      }
    },
    [flash, hydrateEditors]
  );

  const saveDefaults = useCallback(async () => {
    try {
      const heartbeat = buildHeartbeatPayload(defaultsEditor);
      await runSave(
        "save-defaults",
        { action: "save-defaults", heartbeat },
        "Defaults heartbeat updated",
        "Heartbeat defaults were updated."
      );
    } catch (err) {
      flash(formatErrorMessage(err), "error");
    }
  }, [defaultsEditor, flash, runSave]);

  const clearDefaults = useCallback(async () => {
    await runSave(
      "clear-defaults",
      { action: "save-defaults", heartbeat: null },
      "Defaults heartbeat override removed",
      "Heartbeat defaults were updated."
    );
  }, [runSave]);

  const saveAgent = useCallback(
    async (agentId: string) => {
      try {
        const editor = agentEditors[agentId];
        if (!editor) throw new Error(`Missing editor state for ${agentId}`);
        const heartbeat = buildHeartbeatPayload(editor);
        await runSave(
          `save-agent:${agentId}`,
          { action: "save-agent", agentId, heartbeat },
          `Saved heartbeat for ${agentId}`,
          "Heartbeat agent override was updated."
        );
      } catch (err) {
        flash(formatErrorMessage(err), "error");
      }
    },
    [agentEditors, flash, runSave]
  );

  const clearAgent = useCallback(
    async (agentId: string) => {
      await runSave(
        `clear-agent:${agentId}`,
        { action: "save-agent", agentId, heartbeat: null },
        `Cleared heartbeat override for ${agentId}`,
        "Heartbeat agent override was updated."
      );
    },
    [runSave]
  );

  const saveVisibility = useCallback(async () => {
    try {
      const parsed = JSON.parse(visibilityEditor) as unknown;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
        throw new Error("Visibility must be a JSON object");
      }
      await runSave(
        "save-visibility",
        { action: "save-visibility", visibility: parsed },
        "Heartbeat visibility updated",
        "Heartbeat visibility settings were updated."
      );
    } catch (err) {
      flash(formatErrorMessage(err), "error");
    }
  }, [flash, runSave, visibilityEditor]);

  const wakeNow = useCallback(async () => {
    setBusyKey("wake-now");
    try {
      const res = await fetch("/api/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "wake-now",
          mode: wakeMode,
          text: wakeText.trim(),
        }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || payload.ok === false) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      flash("Heartbeat wake event sent", "success");
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

  if (loading) {
    return (
      <div className="flex flex-1 flex-col">
        <ScreenLoadingState />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-lg border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
        Failed to load heartbeat configuration.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {toast && (
        <div
          className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${
            toast.type === "success"
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-danger-border bg-danger-bg text-danger-fg"
          }`}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5" />
          )}
          <span>{toast.message}</span>
        </div>
      )}

      {busyMessage && (
        <div className="rounded-lg border border-info-border bg-info-bg px-3 py-2 text-xs text-info-fg">
          {busyMessage}
        </div>
      )}

      <div className="rounded-xl border border-foreground/10 bg-card/90 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Heart className="h-4 w-4 text-danger-fg" />
              Heartbeat Controls
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Guided editor for heartbeat defaults and per-agent overrides.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={combinedWarning} degraded={combinedDegraded} />
            <a
              href={data.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-control border border-foreground/10 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60"
            >
              Docs
              <ExternalLink className="h-3 w-3" />
            </a>
            <button
              type="button"
              onClick={() => {
                void fetchHeartbeat();
              }}
              disabled={Boolean(busyKey)}
              className="inline-flex items-center gap-1 rounded-lg border border-foreground/10 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
            >
              {loading ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-3 text-xs">
          <div className="rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2">
            <p className="text-muted-foreground">Agents</p>
            <p className="mt-1 font-semibold text-foreground">
              {data.stats.agentsWithOverrides}/{data.stats.agentsTotal} with overrides
            </p>
          </div>
          <div className="rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2">
            <p className="text-muted-foreground">Channels</p>
            <p className="mt-1 font-semibold text-foreground">
              {data.stats.channelsWithOverrides} with visibility overrides
            </p>
          </div>
          <div className="rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2">
            <p className="text-muted-foreground">Effective Defaults</p>
            <p className="mt-1 font-mono text-[11px] text-foreground">
              {data.effectiveDefaultsHeartbeat
                ? JSON.stringify(data.effectiveDefaultsHeartbeat)
                : "not configured"}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-foreground/10 bg-card/90 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Defaults (agents.defaults.heartbeat)
          </h4>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                setDefaultsEditor((prev) => ({
                  ...prev,
                  form: applyTemplate(prev.form, "basic"),
                }))
              }
              className="inline-flex items-center gap-1 rounded-lg border border-foreground/10 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
            >
              <WandSparkles className="h-3 w-3" />
              Basic
            </button>
            <button
              type="button"
              onClick={() =>
                setDefaultsEditor((prev) => ({
                  ...prev,
                  form: applyTemplate(prev.form, "business"),
                }))
              }
              className="inline-flex items-center gap-1 rounded-lg border border-foreground/10 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
            >
              <WandSparkles className="h-3 w-3" />
              Business Hours
            </button>
            <button
              type="button"
              onClick={() =>
                setDefaultsEditor((prev) => ({
                  ...prev,
                  form: applyTemplate(prev.form, "monitor"),
                }))
              }
              className="inline-flex items-center gap-1 rounded-lg border border-foreground/10 px-2 py-1 text-xs text-muted-foreground hover:bg-muted/60"
            >
              <WandSparkles className="h-3 w-3" />
              Monitor
            </button>
          </div>
        </div>

        <p className="mt-1 text-xs text-muted-foreground">
          Use these fields to create or update heartbeat behavior without writing JSON.
        </p>

        <div className="mt-3">
          <HeartbeatFormFields
            editor={defaultsEditor}
            onChange={setDefaultsEditor}
            modelOptions={modelOptions}
            targetOptions={targetOptions}
            recipientOptions={recipientOptions}
          />
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              void saveDefaults();
            }}
            disabled={Boolean(busyKey)}
            className="inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busyKey === "save-defaults" ? (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            {busyKey === "save-defaults" ? "Saving..." : "Save Defaults"}
          </button>
          <button
            type="button"
            onClick={() => {
              void clearDefaults();
            }}
            disabled={Boolean(busyKey)}
            className="inline-flex items-center gap-1 rounded-lg border border-danger-border px-2.5 py-1.5 text-xs text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Clear Override
          </button>
          <button
            type="button"
            onClick={() => setShowAdvancedDefaults((v) => !v)}
            className="rounded-lg border border-foreground/10 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
          >
            {showAdvancedDefaults ? "Hide Advanced JSON" : "Show Advanced JSON"}
          </button>
        </div>

        {showAdvancedDefaults && (
          <div className="mt-3">
            <p className="mb-1 text-xs text-muted-foreground">
              Optional: additional heartbeat keys not shown in the form.
            </p>
            <textarea
              value={defaultsEditor.extrasJson}
              onChange={(e) =>
                setDefaultsEditor((prev) => ({ ...prev, extrasJson: e.target.value }))
              }
              spellCheck={false}
              placeholder='{"customField": true}'
              className="h-36 w-full rounded-lg border border-foreground/10 bg-surface-inset px-3 py-2 font-mono text-xs text-foreground outline-none"
            />
          </div>
        )}
      </div>

      <div className="rounded-xl border border-foreground/10 bg-card/90 p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Manual Wake
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Trigger a heartbeat event now or on the next heartbeat cycle.
        </p>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <select
            value={wakeMode}
            onChange={(e) => setWakeMode(e.target.value === "next-heartbeat" ? "next-heartbeat" : "now")}
            disabled={Boolean(busyKey)}
            className="rounded-lg border border-foreground/10 bg-muted/40 px-2.5 py-2 text-xs text-foreground outline-none"
          >
            <option value="now">Mode: now</option>
            <option value="next-heartbeat">Mode: next-heartbeat</option>
          </select>
          <input
            value={wakeText}
            onChange={(e) => setWakeText(e.target.value)}
            disabled={Boolean(busyKey)}
            placeholder="Wake message text"
            className="min-w-0 flex-1 rounded-lg border border-foreground/10 bg-muted/40 px-3 py-2 text-xs text-foreground outline-none"
          />
          <button
            type="button"
            onClick={() => {
              void wakeNow();
            }}
            disabled={Boolean(busyKey)}
            className="inline-flex items-center justify-center gap-1 rounded-full bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-50"
          >
            {busyKey === "wake-now" ? (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {busyKey === "wake-now" ? "Sending..." : "Trigger"}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-foreground/10 bg-card/90 p-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Per-Agent Overrides
        </h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Add or edit heartbeat behavior for specific agents.
        </p>
        <div className="mt-3 space-y-3">
          {sortedAgents.map((agent) => {
            const editor = agentEditors[agent.id] || parseEditorState(agent.heartbeat);
            return (
              <div key={agent.id} className="rounded-lg border border-foreground/10 bg-muted/30 p-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-foreground">{agent.name}</span>
                  <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {agent.id}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      agent.heartbeat
                        ? "bg-success-bg text-success-fg"
                        : "bg-foreground/10 text-muted-foreground"
                    }`}
                  >
                    {agent.heartbeat ? "override" : "inherits defaults"}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setAgentEditors((prev) => ({
                        ...prev,
                        [agent.id]: {
                          ...editor,
                          form: applyTemplate(editor.form, "basic"),
                        },
                      }))
                    }
                    className="ml-auto inline-flex items-center gap-1 rounded border border-foreground/10 px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/60"
                  >
                    <WandSparkles className="h-3 w-3" />
                    Quick Fill
                  </button>
                </div>

                <HeartbeatFormFields
                  compact
                  editor={editor}
                  modelOptions={modelOptions}
                  targetOptions={targetOptions}
                  recipientOptions={recipientOptions}
                  onChange={(next) =>
                    setAgentEditors((prev) => ({
                      ...prev,
                      [agent.id]: next,
                    }))
                  }
                />

                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void saveAgent(agent.id);
                    }}
                    disabled={Boolean(busyKey)}
                    className="inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busyKey === `save-agent:${agent.id}` ? (
                      <span className="inline-flex items-center gap-0.5">
                        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                        <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                      </span>
                    ) : (
                      <Save className="h-3.5 w-3.5" />
                    )}
                    {busyKey === `save-agent:${agent.id}` ? "Saving..." : "Save Override"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void clearAgent(agent.id);
                    }}
                    disabled={Boolean(busyKey)}
                    className="inline-flex items-center gap-1 rounded-lg border border-danger-border px-2.5 py-1.5 text-xs text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Clear Override
                  </button>
                </div>
              </div>
            );
          })}
          {sortedAgents.length === 0 && (
            <p className="text-xs text-muted-foreground">No agents found in current config.</p>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-foreground/10 bg-card/90 p-4">
        <div className="flex items-center justify-between gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Visibility Controls
          </h4>
          <button
            type="button"
            onClick={() => setShowVisibilityAdvanced((v) => !v)}
            className="rounded-lg border border-foreground/10 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
          >
            {showVisibilityAdvanced ? "Hide" : "Show"} Advanced JSON
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Channel/account visibility uses advanced keys and stays editable in JSON.
        </p>

        {showVisibilityAdvanced && (
          <>
            <textarea
              value={visibilityEditor}
              onChange={(e) => setVisibilityEditor(e.target.value)}
              spellCheck={false}
              className="mt-2 h-52 w-full rounded-lg border border-foreground/10 bg-surface-inset px-3 py-2 font-mono text-xs text-foreground outline-none"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  try {
                    setVisibilityEditor(pretty(JSON.parse(visibilityEditor) as unknown));
                  } catch (err) {
                    flash(formatErrorMessage(err), "error");
                  }
                }}
                className="rounded-lg border border-foreground/10 px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
              >
                Format JSON
              </button>
              <button
                type="button"
                onClick={() => {
                  void saveVisibility();
                }}
                disabled={Boolean(busyKey)}
                className="inline-flex items-center gap-1 rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {busyKey === "save-visibility" ? (
                  <span className="inline-flex items-center gap-0.5">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {busyKey === "save-visibility" ? "Saving..." : "Save Visibility"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
