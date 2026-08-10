/**
 * Pure helpers: parsing config into form state, building config back out of
 * form state, and turning raw settings into plain-language sentences. No
 * fetching, no React, so every function here is trivial to reason about in
 * isolation.
 */

import type { EditorState, HeartbeatForm, JsonObject, TriState } from "./types";

export const BOOLEAN_KEYS = [
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

export const STRING_KEYS = [
  "every",
  "model",
  "prompt",
  "target",
  "to",
  "sleepMessage",
  "awakeMessage",
  "quietMessage",
] as const;

export const ACTIVE_DAYS = [
  { value: "monday", label: "Mon" },
  { value: "tuesday", label: "Tue" },
  { value: "wednesday", label: "Wed" },
  { value: "thursday", label: "Thu" },
  { value: "friday", label: "Fri" },
  { value: "saturday", label: "Sat" },
  { value: "sunday", label: "Sun" },
] as const;

/** Quick cadence choices shown as pills. "Custom" falls through to a text field. */
export const CADENCE_PRESETS: Array<{ value: string; label: string }> = [
  { value: "15m", label: "Every 15 min" },
  { value: "30m", label: "Every 30 min" },
  { value: "1h", label: "Every hour" },
  { value: "4h", label: "Every 4 hours" },
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function parseTri(value: unknown): TriState {
  if (value === true) return "true";
  if (value === false) return "false";
  return "";
}

export function toTri(value: TriState): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

export function emptyForm(): HeartbeatForm {
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

export function parseEditorState(source: JsonObject | null): EditorState {
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
          if (subKey !== "start" && subKey !== "end" && subKey !== "timezone" && subKey !== "days") {
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

export function parseExtrasJson(text: string): JsonObject {
  const raw = text.trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Advanced options must be a JSON object");
  }
  return parsed as JsonObject;
}

/** Turns form state back into the exact shape OpenClaw's config expects. */
export function buildHeartbeatConfig(editor: EditorState): JsonObject | null {
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
    if (editor.form.activeTimezone.trim()) activeHours.timezone = editor.form.activeTimezone.trim();
    if (editor.form.activeDays.length > 0) activeHours.days = editor.form.activeDays;
    if (Object.keys(activeHours).length > 0) out.activeHours = activeHours;
  }

  if (Object.keys(out).length === 0) return null;
  return out;
}

/** True once `every` has been explicitly turned off. */
export function isTurnedOff(every: string): boolean {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i.exec(
    every.trim()
  );
  if (!m) return false;
  const amount = Number(m[1]);
  return Number.isFinite(amount) && amount === 0;
}

/** "30m" -> "every 30 minutes", "1h" -> "every hour", "" -> "every 30 minutes" (the built-in default). */
export function describeCadence(every: string): string {
  const raw = every.trim();
  if (!raw) return "every 30 minutes";
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)?$/i.exec(raw);
  if (!m) return `every ${raw}`;
  const amount = Number(m[1]);
  const unitRaw = (m[2] || "m").toLowerCase();
  const isHours = unitRaw.startsWith("h");
  const isDays = unitRaw.startsWith("d");
  if (amount === 0) return "off";
  const unitLabel = isDays ? "day" : isHours ? "hour" : "minute";
  if (amount === 1 && (isHours || isDays)) return `every ${unitLabel}`;
  return `every ${amount} ${unitLabel}${amount === 1 ? "" : "s"}`;
}

/** Plain-language description of where an alert goes. */
export function describeTarget(target: string, channelLabels: Map<string, string>): string {
  const raw = target.trim();
  if (!raw || raw === "none") return "nowhere — it keeps its notes to itself";
  if (raw === "last") return "wherever you last messaged from";
  return channelLabels.get(raw) || raw;
}

export function parseRetryAfterSeconds(message: string): number | null {
  const match = message.match(/retry after\s+(\d+(?:\.\d+)?)s/i);
  if (!match) return null;
  const seconds = Number(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.ceil(seconds);
}

export function formatErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err || "");
  const retryAfterSeconds = parseRetryAfterSeconds(raw);
  if (retryAfterSeconds) {
    return `Gateway is busy right now. Please try again in about ${retryAfterSeconds}s.`;
  }

  const lower = raw.toLowerCase();
  if (
    lower.includes("gateway closed") ||
    lower.includes("1006") ||
    lower.includes("econnrefused") ||
    lower.includes("socket hang up") ||
    lower.includes("timed out")
  ) {
    return "Connection to OpenClaw was interrupted. It usually recovers in a few seconds.";
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

export function applyTemplate(
  form: HeartbeatForm,
  id: "basic" | "business" | "monitor"
): HeartbeatForm {
  const next = { ...form };
  if (id === "basic") {
    next.every = next.every || "30m";
    next.prompt = next.prompt || "";
    next.askFirst = next.askFirst || "false";
    return next;
  }
  if (id === "business") {
    next.every = "30m";
    next.prompt = "Run focused heartbeat checks during business hours.";
    next.activeEnabled = true;
    next.activeStart = "09:00";
    next.activeEnd = "18:00";
    next.activeTimezone =
      next.activeTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "";
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
