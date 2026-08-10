"use client";

import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  SlidersHorizontal,
  Radio,
  Bell,
  Info,
  Sun,
  Moon,
  Monitor,
  ChevronDown,
  ExternalLink,
  Trash2,
  Check,
  Clock,
  Globe,
  AlertTriangle,
  ShieldAlert,
  RefreshCw,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SectionBody,
  SectionHeader,
  SectionLayout,
} from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";

import {
  setTimeFormatPreference,
  subscribeTimeFormatPreference,
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";
import { chatStore } from "@/lib/chat-store";

const isAgentbayHosted = process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";
const missionControlVersion = process.env.NEXT_PUBLIC_APP_VERSION || "";
const missionControlCommitHash = process.env.NEXT_PUBLIC_COMMIT_HASH || "";
const missionControlBuildLabel = missionControlVersion
  ? missionControlCommitHash && missionControlCommitHash !== "unknown"
    ? `${missionControlVersion} (${missionControlCommitHash})`
    : missionControlVersion
  : "—";

/* ── Types ────────────────────────────────────────── */

type OnboardData = {
  installed: boolean;
  configured: boolean;
  version: string | null;
  gatewayUrl: string;
  home: string;
};

type SystemGateway = {
  port?: number | string;
  mode?: string;
  version?: string;
  authMode?: "token" | "password";
  tokenConfigured?: boolean;
  allowTailscale?: boolean;
};

type SystemData = {
  gateway?: SystemGateway;
  stats?: Record<string, number>;
};

type SettingsData = {
  timezone: string;
  configHash: string;
};

type ResetScope = "config" | "credentials" | "sessions" | "all";

/* ── Timezone list ───────────────────────────────── */

const COMMON_TIMEZONES = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Anchorage",
  "Pacific/Honolulu",
  "America/Toronto",
  "America/Vancouver",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "America/Mexico_City",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Rome",
  "Europe/Madrid",
  "Europe/Amsterdam",
  "Europe/Zurich",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Moscow",
  "Europe/Istanbul",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Johannesburg",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Australia/Perth",
  "Pacific/Auckland",
  "UTC",
];

function getLocalTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/* ── Component ────────────────────────────────────── */

export function SettingsView() {
  const [onboard, setOnboard] = useState<OnboardData | null>(null);
  const [system, setSystem] = useState<SystemData | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);

  // Theme — hydration-safe
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );

  // Banner reset feedback

  // Chat clear feedback
  const [chatCleared, setChatCleared] = useState(false);

  // Notification permission
  const [notifPerm, setNotifPerm] = useState<NotificationPermission | "unsupported">("unsupported");
  useEffect(() => {
    if (typeof Notification !== "undefined") {
      setNotifPerm(Notification.permission);
    }
  }, []);

  // Timezone state
  const [tzSearch, setTzSearch] = useState("");
  const [tzSaving, setTzSaving] = useState(false);
  const [tzSaved, setTzSaved] = useState(false);
  const [tzDropdownOpen, setTzDropdownOpen] = useState(false);
  const [selectedTz, setSelectedTz] = useState("");

  // Reset state
  const [resetScope, setResetScope] = useState<ResetScope | null>(null);
  const [resetPreview, setResetPreview] = useState<string | null>(null);
  const [resetPreviewLoading, setResetPreviewLoading] = useState(false);
  const [resetExecuting, setResetExecuting] = useState(false);
  const [resetResult, setResetResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Gateway restart
  const [restarting, setRestarting] = useState(false);
  const [restartResult, setRestartResult] = useState<string | null>(null);

  // Toast
  const [toast, setToast] = useState<{ message: string; type: "ok" | "err" } | null>(null);
  const showToast = useCallback((message: string, type: "ok" | "err") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    Promise.all([
      fetch("/api/onboard", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/system", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      fetch("/api/settings", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    ]).then(([onboardRes, systemRes, settingsRes]) => {
      setOnboard(onboardRes);
      setSystem(systemRes);
      setSettings(settingsRes);
      if (settingsRes?.timezone) {
        setSelectedTz(settingsRes.timezone);
      } else {
        setSelectedTz(getLocalTimezone());
      }
      setLoading(false);
    });
  }, []);

  // Timezone save handler
  const handleSaveTimezone = useCallback(async (tz: string) => {
    setTzSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-timezone", timezone: tz }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setSelectedTz(tz);
      setTzSaved(true);
      showToast(`Timezone set to ${tz}`, "ok");
      setTimeout(() => setTzSaved(false), 2000);
    } catch (err) {
      showToast(`Failed to save timezone: ${err}`, "err");
    } finally {
      setTzSaving(false);
      setTzDropdownOpen(false);
    }
  }, [showToast]);

  // Reset preview handler
  const handleResetPreview = useCallback(async (scope: ResetScope) => {
    setResetScope(scope);
    setResetPreview(null);
    setResetResult(null);
    setResetPreviewLoading(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset-preview", scope }),
      });
      const json = await res.json();
      setResetPreview(json.output || "No preview available.");
    } catch (err) {
      setResetPreview(`Error: ${err}`);
    } finally {
      setResetPreviewLoading(false);
    }
  }, []);

  // Reset execute handler
  const handleResetExecute = useCallback(async () => {
    if (!resetScope) return;
    setResetExecuting(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset-execute", scope: resetScope }),
      });
      const json = await res.json();
      if (json.ok) {
        setResetResult({ ok: true, message: json.output || "Reset complete." });
        showToast("Reset completed successfully", "ok");
      } else {
        setResetResult({ ok: false, message: json.error || "Reset failed." });
        showToast("Reset failed", "err");
      }
    } catch (err) {
      setResetResult({ ok: false, message: String(err) });
      showToast("Reset failed", "err");
    } finally {
      setResetExecuting(false);
    }
  }, [resetScope, showToast]);

  // Gateway restart handler
  const handleRestartGateway = useCallback(async () => {
    setRestarting(true);
    setRestartResult(null);
    try {
      const res = await fetch("/api/gateway", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart" }),
      });
      const json = await res.json();
      if (json.ok || json.status === "restarting") {
        setRestartResult("Gateway is restarting...");
        showToast("Gateway restart initiated", "ok");
      } else {
        setRestartResult(`Failed: ${json.error || "Unknown error"}`);
        showToast("Gateway restart failed", "err");
      }
    } catch (err) {
      setRestartResult(`Error: ${err}`);
      showToast("Gateway restart failed", "err");
    } finally {
      setRestarting(false);
    }
  }, [showToast]);

  // Filtered timezone list
  const filteredTimezones = tzSearch
    ? COMMON_TIMEZONES.filter((tz) =>
      tz.toLowerCase().includes(tzSearch.toLowerCase()),
    )
    : COMMON_TIMEZONES;

  if (loading) {
    return (
      <SectionLayout>
        <SectionHeader title="Settings" />
        <ContentLoadingState />
      </SectionLayout>
    );
  }

  const gw = system?.gateway;
  const localTz = getLocalTimezone();

  return (
    <SectionLayout>
      <SectionHeader
        title="Settings"
        description="Manage preferences, gateway configuration, and diagnostics."
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

        {/* ── General ──────────────────────────────── */}
        <SettingsSection
          title="General"
          icon={SlidersHorizontal}
          iconColor="text-foreground"
          defaultOpen
        >
          {/* Theme */}
          <SettingRow
            label="Theme"
            description="Choose light, dark, or follow your system preference."
          >
            {mounted ? (
              <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
                {(
                  [
                    { value: "light", icon: Sun, label: "Light" },
                    { value: "dark", icon: Moon, label: "Dark" },
                    { value: "system", icon: Monitor, label: "System" },
                  ] as const
                ).map((opt) => {
                  const Icon = opt.icon;
                  const active = theme === opt.value;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setTheme(opt.value)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                        active
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Icon className="h-3 w-3" />
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="h-7 w-40 animate-pulse rounded-lg bg-muted" />
            )}
          </SettingRow>

          {/* Time format */}
          <SettingRow
            label="Time format"
            description={`Choose how times are displayed across the dashboard. Current: ${timeFormat === "12h" ? "12-hour clock" : "24-hour clock"}.`}
          >
            <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
              {(
                [
                  { value: "12h", label: "12-hour" },
                  { value: "24h", label: "24-hour" },
                ] satisfies Array<{ value: TimeFormatPreference; label: string }>
              ).map((opt) => {
                const active = timeFormat === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setTimeFormatPreference(opt.value)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                      active
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </SettingRow>

          {/* Timezone */}
          <SettingRow
            label="Timezone"
            description={`Used for scheduling, cron jobs, and time displays. ${selectedTz === localTz ? "Matches your browser." : `Browser: ${localTz}`}`}
          >
            <div className="relative">
              <button
                type="button"
                onClick={() => setTzDropdownOpen(!tzDropdownOpen)}
                disabled={tzSaving}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                  tzSaved
                    ? "border-success-border bg-success-bg text-success-fg"
                    : "border-foreground/10 bg-card text-fg-secondary hover:bg-muted/80 hover:text-foreground",
                )}
              >
                {tzSaving ? (
                  <span className="flex items-center gap-1">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                ) : tzSaved ? (
                  <>
                    <Check className="h-3 w-3" />
                    Saved
                  </>
                ) : (
                  <>
                    <Globe className="h-3 w-3" />
                    {selectedTz.replace(/_/g, " ").split("/").pop() || selectedTz}
                  </>
                )}
              </button>

              {tzDropdownOpen && (
                <>
                  {/* Backdrop to close dropdown */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setTzDropdownOpen(false)}
                  />
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-border bg-card shadow-lg">
                    <div className="border-b border-border p-2">
                      <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5">
                        <Search className="h-3 w-3 text-muted-foreground" />
                        <input
                          type="text"
                          value={tzSearch}
                          onChange={(e) => setTzSearch(e.target.value)}
                          placeholder="Search timezones..."
                          aria-label="Search timezones"
                          className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
                          autoFocus
                        />
                      </div>
                    </div>
                    <div className="max-h-56 overflow-y-auto py-1">
                      {/* Auto-detect option */}
                      <button
                        type="button"
                        onClick={() => handleSaveTimezone(localTz)}
                        className={cn(
                          "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                          selectedTz === localTz && "text-success-fg",
                        )}
                      >
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <span className="flex-1">Auto-detect ({localTz.split("/").pop()})</span>
                        {selectedTz === localTz && <Check className="h-3 w-3" />}
                      </button>
                      <div className="my-1 border-t border-border" />
                      {filteredTimezones.map((tz) => (
                        <button
                          key={tz}
                          type="button"
                          onClick={() => handleSaveTimezone(tz)}
                          className={cn(
                            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-muted",
                            selectedTz === tz && "text-success-fg",
                          )}
                        >
                          <span className="flex-1">{tz.replace(/_/g, " ")}</span>
                          {selectedTz === tz && <Check className="h-3 w-3" />}
                        </button>
                      ))}
                      {filteredTimezones.length === 0 && (
                        <p className="px-3 py-2 text-xs text-fg-subtle">No matching timezones</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          </SettingRow>

        </SettingsSection>

        {/* ── Gateway ──────────────────────────────── */}
        <SettingsSection
          title="Gateway"
          icon={Radio}
          iconColor="text-success-fg"
          defaultOpen
        >
          <SettingRow
            label="Gateway URL"
            description="The endpoint where the OpenClaw gateway is accessible."
          >
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono text-xs text-fg-secondary">
              {onboard?.gatewayUrl || "—"}
            </span>
          </SettingRow>

          <SettingRow
            label="Port"
            description="Gateway listening port."
          >
            <span className="font-mono text-xs text-fg-secondary">
              {gw?.port || "—"}
            </span>
          </SettingRow>

          <SettingRow
            label="Auth mode"
            description="How the gateway authenticates incoming connections."
          >
            <Badge
              label={gw?.authMode || "Not configured"}
              color={gw?.authMode ? "emerald" : "zinc"}
            />
          </SettingRow>

          <SettingRow
            label="Auth token"
            description={
              gw?.tokenConfigured
                ? "Token is set. Run `openclaw config get gateway.auth.token` to view."
                : "No token configured. Set one in Config > gateway.auth.token."
            }
          >
            <Badge
              label={gw?.tokenConfigured ? "Configured" : "Not set"}
              color={gw?.tokenConfigured ? "emerald" : "amber"}
            />
          </SettingRow>

          {!isAgentbayHosted && (
            <SettingRow
              label="Tailscale"
              description="Whether Tailscale connections are allowed."
            >
              <div className="flex items-center gap-2">
                <Badge
                  label={gw?.allowTailscale === false ? "Disabled" : "Allowed"}
                  color={gw?.allowTailscale === false ? "zinc" : "emerald"}
                />
                <Link
                  href="/tailscale"
                  className="text-xs text-foreground underline-offset-4 hover:underline"
                >
                  Manage
                </Link>
              </div>
            </SettingRow>
          )}

          <SettingRow
            label="Transport mode"
            description="How Mission Control communicates with the gateway."
          >
            <Badge label={gw?.mode || "local"} color="blue" />
          </SettingRow>

          <SettingRow
            label="Restart gateway"
            description="Restart the gateway process. This briefly interrupts active sessions."
          >
            <button
              type="button"
              onClick={handleRestartGateway}
              disabled={restarting}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                restarting
                  ? "border-foreground/10 bg-foreground/5 text-muted-foreground cursor-wait"
                  : restartResult
                    ? "border-success-border bg-success-bg text-success-fg"
                    : "border-warning-border bg-warning-bg text-warning-fg hover:bg-warning-bg",
              )}
            >
              {restarting ? (
                <span className="flex items-center gap-1">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : restartResult ? (
                <>
                  <Check className="h-3 w-3" />
                  Restarting
                </>
              ) : (
                <>
                  <RefreshCw className="h-3 w-3" />
                  Restart
                </>
              )}
            </button>
          </SettingRow>
        </SettingsSection>

        {/* ── Notifications & Chat ─────────────────── */}
        <SettingsSection
          title="Notifications & Chat"
          icon={Bell}
          iconColor="text-warning-fg"
        >
          <SettingRow
            label="Browser notifications"
            description="Allow Mission Control to send desktop notifications for new messages."
          >
            {notifPerm === "unsupported" ? (
              <Badge label="Unsupported" color="zinc" />
            ) : notifPerm === "granted" ? (
              <Badge label="Enabled" color="emerald" />
            ) : notifPerm === "denied" ? (
              <Badge label="Blocked" color="red" />
            ) : (
              <button
                type="button"
                onClick={async () => {
                  const result = await Notification.requestPermission();
                  setNotifPerm(result);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted/80 hover:text-foreground"
              >
                Request permission
              </button>
            )}
          </SettingRow>

          <SettingRow
            label="Chat history"
            description="Messages are kept locally in your browser. Last 200 messages, 7-day expiry."
          >
            <span className="text-xs text-fg-subtle">Browser-only</span>
          </SettingRow>

          <SettingRow
            label="Clear chat history"
            description="Remove all chat messages from local storage."
          >
            <button
              type="button"
              onClick={() => {
                chatStore.clearMessages();
                setChatCleared(true);
                setTimeout(() => setChatCleared(false), 2000);
              }}
              disabled={chatCleared}
              className={cn(
                "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                chatCleared
                  ? "border-success-border bg-success-bg text-success-fg"
                  : "border-danger-border bg-danger-bg text-danger-fg hover:bg-danger-bg",
              )}
            >
              {chatCleared ? (
                <>
                  <Check className="h-3 w-3" />
                  Cleared
                </>
              ) : (
                <>
                  <Trash2 className="h-3 w-3" />
                  Clear history
                </>
              )}
            </button>
          </SettingRow>
        </SettingsSection>

        {/* ── Reset & Maintenance ─────────────────── */}
        <SettingsSection
          title="Reset & Maintenance"
          icon={ShieldAlert}
          iconColor="text-danger-fg"
        >
          <p className="text-xs text-fg-subtle -mt-1 mb-3">
            Reset different parts of your OpenClaw installation. Each action shows a preview of what will be affected before executing.
          </p>

          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  scope: "config" as ResetScope,
                  label: "Reset Configuration",
                  desc: "Restores openclaw.json to defaults. Keeps credentials and sessions.",
                  color: "amber",
                },
                {
                  scope: "credentials" as ResetScope,
                  label: "Reset Credentials",
                  desc: "Removes saved API keys and auth profiles. You'll need to re-enter them.",
                  color: "amber",
                },
                {
                  scope: "sessions" as ResetScope,
                  label: "Clear Sessions",
                  desc: "Removes all session history and JSONL files. Frees disk space.",
                  color: "amber",
                },
                {
                  scope: "all" as ResetScope,
                  label: "Full Reset",
                  desc: "Removes everything: config, credentials, and sessions. Like a fresh install.",
                  color: "red",
                },
              ] as const
            ).map((item) => (
              <button
                key={item.scope}
                type="button"
                onClick={() => handleResetPreview(item.scope)}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  resetScope === item.scope
                    ? item.color === "red"
                      ? "border-danger-border bg-danger-bg"
                      : "border-warning-border bg-warning-bg"
                    : "border-foreground/10 hover:bg-foreground/[0.03]",
                )}
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className={cn(
                    "h-3.5 w-3.5",
                    item.color === "red" ? "text-danger-fg" : "text-warning-fg",
                  )} />
                  <p className="text-xs font-medium text-foreground">{item.label}</p>
                </div>
                <p className="mt-1 text-xs text-fg-subtle">{item.desc}</p>
              </button>
            ))}
          </div>

          {/* Reset preview + confirm */}
          {resetScope && (
            <div className="mt-3 rounded-lg border border-foreground/10 bg-card p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-xs font-semibold text-foreground">
                  {resetScope === "all" ? "Full Reset" : `Reset: ${resetScope}`} — Preview
                </h3>
                <button
                  type="button"
                  onClick={() => {
                    setResetScope(null);
                    setResetPreview(null);
                    setResetResult(null);
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </button>
              </div>

              {resetPreviewLoading ? (
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-0.5">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                  Running preview...
                </div>
              ) : resetPreview ? (
                <div className="mt-3 max-h-40 overflow-y-auto rounded-md border border-foreground/[0.06] bg-muted/50 p-2.5 font-mono text-xs text-muted-foreground leading-5">
                  {resetPreview.split("\n").map((line, i) => (
                    <div key={i}>{line || "\u00A0"}</div>
                  ))}
                </div>
              ) : null}

              {resetResult ? (
                <div className={cn(
                  "mt-3 rounded-md border p-2.5 text-xs",
                  resetResult.ok
                    ? "border-success-border bg-success-bg text-success-fg"
                    : "border-danger-border bg-danger-bg text-danger-fg",
                )}>
                  {resetResult.message}
                </div>
              ) : resetPreview && !resetPreviewLoading ? (
                <div className="mt-3 flex items-center gap-3">
                  <button
                    type="button"
                    onClick={handleResetExecute}
                    disabled={resetExecuting}
                    className={cn(
                      "rounded-lg border px-4 py-2 text-xs font-medium transition-colors",
                      resetScope === "all"
                        ? "border-danger-border bg-danger-bg text-danger-fg hover:bg-danger-bg"
                        : "border-warning-border bg-warning-bg text-warning-fg hover:bg-warning-bg",
                      resetExecuting && "cursor-wait opacity-60",
                    )}
                  >
                    {resetExecuting ? "Executing..." : `Confirm ${resetScope === "all" ? "Full " : ""}Reset`}
                  </button>
                  <p className="text-xs text-fg-subtle">This action cannot be undone.</p>
                </div>
              ) : null}
            </div>
          )}
        </SettingsSection>

        {/* ── About & Diagnostics ──────────────────── */}
        <SettingsSection
          title="About & Diagnostics"
          icon={Info}
          iconColor="text-info-fg"
        >
          <SettingRow label="Mission Control version">
            <span className="font-mono text-xs text-fg-secondary">
              {missionControlBuildLabel}
            </span>
          </SettingRow>

          <SettingRow label="OpenClaw version">
            <span className="font-mono text-xs text-fg-secondary">
              {onboard?.version || "—"}
            </span>
          </SettingRow>

          <SettingRow label="Gateway version">
            <span className="font-mono text-xs text-fg-secondary">
              {gw?.version || "—"}
            </span>
          </SettingRow>

          <SettingRow label="Home directory">
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono text-xs text-fg-secondary">
              {onboard?.home || "—"}
            </span>
          </SettingRow>

          <SettingRow label="Config hash">
            <span className="rounded-md bg-muted/50 px-2 py-1 font-mono text-xs text-fg-secondary">
              {settings?.configHash || "—"}
            </span>
          </SettingRow>

          <div className="flex flex-wrap gap-3 pt-1">
            <a
              href="https://docs.openclaw.ai"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-control border border-foreground/10 bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted/80 hover:text-foreground"
            >
              Documentation
              <ExternalLink className="h-3 w-3" />
            </a>
            <a
              href="https://github.com/robsannaa/openclaw-mission-control/issues"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-control border border-foreground/10 bg-card px-3 py-1.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted/80 hover:text-foreground"
            >
              Report an issue
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </SettingsSection>
      </SectionBody>
    </SectionLayout>
  );
}

/* ── Internal sub-components ─────────────────────── */

function SettingsSection({
  title,
  icon: Icon,
  iconColor,
  defaultOpen = false,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="glass-subtle rounded-xl overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-4 py-3 transition-colors hover:bg-foreground/5"
      >
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Icon className={cn("h-4 w-4", iconColor)} />
          {title}
        </div>
        <ChevronDown
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="border-t border-foreground/10 px-4 py-4 space-y-4">
          {children}
        </div>
      )}
    </div>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">{label}</p>
        {description && (
          <p className="mt-0.5 text-xs text-fg-subtle">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function ToggleSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (val: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 block h-4 w-4 rounded-full bg-card shadow transition-transform",
          checked ? "left-4" : "left-0.5",
        )}
      />
    </button>
  );
}

const BADGE_COLORS: Record<string, string> = {
  emerald: "border-success-border bg-success-bg text-success-fg",
  amber: "border-warning-border bg-warning-bg text-warning-fg",
  red: "border-danger-border bg-danger-bg text-danger-fg",
  blue: "border-info-border bg-info-bg text-info-fg",
  zinc: "border-foreground/10 bg-muted/50 text-muted-foreground",
};

function Badge({ label, color }: { label: string; color: string }) {
  return (
    <span
      className={cn(
        "rounded-md border px-2 py-0.5 text-xs font-medium",
        BADGE_COLORS[color] || BADGE_COLORS.zinc,
      )}
    >
      {label}
    </span>
  );
}
