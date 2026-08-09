"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  CircleHelp,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  Bot,
  Lock,
  Eye,
  Pencil,
  Shield,
  Wifi,
  WifiOff,
  Radio,
  Container,
  KeyRound,
  ToggleLeft,
  ToggleRight,
} from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";
import { PermissionsView } from "@/components/permissions-view";
import { cn } from "@/lib/utils";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
  type TimeFormatPreference,
} from "@/lib/time-format-preference";

/* ── types ─────────────────────────────────────── */

type SecuritySeverity = "critical" | "warn" | "info";

type SecurityFinding = {
  checkId: string;
  severity: SecuritySeverity;
  title: string;
  detail?: string;
  remediation?: string;
};

type SecurityAuditReport = {
  ts: number;
  mode: "quick" | "deep" | "fix";
  summary: { critical: number; warn: number; info: number };
  findings: SecurityFinding[];
  deep?: unknown;
};

type SecurityFixAction = {
  kind: string;
  path?: string;
  mode?: number;
  ok?: boolean;
  skipped?: string;
  error?: string;
};

type SecurityFixResult = {
  ok: boolean;
  stateDir?: string;
  configPath?: string;
  configWritten?: boolean;
  changes: string[];
  actions: SecurityFixAction[];
  errors: string[];
};

type SecuritySnapshot = {
  ts: number;
  docsUrl: string;
  cache: {
    updatedAt?: number;
    lastAudit?: SecurityAuditReport;
    lastFix?: { ts: number; fix: SecurityFixResult; report: SecurityAuditReport };
  };
  warning?: string;
  degraded?: boolean;
  error?: string;
};

type SecurityPrefs = {
  autoScan: boolean;
  defaultMode: "quick" | "deep";
};

type SecurityTab = "health" | "gateway" | "sandbox" | "secrets" | "permissions";

type ConfigData = {
  rawConfig: Record<string, unknown>;
  baseHash: string;
  warning?: string;
  degraded?: boolean;
};

/* ── constants ──────────────────────────────────── */

const TABS: { id: SecurityTab; label: string }[] = [
  { id: "health", label: "Health" },
  { id: "gateway", label: "Gateway" },
  { id: "sandbox", label: "Sandbox & Tools" },
  { id: "secrets", label: "Secrets & Auth" },
  { id: "permissions", label: "Permissions" },
];

const PREFS_KEY = "openclaw-security-center-prefs-v1";
const TAB_PREF_KEY = "openclaw-security-center-tab-v2";
const DEFAULT_PREFS: SecurityPrefs = { autoScan: true, defaultMode: "quick" };
const STALE_AUDIT_MS = 24 * 60 * 60 * 1000;
const EMPTY_SUMMARY = { critical: 0, warn: 0, info: 0 } as const;

/* ── helpers ────────────────────────────────────── */

function formatTime(ts: number | undefined, timeFormat: TimeFormatPreference): string {
  if (!ts) return "Never";
  return new Date(ts).toLocaleString(
    undefined,
    withTimeFormat(
      {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      },
      timeFormat,
    ),
  );
}

function formatAge(ts?: number): string {
  if (!ts) return "not yet scanned";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function loadPrefs(): SecurityPrefs {
  if (typeof window === "undefined") return DEFAULT_PREFS;
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<SecurityPrefs>;
    return {
      autoScan: parsed.autoScan !== false,
      defaultMode: parsed.defaultMode === "deep" ? "deep" : "quick",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefs(prefs: SecurityPrefs): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {}
}

function loadTabPref(): SecurityTab {
  if (typeof window === "undefined") return "health";
  try {
    const saved = localStorage.getItem(TAB_PREF_KEY);
    if (saved && TABS.some((t) => t.id === saved)) return saved as SecurityTab;
  } catch {}
  return "health";
}

function saveTabPref(tab: SecurityTab): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TAB_PREF_KEY, tab);
  } catch {}
}

function severityLabel(severity: SecuritySeverity): string {
  if (severity === "critical") return "critical";
  if (severity === "warn") return "warning";
  return "info";
}

function severityBorder(severity: SecuritySeverity): string {
  if (severity === "critical") return "border-l-red-500";
  if (severity === "warn") return "border-l-amber-500";
  return "border-l-blue-500";
}

function severityBadge(severity: SecuritySeverity): string {
  if (severity === "critical") return "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-200";
  if (severity === "warn") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-200";
  return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-200";
}

function computeGrade(summary: { critical: number; warn: number; info: number }): string {
  if (summary.critical >= 3) return "F";
  if (summary.critical >= 1) return "D";
  if (summary.warn >= 5) return "C";
  if (summary.warn >= 1) return "B";
  return "A";
}

function gradeColor(grade: string): string {
  if (grade === "A") return "text-emerald-600 dark:text-emerald-400";
  if (grade === "B") return "text-blue-600 dark:text-blue-400";
  if (grade === "C") return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

/** Deep-get a dotted path from a nested object */
function getPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/* ── shared ui atoms ────────────────────────────── */

function Dots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}

function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="glass-subtle rounded-lg px-4 py-3.5">
      <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">{label}</p>
      <p className="mt-1.5 text-xl font-semibold leading-none tabular-nums text-foreground">{value}</p>
      {sub && <p className="mt-1.5 text-xs text-muted-foreground/60">{sub}</p>}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="glass rounded-lg p-4 md:p-5">
      <div className="mb-4">
        <h2 className="text-xs font-sans font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground/60">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function OptionCard({
  selected,
  onClick,
  icon,
  label,
  description,
  color = "default",
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
  label: string;
  description: string;
  color?: "default" | "red" | "amber" | "emerald";
  disabled?: boolean;
}) {
  const borderMap = {
    default: selected ? "border-foreground/20" : "border-foreground/10",
    red: selected ? "border-red-500/40 bg-red-500/5" : "border-foreground/10",
    amber: selected ? "border-amber-500/40 bg-amber-500/5" : "border-foreground/10",
    emerald: selected ? "border-emerald-500/40 bg-emerald-500/5" : "border-foreground/10",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "glass-glow rounded-lg p-3 text-left transition-colors disabled:opacity-50",
        borderMap[color],
        selected && color === "default" && "ring-1 ring-foreground/10",
      )}
    >
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-xs font-medium text-foreground/90">{label}</p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground/60">{description}</p>
    </button>
  );
}

/* ── dangerous flags definition ─────────────────── */

type DangerousFlag = {
  id: string;
  configPath: string;
  label: string;
  description: string;
  inverse?: boolean; // if true, "enabled" means the config value is false
};

const DANGEROUS_FLAGS: DangerousFlag[] = [
  {
    id: "allowInsecureAuth",
    configPath: "gateway.controlUi.allowInsecureAuth",
    label: "Allow insecure auth on non-HTTPS",
    description: "Permits authentication without TLS, exposing credentials in transit.",
  },
  {
    id: "dangerouslyAllowHostHeaderOriginFallback",
    configPath: "gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback",
    label: "Relax origin checking",
    description: "Falls back to Host header for origin validation, weakening CSRF protection.",
  },
  {
    id: "dangerouslyDisableDeviceAuth",
    configPath: "gateway.controlUi.dangerouslyDisableDeviceAuth",
    label: "Disable device verification",
    description: "Skips device authentication, allowing any client to connect.",
  },
  {
    id: "gmailUnsafe",
    configPath: "hooks.gmail.allowUnsafeExternalContent",
    label: "Allow unfiltered Gmail content",
    description: "Passes raw external email content to agents without sanitization.",
  },
  {
    id: "patchOutsideWorkspace",
    configPath: "tools.exec.applyPatch.workspaceOnly",
    label: "Allow patching outside workspace",
    description: "Lets applyPatch write to files outside the designated workspace directory.",
    inverse: true,
  },
];

/* ── main component ─────────────────────────────── */

export function SecurityView({ initialTab }: { initialTab?: SecurityTab } = {}) {
  /* ── state ──────────────────────────────────── */
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [snapshot, setSnapshot] = useState<SecuritySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<"success" | "error" | "info">("success");
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);
  const [prefs, setPrefs] = useState<SecurityPrefs>(DEFAULT_PREFS);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [showFixConfirm, setShowFixConfirm] = useState(false);
  const [fixAcknowledge, setFixAcknowledge] = useState(false);
  const [activeTab, setActiveTab] = useState<SecurityTab>(initialTab || "health");
  const autoScanTriggered = useRef(false);

  // Config state (for Gateway, Sandbox, Secrets tabs)
  const [configData, setConfigData] = useState<ConfigData | null>(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [configSaving, setConfigSaving] = useState(false);

  // Secrets & Models check state
  const [secretsResult, setSecretsResult] = useState<string | null>(null);
  const [secretsChecking, setSecretsChecking] = useState(false);
  const [modelsResult, setModelsResult] = useState<string | null>(null);
  const [modelsChecking, setModelsChecking] = useState(false);

  const showNotice = useCallback(
    (message: string, tone: "success" | "error" | "info" = "info") => {
      setNoticeTone(tone);
      setNotice(message);
    },
    [],
  );

  // Config convenience getters
  const raw = useMemo(() => configData?.rawConfig || {}, [configData?.rawConfig]);
  const cfgGet = useCallback((path: string) => getPath(raw, path), [raw]);

  /* ── prefs persistence ──────────────────────── */
  useEffect(() => {
    setPrefs(loadPrefs());
    setPrefsLoaded(true);
  }, []);

  useEffect(() => {
    if (!prefsLoaded) return;
    savePrefs(prefs);
  }, [prefs, prefsLoaded]);

  /* ── tab persistence ────────────────────────── */
  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
      return;
    }
    setActiveTab(loadTabPref());
  }, [initialTab]);

  useEffect(() => {
    if (initialTab) return;
    saveTabPref(activeTab);
  }, [activeTab, initialTab]);

  /* ── security data ──────────────────────────── */
  const load = useCallback(async () => {
    setLoading(true);
    setApiWarning(null);
    setApiDegraded(false);
    try {
      const res = await fetch("/api/security", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as SecuritySnapshot;
      setSnapshot(data);
      setError(null);
      if (data.warning) setApiWarning(data.warning);
      if (data.degraded) setApiDegraded(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setApiWarning(message);
      setApiDegraded(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /* ── config data ────────────────────────────── */
  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setConfigData({
        rawConfig: data.config || {},
        baseHash: data.meta?.baseHash || "",
        warning: data.meta?.warning,
        degraded: data.meta?.degraded,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showNotice(`Config load failed: ${msg}`, "error");
    } finally {
      setConfigLoading(false);
    }
  }, [showNotice]);

  // Load config when switching to tabs that need it
  useEffect(() => {
    if (["gateway", "sandbox", "secrets"].includes(activeTab) && !configData && !configLoading) {
      void loadConfig();
    }
  }, [activeTab, configData, configLoading, loadConfig]);

  const friendlySaveError = useCallback((message: string) => {
    const raw = String(message || "");
    const lower = raw.toLowerCase();
    if (lower.includes("rate limit")) {
      return "OpenClaw is applying another config change right now. Wait a few seconds and try again.";
    }
    if (lower.includes("invalid config")) {
      return "OpenClaw rejected this change because another setting is invalid. Mission Control tried an automatic repair but still could not save.";
    }
    if (lower.includes("basehash") || lower.includes("base hash") || lower.includes("hash mismatch")) {
      return "This setting changed elsewhere at the same time. Please try again.";
    }
    return raw;
  }, []);

  const patchConfig = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!configData?.baseHash) {
        showNotice("Cannot save yet. Security settings are still loading.", "error");
        return;
      }
      const noChanges = Object.entries(patch).every(([path, nextVal]) => Object.is(cfgGet(path), nextVal));
      if (noChanges) {
        showNotice("No change needed. This setting is already applied.", "info");
        return;
      }
      setConfigSaving(true);
      setNotice(null);
      setError(null);
      try {
        const res = await fetch("/api/config", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patch, baseHash: configData.baseHash }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (data?.fallbackUsed) {
          showNotice(
            "Configuration saved. Mission Control used a compatibility path to keep this update reliable.",
            "success",
          );
        } else if (data?.repairedConfig) {
          showNotice("Configuration saved after repairing an invalid local config.", "success");
        } else {
          showNotice("Configuration saved.", "success");
        }
        // Reload config to get fresh baseHash
        await loadConfig();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        showNotice(`Save failed: ${friendlySaveError(msg)}`, "error");
      } finally {
        setConfigSaving(false);
      }
    },
    [cfgGet, configData?.baseHash, friendlySaveError, loadConfig, showNotice],
  );

  /* ── audit / fix ────────────────────────────── */
  const runAudit = useCallback(
    async (mode: "quick" | "deep", silent = false) => {
      setMutating(true);
      setPendingAction(mode === "deep" ? "audit-deep" : "audit-quick");
      if (!silent) setNotice(null);
      try {
        const res = await fetch("/api/security", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "audit", mode }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
        setSnapshot((prev) => ({
          ts: Date.now(),
          docsUrl: prev?.docsUrl || "https://docs.openclaw.ai/cli/security",
          cache: data.cache || prev?.cache || {},
          warning: data.warning || undefined,
          degraded: false,
        }));
        setShowFixConfirm(false);
        setFixAcknowledge(false);
        setError(null);
        if (!silent) {
          showNotice(
            mode === "deep" ? "Deep security audit completed." : "Security audit completed.",
            "success",
          );
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setMutating(false);
        setPendingAction(null);
      }
    },
    [showNotice],
  );

  const runFix = useCallback(async () => {
    setMutating(true);
    setPendingAction("fix");
    setNotice(null);
    try {
      const res = await fetch("/api/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "fix" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
      setSnapshot((prev) => ({
        ts: Date.now(),
        docsUrl: prev?.docsUrl || "https://docs.openclaw.ai/cli/security",
        cache: data.cache || prev?.cache || {},
        warning: data.warning || undefined,
        degraded: false,
      }));
      setShowFixConfirm(false);
      setFixAcknowledge(false);
      setError(null);
      showNotice("Safe security fixes applied. Review findings below.", "success");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
      setPendingAction(null);
    }
  }, [showNotice]);

  /* ── auto-scan ──────────────────────────────── */
  useEffect(() => {
    if (!snapshot || !prefsLoaded || autoScanTriggered.current) return;
    if (!prefs.autoScan) return;
    const lastTs = snapshot.cache.lastAudit?.ts || 0;
    if (!lastTs || Date.now() - lastTs > STALE_AUDIT_MS) {
      autoScanTriggered.current = true;
      void runAudit(prefs.defaultMode, true);
    }
  }, [prefs.autoScan, prefs.defaultMode, prefsLoaded, runAudit, snapshot]);

  /* ── secrets / models checks ────────────────── */
  const checkSecrets = useCallback(async () => {
    setSecretsChecking(true);
    setSecretsResult(null);
    try {
      const res = await fetch("/api/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-secrets" }),
      });
      const data = await res.json();
      setSecretsResult(data.output || "Check complete.");
    } catch (err) {
      setSecretsResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSecretsChecking(false);
    }
  }, []);

  const checkModels = useCallback(async () => {
    setModelsChecking(true);
    setModelsResult(null);
    try {
      const res = await fetch("/api/security", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check-models" }),
      });
      const data = await res.json();
      if (data.models) {
        setModelsResult(JSON.stringify(data.models, null, 2));
      } else {
        setModelsResult(data.output || "Check complete.");
      }
    } catch (err) {
      setModelsResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setModelsChecking(false);
    }
  }, []);

  /* ── derived data ───────────────────────────── */
  const lastAudit = snapshot?.cache.lastAudit || null;
  const lastFix = snapshot?.cache.lastFix || null;
  const summary = lastAudit?.summary ?? EMPTY_SUMMARY;
  const grade = useMemo(() => computeGrade(summary), [summary]);

  const findings = useMemo(() => {
    const order: Record<SecuritySeverity, number> = { critical: 0, warn: 1, info: 2 };
    return [...(lastAudit?.findings || [])].sort((a, b) => {
      const sev = order[a.severity] - order[b.severity];
      if (sev !== 0) return sev;
      return a.checkId.localeCompare(b.checkId);
    });
  }, [lastAudit?.findings]);

  const deepGateway = useMemo(() => {
    if (!lastAudit?.deep || typeof lastAudit.deep !== "object" || Array.isArray(lastAudit.deep)) return null;
    const deep = lastAudit.deep as Record<string, unknown>;
    if (!deep.gateway || typeof deep.gateway !== "object" || Array.isArray(deep.gateway)) return null;
    return deep.gateway as Record<string, unknown>;
  }, [lastAudit?.deep]);

  const deepIssue = useMemo(() => {
    if (!deepGateway) return "";
    const value = deepGateway.error || deepGateway.close;
    return String(value || "").trim();
  }, [deepGateway]);

  const initialLoading = loading && !snapshot;
  const busy = mutating || configSaving;

  /* ── render ─────────────────────────────────── */
  return (
    <SectionLayout>
      <SectionHeader
        title="Security"
        description="Audit, configure, and monitor every security-relevant setting across your OpenClaw deployment."
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <button
              type="button"
              onClick={() => {
                void load();
                void loadConfig();
              }}
              disabled={loading || mutating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100"
            >
              {loading || mutating ? <Dots /> : <RefreshCw className="h-3.5 w-3.5" />}
              Refresh
            </button>
          </div>
        }
      />

      <SectionBody width="content" padding="regular" innerClassName="space-y-4">
        {/* ── Tab picker ────────────────────────── */}
        <div className="inline-flex rounded-lg border border-border bg-muted p-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200",
                activeTab === tab.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── Notices ───────────────────────────── */}
        {error && (
          <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-4 py-2.5 text-xs text-red-700 dark:text-red-200">
            {error}
          </div>
        )}
        {notice && (
          <div
            className={cn(
              "rounded-lg border px-4 py-2.5 text-xs",
              noticeTone === "success" &&
                "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-200",
              noticeTone === "error" &&
                "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-200",
              noticeTone === "info" &&
                "border-blue-500/25 bg-blue-500/10 text-blue-700 dark:text-blue-200",
            )}
          >
            {notice}
          </div>
        )}

        {/* ═══════════════ HEALTH TAB ═══════════════ */}
        {activeTab === "health" && (
          <>
            {initialLoading ? (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={`skel-stat-${i}`} className="glass-subtle rounded-lg px-4 py-3.5">
                      <Skeleton className="h-3 w-24" />
                      <Skeleton className="mt-2 h-6 w-20" />
                      <Skeleton className="mt-2 h-3 w-32" />
                    </div>
                  ))}
                </div>
                <div className="glass rounded-lg p-4">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="mt-3 h-8 w-full rounded-lg" />
                  <Skeleton className="mt-2 h-8 w-full rounded-lg" />
                </div>
              </>
            ) : (
              <>
                {/* Metric tiles */}
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <MetricTile
                    label="Overall Grade"
                    value={lastAudit ? grade : "—"}
                    sub={lastAudit ? `${summary.critical} critical · ${summary.warn} warn · ${summary.info} info` : "Run a scan to grade"}
                  />
                  <MetricTile
                    label="Critical Issues"
                    value={String(summary.critical)}
                    sub={summary.critical > 0 ? "Immediate attention needed" : "None detected"}
                  />
                  <MetricTile
                    label="Warnings"
                    value={String(summary.warn)}
                    sub={summary.warn > 0 ? "Review recommended" : "All clear"}
                  />
                  <MetricTile
                    label="Last Scan"
                    value={lastAudit ? formatAge(lastAudit.ts) : "Never"}
                    sub={lastAudit ? `${lastAudit.mode} scan` : "Run a quick or deep scan"}
                  />
                </div>

                {/* Score shield */}
                {lastAudit && (
                  <div className="glass rounded-lg p-4 md:p-5">
                    <div className="flex items-center gap-4">
                      <div className={cn("flex h-16 w-16 items-center justify-center rounded-xl border-2", grade === "A" ? "border-emerald-500/40 bg-emerald-500/10" : grade === "B" ? "border-blue-500/40 bg-blue-500/10" : grade === "C" ? "border-amber-500/40 bg-amber-500/10" : "border-red-500/40 bg-red-500/10")}>
                        <span className={cn("text-3xl font-bold", gradeColor(grade))}>{grade}</span>
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-foreground/90">
                          {grade === "A" ? "Excellent" : grade === "B" ? "Good" : grade === "C" ? "Fair" : "Needs Work"}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground/70">
                          {findings.length} finding{findings.length !== 1 ? "s" : ""} from {lastAudit.mode} scan · {formatTime(lastAudit.ts, timeFormat)}
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions panel */}
                <Panel title="Security Actions" subtitle="Quick audit for daily checks. Deep audit probes live gateway reachability.">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void runAudit("quick")}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-200 disabled:opacity-50"
                    >
                      {pendingAction === "audit-quick" ? <Dots /> : <ShieldCheck className="h-3.5 w-3.5" />}
                      Quick Audit
                    </button>
                    <button
                      type="button"
                      onClick={() => void runAudit("deep")}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/15 px-2.5 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-200 disabled:opacity-50"
                    >
                      {pendingAction === "audit-deep" ? <Dots /> : <CircleHelp className="h-3.5 w-3.5" />}
                      Deep Audit
                    </button>
                    <button
                      type="button"
                      onClick={() => { setShowFixConfirm((p) => !p); setFixAcknowledge(false); }}
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-200 disabled:opacity-50"
                    >
                      <Wrench className="h-3.5 w-3.5" />
                      Apply Safe Fixes
                    </button>
                  </div>

                  {/* Auto-scan prefs */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground/75">
                    <label className="inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={prefs.autoScan}
                        onChange={(e) => setPrefs((p) => ({ ...p, autoScan: e.target.checked }))}
                        className="h-3.5 w-3.5 rounded border border-foreground/20 bg-card"
                      />
                      Auto-run when stale
                    </label>
                    <span>Default mode:</span>
                    <select
                      value={prefs.defaultMode}
                      onChange={(e) => setPrefs((p) => ({ ...p, defaultMode: e.target.value === "deep" ? "deep" : "quick" }))}
                      aria-label="Default scan mode"
                      className="rounded border border-foreground/15 bg-card px-2 py-1 text-xs text-foreground/90"
                    >
                      <option value="quick">quick</option>
                      <option value="deep">deep</option>
                    </select>
                  </div>

                  {/* Fix confirmation */}
                  {showFixConfirm && (
                    <div className="mt-3 glass-subtle rounded-lg p-3 text-xs">
                      <p className="font-medium text-amber-700 dark:text-amber-200">Before applying fixes</p>
                      <p className="mt-1 text-muted-foreground/80">
                        This applies OpenClaw&apos;s built-in safe remediations: permission hardening and security defaults.
                      </p>
                      <p className="mt-2 font-medium text-foreground/90">What it fixes:</p>
                      <p className="text-muted-foreground/75">groupPolicy hardening, sensitive logging defaults, and sensitive-file permissions.</p>
                      <p className="mt-1 font-medium text-foreground/90">What it does not do:</p>
                      <p className="text-muted-foreground/75">It does not rotate secrets, disable tools, or rewrite plugins/skills.</p>
                      <label className="mt-2 inline-flex items-center gap-1.5 text-foreground/85">
                        <input
                          type="checkbox"
                          checked={fixAcknowledge}
                          onChange={(e) => setFixAcknowledge(e.target.checked)}
                          className="h-3.5 w-3.5 rounded border border-foreground/20 bg-card"
                        />
                        I understand this updates local OpenClaw security settings.
                      </label>
                      <div className="mt-2">
                        <button
                          type="button"
                          onClick={() => void runFix()}
                          disabled={busy || !fixAcknowledge}
                          className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-200 disabled:opacity-50"
                        >
                          {pendingAction === "fix" ? <Dots /> : <Wrench className="h-3.5 w-3.5" />}
                          Confirm and apply safe fixes
                        </button>
                      </div>
                    </div>
                  )}
                </Panel>

                {/* Findings list */}
                <Panel title={`Findings (${findings.length})`}>
                  {findings.length === 0 ? (
                    <div className="glass-subtle rounded-lg px-4 py-8 text-center text-xs text-emerald-700 dark:text-emerald-200">
                      {lastAudit ? "No findings in the latest audit." : "Run an audit to see security findings."}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {findings.map((f) => (
                        <div key={f.checkId} className={cn("glass-subtle rounded-lg border-l-2 px-3 py-2", severityBorder(f.severity))}>
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="text-xs font-medium text-foreground/90">{f.title}</p>
                              <p className="text-[11px] text-muted-foreground/70">{f.checkId}</p>
                            </div>
                            <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-medium", severityBadge(f.severity))}>
                              {severityLabel(f.severity)}
                            </span>
                          </div>
                          {f.detail && <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground/80">{f.detail}</p>}
                          {f.remediation && (
                            <div className="mt-2 rounded-md border border-cyan-500/20 bg-cyan-500/8 px-2 py-1.5 text-xs text-cyan-800 dark:text-cyan-100">
                              <span className="font-medium">Suggested fix:</span> {f.remediation}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </Panel>

                {/* Deep gateway */}
                {deepGateway && (
                  <Panel title="Deep Audit Gateway Check">
                    <p className="text-xs text-muted-foreground/75">
                      attempted: <code>{String(Boolean(deepGateway.attempted))}</code> · ok: <code>{String(Boolean(deepGateway.ok))}</code> · url: <code>{String(deepGateway.url || "unknown")}</code>
                    </p>
                    {Boolean(deepIssue) && (
                      <p className="mt-1 text-xs text-amber-700 dark:text-amber-200">
                        issue: <code>{deepIssue}</code>
                      </p>
                    )}
                  </Panel>
                )}

                {/* Last fix */}
                {lastFix && (
                  <Panel title="Last Safe Fix Run">
                    <p className="text-xs text-muted-foreground/75">
                      {formatTime(lastFix.ts, timeFormat)} · status:{" "}
                      <span className={lastFix.fix.ok ? "text-emerald-700 dark:text-emerald-200" : "text-red-700 dark:text-red-200"}>
                        {lastFix.fix.ok ? "ok" : "needs review"}
                      </span>
                      {" · "}changes: <code>{lastFix.fix.changes.length}</code> · action steps: <code>{lastFix.fix.actions.length}</code>
                    </p>
                    {lastFix.fix.configPath && (
                      <p className="mt-1 text-xs text-muted-foreground/75">
                        config path: <code>{lastFix.fix.configPath}</code>
                      </p>
                    )}
                    {lastFix.fix.changes.length > 0 && (
                      <div className="mt-2 glass-subtle rounded-lg p-2.5">
                        <p className="text-xs font-medium text-emerald-700 dark:text-emerald-200">Changes</p>
                        <div className="mt-1 space-y-1">
                          {lastFix.fix.changes.slice(0, 8).map((c, i) => (
                            <p key={`change-${i}`} className="text-xs text-emerald-800 dark:text-emerald-100">{c}</p>
                          ))}
                        </div>
                      </div>
                    )}
                    {lastFix.fix.errors.length > 0 && (
                      <div className="mt-2 rounded-lg border border-red-500/20 bg-red-500/5 p-2.5">
                        <p className="text-xs font-medium text-red-700 dark:text-red-200">Fix errors</p>
                        <div className="mt-1 space-y-1">
                          {lastFix.fix.errors.slice(0, 6).map((e, i) => (
                            <p key={`err-${i}`} className="text-xs text-red-800 dark:text-red-100">{e}</p>
                          ))}
                        </div>
                      </div>
                    )}
                  </Panel>
                )}
              </>
            )}
          </>
        )}

        {/* ═══════════════ GATEWAY TAB ═══════════════ */}
        {activeTab === "gateway" && (
          <>
            {configLoading && !configData ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={`gw-skel-${i}`} className="glass rounded-lg p-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-3 h-10 w-full rounded-lg" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <GatewayAuthCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <GatewayBindCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <GatewayMdnsCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <DangerousFlagsCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
              </>
            )}
          </>
        )}

        {/* ═══════════════ SANDBOX TAB ═══════════════ */}
        {activeTab === "sandbox" && (
          <>
            {configLoading && !configData ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={`sb-skel-${i}`} className="glass rounded-lg p-4">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="mt-3 h-10 w-full rounded-lg" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <SandboxModeCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <SandboxScopeCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <WorkspaceAccessCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <ExecSecurityCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
                <QuickPresetsCard patchConfig={patchConfig} busy={busy} />
                <ToolPolicySummary cfgGet={cfgGet} onGoToPermissions={() => setActiveTab("permissions")} />
              </>
            )}
          </>
        )}

        {/* ═══════════════ SECRETS TAB ═══════════════ */}
        {activeTab === "secrets" && (
          <>
            {/* Secrets Health */}
            <Panel title="Secrets Health" subtitle="Run an audit of locally stored credentials and secret files.">
              <button
                type="button"
                onClick={checkSecrets}
                disabled={secretsChecking}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-200 disabled:opacity-50"
              >
                {secretsChecking ? <Dots /> : <KeyRound className="h-3.5 w-3.5" />}
                Check Secrets
              </button>
              {secretsResult && (
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words glass-subtle rounded-lg p-3 text-xs text-foreground/85">
                  {secretsResult}
                </pre>
              )}
            </Panel>

            {/* Model Auth Status */}
            <Panel title="Model Auth Status" subtitle="Verify provider authentication tokens are valid and active.">
              <button
                type="button"
                onClick={checkModels}
                disabled={modelsChecking}
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-500/30 bg-blue-500/15 px-2.5 py-1.5 text-xs font-medium text-blue-700 dark:text-blue-200 disabled:opacity-50"
              >
                {modelsChecking ? <Dots /> : <Bot className="h-3.5 w-3.5" />}
                Check Models
              </button>
              {modelsResult && (
                <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words glass-subtle rounded-lg p-3 text-xs text-foreground/85">
                  {modelsResult}
                </pre>
              )}
            </Panel>

            {/* Logging & Redaction */}
            {configLoading && !configData ? (
              <div className="glass rounded-lg p-4">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-3 h-10 w-full rounded-lg" />
              </div>
            ) : (
              <RedactionCard cfgGet={cfgGet} patchConfig={patchConfig} busy={busy} />
            )}
          </>
        )}

        {/* ═══════════════ PERMISSIONS TAB ═══════════════ */}
        {activeTab === "permissions" && (
          <PermissionsView embedded />
        )}
      </SectionBody>
    </SectionLayout>
  );
}

/* ════════════════════════════════════════════════════
   Gateway sub-cards
   ════════════════════════════════════════════════════ */

type CardProps = {
  cfgGet: (path: string) => unknown;
  patchConfig: (patch: Record<string, unknown>) => Promise<void>;
  busy: boolean;
};

function GatewayAuthCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("gateway.auth.mode") || "token");
  const hasPassword = Boolean(String(cfgGet("gateway.auth.password") || "").trim());
  const options = [
    { value: "token", label: "Token", desc: "Authenticate with a shared secret token (default)." },
    {
      value: "password",
      label: "Password",
      desc: hasPassword
        ? "Authenticate with a user-set password."
        : "Requires a saved gateway password first (set in Config Editor).",
    },
    { value: "none", label: "None", desc: "No authentication required. Not recommended." },
  ] as const;

  return (
    <Panel title="Authentication Mode" subtitle="How clients authenticate to the gateway.">
      {current === "none" && (
        <div className="mb-3 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-200">
          <ShieldAlert className="mr-1 inline h-3 w-3" />
          Auth is disabled. Any client can connect without credentials.
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "gateway.auth.mode": opt.value })}
            label={opt.label}
            description={opt.desc}
            color={opt.value === "none" ? "red" : current === opt.value ? "emerald" : "default"}
            disabled={busy || (opt.value === "password" && !hasPassword && current !== "password")}
          />
        ))}
      </div>
    </Panel>
  );
}

function GatewayBindCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("gateway.bind") || "loopback");
  const options = [
    { value: "loopback", label: "Loopback", desc: "Only this computer (127.0.0.1).", icon: <Lock className="h-3.5 w-3.5 text-emerald-500" /> },
    { value: "lan", label: "LAN", desc: "Accessible on your local network.", icon: <Wifi className="h-3.5 w-3.5 text-amber-500" /> },
    { value: "tailnet", label: "Tailscale VPN", desc: "Accessible via Tailscale network only.", icon: <Radio className="h-3.5 w-3.5 text-blue-500" /> },
  ] as const;

  return (
    <Panel title="Network Binding" subtitle="Controls which network interfaces the gateway listens on.">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "gateway.bind": opt.value })}
            icon={opt.icon}
            label={opt.label}
            description={opt.desc}
            disabled={busy}
          />
        ))}
      </div>
    </Panel>
  );
}

function GatewayMdnsCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("discovery.mdns.mode") || "minimal");
  const options = [
    { value: "minimal", label: "Minimal", desc: "Broadcast only hostname (recommended)." },
    { value: "off", label: "Off", desc: "No mDNS discovery. Clients need manual config." },
    { value: "full", label: "Full", desc: "Broadcast all service metadata." },
  ] as const;

  return (
    <Panel title="mDNS Discovery" subtitle="Controls what the gateway advertises on the local network.">
      {current === "full" && (
        <div className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          Full mDNS broadcasts all service metadata to the local network.
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "discovery.mdns.mode": opt.value })}
            label={opt.label}
            description={opt.desc}
            color={opt.value === "full" && current === "full" ? "amber" : "default"}
            disabled={busy}
          />
        ))}
      </div>
    </Panel>
  );
}

function DangerousFlagsCard({ cfgGet, patchConfig, busy }: CardProps) {
  return (
    <Panel title="Dangerous Flags" subtitle="Security overrides that should normally remain disabled.">
      <div className="space-y-2">
        {DANGEROUS_FLAGS.map((flag) => {
          const rawVal = cfgGet(flag.configPath);
          const isEnabled = flag.inverse
            ? rawVal === false
            : rawVal === true;

          return (
            <div
              key={flag.id}
              className={cn(
                "glass-subtle rounded-lg px-3 py-2.5",
                isEnabled && "border-l-2 border-l-red-500",
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-foreground/90">{flag.label}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground/60">{flag.description}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const newVal = flag.inverse ? isEnabled : !isEnabled;
                    const configVal = flag.inverse ? !newVal : newVal;
                    void patchConfig({ [flag.configPath]: configVal });
                  }}
                  disabled={busy}
                  className="shrink-0 disabled:opacity-50"
                  title={isEnabled ? "Disable" : "Enable"}
                >
                  {isEnabled ? (
                    <ToggleRight className="h-6 w-6 text-red-500" />
                  ) : (
                    <ToggleLeft className="h-6 w-6 text-muted-foreground/40" />
                  )}
                </button>
              </div>
              {isEnabled && (
                <div className="mt-2 rounded-md border border-red-500/20 bg-red-500/8 px-2 py-1 text-[11px] text-red-700 dark:text-red-200">
                  This override is currently active. Consider disabling it unless required.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/* ════════════════════════════════════════════════════
   Sandbox sub-cards
   ════════════════════════════════════════════════════ */

function SandboxModeCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("agents.defaults.sandbox.mode") || "off");
  const options = [
    { value: "off", label: "Off", desc: "No sandboxing — agents run directly on your system.", icon: <WifiOff className="h-3.5 w-3.5 text-red-400" /> },
    { value: "non-main", label: "Non-main", desc: "Sandbox non-primary sessions (recommended).", icon: <Container className="h-3.5 w-3.5 text-amber-400" /> },
    { value: "all", label: "All", desc: "Maximum isolation — everything runs in containers.", icon: <Shield className="h-3.5 w-3.5 text-emerald-400" /> },
  ] as const;

  return (
    <Panel title="Sandbox Mode" subtitle="Controls whether agent sessions run in isolated containers.">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "agents.defaults.sandbox.mode": opt.value })}
            icon={opt.icon}
            label={opt.label}
            description={opt.desc}
            color={opt.value === "off" && current === "off" ? "red" : opt.value === "all" && current === "all" ? "emerald" : "default"}
            disabled={busy}
          />
        ))}
      </div>
    </Panel>
  );
}

function SandboxScopeCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("agents.defaults.sandbox.scope") || "session");
  const options = [
    { value: "session", label: "Session", desc: "Each session gets its own sandbox." },
    { value: "agent", label: "Agent", desc: "Each agent identity shares a sandbox." },
    { value: "shared", label: "Shared", desc: "All sessions share one sandbox." },
  ] as const;

  return (
    <Panel title="Sandbox Scope" subtitle="Determines sandbox lifecycle boundaries.">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "agents.defaults.sandbox.scope": opt.value })}
            label={opt.label}
            description={opt.desc}
            disabled={busy}
          />
        ))}
      </div>
    </Panel>
  );
}

function WorkspaceAccessCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("agents.defaults.sandbox.workspaceAccess") || "ro");
  const options = [
    { value: "none", label: "None", desc: "No workspace access.", icon: <Lock className="h-3.5 w-3.5 text-red-400" /> },
    { value: "ro", label: "Read-only", desc: "Can read but not modify workspace.", icon: <Eye className="h-3.5 w-3.5 text-amber-400" /> },
    { value: "rw", label: "Read-write", desc: "Full workspace access.", icon: <Pencil className="h-3.5 w-3.5 text-emerald-400" /> },
  ] as const;

  return (
    <Panel title="Workspace Access" subtitle="Controls sandbox access to the workspace directory.">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "agents.defaults.sandbox.workspaceAccess": opt.value })}
            icon={opt.icon}
            label={opt.label}
            description={opt.desc}
            disabled={busy}
          />
        ))}
      </div>
    </Panel>
  );
}

function ExecSecurityCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("tools.exec.security") || "ask");
  const options = [
    { value: "deny", label: "Deny", desc: "Block all exec. Most restrictive." },
    { value: "ask", label: "Ask", desc: "Prompt before running commands." },
    { value: "allow", label: "Allow", desc: "Run commands without prompting." },
  ] as const;

  return (
    <Panel title="Exec Security" subtitle="Controls how tool execution requests are handled.">
      <div className="grid gap-2 sm:grid-cols-3">
        {options.map((opt) => (
          <OptionCard
            key={opt.value}
            selected={current === opt.value}
            onClick={() => void patchConfig({ "tools.exec.security": opt.value })}
            label={opt.label}
            description={opt.desc}
            color={opt.value === "allow" && current === "allow" ? "red" : opt.value === "deny" && current === "deny" ? "emerald" : "default"}
            disabled={busy}
          />
        ))}
      </div>
    </Panel>
  );
}

function QuickPresetsCard({ patchConfig, busy }: { patchConfig: (patch: Record<string, unknown>) => Promise<void>; busy: boolean }) {
  const presets = [
    {
      label: "Locked Down",
      desc: "Maximum security: full sandboxing, no workspace access, exec denied.",
      icon: <Shield className="h-4 w-4 text-red-400" />,
      color: "red" as const,
      patch: {
        "agents.defaults.sandbox.mode": "all",
        "agents.defaults.sandbox.scope": "session",
        "agents.defaults.sandbox.workspaceAccess": "none",
        "tools.exec.security": "deny",
      },
    },
    {
      label: "Balanced",
      desc: "Recommended: non-main sandboxing, read-only workspace, ask before exec.",
      icon: <Shield className="h-4 w-4 text-amber-400" />,
      color: "amber" as const,
      patch: {
        "agents.defaults.sandbox.mode": "non-main",
        "agents.defaults.sandbox.scope": "session",
        "agents.defaults.sandbox.workspaceAccess": "ro",
        "tools.exec.security": "ask",
      },
    },
    {
      label: "Full Access",
      desc: "No restrictions: sandboxing off, exec allowed. Use with caution.",
      icon: <ShieldAlert className="h-4 w-4 text-emerald-400" />,
      color: "emerald" as const,
      patch: {
        "agents.defaults.sandbox.mode": "off",
        "tools.exec.security": "allow",
      },
    },
  ];

  return (
    <Panel title="Quick Presets" subtitle="Apply a predefined security profile with one click.">
      <div className="grid gap-2 sm:grid-cols-3">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => void patchConfig(p.patch)}
            disabled={busy}
            className={cn(
              "glass-glow rounded-lg p-3 text-left disabled:opacity-50",
              p.color === "red" && "hover:border-red-500/30",
              p.color === "amber" && "hover:border-amber-500/30",
              p.color === "emerald" && "hover:border-emerald-500/30",
            )}
          >
            <div className="flex items-center gap-2">
              {p.icon}
              <p className="text-xs font-medium text-foreground/90">{p.label}</p>
              {p.label === "Balanced" && (
                <span className="rounded border border-amber-500/30 bg-amber-500/10 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-200">
                  recommended
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground/60">{p.desc}</p>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function ToolPolicySummary({ cfgGet, onGoToPermissions }: { cfgGet: (path: string) => unknown; onGoToPermissions: () => void }) {
  const allowList = cfgGet("tools.allow");
  const denyList = cfgGet("tools.deny");
  const allowArr = Array.isArray(allowList) ? allowList.map(String) : [];
  const denyArr = Array.isArray(denyList) ? denyList.map(String) : [];

  return (
    <Panel title="Tool Policy Summary" subtitle="Configured allow/deny lists from your config.">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="glass-subtle rounded-lg p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-widest text-emerald-700/90 dark:text-emerald-200/90">Allow List ({allowArr.length})</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {allowArr.length === 0 ? (
              <span className="text-xs text-muted-foreground/60">none configured</span>
            ) : (
              allowArr.map((t) => (
                <span key={t} className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-700 dark:text-emerald-100">
                  {t}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="glass-subtle rounded-lg p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-widest text-zinc-700/90 dark:text-zinc-300/90">Deny List ({denyArr.length})</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {denyArr.length === 0 ? (
              <span className="text-xs text-muted-foreground/60">none configured</span>
            ) : (
              denyArr.map((t) => (
                <span key={t} className="rounded-md border border-zinc-500/25 bg-zinc-500/12 px-1.5 py-0.5 text-xs text-zinc-700 dark:text-zinc-200">
                  {t}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={onGoToPermissions}
        className="mt-3 text-xs text-cyan-600 underline hover:text-cyan-500 dark:text-cyan-400"
      >
        Edit detailed permissions in the Permissions tab
      </button>
    </Panel>
  );
}

/* ════════════════════════════════════════════════════
   Secrets sub-cards
   ════════════════════════════════════════════════════ */

function RedactionCard({ cfgGet, patchConfig, busy }: CardProps) {
  const current = String(cfgGet("logging.redactSensitive") || "off");
  const patternsRaw = cfgGet("logging.redactPatterns");
  const patterns = Array.isArray(patternsRaw) ? patternsRaw.map(String) : [];
  const isActive = current === "tools";

  return (
    <Panel title="Logging & Redaction" subtitle="Controls sensitive data redaction in tool output logs.">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs font-medium text-foreground/90">Redact Sensitive Data</p>
          <p className="mt-0.5 text-xs text-muted-foreground/60">
            When enabled, tool output is scanned for secrets and API keys before logging.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void patchConfig({ "logging.redactSensitive": isActive ? "off" : "tools" })}
          disabled={busy}
          className="shrink-0 disabled:opacity-50"
        >
          {isActive ? (
            <ToggleRight className="h-6 w-6 text-emerald-500" />
          ) : (
            <ToggleLeft className="h-6 w-6 text-muted-foreground/40" />
          )}
        </button>
      </div>
      {patterns.length > 0 && (
        <div className="mt-3 glass-subtle rounded-lg p-2.5">
          <p className="text-[10px] font-medium uppercase tracking-widest text-muted-foreground/60">
            Custom Redaction Patterns ({patterns.length})
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {patterns.map((p, i) => (
              <code key={`pat-${i}`} className="rounded-md border border-foreground/10 bg-card px-1.5 py-0.5 text-xs text-foreground/80">
                {p}
              </code>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}
