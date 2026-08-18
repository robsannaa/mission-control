"use client";

import { useEffect, useState, useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import {
  Clock,
  Play,
  Pause,
  Pencil,
  Trash2,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  X,
  Check,
  Send,
  Cpu,
  Calendar,
  Globe,
  Hash,
  FileText,
  Timer,
  AlertTriangle,
  Info,
  Plus,
  Terminal,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { InlineSpinner, ContentLoadingState } from "@/components/ui/loading-state";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  is12HourTimeFormat,
  withTimeFormat,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";
import { getFriendlyModelName, getModelOptions } from "@/lib/model-metadata";

/* ── types ────────────────────────────────────────── */

type CronJob = {
  id: string;
  agentId: string;
  name: string;
  enabled: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  schedule: { kind: string; expr?: string; everyMs?: number; tz?: string };
  sessionTarget?: string;
  wakeMode?: string;
  payload: { kind: string; message?: string; model?: string; timeoutSeconds?: number };
  delivery: { mode: string; channel?: string; to?: string; bestEffort?: boolean };
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastDurationMs?: number;
    consecutiveErrors?: number;
    lastError?: string;
    isRunning?: boolean;
    runningStartedAtMs?: number;
    runningAtMs?: number;
  };
};

type RunEntry = {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  durationMs?: number;
  error?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  nextRunAtMs?: number;
};

type Toast = { message: string; type: "success" | "error" };

type RunOutputState = {
  status: "running" | "done" | "error";
  output: string;
  runStartedAtMs: number;
  baselineRunAtMs: number;
  phase: string;
  sessionKey?: string;
  timeoutAtMs: number;
};

type DeliveryMode = "announce" | "webhook" | "none";

/* ── helpers ──────────────────────────────────────── */

export function fmtDuration(ms: number | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function fmtAgo(ms: number | undefined): string {
  if (!ms) return "—";
  const diff = Date.now() - ms;
  if (diff < 0) {
    // Future
    const absDiff = Math.abs(diff);
    if (absDiff < 60000) return `in ${Math.floor(absDiff / 1000)}s`;
    if (absDiff < 3600000) return `in ${Math.floor(absDiff / 60000)}m`;
    if (absDiff < 86400000) return `in ${Math.floor(absDiff / 3600000)}h`;
    return `in ${Math.floor(absDiff / 86400000)}d`;
  }
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function fmtDate(ms: number | undefined, timeFormat: TimeFormatPreference): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(
    "en-US",
    withTimeFormat(
      {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      },
      timeFormat,
    ),
  );
}

export function fmtFullDate(ms: number | undefined, timeFormat: TimeFormatPreference): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString(
    "en-US",
    withTimeFormat(
      {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      },
      timeFormat,
    ),
  );
}

/** Turn a cron expression into a short human-readable phrase (e.g. "Every 6 hours", "Daily at 8:00 AM"). */
export function cronToHuman(expr: string, timeFormat: TimeFormatPreference): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, day, month, dow] = parts;
  const formatClock = (hour24: number, minute: number): string => {
    if (!Number.isFinite(hour24) || !Number.isFinite(minute)) return `${hour24}:${minute}`;
    if (!is12HourTimeFormat(timeFormat)) {
      return `${String(hour24).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
    const suffix = hour24 < 12 ? "AM" : "PM";
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
  };
  // Every N minutes: */N * * * *
  if (min.startsWith("*/") && hour === "*" && day === "*" && month === "*" && dow === "*") {
    const n = min.slice(2);
    if (/^\d+$/.test(n)) return `Every ${n} minutes`;
  }
  // Every N hours: 0 */N * * *
  if (min === "0" && hour.startsWith("*/") && day === "*" && month === "*" && dow === "*") {
    const n = hour.slice(2);
    if (/^\d+$/.test(n)) return n === "1" ? "Every hour" : `Every ${n} hours`;
  }
  // Every hour: 0 * * * *
  if (min === "0" && hour === "*" && day === "*" && month === "*" && dow === "*")
    return "Every hour";
  // Daily at H:M
  if (min !== "*" && !min.includes("/") && !min.includes(",") && hour !== "*" && !hour.includes("/") && !hour.includes(",") && day === "*" && month === "*" && dow === "*") {
    const h = parseInt(hour, 10);
    const m = parseInt(min, 10);
    return `Daily at ${formatClock(h, m)}`;
  }
  // Twice a day: 0 8,20 * * *
  if (min === "0" && /^\d+,\d+$/.test(hour) && day === "*" && month === "*" && dow === "*") {
    const [h1, h2] = hour.split(",").map((x) => parseInt(x, 10));
    return `Twice a day (${formatClock(h1, 0)} & ${formatClock(h2, 0)})`;
  }
  // Weekdays at noon: 0 12 * * 1-5
  if (min === "0" && hour === "12" && day === "*" && month === "*" && dow === "1-5")
    return is12HourTimeFormat(timeFormat) ? "Weekdays at noon" : "Weekdays at 12:00";
  // Weekdays at H
  if (min === "0" && day === "*" && month === "*" && dow === "1-5") {
    const h = parseInt(hour, 10);
    return `Weekdays at ${formatClock(h, 0)}`;
  }
  // Specific weekday: 0 9 * * 1 = Monday at 9am
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  if (min === "0" && day === "*" && month === "*" && /^\d+$/.test(dow)) {
    const d = parseInt(dow, 10);
    const h = parseInt(hour, 10);
    if (d >= 0 && d <= 6) return `Every ${dayNames[d]} at ${formatClock(h, 0)}`;
  }
  return expr;
}

export function scheduleDisplay(s: CronJob["schedule"], timeFormat: TimeFormatPreference): string {
  if (s.kind === "cron" && s.expr) {
    const human = cronToHuman(s.expr, timeFormat);
    return human !== s.expr ? `${human}${s.tz ? ` (${s.tz})` : ""}` : `${s.expr}${s.tz ? ` (${s.tz})` : ""}`;
  }
  if (s.kind === "every" && s.everyMs) {
    const mins = Math.round(s.everyMs / 60000);
    return mins < 60 ? `Every ${mins}m` : `Every ${Math.round(mins / 60)}h`;
  }
  return "Unknown";
}

export function scheduleOptionLabel(opt: ScheduleOption, timeFormat: TimeFormatPreference): string {
  if (opt.kind === "cron" && "expr" in opt) {
    const human = cronToHuman(opt.expr, timeFormat);
    if (human !== opt.expr) return human;
  }
  if (!is12HourTimeFormat(timeFormat)) {
    if (opt.id === "daily-8am") return "Every day at 08:00";
    if (opt.id === "daily-6pm") return "Every day at 18:00";
    if (opt.id === "monday-9am") return "Every Monday at 09:00";
    if (opt.id === "twice-day") return "Twice a day (08:00 & 20:00)";
  }
  return opt.label;
}

export function normalizeDeliveryMode(value: string | null | undefined): DeliveryMode {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "announce" || mode === "webhook" || mode === "none") {
    return mode;
  }
  return "none";
}

export function isValidWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function inferChannelFromTarget(target: string): string {
  const value = String(target || "").trim().toLowerCase();
  if (!value) return "";
  if (value.startsWith("telegram:")) return "telegram";
  if (value.startsWith("discord:")) return "discord";
  if (value.startsWith("slack:")) return "slack";
  if (value.startsWith("webchat:")) return "webchat";
  if (value.startsWith("web:")) return "web";
  if (value.startsWith("signal:")) return "signal";
  if (value.startsWith("+")) return "phone";
  return "";
}

function targetMatchesChannel(target: string, channel: string): boolean {
  if (!target || !channel || channel === "last") return true;
  const inferred = inferChannelFromTarget(target);
  if (!inferred) return true;
  if (inferred === "phone") {
    return channel === "whatsapp" || channel === "signal";
  }
  return inferred === channel;
}

function getDeliveryChannelLabel(channel: string | undefined): string {
  if (!channel || channel === "last") return "Last route";
  return channel;
}

function getRecipientLabel(mode: DeliveryMode): string {
  return mode === "webhook" ? "Webhook URL" : "Recipient";
}

function getRecipientPlaceholder(mode: DeliveryMode, channel: string): string {
  if (mode === "webhook") return "https://example.com/webhook";
  if (!channel || channel === "last") return "Enter a recipient ID, for example telegram:123456789";
  return CHANNEL_PLACEHOLDER[channel] || "channel:TARGET_ID";
}

function getDeliveryNote(
  mode: DeliveryMode,
  channel: string,
  to: string,
): { tone: "info" | "warning"; message: string } | null {
  if (mode === "none") return null;
  if (mode === "webhook") {
    if (!to.trim()) {
      return {
        tone: "warning",
        message: "Webhook delivery needs a destination URL.",
      };
    }
    if (!isValidWebhookUrl(to.trim())) {
      return {
        tone: "warning",
        message: "Webhook URL must start with http:// or https://",
      };
    }
    return null;
  }
  if (!to.trim()) {
    return {
      tone: "warning",
      message: "Choose a recipient. Telegram delivery requires the numeric chat ID.",
    };
  }
  return null;
}

function isReadyChannel(channel: ChannelInfo): boolean {
  if (channel.setupType === "auto") return true;
  if (!channel.enabled && !channel.configured) return false;
  const statuses = Array.isArray(channel.statuses) ? channel.statuses : [];
  if (channel.enabled) {
    if (statuses.some((status) => status.connected || status.linked)) return true;
    if (statuses.some((status) => status.error)) return false;
  }
  return channel.configured || channel.enabled;
}

function describeDelivery(
  d: CronJob["delivery"] | null | undefined,
): {
  label: string;
  hasIssue: boolean;
  issue?: string;
} {
  const safe = d ?? { mode: "none" as const };
  const mode = normalizeDeliveryMode(safe.mode);
  if (mode === "none")
    return { label: "No delivery", hasIssue: false };
  if (mode === "webhook") {
    const target = String(safe.to || "").trim();
    const hasIssue = !target || !isValidWebhookUrl(target);
    return {
      label: target ? `webhook → ${target}` : "webhook",
      hasIssue,
      issue: hasIssue
        ? "Webhook delivery requires a valid http:// or https:// URL."
        : undefined,
    };
  }
  const parts: string[] = ["announce", "→", getDeliveryChannelLabel(safe.channel)];
  if (safe.to) parts.push("→", safe.to);
  const note = getDeliveryNote("announce", String(safe.channel || "last"), String(safe.to || ""));
  return {
    label: parts.join(" "),
    hasIssue: note?.tone === "warning",
    issue: note?.tone === "warning" ? note.message : undefined,
  };
}

type FailureGuide = {
  headline: string;
  explanation: string;
  steps: string[];
};

export function buildFailureGuide(error: string, delivery: CronJob["delivery"]): FailureGuide {
  const raw = String(error || "").trim();
  const lower = raw.toLowerCase();
  const channelHint = delivery.channel
    ? `Set recipient in Delivery for the ${delivery.channel} channel.`
    : "Set a delivery channel and recipient in the Delivery section.";

  if (
    lower.includes("delivery target is missing") ||
    (lower.includes("delivery") && lower.includes("missing") && lower.includes("target"))
  ) {
    return {
      headline: "Delivery destination is missing",
      explanation:
        "The job ran, but it had nowhere to send the result. This is a setup issue, not a system crash.",
      steps: [
        "Open job settings.",
        channelHint,
        "Save changes and run the job once to confirm.",
      ],
    };
  }

  if (
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("invalid api key") ||
    lower.includes("api key") ||
    lower.includes("authentication failed")
  ) {
    return {
      headline: "Provider authentication failed",
      explanation:
        "This job could not access the model provider because credentials are missing, expired, or invalid.",
      steps: [
        "Open Models or Accounts/Keys and reconnect the provider.",
        "Check that the selected model is available for your account.",
        "Run the cron job again after updating credentials.",
      ],
    };
  }

  if (
    lower.includes("model") &&
    (lower.includes("not found") ||
      lower.includes("unknown") ||
      lower.includes("invalid") ||
      lower.includes("unavailable"))
  ) {
    return {
      headline: "Selected model is unavailable",
      explanation:
        "The configured model could not be resolved at runtime, so the job stopped before completion.",
      steps: [
        "Edit this job and choose a valid model override, or clear the override.",
        "Confirm the model exists in the Models page.",
        "Run once manually to validate.",
      ],
    };
  }

  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      headline: "The job timed out",
      explanation:
        "The run took longer than the allowed execution window and was canceled automatically.",
      steps: [
        "Shorten the prompt to reduce runtime.",
        "Try a faster model for this cron job.",
        "Run once manually and check output duration.",
      ],
    };
  }

  if (
    lower.includes("econnrefused") ||
    lower.includes("connection refused") ||
    lower.includes("network") ||
    lower.includes("dns") ||
    lower.includes("host not found")
  ) {
    return {
      headline: "Connection to a required service failed",
      explanation:
        "The job could not reach a provider or local service while running.",
      steps: [
        "Check internet/local network connectivity.",
        "If using local models, verify the local model service is running.",
        "Retry once services are reachable.",
      ],
    };
  }

  return {
    headline: "The run failed",
    explanation:
      "Mission Control received an error from OpenClaw while executing this job.",
    steps: [
      "Open job settings and confirm schedule, model, and delivery fields.",
      "Run the job once manually to verify behavior.",
      "If this keeps failing, use Technical details below when reporting the issue.",
    ],
  };
}

/* ── Run detail card ──────────────────────────────── */

function RunCard({ run, timeFormat }: { run: RunEntry; timeFormat: TimeFormatPreference }) {
  const [showFull, setShowFull] = useState(false);

  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-xs",
        run.status === "error"
          ? "border-danger-border bg-danger-bg"
          : "border-foreground/5 bg-muted/40"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        {run.status === "ok" ? (
          <CheckCircle className="h-3.5 w-3.5 shrink-0 text-success-fg" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-danger-fg" />
        )}
        <span className="font-medium text-foreground">
          {fmtFullDate(run.ts, timeFormat)}
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">{fmtDuration(run.durationMs)}</span>
        {run.sessionId && (
          <>
            <span className="text-muted-foreground">·</span>
            <span className="font-mono text-xs text-muted-foreground">
              {run.sessionId.substring(0, 8)}
            </span>
          </>
        )}
        <div className="flex-1" />
        {(run.summary || run.error || run.sessionKey) && (
          <button
            type="button"
            onClick={() => setShowFull(!showFull)}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {showFull ? "Collapse" : "Details"}
          </button>
        )}
      </div>

      {/* Error */}
      {run.error && (
        <div className="mt-2 flex items-start gap-1.5 rounded bg-danger-bg px-2.5 py-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-danger-fg" />
          <p className="text-danger-fg">{run.error}</p>
        </div>
      )}

      {/* Summary preview (collapsed) */}
      {!showFull && run.summary && (
        <p className="mt-1.5 line-clamp-2 leading-5 text-muted-foreground">
          {run.summary.replace(/[*#|_`]/g, "").substring(0, 200)}
        </p>
      )}

      {/* Full details (expanded) */}
      {showFull && (
        <div className="mt-2 space-y-2">
          {run.summary && (
            <div>
              <p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Summary
              </p>
              <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-lg border border-foreground/10 bg-background/70 p-3 leading-5 text-foreground">
                {run.summary}
              </pre>
            </div>
          )}
          {run.sessionKey && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Session:</span>
              <code className="rounded bg-background/70 px-2 py-0.5 font-mono text-xs text-foreground">
                {run.sessionKey}
              </code>
            </div>
          )}
          {run.runAtMs && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>Scheduled: {fmtFullDate(run.runAtMs, timeFormat)}</span>
              <span>·</span>
              <span>Ran: {fmtFullDate(run.ts, timeFormat)}</span>
              {run.nextRunAtMs && (
                <>
                  <span>·</span>
                  <span>Next: {fmtFullDate(run.nextRunAtMs, timeFormat)}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FailureGuideCard({
  error,
  delivery,
  consecutiveErrors,
  onFix,
  compact = false,
}: {
  error: string;
  delivery: CronJob["delivery"];
  consecutiveErrors?: number;
  onFix: () => void;
  compact?: boolean;
}) {
  const guide = buildFailureGuide(error, delivery);
  const steps = compact ? guide.steps.slice(0, 2) : guide.steps;

  return (
    <div className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-danger-fg">
            Last run failed
            {consecutiveErrors && consecutiveErrors > 1
              ? ` (${consecutiveErrors} consecutive)`
              : ""}
          </p>
          <p className="mt-1 text-xs font-medium text-danger-fg">
            {guide.headline}
          </p>
          <p className="mt-1 text-xs leading-5 text-danger-fg">
            {guide.explanation}
          </p>
          <div className="mt-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-danger-fg">
              What to do
            </p>
            <ol className="mt-1 space-y-1 text-xs text-danger-fg">
              {steps.map((step, index) => (
                <li key={`${step}-${index}`}>{index + 1}. {step}</li>
              ))}
            </ol>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onFix}
              className="rounded-full bg-destructive px-2.5 py-1 text-xs font-medium text-white transition-colors hover:bg-destructive/88"
            >
              Open job settings
            </button>
            <details className="text-xs">
              <summary className="cursor-pointer text-danger-fg hover:text-danger-fg">
                Technical details
              </summary>
              <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap rounded-md border border-danger-border bg-danger-bg px-2 py-1.5 font-mono text-[11px] leading-relaxed text-danger-fg">
                {error}
              </pre>
            </details>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Known delivery target type ───────────────────── */
type KnownTarget = { target: string; channel: string; source: string };
type ChannelInfo = {
  channel: string;
  label: string;
  enabled: boolean;
  configured: boolean;
  setupType: "qr" | "token" | "cli" | "auto";
  statuses: { connected?: boolean; linked?: boolean; error?: string }[];
};

const CHANNEL_PLACEHOLDER: Record<string, string> = {
  telegram: "telegram:CHAT_ID",
  discord: "discord:CHANNEL_ID",
  whatsapp: "+15555550123",
  slack: "slack:CHANNEL_ID",
  signal: "+15555550123",
  webchat: "webchat:ROOM_ID",
  web: "web:ROOM_ID",
};

/* ── Edit form ───────────────────────────────────── */

function EditCronForm({
  job,
  onSave,
  onCancel,
  onDelete,
  onMessageAutoSave,
}: {
  job: CronJob;
  onSave: (updates: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void;
  onDelete: () => Promise<boolean>;
  onMessageAutoSave?: (message: string) => Promise<void>;
}) {
  const [name, setName] = useState(job.name);
  const [agentId, setAgentId] = useState(job.agentId || "main");
  const [agents, setAgents] = useState<{ id: string; name?: string }[]>([]);
  const [message, setMessage] = useState(job.payload.message || "");
  const [messageSaveStatus, setMessageSaveStatus] = useState<null | "unsaved" | "saving" | "saved">(null);
  const messageSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [schedType, setSchedType] = useState(job.schedule.kind);
  const [cronExpr, setCronExpr] = useState(job.schedule.expr || "");
  const [everyVal, setEveryVal] = useState(
    job.schedule.everyMs
      ? `${Math.round(job.schedule.everyMs / 60000)}m`
      : ""
  );
  const [tz, setTz] = useState(job.schedule.tz || "");
  const [model, setModel] = useState(job.payload.model || "");

  // Delivery
  const initialDeliveryMode = normalizeDeliveryMode(job.delivery.mode);
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(initialDeliveryMode);
  const [channel, setChannel] = useState(
    initialDeliveryMode === "announce" ? job.delivery.channel || "last" : ""
  );
  const [to, setTo] = useState(job.delivery.to || "");
  const [bestEffort, setBestEffort] = useState(Boolean(job.delivery.bestEffort));
  const [customTo, setCustomTo] = useState(initialDeliveryMode === "webhook");
  const [knownTargets, setKnownTargets] = useState<KnownTarget[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [confirmDel, setConfirmDel] = useState(false);

  const fetchTargets = useCallback(async () => {
    setTargetsLoading(true);
    try {
      const [targetsRes, channelsRes] = await Promise.all([
        fetch("/api/cron?action=targets", { cache: "no-store" }),
        fetch("/api/channels?scope=all", { cache: "no-store" }),
      ]);
      const targetsData = await targetsRes.json();
      const channelsData = await channelsRes.json();
      setKnownTargets(targetsData.targets || []);
      setChannels((channelsData.channels || []) as ChannelInfo[]);
    } catch {
      /* ignore */
    }
    setTargetsLoading(false);
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchTargets();
    });
    (async () => {
      try {
        const res = await fetch("/api/agents");
        const data = await res.json();
        setAgents((data.agents || []).map((a: Record<string, unknown>) => ({
          id: a.id as string,
          name: a.name as string | undefined,
        })));
      } catch { /* ignore */ }
    })();
  }, [fetchTargets]);

  useEffect(() => {
    return () => {
      if (messageSaveTimeoutRef.current) {
        clearTimeout(messageSaveTimeoutRef.current);
        messageSaveTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (deliveryMode === "announce" && !channel) {
      queueMicrotask(() => setChannel("last"));
      return;
    }
    if (deliveryMode !== "announce") {
      queueMicrotask(() => setCustomTo(deliveryMode === "webhook"));
      return;
    }
    queueMicrotask(() => {
      setCustomTo(false);
      if (to && !targetMatchesChannel(to, channel)) setTo("");
    });
  }, [channel, deliveryMode, to]);

  const readyChannels = useMemo(() => {
    return channels.filter((ch) => isReadyChannel(ch));
  }, [channels]);
  const readyChannelKeys = useMemo(
    () => new Set(readyChannels.map((c) => c.channel)),
    [readyChannels]
  );

  const filteredTargets = useMemo(() => {
    if (deliveryMode !== "announce") return [];
    const base = knownTargets.filter(
      (t) => {
        const knownChannel = t.channel || inferChannelFromTarget(t.target);
        if (!knownChannel) return true;
        if (knownChannel === "phone") {
          return readyChannelKeys.has("whatsapp") || readyChannelKeys.has("signal");
        }
        return readyChannelKeys.has(knownChannel);
      }
    );
    if (!channel || channel === "last") return base;
    return base.filter((t) => {
      const knownChannel = t.channel || inferChannelFromTarget(t.target);
      if (!knownChannel) return true;
      if (knownChannel === "phone") {
        return channel === "whatsapp" || channel === "signal";
      }
      return knownChannel === channel;
    });
  }, [channel, deliveryMode, knownTargets, readyChannelKeys]);

  useEffect(() => {
    if (deliveryMode === "webhook") {
      queueMicrotask(() => setCustomTo(true));
      return;
    }
    if (deliveryMode !== "announce") return;
    if (!targetsLoading && to && filteredTargets.length > 0) {
      const found = filteredTargets.some((t) => t.target === to);
      if (!found) queueMicrotask(() => setCustomTo(true));
    }
    if (!targetsLoading && filteredTargets.length === 0) {
      queueMicrotask(() => setCustomTo(true));
    }
  }, [deliveryMode, targetsLoading, to, filteredTargets]);

  const save = async () => {
    const updates: Record<string, unknown> = {};
    if (name !== job.name) updates.name = name;
    if (agentId !== (job.agentId || "main")) updates.agentId = agentId;
    if (message !== (job.payload.message || "")) updates.message = message;
    if (schedType === "cron" && cronExpr !== (job.schedule.expr || ""))
      updates.cron = cronExpr;
    if (schedType === "every" && everyVal) updates.every = everyVal;
    if (tz && tz !== (job.schedule.tz || "")) updates.tz = tz;
    if (model !== (job.payload.model || "")) updates.model = model;

    const currentDeliveryMode = normalizeDeliveryMode(job.delivery.mode);
    const currentChannel = currentDeliveryMode === "announce" ? job.delivery.channel || "last" : "";
    const currentTo = job.delivery.to || "";
    const currentBestEffort = Boolean(job.delivery.bestEffort);
    if (
      deliveryMode !== currentDeliveryMode ||
      (deliveryMode === "announce" && channel !== currentChannel) ||
      (deliveryMode !== "none" && to !== currentTo) ||
      (deliveryMode !== "none" && bestEffort !== currentBestEffort)
    ) {
      updates.deliveryMode = deliveryMode;
      updates.channel = deliveryMode === "announce" ? channel : "";
      updates.to = deliveryMode === "none" ? "" : to;
      updates.bestEffort = deliveryMode === "none" ? false : bestEffort;
    }

    setSaving(true);
    try {
      await onSave(updates);
    } finally {
      setSaving(false);
    }
  };

  const deliveryNote = getDeliveryNote(deliveryMode, channel, to);
  const saveDisabled =
    saving ||
    (deliveryMode === "announce" && !to.trim()) ||
    (deliveryMode === "webhook" && !isValidWebhookUrl(to.trim()));

  return (
    <div className="border-t border-foreground/10 bg-card/70 px-4 py-4 space-y-4">
      {/* Name */}
      <div>
        <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-success-border"
        />
      </div>

      {/* Agent */}
      {agents.length > 1 && (
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Agent
          </label>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground outline-none focus:border-success-border"
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name || a.id}</option>
            ))}
          </select>
        </div>
      )}

      {/* Prompt / Message — editable with auto-save like /documents */}
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Prompt / Message
          </label>
          {onMessageAutoSave && messageSaveStatus && (
            <span className={cn(
              "text-xs",
              messageSaveStatus === "saving" && "text-warning-fg",
              messageSaveStatus === "saved" && "text-success-fg",
              messageSaveStatus === "unsaved" && "text-muted-foreground"
            )}>
              {messageSaveStatus === "saving" && "Saving…"}
              {messageSaveStatus === "saved" && "Saved"}
              {messageSaveStatus === "unsaved" && "Unsaved"}
            </span>
          )}
        </div>
        <textarea
          value={message}
          onChange={(e) => {
            const val = e.target.value;
            setMessage(val);
            if (!onMessageAutoSave) return;
            setMessageSaveStatus("unsaved");
            if (messageSaveTimeoutRef.current) clearTimeout(messageSaveTimeoutRef.current);
            messageSaveTimeoutRef.current = setTimeout(async () => {
              messageSaveTimeoutRef.current = null;
              setMessageSaveStatus("saving");
              try {
                await onMessageAutoSave(val);
                setMessageSaveStatus("saved");
                setTimeout(() => setMessageSaveStatus(null), 2000);
              } catch {
                setMessageSaveStatus("unsaved");
              }
            }, 400);
          }}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              if (!onMessageAutoSave) return;
              if (messageSaveTimeoutRef.current) {
                clearTimeout(messageSaveTimeoutRef.current);
                messageSaveTimeoutRef.current = null;
              }
              setMessageSaveStatus("saving");
              onMessageAutoSave(message).then(() => {
                setMessageSaveStatus("saved");
                setTimeout(() => setMessageSaveStatus(null), 2000);
              }).catch(() => setMessageSaveStatus("unsaved"));
            }
          }}
          rows={5}
          aria-label="Prompt / Message"
          className="w-full resize-y rounded-lg border border-border bg-muted px-3 py-2 text-xs leading-5 text-foreground outline-none focus:border-success-border"
          placeholder="Instructions or prompt for the agent run…"
        />
      </div>

      {/* Schedule */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Schedule Type
          </label>
          <select
            value={schedType}
            onChange={(e) => setSchedType(e.target.value)}
            className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
          >
            <option value="cron">Cron Expression</option>
            <option value="every">Interval</option>
          </select>
        </div>
        <div>
          {schedType === "cron" ? (
            <>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Cron Expression
              </label>
              <input
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="0 8 * * *"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
              />
            </>
          ) : (
            <>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Interval
              </label>
              <input
                value={everyVal}
                onChange={(e) => setEveryVal(e.target.value)}
                placeholder="5m, 1h, 30s"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
              />
            </>
          )}
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Timezone
          </label>
          <input
            value={tz}
            onChange={(e) => setTz(e.target.value)}
            placeholder="Europe/Warsaw"
            className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-success-border"
          />
        </div>
      </div>

      {/* Delivery */}
      <div>
        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Send className="h-3 w-3" />
          Delivery Configuration
        </label>
        <div className="rounded-lg border border-foreground/10 bg-muted/50 p-3 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Mode
              </label>
              <select
                value={deliveryMode}
                onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}
                className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
              >
                <option value="announce">Announce (send summary)</option>
                <option value="webhook">Webhook</option>
                <option value="none">No delivery</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                Channel
              </label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value)}
                disabled={deliveryMode !== "announce"}
                className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none disabled:opacity-40"
              >
                <option value="last">Last route</option>
                {readyChannels.map((ch, index) => (
                  <option key={`${ch.channel}:${ch.label}:${index}`} value={ch.channel}>
                    {ch.label || ch.channel}
                  </option>
                ))}
                {channel && channel !== "last" && !readyChannelKeys.has(channel) && (
                  <option value={channel}>
                    {channel} (currently unavailable)
                  </option>
                )}
              </select>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between gap-2">
                <label className="block text-xs text-muted-foreground">
                  {getRecipientLabel(deliveryMode)}
                </label>
                {deliveryMode === "announce" && (
                  <button
                    type="button"
                    onClick={() => fetchTargets()}
                    disabled={targetsLoading}
                    className="shrink-0 text-xs text-success-fg hover:text-success-fg disabled:opacity-50"
                  >
                    {targetsLoading ? "Refreshing…" : "Refresh targets"}
                  </button>
                )}
              </div>
              {deliveryMode === "none" ? (
                <input
                  disabled
                  value=""
                  placeholder="—"
                  aria-label="Recipient (no delivery)"
                  className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 font-mono text-xs text-foreground outline-none disabled:opacity-40"
                />
              ) : deliveryMode === "webhook" ? (
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder={getRecipientPlaceholder(deliveryMode, channel)}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                  aria-label="Webhook URL"
                />
              ) : targetsLoading && knownTargets.length === 0 ? (
                <div className="flex h-9 items-center rounded-lg border border-foreground/10 bg-muted/80 px-3">
                  <InlineSpinner size="sm" />
                </div>
              ) : (
                <div className="space-y-1.5">
                  <select
                    value={customTo ? "__custom__" : to}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === "__custom__") {
                        setCustomTo(true);
                      } else {
                        setCustomTo(false);
                        setTo(v);
                        const selected = knownTargets.find((target) => target.target === v);
                        if (selected?.channel) setChannel(selected.channel);
                      }
                    }}
                    aria-label="Select recipient"
                    className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                  >
                    <option value="">Select recipient…</option>
                    {filteredTargets.map((t) => (
                      <option key={t.target} value={t.target}>
                        {t.target} ({t.source})
                      </option>
                    ))}
                    <option value="__custom__">
                      {channel
                        ? `Enter ${channel} ID manually…`
                        : "Enter channel ID manually…"}
                    </option>
                  </select>
                  {customTo && (
                    <input
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      placeholder={getRecipientPlaceholder(deliveryMode, channel)}
                      className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                      aria-label="Recipient (e.g. discord:CHANNEL_ID)"
                    />
                  )}
                  {!customTo && to && (
                    <p className="text-xs text-success-fg">
                      <CheckCircle className="mr-1 inline h-2.5 w-2.5" />
                      Target set: <code className="text-success-fg">{to}</code>
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {deliveryMode !== "none" && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={bestEffort}
                onChange={(e) => setBestEffort(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-foreground/20 bg-muted/80 text-success-fg focus:ring-success-border"
              />
              <span className="text-xs text-muted-foreground">
                Best effort delivery (don&apos;t fail the job if delivery fails)
              </span>
            </label>
          )}

          {deliveryNote && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-lg px-3 py-2",
                deliveryNote.tone === "warning" ? "bg-warning-bg" : "bg-info-bg"
              )}
            >
              {deliveryNote.tone === "warning" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-fg" />
              ) : (
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info-fg" />
              )}
              <p
                className={cn(
                  "text-xs",
                  deliveryNote.tone === "warning"
                    ? "text-warning-fg"
                    : "text-info-fg"
                )}
              >
                {deliveryNote.message}
              </p>
            </div>
          )}

          {customTo && deliveryMode === "announce" && (
            <p className="text-xs text-muted-foreground">
              Format: <code className="text-muted-foreground">telegram:CHAT_ID</code>,{" "}
              <code className="text-muted-foreground">+15555550123</code> (WhatsApp),{" "}
              <code className="text-muted-foreground">discord:CHANNEL_ID</code>
            </p>
          )}
        </div>
      </div>

      {/* Model override */}
      <div>
        <label className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <Cpu className="h-3 w-3" />
          Model Override
          <span className="font-normal normal-case text-muted-foreground">
            (optional — leave blank for default)
          </span>
        </label>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-success-border"
        >
          <option value="">Default (no override)</option>
          {(() => {
            const opts = getModelOptions();
            const groups = new Map<string, typeof opts>();
            for (const o of opts) {
              if (!groups.has(o.provider)) groups.set(o.provider, []);
              groups.get(o.provider)!.push(o);
            }
            // If current model isn't in the known list, add it as a fallback
            if (model && !opts.some((o) => o.key === model)) {
              return (
                <>
                  <option value={model}>{getFriendlyModelName(model)}</option>
                  {[...groups.entries()].map(([provider, models]) => (
                    <optgroup key={provider} label={provider}>
                      {models.map((m) => (
                        <option key={m.key} value={m.key}>{m.displayName}</option>
                      ))}
                    </optgroup>
                  ))}
                </>
              );
            }
            return [...groups.entries()].map(([provider, models]) => (
              <optgroup key={provider} label={provider}>
                {models.map((m) => (
                  <option key={m.key} value={m.key}>{m.displayName}</option>
                ))}
              </optgroup>
            ));
          })()}
        </select>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {confirmDel ? (
          <>
            <button
              type="button"
              onClick={async () => {
                setDeleting(true);
                try {
                  await onDelete();
                } finally {
                  setDeleting(false);
                }
              }}
              disabled={deleting}
              className="rounded-full bg-destructive px-3 py-1.5 text-xs font-medium text-white hover:bg-destructive/88"
            >
              {deleting ? "Deleting..." : "Confirm Delete"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDel(false)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => setConfirmDel(true)}
            className="flex items-center gap-1 rounded p-1.5 text-muted-foreground hover:bg-danger-bg hover:text-danger-fg"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={save}
          disabled={saveDisabled}
          className="flex items-center gap-1 rounded bg-primary text-primary-foreground px-4 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Check className="h-3 w-3" /> {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

/* ── Schedule options: friendly labels + cron/interval ──────────────── */

type ScheduleOption =
  | { id: string; label: string; kind: "cron"; expr: string }
  | { id: string; label: string; kind: "every"; interval: string }
  | { id: string; label: string; kind: "at" }
  | { id: string; label: string; kind: "custom" };

const SCHEDULE_SIMPLE_OPTIONS: ScheduleOption[] = [
  { id: "daily-8am", label: "Every day at 8:00 AM", kind: "cron", expr: "0 8 * * *" },
  { id: "daily-6pm", label: "Every day at 6:00 PM", kind: "cron", expr: "0 18 * * *" },
  { id: "monday-9am", label: "Every Monday at 9:00 AM", kind: "cron", expr: "0 9 * * 1" },
  { id: "weekdays-noon", label: "Weekdays at noon", kind: "cron", expr: "0 12 * * 1-5" },
  { id: "twice-day", label: "Twice a day (8am & 8pm)", kind: "cron", expr: "0 8,20 * * *" },
  { id: "every-hour", label: "Every hour", kind: "every", interval: "1h" },
  { id: "every-6h", label: "Every 6 hours", kind: "cron", expr: "0 */6 * * *" },
  { id: "every-12h", label: "Every 12 hours", kind: "cron", expr: "0 */12 * * *" },
  { id: "every-30m", label: "Every 30 minutes", kind: "every", interval: "30m" },
  { id: "every-5m", label: "Every 5 minutes", kind: "every", interval: "5m" },
  { id: "at", label: "Run once at a specific time", kind: "at" },
  { id: "custom", label: "Custom schedule (advanced)", kind: "custom" },
];

/* ── Timezone suggestions ────────────────────────── */

const TZ_SUGGESTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Warsaw",
  "Europe/Rome",
  "Asia/Tokyo",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/* ── Create Cron Job Form ────────────────────────── */

function CreateCronForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  // ── Step management ──
  const [step, setStep] = useState(1); // 1=basics, 2=schedule, 3=payload, 4=delivery, 5=review
  const totalSteps = 5;

  // ── Form state ──
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agent, setAgent] = useState("main");
  const [scheduleKind, setScheduleKind] = useState<"cron" | "every" | "at">("cron");
  const [cronExpr, setCronExpr] = useState("0 8 * * *");
  const [everyInterval, setEveryInterval] = useState("1h");
  const [atTime, setAtTime] = useState("");
  const [tz, setTz] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  /** Which simple schedule option is selected (id from SCHEDULE_SIMPLE_OPTIONS); "custom" shows advanced form. */
  const [simpleScheduleOption, setSimpleScheduleOption] = useState<string>("daily-8am");
  const [sessionTarget, setSessionTarget] = useState<"main" | "isolated">("isolated");
  const [payloadKind, setPayloadKind] = useState<"agentTurn" | "systemEvent">("agentTurn");
  const [message, setMessage] = useState("");
  const [model, setModel] = useState("");
  const [thinking, setThinking] = useState("");
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>("announce");
  const [channel, setChannel] = useState("last");
  const [to, setTo] = useState("");
  const [bestEffort, setBestEffort] = useState(true);
  const [deleteAfterRun, setDeleteAfterRun] = useState(false);
  const [customTo, setCustomTo] = useState(false);

  // ── Data loading ──
  const [agents, setAgents] = useState<{ id: string; name?: string }[]>([]);
  const [knownTargets, setKnownTargets] = useState<KnownTarget[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTargetsCreate = useCallback(async () => {
    setTargetsLoading(true);
    try {
      const [targetsRes, channelsRes] = await Promise.all([
        fetch("/api/cron?action=targets", { cache: "no-store" }),
        fetch("/api/channels?scope=all", { cache: "no-store" }),
      ]);
      const targetsData = await targetsRes.json();
      const channelsData = await channelsRes.json();
      setKnownTargets(targetsData.targets || []);
      setChannels((channelsData.channels || []) as ChannelInfo[]);
    } catch { /* ignore */ }
    setTargetsLoading(false);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/agents");
        const data = await res.json();
        const agentList = (data.agents || []).map((a: Record<string, unknown>) => ({
          id: a.id as string,
          name: a.name as string | undefined,
        }));
        setAgents(agentList);
        if (agentList.length === 1) setAgent(agentList[0].id);
      } catch { /* ignore */ }
    })();
    void fetchTargetsCreate();
  }, [fetchTargetsCreate]);

  useEffect(() => {
    if (deliveryMode === "announce" && !channel) {
      queueMicrotask(() => setChannel("last"));
      return;
    }
    if (deliveryMode !== "announce") {
      queueMicrotask(() => setCustomTo(deliveryMode === "webhook"));
      return;
    }
    queueMicrotask(() => {
      setCustomTo(false);
      if (to && !targetMatchesChannel(to, channel)) setTo("");
    });
  }, [channel, deliveryMode, to]);

  const readyChannels = useMemo(() => {
    return channels.filter((ch) => isReadyChannel(ch));
  }, [channels]);
  const readyChannelKeys = useMemo(
    () => new Set(readyChannels.map((c) => c.channel)),
    [readyChannels]
  );

  const filteredTargets = useMemo(() => {
    if (deliveryMode !== "announce") return [];
    const base = knownTargets.filter(
      (t) => {
        const knownChannel = t.channel || inferChannelFromTarget(t.target);
        if (!knownChannel) return true;
        if (knownChannel === "phone") {
          return readyChannelKeys.has("whatsapp") || readyChannelKeys.has("signal");
        }
        return readyChannelKeys.has(knownChannel);
      }
    );
    if (!channel || channel === "last") return base;
    return base.filter((t) => {
      const knownChannel = t.channel || inferChannelFromTarget(t.target);
      if (!knownChannel) return true;
      if (knownChannel === "phone") {
        return channel === "whatsapp" || channel === "signal";
      }
      return knownChannel === channel;
    });
  }, [channel, deliveryMode, knownTargets, readyChannelKeys]);

  // Auto-set deleteAfterRun for "at" schedules
  useEffect(() => {
    if (scheduleKind === "at") setDeleteAfterRun(true);
  }, [scheduleKind]);

  // Auto-set session + delivery when payload kind changes
  useEffect(() => {
    if (payloadKind === "systemEvent") {
      setSessionTarget("main");
      setDeliveryMode("none");
    }
  }, [payloadKind]);

  useEffect(() => {
    if (sessionTarget !== "isolated" && deliveryMode === "announce") {
      queueMicrotask(() => setDeliveryMode("none"));
    }
  }, [deliveryMode, sessionTarget]);

  useEffect(() => {
    if (deliveryMode === "webhook") {
      queueMicrotask(() => setCustomTo(true));
      return;
    }
    if (deliveryMode !== "announce") return;
    if (!targetsLoading && to && filteredTargets.length > 0) {
      const found = filteredTargets.some((t) => t.target === to);
      if (!found) queueMicrotask(() => setCustomTo(true));
    }
    if (!targetsLoading && filteredTargets.length === 0) {
      queueMicrotask(() => setCustomTo(true));
    }
  }, [deliveryMode, filteredTargets, targetsLoading, to]);

  const canAdvance = (): boolean => {
    switch (step) {
      case 1: return name.trim().length > 0;
      case 2:
        if (scheduleKind === "cron") return cronExpr.trim().length > 0;
        if (scheduleKind === "every") return everyInterval.trim().length > 0;
        if (scheduleKind === "at") return atTime.trim().length > 0;
        return false;
      case 3: return message.trim().length > 0;
      case 4:
        if (deliveryMode === "announce") return to.trim().length > 0;
        if (deliveryMode === "webhook") return isValidWebhookUrl(to.trim());
        return true;
      default: return true;
    }
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          name: name.trim(),
          description: description.trim() || undefined,
          agent,
          scheduleKind,
          cronExpr: scheduleKind === "cron" ? cronExpr.trim() : undefined,
          everyInterval: scheduleKind === "every" ? everyInterval.trim() : undefined,
          atTime: scheduleKind === "at" ? atTime.trim() : undefined,
          tz: tz || undefined,
          sessionTarget,
          payloadKind,
          message: message.trim(),
          model: model.trim() || undefined,
          thinking: thinking || undefined,
          deliveryMode,
          channel: deliveryMode === "announce" ? channel : undefined,
          to: deliveryMode !== "none" ? to || undefined : undefined,
          bestEffort: deliveryMode !== "none" ? bestEffort : undefined,
          deleteAfterRun: scheduleKind === "at" ? deleteAfterRun : undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        onCreated();
      } else {
        setError(data.error || "Failed to create cron job");
      }
    } catch (err) {
      setError(String(err));
    }
    setSubmitting(false);
  };

  const deliveryNote = getDeliveryNote(deliveryMode, channel, to);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      {/* Wizard header */}
      <div className="flex items-center justify-between border-b border-border bg-muted px-4 py-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-4 w-4 text-fg-secondary" />
          <h3 className="text-sm font-semibold text-foreground">New Cron Job</h3>
        </div>
        <div className="flex items-center gap-3">
          {/* Step indicator */}
          <div className="flex items-center gap-1">
            {Array.from({ length: totalSteps }, (_, i) => (
              <div
                key={i}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i + 1 === step ? "w-4 bg-success" : i + 1 < step ? "w-1.5 bg-success-bg" : "w-1.5 bg-secondary"
                )}
              />
            ))}
          </div>
          <span className="text-xs text-muted-foreground">Step {step}/{totalSteps}</span>
          <button type="button" onClick={onCancel} className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="px-4 py-4 space-y-4">
        {/* ── Step 1: Basics ── */}
        {step === 1 && (
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1">What should we call this job?</h4>
              <p className="text-xs text-muted-foreground mb-3">Give it a descriptive name so you can easily find it later.</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Morning Brief, Daily Sync, Weekly Report..."
                aria-label="Job name"
                className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 text-sm text-foreground outline-none focus:border-success-border"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Description <span className="font-normal normal-case">(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                aria-label="Job description"
                placeholder="Explain the purpose, context, or expected outcome of this job..."
                className="min-h-28 w-full resize-y rounded-lg border border-border bg-muted px-3 py-2.5 text-sm leading-5 text-foreground outline-none focus:border-success-border"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                This helps you recognize the job. You will write the instructions the agent follows in Step 3.
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Agent</label>
              <select
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
                className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
              >
                {agents.length === 0 && <option value="main">main</option>}
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>{a.name || a.id}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* ── Step 2: Schedule ── */}
        {step === 2 && (
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1">How often should it run?</h4>
              <p className="text-xs text-muted-foreground mb-3">Choose a schedule below. Timezone applies to daily/weekly times.</p>
            </div>

            {/* Friendly schedule options (cards) */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-64 overflow-y-auto pr-1">
              {SCHEDULE_SIMPLE_OPTIONS.map((opt) => {
                const isSelected = simpleScheduleOption === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => {
                      setSimpleScheduleOption(opt.id);
                      if (opt.kind === "cron" && "expr" in opt) {
                        setScheduleKind("cron");
                        setCronExpr(opt.expr);
                      } else if (opt.kind === "every" && "interval" in opt) {
                        setScheduleKind("every");
                        setEveryInterval(opt.interval);
                      } else if (opt.kind === "at") {
                        setScheduleKind("at");
                      }
                      // "custom" leaves kind/expr/interval as-is and shows advanced form
                    }}
                    className={cn(
                      "rounded-lg border px-3 py-2.5 text-left text-xs transition-colors",
                      isSelected
                        ? "border-success-border bg-success-bg text-success-fg"
                        : "border-border bg-muted text-fg-secondary hover:bg-muted hover:text-foreground dark:text-muted-foreground dark:hover:bg-secondary"
                    )}
                  >
                    {scheduleOptionLabel(opt, timeFormat)}
                  </button>
                );
              })}
            </div>

            {/* Run once: show datetime picker */}
            {simpleScheduleOption === "at" && (
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Run at</label>
                <input
                  type="datetime-local"
                  value={atTime}
                  onChange={(e) => setAtTime(e.target.value)}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-success-border"
                />
              </div>
            )}

            {/* Custom: show type + cron/interval input */}
            {simpleScheduleOption === "custom" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-lg border border-foreground/10 bg-muted/30 p-3">
                <div>
                  <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Type</label>
                  <select
                    value={scheduleKind}
                    onChange={(e) => setScheduleKind(e.target.value as "cron" | "every" | "at")}
                    className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
                  >
                    <option value="cron">Cron expression</option>
                    <option value="every">Every X (interval)</option>
                    <option value="at">One-shot (run once)</option>
                  </select>
                </div>
                <div>
                  {scheduleKind === "cron" && (
                    <>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Cron</label>
                      <input
                        value={cronExpr}
                        onChange={(e) => setCronExpr(e.target.value)}
                        placeholder="0 8 * * *"
                        className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                      />
                    </>
                  )}
                  {scheduleKind === "every" && (
                    <>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Interval</label>
                      <input
                        value={everyInterval}
                        onChange={(e) => setEveryInterval(e.target.value)}
                        placeholder="5m, 1h"
                        className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                      />
                    </>
                  )}
                  {scheduleKind === "at" && (
                    <>
                      <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Run at</label>
                      <input
                        type="datetime-local"
                        value={atTime}
                        onChange={(e) => setAtTime(e.target.value)}
                        className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Timezone (always) */}
            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Timezone</label>
              <select
                value={tz}
                onChange={(e) => setTz(e.target.value)}
                className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
              >
                {TZ_SUGGESTIONS.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
                {!TZ_SUGGESTIONS.includes(tz) && tz && (
                  <option value={tz}>{tz}</option>
                )}
              </select>
            </div>
          </div>
        )}

        {/* ── Step 3: Payload ── */}
        {step === 3 && (
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1">What should the agent do?</h4>
              <p className="text-xs text-muted-foreground mb-3">Write a prompt for the agent. Be specific about what you want.</p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Payload Type</label>
                <select
                  value={payloadKind}
                  onChange={(e) => setPayloadKind(e.target.value as "agentTurn" | "systemEvent")}
                  className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
                >
                  <option value="agentTurn">Agent Turn (isolated task)</option>
                  <option value="systemEvent">System Event (main session)</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {payloadKind === "agentTurn"
                    ? "Runs in an isolated session — best for tasks with delivery"
                    : "Runs in the main session — best for internal updates"}
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Session</label>
                <select
                  value={sessionTarget}
                  onChange={(e) => setSessionTarget(e.target.value as "main" | "isolated")}
                  disabled={payloadKind === "systemEvent"}
                  className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none disabled:opacity-40"
                >
                  <option value="isolated">Isolated (recommended)</option>
                  <option value="main">Main</option>
                </select>
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {payloadKind === "agentTurn" ? "Agent Prompt" : "System Event Text"}
              </label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={8}
                aria-label={payloadKind === "agentTurn" ? "Agent Prompt" : "System Event Text"}
                placeholder={
                  payloadKind === "agentTurn"
                    ? "e.g. Summarize the latest news and send me a brief update..."
                    : "e.g. Time to run the daily health check."
                }
                className="min-h-48 w-full resize-y rounded-lg border border-border bg-muted px-3 py-2.5 text-sm leading-6 text-foreground outline-none focus:border-success-border"
                autoFocus
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <Cpu className="h-3 w-3" />
                  Model Override <span className="font-normal normal-case">(optional)</span>
                </label>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="w-full rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-success-border"
                >
                  <option value="">Default (no override)</option>
                  {(() => {
                    const opts = getModelOptions();
                    const groups = new Map<string, typeof opts>();
                    for (const o of opts) {
                      if (!groups.has(o.provider)) groups.set(o.provider, []);
                      groups.get(o.provider)!.push(o);
                    }
                    return [...groups.entries()].map(([provider, models]) => (
                      <optgroup key={provider} label={provider}>
                        {models.map((m) => (
                          <option key={m.key} value={m.key}>{m.displayName}</option>
                        ))}
                      </optgroup>
                    ));
                  })()}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Thinking Level <span className="font-normal normal-case">(optional)</span>
                </label>
                <select
                  value={thinking}
                  onChange={(e) => setThinking(e.target.value)}
                  className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
                >
                  <option value="">Default</option>
                  <option value="off">Off</option>
                  <option value="minimal">Minimal</option>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="xhigh">Extra High</option>
                </select>
              </div>
            </div>
          </div>
        )}

        {/* ── Step 4: Delivery ── */}
        {step === 4 && (
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1">Where should results be delivered?</h4>
              <p className="text-xs text-muted-foreground mb-3">
                {sessionTarget === "isolated"
                  ? "Isolated jobs can announce to a channel or post to a webhook."
                  : "Main session jobs usually do not need delivery, but webhook delivery is available if you want an external callback."}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Mode</label>
                <select
                  value={deliveryMode}
                  onChange={(e) => setDeliveryMode(e.target.value as DeliveryMode)}
                  className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none"
                >
                  {sessionTarget === "isolated" && (
                    <option value="announce">Announce (send summary)</option>
                  )}
                  <option value="webhook">Webhook</option>
                  <option value="none">No delivery</option>
                </select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium uppercase tracking-wider text-muted-foreground">Channel</label>
                <select
                  value={channel}
                  onChange={(e) => setChannel(e.target.value)}
                  disabled={deliveryMode !== "announce"}
                  className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 text-xs text-foreground outline-none disabled:opacity-40"
                >
                  <option value="last">Last route</option>
                  {readyChannels.map((ch, index) => (
                    <option key={`${ch.channel}:${ch.label}:${index}`} value={ch.channel}>
                      {ch.label || ch.channel}
                    </option>
                  ))}
                  {channel && channel !== "last" && !readyChannelKeys.has(channel) && (
                    <option value={channel}>
                      {channel} (currently unavailable)
                    </option>
                  )}
                </select>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {getRecipientLabel(deliveryMode)}
                  </label>
                  {deliveryMode === "announce" && (
                    <button
                      type="button"
                      onClick={() => fetchTargetsCreate()}
                      disabled={targetsLoading}
                      className="shrink-0 text-xs text-success-fg hover:text-success-fg disabled:opacity-50"
                    >
                      {targetsLoading ? "Refreshing…" : "Refresh targets"}
                    </button>
                  )}
                </div>
                {deliveryMode === "none" ? (
                  <input disabled value="" placeholder="—" aria-label="Recipient (no delivery)" className="w-full rounded-lg border border-foreground/10 bg-muted/80 px-3 py-2 font-mono text-xs text-foreground outline-none disabled:opacity-40" />
                ) : deliveryMode === "webhook" ? (
                  <input
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    placeholder={getRecipientPlaceholder(deliveryMode, channel)}
                    className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                    aria-label="Webhook URL"
                  />
                ) : targetsLoading && knownTargets.length === 0 ? (
                  <div className="flex h-9 items-center rounded-lg border border-foreground/10 bg-muted/80 px-3">
                    <InlineSpinner size="sm" />
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <select
                      value={customTo ? "__custom__" : to}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "__custom__") setCustomTo(true);
                        else {
                          setCustomTo(false);
                          setTo(v);
                          const selected = knownTargets.find((target) => target.target === v);
                          if (selected?.channel) setChannel(selected.channel);
                        }
                      }}
                      aria-label="Select recipient"
                      className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                    >
                      <option value="">Select recipient…</option>
                      {filteredTargets.map((t) => (
                        <option key={t.target} value={t.target}>{t.target} ({t.source})</option>
                      ))}
                      <option value="__custom__">
                        {channel ? `Enter ${channel} ID manually…` : "Enter channel ID manually…"}
                      </option>
                    </select>
                    {customTo && (
                      <input
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                        placeholder={getRecipientPlaceholder(deliveryMode, channel)}
                        className="w-full rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-success-border"
                        aria-label="Recipient (e.g. discord:CHANNEL_ID)"
                      />
                    )}
                    {!customTo && to && (
                      <p className="text-xs text-success-fg">
                        <CheckCircle className="mr-1 inline h-2.5 w-2.5" />
                        Target set: <code className="text-success-fg">{to}</code>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>

            {deliveryMode !== "none" && (
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bestEffort}
                  onChange={(e) => setBestEffort(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-foreground/20 bg-muted/80 text-success-fg focus:ring-success-border"
                />
                <span className="text-xs text-muted-foreground">Best effort delivery (don&apos;t fail the job if delivery fails)</span>
              </label>
            )}

            {deliveryNote && (
              <div
                className={cn(
                  "flex items-start gap-2 rounded-lg px-3 py-2",
                  deliveryNote.tone === "warning" ? "bg-warning-bg" : "bg-info-bg"
                )}
              >
                {deliveryNote.tone === "warning" ? (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-fg" />
                ) : (
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-info-fg" />
                )}
                <p
                  className={cn(
                    "text-xs",
                    deliveryNote.tone === "warning"
                      ? "text-warning-fg"
                      : "text-info-fg"
                  )}
                >
                  {deliveryNote.message}
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Step 5: Review ── */}
        {step === 5 && (
          <div className="space-y-4">
            <div>
              <h4 className="text-xs font-medium text-foreground mb-1">Review &amp; Create</h4>
              <p className="text-xs text-muted-foreground mb-3">Double-check everything looks good before creating.</p>
            </div>

            <div className="rounded-lg border border-foreground/5 bg-muted/40 divide-y divide-foreground/5">
              {/* Name */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-muted-foreground">Name</span>
                <span className="text-xs font-medium text-foreground">{name}</span>
              </div>
              {/* Agent */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-muted-foreground">Agent</span>
                <span className="text-xs text-foreground">{agent}</span>
              </div>
              {/* Schedule */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-muted-foreground">Schedule</span>
                <span className="text-xs text-foreground">
                  {simpleScheduleOption !== "custom" && simpleScheduleOption !== "at"
                    ? (() => {
                        const opt = SCHEDULE_SIMPLE_OPTIONS.find((o) => o.id === simpleScheduleOption);
                        return opt ? scheduleOptionLabel(opt, timeFormat) : (scheduleKind === "cron" ? cronToHuman(cronExpr, timeFormat) : `Every ${everyInterval}`);
                      })()
                    : scheduleKind === "cron"
                      ? cronToHuman(cronExpr, timeFormat)
                      : scheduleKind === "every"
                        ? `Every ${everyInterval}`
                        : atTime}
                  {tz && <span className="text-muted-foreground"> ({tz})</span>}
                </span>
              </div>
              {/* Session */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-muted-foreground">Session</span>
                <span className="text-xs text-foreground">{sessionTarget}</span>
              </div>
              {/* Prompt */}
              <div className="px-3 py-2.5">
                <span className="text-xs text-muted-foreground">Prompt</span>
                <p className="mt-1 whitespace-pre-wrap rounded bg-muted/60 p-2 text-xs leading-5 text-foreground">{message}</p>
              </div>
              {/* Model */}
              {model && (
                <div className="flex items-center justify-between px-3 py-2.5">
                  <span className="text-xs text-muted-foreground">Model Override</span>
                  <span className="text-xs font-mono text-success-fg">{model}</span>
                </div>
              )}
              {/* Delivery */}
              <div className="flex items-center justify-between px-3 py-2.5">
                <span className="text-xs text-muted-foreground">Delivery</span>
                <span className="text-xs text-foreground">
                  {deliveryMode === "none" ? (
                    "No delivery"
                  ) : deliveryMode === "webhook" ? (
                    <>Webhook → {to || <span className="text-warning-fg">not set</span>}</>
                  ) : (
                    <>
                      {getDeliveryChannelLabel(channel)} →{" "}
                      {to || <span className="text-info-fg">last route fallback</span>}
                    </>
                  )}
                </span>
              </div>
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-danger-border bg-danger-bg px-3 py-2.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-fg" />
                <p className="text-xs text-danger-fg">{error}</p>
              </div>
            )}
          </div>
        )}

        {/* ── Navigation ── */}
        <div className="flex items-center gap-2 pt-2 border-t border-foreground/5">
          {step > 1 && (
            <button
              type="button"
              onClick={() => setStep(step - 1)}
              className="rounded px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              ← Back
            </button>
          )}
          <div className="flex-1" />
          {step < totalSteps ? (
            <button
              type="button"
              onClick={() => setStep(step + 1)}
              disabled={!canAdvance()}
              className="flex items-center gap-1 rounded bg-primary text-primary-foreground px-4 py-1.5 text-xs font-medium transition-colors hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={submitting}
              className="flex items-center gap-1 rounded-full bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-70"
            >
              {submitting ? (
                <>
                  <span className="inline-flex items-center gap-0.5">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span> Creating...
                </>
              ) : (
                <>
                  <Check className="h-3 w-3" /> Create Cron Job
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Main CronView ───────────────────────────────── */

export function CronView() {
  const searchParams = useSearchParams();
  const showMode = searchParams.get("show"); // "errors" to auto-expand first error
  const targetJobId = searchParams.get("job");
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchFilter, setSearchFilter] = useState("");
  const [sortBy, setSortBy] = useState<"name" | "status" | "next" | "last">("next");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, RunEntry[]>>({});
  const [runsLoading, setRunsLoading] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [runOutput, setRunOutput] = useState<Record<string, RunOutputState>>({});
  const [runOutputCollapsed, setRunOutputCollapsed] = useState<
    Record<string, boolean>
  >({});
  const runOutputRef = useRef<HTMLPreElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runOutputStateRef = useRef<Record<string, RunOutputState>>({});
  const didAutoExpand = useRef(false);
  const didAutoFocusJob = useRef<string | null>(null);

  const flash = useCallback(
    (message: string, type: "success" | "error" = "success") => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      setToast({ message, type });
      toastTimer.current = setTimeout(() => setToast(null), 4000);
    },
    []
  );

  const fetchJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/cron");
      const data = await res.json();
      const incoming = Array.isArray(data.jobs) ? (data.jobs as CronJob[]) : [];
      // Some older cron jobs may not have delivery fields; normalize to avoid UI crashes.
      setJobs(
        incoming.map((job) => ({
          ...job,
          delivery:
            job.delivery && typeof job.delivery === "object"
              ? job.delivery
              : { mode: "none" },
          payload:
            job.payload && typeof job.payload === "object"
              ? job.payload
              : { kind: "agentTurn" },
          schedule:
            job.schedule && typeof job.schedule === "object"
              ? job.schedule
              : { kind: "cron" as const, expr: "* * * * *" },
          state:
            job.state && typeof job.state === "object"
              ? job.state
              : {},
        })),
      );
    } catch {
      /* ignore */
    }
    setLoading(false);
  }, []);

  const saveCronField = useCallback(
    async (jobId: string, updates: Record<string, unknown>) => {
      const res = await fetch("/api/cron", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", id: jobId, ...updates }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error((data.error as string) || "Save failed");
      await fetchJobs();
    },
    [fetchJobs]
  );

  useEffect(() => {
    queueMicrotask(() => fetchJobs());
    const timer = setInterval(() => fetchJobs(), 4_000);
    return () => clearInterval(timer);
  }, [fetchJobs]);

  useEffect(() => {
    const timer = setInterval(() => setClockNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const fetchRuns = useCallback(async (jobId: string) => {
    setRunsLoading(jobId);
    try {
      const res = await fetch(
        `/api/cron?action=runs&id=${jobId}&limit=20`
      );
      const data = await res.json();
      setRuns((prev) => ({ ...prev, [jobId]: data.entries || [] }));
    } catch {
      /* ignore */
    }
    setRunsLoading(null);
  }, []);

  // Auto-expand the first errored job when navigated with ?show=errors
  useEffect(() => {
    if (targetJobId) return;
    if (showMode === "errors" && jobs.length > 0 && !didAutoExpand.current) {
      const firstError = jobs.find((j) => j.state.lastStatus === "error");
      if (firstError) {
        didAutoExpand.current = true;
        queueMicrotask(() => setExpanded(firstError.id));
        if (!runs[firstError.id]) {
          queueMicrotask(() => fetchRuns(firstError.id));
        }
        setTimeout(() => {
          const el = document.getElementById(`cron-job-${firstError.id}`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 200);
      }
    }
  }, [showMode, jobs, runs, fetchRuns, targetJobId]);

  // Auto-expand a specific job when navigated with ?job=<id>
  useEffect(() => {
    if (!targetJobId || jobs.length === 0) return;
    const target = jobs.find((j) => j.id === targetJobId);
    if (!target) return;
    if (didAutoFocusJob.current === targetJobId) return;
    didAutoFocusJob.current = targetJobId;
    queueMicrotask(() => setExpanded(target.id));
    if (!runs[target.id]) {
      queueMicrotask(() => fetchRuns(target.id));
    }
    setTimeout(() => {
      const el = document.getElementById(`cron-job-${target.id}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 200);
  }, [targetJobId, jobs, runs, fetchRuns]);

  const toggleExpand = (id: string) => {
    if (expanded === id) {
      setExpanded(null);
    } else {
      setExpanded(id);
      if (!runs[id]) fetchRuns(id);
    }
  };

  const doAction = useCallback(
    async (action: string, id: string, extra?: Record<string, unknown>): Promise<boolean> => {
      setActionLoading(`${action}-${id}`);
      const selectedJob = jobs.find((job) => job.id === id);
      if (action === "run") {
        const startedAt = Date.now();
        setExpanded(id);
        setRunOutput((prev) => ({
          ...prev,
          [id]: {
            status: "running",
            output: "",
            runStartedAtMs: startedAt,
            baselineRunAtMs: selectedJob?.state.lastRunAtMs || 0,
            phase: "Sending run request",
            timeoutAtMs:
              startedAt +
              Math.max(
                15 * 60_000,
                (selectedJob?.payload.timeoutSeconds || 0) * 1000 + 60_000,
              ),
          },
        }));
        setRunOutputCollapsed((prev) => ({ ...prev, [id]: false }));
      }
      try {
        const res = await fetch("/api/cron", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, id, ...extra }),
        });
        const data = await res.json();
        if (action === "run") {
          const runStartedAtMs = Date.now();
          const cliOutput = data.output ?? data.error ?? "";
          const initialOutput =
            typeof cliOutput === "string" ? cliOutput : String(cliOutput);
          if (!data.ok) {
            setRunOutput((prev) => ({
              ...prev,
              [id]: {
                status: "error",
                output: initialOutput,
                runStartedAtMs: prev[id]?.runStartedAtMs || runStartedAtMs,
                baselineRunAtMs: prev[id]?.baselineRunAtMs || 0,
                phase: "Run request failed",
                timeoutAtMs: prev[id]?.timeoutAtMs || Date.now(),
              },
            }));
          } else {
            setRunOutput((prev) => ({
              ...prev,
              [id]: {
                status: "running",
                output: "",
                runStartedAtMs: data.alreadyRunning
                  ? (selectedJob?.state.lastRunAtMs || 0) + 1
                  : prev[id]?.runStartedAtMs || runStartedAtMs,
                baselineRunAtMs: prev[id]?.baselineRunAtMs || 0,
                phase: data.alreadyRunning
                  ? "Following the run already in progress"
                  : "Waiting for OpenClaw worker",
                timeoutAtMs: prev[id]?.timeoutAtMs || Date.now() + 15 * 60_000,
              },
            }));
          }
        }
        if (data.ok) {
          if (action !== "run") flash(`${action} successful`);
          else flash("Run started");
          fetchJobs();
          if (action === "run") {
            // Cron state can lag right after a successful run.
            // Refresh again to avoid showing stale "failed" status.
            setTimeout(() => fetchJobs(), 1500);
            setTimeout(() => fetchJobs(), 5000);
          }
          if (action === "run") setTimeout(() => fetchRuns(id), 5000);
          // Cron add/edit/delete/enable/disable apply in-memory on the gateway; no restart needed
          setActionLoading(null);
          return true;
        } else {
          flash(data.error || "Failed", "error");
        }
      } catch (err) {
        const msg = String(err);
        if (action === "run") {
          setRunOutput((prev) => ({
            ...prev,
            [id]: {
              status: "error",
              output: msg,
              runStartedAtMs: prev[id]?.runStartedAtMs || Date.now(),
              baselineRunAtMs: prev[id]?.baselineRunAtMs || 0,
              phase: "Run request failed",
              timeoutAtMs: prev[id]?.timeoutAtMs || Date.now(),
            },
          }));
        }
        flash(msg, "error");
      }
      setActionLoading(null);
      return false;
    },
    [fetchJobs, fetchRuns, flash, jobs]
  );

  const clearRunOutput = useCallback((jobId: string) => {
    setRunOutput((prev) => {
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
    setRunOutputCollapsed((prev) => ({ ...prev, [jobId]: false }));
  }, []);

  useEffect(() => {
    runOutputStateRef.current = runOutput;
  }, [runOutput]);

  // Scheduled runs and runs started in another tab get the same live UI.
  useEffect(() => {
    queueMicrotask(() => {
      setRunOutput((prev) => {
        let next = prev;
        for (const job of jobs) {
          const gatewayRunning = Boolean(
            job.state.isRunning || job.state.runningAtMs || job.state.lastStatus === "running",
          );
          if (!gatewayRunning || prev[job.id]) continue;
          const startedAt =
            job.state.runningStartedAtMs || job.state.runningAtMs || Date.now();
          if (next === prev) next = { ...prev };
          next[job.id] = {
            status: "running",
            output: "",
            runStartedAtMs: startedAt,
            baselineRunAtMs: job.state.lastRunAtMs || 0,
            phase: "Agent is working",
            timeoutAtMs: startedAt + 15 * 60_000,
          };
        }
        return next;
      });
    });
  }, [jobs]);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    const pollRunningJobs = async () => {
      if (polling) return;
      polling = true;
      const entries = Object.entries(runOutputStateRef.current).filter(
        ([, run]) => run.status === "running",
      );
      await Promise.all(
        entries.map(async ([id, run]) => {
          if (Date.now() >= run.timeoutAtMs) {
            setRunOutput((prev) => ({
              ...prev,
              [id]: {
                ...prev[id],
                status: "error",
                phase: "Run status timed out",
                output:
                  prev[id]?.output ||
                  "Mission Control could not confirm that this run finished. Check Run history or Logs for its final state.",
              },
            }));
            return;
          }
          try {
            const query = new URLSearchParams({
              action: "runStatus",
              id,
              requestedAt: String(run.runStartedAtMs),
              baselineRunAt: String(run.baselineRunAtMs),
            });
            const response = await fetch(`/api/cron?${query.toString()}`, {
              cache: "no-store",
            });
            const snapshot = await response.json();
            if (!response.ok || stopped) return;
            const status = snapshot.status as RunOutputState["status"];
            setRunOutput((prev) => {
              const current = prev[id];
              if (!current || current.status !== "running") return prev;
              return {
                ...prev,
                [id]: {
                  ...current,
                  status,
                  phase: String(snapshot.phase || "Agent is working"),
                  output:
                    typeof snapshot.output === "string" && snapshot.output.trim()
                      ? snapshot.output.trim()
                      : current.output,
                  sessionKey:
                    typeof snapshot.sessionKey === "string"
                      ? snapshot.sessionKey
                      : current.sessionKey,
                },
              };
            });
            if (status === "done" || status === "error") {
              void fetchJobs();
              void fetchRuns(id);
            }
          } catch {
            // A transient gateway miss must not falsely mark a real run done.
          }
        }),
      );
      polling = false;
    };
    void pollRunningJobs();
    const timer = setInterval(pollRunningJobs, 1_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [fetchJobs, fetchRuns]);

  // Auto-scroll run output to bottom when output updates
  useEffect(() => {
    if (expanded && runOutput[expanded] && runOutputRef.current) {
      const el = runOutputRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [expanded, runOutput]);

  // Filter + sort (must be above any conditional return to satisfy Rules of Hooks)
  const filteredJobs = useMemo(() => {
    let list = jobs;
    if (searchFilter.trim()) {
      const q = searchFilter.trim().toLowerCase();
      list = list.filter(
        (j) =>
          j.name.toLowerCase().includes(q) ||
          (j.agentId || "").toLowerCase().includes(q) ||
          (j.payload.message || "").toLowerCase().includes(q)
      );
    }
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case "name":
          return a.name.localeCompare(b.name);
        case "status": {
          const statusOrder = (s: string | undefined) =>
            s === "error" ? 0 : s === "ok" ? 2 : 1;
          return statusOrder(a.state.lastStatus) - statusOrder(b.state.lastStatus);
        }
        case "last":
          return (b.state.lastRunAtMs || 0) - (a.state.lastRunAtMs || 0);
        case "next":
        default:
          // Enabled jobs first, then by next run time
          if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
          return (a.state.nextRunAtMs || Infinity) - (b.state.nextRunAtMs || Infinity);
      }
    });
  }, [jobs, searchFilter, sortBy]);

  const errorJobs = jobs.filter((j) => {
    const local = runOutput[j.id];
    const localIsNewer =
      Boolean(local) &&
      (!j.state.lastRunAtMs || (local?.runStartedAtMs || 0) > j.state.lastRunAtMs);
    if (localIsNewer && local?.status === "done") return false;
    if (localIsNewer && local?.status === "error") return true;
    return j.state.lastStatus === "error";
  });

  if (loading) {
    return (
      <SectionLayout>
        <ContentLoadingState />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title={`Cron Jobs (${jobs.length})`}
        description={
          <>
            Schedule, delivery, run history &bull; Edit schedule, content, delivery targets
            {errorJobs.length > 0 && (
              <span className="ml-2 rounded bg-danger-bg px-1.5 py-0.5 text-xs font-medium text-danger-fg">
                {errorJobs.length} failing
              </span>
            )}
          </>
        }
        actions={
          <>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88"
            >
              <Plus className="h-3 w-3" /> New Cron Job
            </button>
            <button
              type="button"
              onClick={() => {
                setLoading(true);
                fetchJobs();
              }}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground dark:hover:bg-secondary"
            >
              <RefreshCw className="h-3 w-3" /> Refresh
            </button>
          </>
        }
      />

      <SectionBody width="content" padding="compact" innerClassName="space-y-3">
        {/* Search & Sort controls */}
        {jobs.length > 1 && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[180px]">
              <Hash className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
              <input
                type="text"
                placeholder="Filter jobs..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                className="w-full rounded-lg border border-border bg-card py-1.5 pl-7 pr-3 text-xs text-foreground outline-none placeholder:text-fg-subtle focus:border-success-border dark:bg-muted"
              />
              {searchFilter && (
                <button
                  type="button"
                  onClick={() => setSearchFilter("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-fg-subtle hover:text-fg-secondary"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as typeof sortBy)}
              className="rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs text-fg-secondary outline-none dark:bg-muted"
            >
              <option value="next">Sort: Next run</option>
              <option value="name">Sort: Name</option>
              <option value="status">Sort: Status</option>
              <option value="last">Sort: Last run</option>
            </select>
          </div>
        )}
        {/* Create form */}
        {showCreate && (
          <CreateCronForm
            onCreated={() => {
              setShowCreate(false);
              flash("Cron job created!");
              fetchJobs();
            }}
            onCancel={() => setShowCreate(false)}
          />
        )}

        {/* Empty state */}
        {jobs.length === 0 && !showCreate && (
          <div className="flex flex-col items-center justify-center py-16">
            <Calendar className="mx-auto mb-3 h-10 w-10 text-fg-subtle" />
            <p className="mb-1 text-sm text-fg-secondary">No cron jobs yet</p>
            <p className="mb-4 text-xs text-muted-foreground">Create your first scheduled task to get started.</p>
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/88"
            >
              <Plus className="h-4 w-4" /> Create Cron Job
            </button>
          </div>
        )}

        {/* No results from filter */}
        {jobs.length > 0 && filteredJobs.length === 0 && searchFilter.trim() && (
          <div className="flex flex-col items-center justify-center py-10">
            <p className="text-xs text-fg-subtle">No jobs matching &ldquo;{searchFilter}&rdquo;</p>
          </div>
        )}

        {filteredJobs.map((job) => {
          const isExpanded = expanded === job.id;
          const isEditing = editing === job.id;
          const isFocusedFromLink = targetJobId === job.id;
          const st = job.state;
          const localRun = runOutput[job.id];
          const isRunning =
            localRun?.status === "running" ||
            Boolean(st.isRunning || st.runningAtMs || st.lastStatus === "running");
          const localRunIsNewer =
            Boolean(localRun) &&
            (!st.lastRunAtMs || (localRun?.runStartedAtMs || 0) > st.lastRunAtMs);
          const effectiveStatus =
            isRunning
              ? "running"
              : localRunIsNewer && localRun?.status === "done"
              ? "ok"
              : localRunIsNewer && localRun?.status === "error"
                ? "error"
                : st.lastStatus;
          const hasError = effectiveStatus === "error";
          const delivery = describeDelivery(job.delivery);
          const jobRuns = runs[job.id] || [];

          return (
            <div
              key={job.id}
              id={`cron-job-${job.id}`}
              className={cn(
                "rounded-xl border bg-card transition-colors",
                hasError
                  ? "border-danger-border"
                  : "border-border",
                hasError && expanded === job.id && "ring-1 ring-danger-border",
                isFocusedFromLink && "ring-1 ring-border-strong/40 dark:ring-border-strong"
              )}
            >
              {/* Job header */}
              <div className="flex items-center gap-3 p-4">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpand(job.id);
                  }}
                  className="shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                <div
                  className={cn(
                    "h-2.5 w-2.5 shrink-0 rounded-full",
                    !job.enabled
                      ? "bg-fg-secondary"
                      : hasError
                        ? "bg-danger shadow-md shadow-danger-border"
                        : "bg-success"
                  )}
                />
                <div
                  className="min-w-0 flex-1 cursor-pointer"
                  onClick={() => toggleExpand(job.id)}
                >
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">
                      {job.name}
                    </p>
                    {!job.enabled && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold text-muted-foreground dark:bg-secondary">
                        DISABLED
                      </span>
                    )}
                    {isRunning && (
                      <span className="inline-flex items-center rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg">
                        Running
                      </span>
                    )}
                    {delivery.hasIssue && (
                      <span className="flex items-center gap-0.5 rounded bg-warning-bg px-1.5 py-0.5 text-xs font-medium text-warning-fg">
                        <AlertTriangle className="h-2.5 w-2.5" />
                        missing target
                      </span>
                    )}
                    {job.payload.model && (
                      <span className="flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success-fg">
                        <Cpu className="h-2.5 w-2.5" />
                        {getFriendlyModelName(job.payload.model)}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {scheduleDisplay(job.schedule, timeFormat)} &bull; {job.agentId}
                    {st.nextRunAtMs && (
                      <>
                        {" "}&bull; Next: {fmtAgo(st.nextRunAtMs)}
                      </>
                    )}
                  </p>
                </div>
                {/* Quick actions */}
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      doAction(
                        job.enabled ? "disable" : "enable",
                        job.id
                      )
                    }
                    disabled={
                      actionLoading ===
                      `${job.enabled ? "disable" : "enable"}-${job.id}`
                    }
                    className={cn(
                      "rounded p-1.5 transition-colors",
                      job.enabled
                        ? "text-muted-foreground hover:bg-accent hover:text-foreground"
                        : "text-fg-subtle hover:bg-accent hover:text-foreground"
                    )}
                    title={job.enabled ? "Disable" : "Enable"}
                  >
                    {job.enabled ? (
                      <Pause className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => doAction("run", job.id)}
                    disabled={actionLoading === `run-${job.id}` || isRunning}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 dark:hover:bg-secondary"
                    title="Run now"
                  >
                    {actionLoading === `run-${job.id}` || isRunning ? (
                      <InlineSpinner className="h-3.5 w-3.5" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setEditing(isEditing ? null : job.id)
                    }
                    className={cn(
                      "rounded p-1.5 transition-colors",
                      isEditing
                        ? "bg-accent text-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground"
                    )}
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (window.confirm(`Delete cron job "${job.name}"? This cannot be undone.`)) {
                        doAction("delete", job.id);
                      }
                    }}
                    disabled={actionLoading === `delete-${job.id}`}
                    className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger-fg disabled:opacity-50"
                    title="Delete job"
                  >
                    {actionLoading === `delete-${job.id}` ? (
                      <InlineSpinner className="h-3.5 w-3.5" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Error banner with quick-fix suggestion */}
              {hasError && st.lastError && !isEditing && !isExpanded && (
                <div className="mx-4 mb-3">
                  <FailureGuideCard
                    error={st.lastError}
                    delivery={job.delivery}
                    consecutiveErrors={st.consecutiveErrors}
                    onFix={() => setEditing(job.id)}
                    compact
                  />
                </div>
              )}

              {/* Edit form */}
              {isEditing && (
                <EditCronForm
                  job={job}
                  onSave={async (updates) => {
                    const ok = await doAction("edit", job.id, updates);
                    if (ok) setEditing(null);
                    return ok;
                  }}
                  onCancel={() => setEditing(null)}
                  onDelete={async () => {
                    const ok = await doAction("delete", job.id);
                    if (ok) setEditing(null);
                    return ok;
                  }}
                  onMessageAutoSave={async (msg) => {
                    await saveCronField(job.id, { message: msg });
                  }}
                />
              )}

              {/* Expanded detail view */}
              {isExpanded && !isEditing && (
                <div className="border-t border-foreground/5 px-4 py-4 space-y-4">
                  {hasError && st.lastError && (
                    <FailureGuideCard
                      error={st.lastError}
                      delivery={job.delivery}
                      consecutiveErrors={st.consecutiveErrors}
                      onFix={() => setEditing(job.id)}
                    />
                  )}

                  {/* ── Run output (terminal-like accordion) ──── */}
                  {runOutput[job.id] && (
                    <div className="rounded-lg border border-border-strong/70 bg-muted overflow-hidden dark:border-border dark:bg-surface-inset">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          setRunOutputCollapsed((prev) => ({
                            ...prev,
                            [job.id]: !prev[job.id],
                          }))
                        }
                        onKeyDown={(e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setRunOutputCollapsed((prev) => ({
                              ...prev,
                              [job.id]: !prev[job.id],
                            }));
                          }
                        }}
                        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-fg-secondary transition-colors hover:bg-muted dark:text-fg-subtle"
                      >
                        <span className="flex items-center gap-1.5">
                          <Terminal className="h-3.5 w-3.5 text-success-fg" />
                          {runOutput[job.id].status === "running" ? "Live run log" : "Run output"}
                          {runOutput[job.id].status === "running" && (
                            <span className="flex items-center gap-1 text-success-fg">
                              <InlineSpinner className="h-3 w-3" />
                              {runOutput[job.id].phase}
                            </span>
                          )}
                          {runOutput[job.id].status === "done" && (
                            <span className="text-success-fg">Done</span>
                          )}
                          {runOutput[job.id].status === "error" && (
                            <span className="text-danger-fg">Error</span>
                          )}
                        </span>
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              clearRunOutput(job.id);
                            }}
                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                            title="Clear output"
                          >
                            <X className="h-3 w-3" />
                          </button>
                          {runOutputCollapsed[job.id] ? (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </span>
                      </div>
                      {!runOutputCollapsed[job.id] && (
                        <pre
                          ref={job.id === expanded ? runOutputRef : undefined}
                          aria-live="polite"
                          aria-label="Live cron job output"
                          className="max-h-64 overflow-auto border-t border-border bg-card px-3 py-2.5 text-xs font-mono leading-relaxed text-foreground whitespace-pre-wrap break-words dark:bg-surface-inset"
                        >
                          {runOutput[job.id].status === "running" && !runOutput[job.id].output
                            ? `${runOutput[job.id].phase}…\n\nThe agent transcript will appear here as OpenClaw publishes it.`
                            : runOutput[job.id].output || "(no output)"}
                        </pre>
                      )}
                    </div>
                  )}

                  {/* ── Job Configuration ──── */}
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Info className="h-3 w-3" />
                      Job Configuration
                    </h3>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 md:gap-x-6 gap-y-2 rounded-lg border border-foreground/5 bg-muted/40 px-3 py-3 text-xs">
                      <div className="flex items-center gap-2">
                        <Hash className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Job ID</span>
                        <code className="ml-auto font-mono text-xs text-foreground">
                          {job.id}
                        </code>
                      </div>
                      <div className="flex items-center gap-2">
                        <Globe className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Agent</span>
                        <span className="ml-auto text-foreground">
                          {job.agentId}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Calendar className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Schedule</span>
                        <span className="ml-auto font-mono text-foreground">
                          {scheduleDisplay(job.schedule, timeFormat)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Session</span>
                        <span className="ml-auto text-foreground">
                          {job.sessionTarget || "default"}
                          {job.wakeMode && ` · wake: ${job.wakeMode}`}
                        </span>
                      </div>
                      {job.payload.model && (
                        <div className="flex items-center gap-2">
                          <Cpu className="h-3 w-3 text-muted-foreground" />
                          <span className="text-muted-foreground">Model</span>
                          <span className="ml-auto text-xs text-success-fg">
                            {getFriendlyModelName(job.payload.model)}
                          </span>
                        </div>
                      )}
                      <div className="flex items-center gap-2">
                        <FileText className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Created</span>
                        <span className="ml-auto text-foreground">
                          {fmtDate(job.createdAtMs, timeFormat)}
                        </span>
                      </div>
                      {job.updatedAtMs && (
                        <div className="flex items-center gap-2">
                          <FileText className="h-3 w-3 text-muted-foreground" />
                          <span className="text-muted-foreground">Updated</span>
                          <span className="ml-auto text-foreground">
                            {fmtDate(job.updatedAtMs, timeFormat)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Delivery Config ─────── */}
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Send className="h-3 w-3" />
                      Delivery
                    </h3>
                    <div
                      className={cn(
                        "rounded-lg border px-3 py-3 text-xs",
                        delivery.hasIssue
                          ? "border-warning-border bg-warning-bg"
                          : "border-foreground/5 bg-muted/40"
                      )}
                    >
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        <div>
                          <span className="text-muted-foreground">Mode</span>
                          <p className="mt-0.5 font-medium text-foreground">
                            {normalizeDeliveryMode(job.delivery.mode)}
                          </p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Channel</span>
                          <p className="mt-0.5 text-foreground">
                            {job.delivery.mode === "webhook"
                              ? "—"
                              : getDeliveryChannelLabel(job.delivery.channel)}
                          </p>
                        </div>
                        <div>
                          <span className="text-muted-foreground">
                            {normalizeDeliveryMode(job.delivery.mode) === "webhook"
                              ? "Webhook URL"
                              : "To (recipient)"}
                          </span>
                          <p
                            className={cn(
                              "mt-0.5 font-mono",
                              job.delivery.to
                                ? "text-foreground"
                                : normalizeDeliveryMode(job.delivery.mode) === "announce"
                                  ? "text-info-fg"
                                  : "text-warning-fg"
                            )}
                          >
                            {job.delivery.to ||
                              (normalizeDeliveryMode(job.delivery.mode) === "announce"
                                ? "last route fallback"
                                : "⚠ not set")}
                          </p>
                        </div>
                      </div>

                      {delivery.hasIssue && (
                        <div className="mt-2 flex items-center gap-2">
                          <AlertTriangle className="h-3 w-3 shrink-0 text-warning-fg" />
                          <p className="text-xs text-warning-fg">
                            {delivery.issue}
                          </p>
                          <button
                            type="button"
                            onClick={() => setEditing(job.id)}
                            className="ml-auto shrink-0 rounded bg-warning-bg px-2 py-1 text-xs font-medium text-warning-fg transition-colors hover:bg-warning-bg"
                          >
                            Fix →
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Execution Status ────── */}
                  <div>
                    <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      <Timer className="h-3 w-3" />
                      Execution Status
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="rounded-lg border border-foreground/5 bg-muted/40 px-3 py-2 text-center">
                        <p className="text-xs text-muted-foreground">Last Run</p>
                        <p className="mt-0.5 text-xs font-medium text-foreground">
                          {fmtAgo(st.lastRunAtMs)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {fmtDate(st.lastRunAtMs, timeFormat)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-foreground/5 bg-muted/40 px-3 py-2 text-center">
                        <p className="text-xs text-muted-foreground">Next Run</p>
                        <p className="mt-0.5 text-xs font-medium text-foreground">
                          {fmtAgo(st.nextRunAtMs)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {fmtDate(st.nextRunAtMs, timeFormat)}
                        </p>
                      </div>
                      <div className="rounded-lg border border-foreground/5 bg-muted/40 px-3 py-2 text-center">
                        <p className="text-xs text-muted-foreground">Duration</p>
                        <p className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-foreground">
                          {isRunning && <InlineSpinner className="h-3 w-3 text-success-fg" />}
                          {isRunning
                            ? fmtDuration(
                                clockNow -
                                  (localRun?.runStartedAtMs ||
                                    st.runningStartedAtMs ||
                                    st.runningAtMs ||
                                    clockNow),
                              )
                            : fmtDuration(st.lastDurationMs)}
                        </p>
                      </div>
                      <div
                        className={cn(
                          "rounded-lg border px-3 py-2 text-center",
                          hasError
                            ? "border-danger-border bg-danger-bg"
                            : "border-foreground/5 bg-muted/40"
                        )}
                      >
                        <p className="text-xs text-muted-foreground">Status</p>
                        <p
                          className={cn(
                            "mt-0.5 text-xs font-medium",
                            hasError
                              ? "text-danger-fg"
                              : effectiveStatus === "running"
                                ? "text-success-fg"
                              : effectiveStatus === "ok"
                                ? "text-success-fg"
                                : "text-muted-foreground"
                          )}
                        >
                          {effectiveStatus === "running" ? (
                            <span className="inline-flex items-center gap-1">
                              <InlineSpinner className="h-3 w-3" /> Running
                            </span>
                          ) : (
                            effectiveStatus || "—"
                          )}
                        </p>
                        {hasError && st.consecutiveErrors ? (
                          <p className="text-xs text-danger-fg">
                            {st.consecutiveErrors} consecutive
                          </p>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {/* ── Prompt ──────────────── */}
                  {job.payload.message && (
                    <div>
                      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <FileText className="h-3 w-3" />
                        Prompt
                      </h3>
                      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-foreground/10 bg-background/70 p-3 text-xs leading-5 text-foreground">
                        {job.payload.message}
                      </pre>
                    </div>
                  )}

                  {/* ── Run History ─────────── */}
                  <div>
                    <div className="mb-2 flex items-center justify-between">
                      <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Run History
                      </h3>
                      <button
                        type="button"
                        onClick={() => fetchRuns(job.id)}
                        disabled={runsLoading === job.id}
                        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {runsLoading === job.id ? (
                          <span className="inline-flex items-center gap-0.5">
                            <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                            <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                            <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                          </span>
                        ) : (
                          <RefreshCw className="h-2.5 w-2.5" />
                        )}
                        Refresh
                      </button>
                    </div>
                    {runsLoading === job.id && jobRuns.length === 0 ? (
                      <div className="flex items-center py-4">
                        <InlineSpinner size="sm" />
                      </div>
                    ) : jobRuns.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        No runs recorded
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {jobRuns.map((run, i) => (
                          <RunCard key={`${run.ts}-${i}`} run={run} timeFormat={timeFormat} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </SectionBody>

      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-xs shadow-xl backdrop-blur-sm",
            toast.type === "success"
              ? "border-success-border bg-success-bg text-success-fg"
              : "border-danger-border bg-danger-bg text-danger-fg"
          )}
        >
          {toast.type === "success" ? (
            <Check className="h-3.5 w-3.5" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5" />
          )}
          {toast.message}
        </div>
      )}
    </SectionLayout>
  );
}
