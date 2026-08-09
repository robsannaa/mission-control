"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  Cpu,
  Eye,
  EyeOff,
  FileWarning,
  KeyRound,
  RefreshCw,
  RotateCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Wrench,
} from "lucide-react";
import { InlineSpinner } from "@/components/ui/loading-state";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import {
  getTimeFormatSnapshot,
  getTimeFormatServerSnapshot,
  subscribeTimeFormatPreference,
  withTimeFormat,
} from "@/lib/time-format-preference";

type AccountsResponse = {
  generatedAt: number;
  configPath: string;
  configHash: string | null;
  sourceOfTruth: {
    gatewayConfig: boolean;
    channelsStatus: boolean;
    modelsStatus: boolean;
  };
  summary: {
    agents: number;
    modelProvidersConnected: number;
    modelProvidersTotal: number;
    authProfiles: number;
    channelAccounts: number;
    channelAccountsRunning: number;
    configEnvKeys: number;
    processEnvKeys: number;
    configSecrets: number;
  };
  agents: Array<{
    id: string;
    name: string;
    workspace: string | null;
    agentDir: string;
    model: string | null;
    isDefault: boolean;
  }>;
  modelAuthByAgent: Array<{
    agentId: string;
    storePath: string | null;
    shellEnvFallback: { enabled: boolean; appliedKeys: string[] };
    providers: Array<{
      provider: string;
      connected: boolean;
      effectiveKind: string | null;
      effectiveDetail: string | null;
      profileCount: number;
      oauthCount: number;
      tokenCount: number;
      apiKeyCount: number;
      labels: string[];
      envSource: string | null;
      envValue: string | null;
      modelsJsonSource: string | null;
    }>;
    oauthProfiles: Array<{
      profileId: string;
      provider: string;
      type: string;
      status: string;
      source: string;
      label: string;
      expiresAt: number | null;
      remainingMs: number | null;
    }>;
    unusableProfiles: Array<{
      profileId: string;
      provider: string;
      kind: string;
      until: number | null;
      remainingMs: number | null;
    }>;
  }>;
  channels: {
    chat: Record<string, string[]>;
    auth: Array<{ id: string; provider: string; type: string; isExternal: boolean }>;
    accounts: Array<{
      channel: string;
      accountId: string;
      enabled: boolean;
      configured: boolean;
      running: boolean;
      tokenSource: string | null;
      mode: string | null;
      lastError: string | null;
      probeOk: boolean | null;
      botId: string | null;
      botUsername: string | null;
      lastInboundAt: number | null;
      lastOutboundAt: number | null;
      lastProbeAt: number | null;
    }>;
  };
  envCredentials: {
    config: Array<{ key: string; value: string; source: string; redacted: boolean }>;
    process: Array<{ key: string; value: string; source: string; redacted: boolean }>;
  };
  skillCredentials: {
    skills: Array<{
      name: string;
      source: string;
      eligible: boolean;
      disabled: boolean;
      blockedByAllowlist: boolean;
      primaryEnv: string | null;
      requiredEnv: string[];
      missingEnv: string[];
      ready: boolean;
      env: Array<{
        key: string;
        present: boolean;
        source: string | null;
        value: string | null;
        redacted: boolean;
      }>;
    }>;
  };
  configSecrets: Array<{
    path: string;
    key: string;
    value: string;
    source: string;
    redacted: boolean;
  }>;
  warnings: string[];
};

type EnvEditorState = {
  editing: boolean;
  show: boolean;
  nextValue: string;
  confirmValue: string;
};

function formatAgo(ts: number | null): string {
  if (!ts) return "n/a";
  const ms = Date.now() - ts;
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function masked(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

function renderSecret(value: string, reveal: boolean, alreadyRedacted: boolean): string {
  if (alreadyRedacted) return value;
  return reveal ? value : masked(value);
}

function statusPill(ok: boolean, label: string) {
  return (
    <span
      className={
        ok
          ? "inline-flex items-center gap-1 rounded-full border border-success-border bg-success-bg px-2 py-1 text-xs text-success-fg"
          : "inline-flex items-center gap-1 rounded-full border border-danger-border bg-danger-bg px-2 py-1 text-xs text-danger-fg"
      }
    >
      {ok ? <ShieldCheck className="h-3.5 w-3.5" /> : <ShieldX className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

/* ================================================================
   Secrets Management Panel
   ================================================================ */

type AuditFinding = {
  code: string;
  severity: "warn" | "info" | "error";
  file: string;
  path: string;
  message: string;
  provider?: string;
  detail?: string;
};

type AuditData = {
  version: number;
  status: string;
  filesScanned: string[];
  summary: {
    plaintextCount: number;
    unresolvedRefCount: number;
    shadowedRefCount: number;
    legacyResidueCount: number;
  };
  findings: AuditFinding[];
};

type SecretsActionResponse = {
  ok?: boolean;
  error?: string;
  stderr?: string;
  raw?: string;
  code?: number | null;
  requiresInteractiveTty?: boolean;
  recommendedCommand?: string;
};

const SEVERITY_STYLES: Record<string, { bg: string; text: string; border: string; icon: React.ReactNode }> = {
  warn: {
    bg: "bg-warning-bg",
    text: "text-warning-fg",
    border: "border-warning-border",
    icon: <ShieldAlert className="h-3.5 w-3.5 text-warning-fg" />,
  },
  error: {
    bg: "bg-danger-bg",
    text: "text-danger-fg",
    border: "border-danger-border",
    icon: <FileWarning className="h-3.5 w-3.5 text-danger-fg" />,
  },
  info: {
    bg: "bg-info-bg",
    text: "text-info-fg",
    border: "border-info-border",
    icon: <Shield className="h-3.5 w-3.5 text-info-fg" />,
  },
};

const CODE_LABELS: Record<string, { label: string; hint: string }> = {
  PLAINTEXT_FOUND: {
    label: "Plaintext Secret",
    hint: "This value is stored as plain text. Migrate to a SecretRef (env/file/exec) for better security.",
  },
  UNRESOLVED_REF: {
    label: "Unresolved Reference",
    hint: "A SecretRef points to a source that cannot be resolved. Check the provider or env variable.",
  },
  SHADOWED_REF: {
    label: "Shadowed Reference",
    hint: "This SecretRef is overridden by another source, which may cause unexpected behavior.",
  },
  LEGACY_RESIDUE: {
    label: "Legacy Residue",
    hint: "Old credential format from a previous version. Can be safely cleaned up.",
  },
};

function shortFilePath(path: string): string {
  const home = path.indexOf(".openclaw/");
  if (home >= 0) return path.slice(home);
  const parts = path.split("/");
  return parts.slice(-2).join("/");
}

function SecretsPanel() {
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [findingsExpanded, setFindingsExpanded] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configResult, setConfigResult] = useState<string | null>(null);
  const [configureCommand, setConfigureCommand] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [reloadResult, setReloadResult] = useState<string | null>(null);

  const runAudit = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/secrets", { cache: "no-store" });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAudit(data as AuditData);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runAudit();
  }, [runAudit]);

  const handleConfigure = useCallback(async (opts: { apply?: boolean; providersOnly?: boolean; skipProviderSetup?: boolean } = {}) => {
    setConfiguring(true);
    setConfigResult(null);
    setError(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "configure", ...opts }),
      });
      const data = (await res.json()) as SecretsActionResponse;
      if (!res.ok || data.ok === false || data.error) {
        if (data.requiresInteractiveTty) {
          setConfigureCommand(data.recommendedCommand || "openclaw secrets configure --apply");
        }
        throw new Error(data.error || data.stderr || data.raw || `HTTP ${res.status}`);
      }
      setConfigureCommand(null);
      setConfigResult("Configuration applied successfully.");
      // Re-run audit to refresh findings
      await runAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfiguring(false);
    }
  }, [runAudit]);

  const handleReload = useCallback(async () => {
    setReloading(true);
    setReloadResult(null);
    setError(null);
    try {
      const res = await fetch("/api/secrets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reload" }),
      });
      const data = (await res.json()) as SecretsActionResponse;
      if (!res.ok || data.ok === false || data.error) {
        throw new Error(data.error || data.stderr || data.raw || `HTTP ${res.status}`);
      }
      setReloadResult("Secrets reloaded successfully. Runtime snapshot updated.");
      await runAudit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReloading(false);
    }
  }, [runAudit]);

  const totalFindings = audit?.findings.length ?? 0;
  const warnCount = audit?.findings.filter((f) => f.severity === "warn").length ?? 0;
  const errorCount = audit?.findings.filter((f) => f.severity === "error").length ?? 0;
  const infoCount = audit?.findings.filter((f) => f.severity === "info").length ?? 0;
  const isClean = totalFindings === 0 && audit?.status === "clean";
  const configureBlockedByTty = Boolean(configureCommand);

  return (
    <div className="rounded-xl border border-border/70 bg-card">
      {/* Header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
      >
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-muted-foreground/10">
          <Shield className="h-4 w-4 text-fg-secondary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-foreground">Secrets Management</h2>
            {audit && !loading && (
              isClean ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs text-success-fg">
                  <CheckCircle className="h-2.5 w-2.5" /> Clean
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-xs text-warning-fg">
                  <ShieldAlert className="h-2.5 w-2.5" /> {totalFindings} finding{totalFindings !== 1 ? "s" : ""}
                </span>
              )
            )}
            {loading && <InlineSpinner size="sm" className="text-fg-subtle" />}
          </div>
          <p className="text-xs text-fg-subtle">
            Audit, configure SecretRefs, and reload runtime secrets
          </p>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-fg-subtle shrink-0" />
        ) : (
          <ChevronDown className="h-4 w-4 text-fg-subtle shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-foreground/10 px-4 py-4 space-y-4">
          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}
          {configureCommand && (
            <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
              <p className="leading-relaxed">
                Configure requires an interactive terminal in this environment. Run:
                {" "}
                <code className="text-warning-fg">{configureCommand}</code>
              </p>
            </div>
          )}

          {/* Config/Reload success */}
          {configResult && (
            <div className="flex items-center gap-2 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-xs text-success-fg">
              <CheckCircle className="h-3.5 w-3.5 shrink-0" />
              {configResult}
            </div>
          )}
          {reloadResult && (
            <div className="flex items-center gap-2 rounded-lg border border-success-border bg-success-bg px-3 py-2 text-xs text-success-fg">
              <CheckCircle className="h-3.5 w-3.5 shrink-0" />
              {reloadResult}
            </div>
          )}

          {/* Summary cards */}
          {audit && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2">
                <p className="text-xs text-fg-subtle">Plaintext</p>
                <p className={`text-sm font-bold ${audit.summary.plaintextCount > 0 ? "text-warning-fg" : "text-success-fg"}`}>
                  {audit.summary.plaintextCount}
                </p>
              </div>
              <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2">
                <p className="text-xs text-fg-subtle">Unresolved</p>
                <p className={`text-sm font-bold ${audit.summary.unresolvedRefCount > 0 ? "text-danger-fg" : "text-success-fg"}`}>
                  {audit.summary.unresolvedRefCount}
                </p>
              </div>
              <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2">
                <p className="text-xs text-fg-subtle">Shadowed</p>
                <p className={`text-sm font-bold ${audit.summary.shadowedRefCount > 0 ? "text-warning-fg" : "text-success-fg"}`}>
                  {audit.summary.shadowedRefCount}
                </p>
              </div>
              <div className="rounded-lg border border-foreground/10 bg-foreground/[0.03] px-3 py-2">
                <p className="text-xs text-fg-subtle">Legacy</p>
                <p className={`text-sm font-bold ${audit.summary.legacyResidueCount > 0 ? "text-info-fg" : "text-success-fg"}`}>
                  {audit.summary.legacyResidueCount}
                </p>
              </div>
            </div>
          )}

          {/* Findings list */}
          {audit && totalFindings > 0 && (
            <div>
              <button
                type="button"
                onClick={() => setFindingsExpanded(!findingsExpanded)}
                className="flex w-full items-center gap-2 text-left text-xs font-medium text-fg-secondary hover:text-foreground"
              >
                {findingsExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
                {totalFindings} finding{totalFindings !== 1 ? "s" : ""}
                {warnCount > 0 && <span className="text-warning-fg">{warnCount} warn</span>}
                {errorCount > 0 && <span className="text-danger-fg">{errorCount} error</span>}
                {infoCount > 0 && <span className="text-info-fg">{infoCount} info</span>}
              </button>

              {findingsExpanded && (
                <div className="mt-2 space-y-2">
                  {audit.findings.map((finding, idx) => {
                    const style = SEVERITY_STYLES[finding.severity] || SEVERITY_STYLES.info;
                    const codeMeta = CODE_LABELS[finding.code];
                    return (
                      <div
                        key={`${finding.file}:${finding.path}:${idx}`}
                        className={`rounded-lg border ${style.border} ${style.bg} px-3 py-2.5`}
                      >
                        <div className="flex items-start gap-2">
                          <div className="mt-0.5 shrink-0">{style.icon}</div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`text-xs font-semibold ${style.text}`}>
                                {codeMeta?.label || finding.code}
                              </span>
                              <code className="rounded bg-foreground/5 px-1.5 py-0.5 text-xs text-muted-foreground">
                                {finding.code}
                              </code>
                            </div>
                            <p className="mt-1 text-xs text-fg-secondary">{finding.message}</p>
                            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-fg-subtle">
                              <span>
                                File: <code>{shortFilePath(finding.file)}</code>
                              </span>
                              <span>
                                Path: <code>{finding.path}</code>
                              </span>
                              {finding.provider && (
                                <span>
                                  Provider: <code>{finding.provider}</code>
                                </span>
                              )}
                            </div>
                            {codeMeta?.hint && (
                              <p className="mt-1.5 text-xs text-fg-subtle italic">
                                {codeMeta.hint}
                              </p>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Files scanned */}
          {audit && (
            <p className="text-xs text-fg-subtle">
              {audit.filesScanned.length} file{audit.filesScanned.length !== 1 ? "s" : ""} scanned
              {audit.status === "clean" && " — no issues found"}
            </p>
          )}

          {/* Actions */}
          <div className="flex flex-wrap gap-2 border-t border-foreground/5 pt-3">
            <button
              type="button"
              onClick={() => void runAudit()}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs font-medium text-fg-secondary transition-colors hover:bg-foreground/10 disabled:opacity-40"
            >
              {loading ? <InlineSpinner size="sm" /> : <RefreshCw className="h-3 w-3" />}
              Re-audit
            </button>
            <button
              type="button"
              onClick={() => void handleConfigure({ apply: true })}
              disabled={configuring || loading || configureBlockedByTty}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-40"
              title={configureBlockedByTty ? "Run this command in Terminal instead" : "Run secrets configure --apply: auto-map plaintext secrets to SecretRefs"}
            >
              {configuring ? <InlineSpinner size="sm" /> : <Wrench className="h-3 w-3" />}
              Auto-configure & Apply
            </button>
            <button
              type="button"
              onClick={() => void handleConfigure({ providersOnly: true, apply: true })}
              disabled={configuring || loading || configureBlockedByTty}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs font-medium text-fg-secondary transition-colors hover:bg-foreground/10 disabled:opacity-40"
              title={configureBlockedByTty ? "Run this command in Terminal instead" : "Configure providers only without mapping credentials"}
            >
              {configuring ? <InlineSpinner size="sm" /> : <Shield className="h-3 w-3" />}
              Providers Only
            </button>
            <button
              type="button"
              onClick={() => void handleReload()}
              disabled={reloading || loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-xs font-medium text-fg-secondary transition-colors hover:bg-foreground/10 disabled:opacity-40"
              title="Re-resolve secret references and swap runtime snapshot"
            >
              {reloading ? <InlineSpinner size="sm" /> : <RotateCw className="h-3 w-3" />}
              Reload Runtime
            </button>
          </div>

          {/* Help text */}
          <div className="rounded-lg border border-foreground/5 bg-foreground/[0.02] px-3 py-2.5">
            <p className="text-xs text-fg-subtle leading-relaxed">
              <strong className="text-fg-secondary">Secrets audit</strong> scans your config for plaintext tokens, unresolved SecretRefs, and legacy credentials.{" "}
              <strong className="text-fg-secondary">Auto-configure</strong> maps plaintext values to secure SecretRef providers (env/file/exec).{" "}
              <strong className="text-fg-secondary">Reload</strong> re-resolves all references and updates the runtime snapshot without restarting.{" "}
              CLI equivalents: <code className="text-fg-subtle">openclaw secrets audit</code>, <code className="text-fg-subtle">secrets configure --apply</code>, <code className="text-fg-subtle">secrets reload</code>.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function AccountsKeysView() {
  const timeFormat = useSyncExternalStore(
    subscribeTimeFormatPreference,
    getTimeFormatSnapshot,
    getTimeFormatServerSnapshot,
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [revealSecrets, setRevealSecrets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savingEnvKey, setSavingEnvKey] = useState<string | null>(null);
  const [envEditors, setEnvEditors] = useState<Record<string, EnvEditorState>>({});
  const [data, setData] = useState<AccountsResponse | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/accounts", { cache: "no-store" });
      const body = (await res.json()) as AccountsResponse & { error?: string };
      if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const editableConfigEnvRows = useMemo(() => {
    if (!data) return [] as Array<{
      key: string;
      value: string;
      source: string;
      redacted: boolean;
      present: boolean;
    }>;
    const byKey = new Map<
      string,
      {
        key: string;
        value: string;
        source: string;
        redacted: boolean;
        present: boolean;
      }
    >();

    for (const item of data.envCredentials.config) {
      byKey.set(item.key, {
        key: item.key,
        value: item.value,
        source: item.source,
        redacted: item.redacted,
        present: true,
      });
    }

    for (const skill of data.skillCredentials.skills) {
      for (const env of skill.env) {
        if (byKey.has(env.key)) continue;
        byKey.set(env.key, {
          key: env.key,
          value: env.value || "",
          source: env.source || "missing",
          redacted: env.redacted,
          present: env.present,
        });
      }
    }

    return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
  }, [data]);

  const getEnvEditor = useCallback(
    (key: string): EnvEditorState =>
      envEditors[key] || {
        editing: false,
        show: false,
        nextValue: "",
        confirmValue: "",
      },
    [envEditors]
  );

  const patchEnvEditor = useCallback((key: string, patch: Partial<EnvEditorState>) => {
    setEnvEditors((prev) => ({
      ...prev,
      [key]: {
        ...(prev[key] || {
          editing: false,
          show: false,
          nextValue: "",
          confirmValue: "",
        }),
        ...patch,
      } as EnvEditorState,
    }));
  }, []);

  const startEditEnvKey = useCallback((key: string) => {
    patchEnvEditor(key, { editing: true, nextValue: "", confirmValue: "" });
  }, [patchEnvEditor]);

  const cancelEditEnvKey = useCallback((key: string) => {
    patchEnvEditor(key, {
      editing: false,
      show: false,
      nextValue: "",
      confirmValue: "",
    });
  }, [patchEnvEditor]);

  const saveEnvKey = useCallback(
    async (key: string) => {
      const editor = getEnvEditor(key);
      const nextValue = editor.nextValue.trim();
      if (!nextValue) {
        setError(`New value for ${key} cannot be empty.`);
        return;
      }
      if (editor.nextValue !== editor.confirmValue) {
        setError(`Confirmation does not match for ${key}.`);
        return;
      }

      setSavingEnvKey(key);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "update-env-key",
            key,
            value: editor.nextValue,
          }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string };
        if (!res.ok || !body.ok) {
          throw new Error(body.error || `HTTP ${res.status}`);
        }
        cancelEditEnvKey(key);
        setNotice(`Updated ${key}.`);
        await load(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingEnvKey(null);
      }
    },
    [cancelEditEnvKey, getEnvEditor, load]
  );

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-fg-secondary dark:text-foreground" />
            Keys & Access
          </span>
        }
        description="Advanced view of saved keys, auth profiles, channel logins, env credentials, and discovered access sources. Use Models for everyday provider setup and model choice."
        meta={
          data
            ? `Last sync: ${new Date(data.generatedAt).toLocaleString(
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
              )}`
            : "Loading source-of-truth snapshot…"
        }
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setRevealSecrets((prev) => !prev)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
              disabled={!data}
            >
              {revealSecrets ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {revealSecrets ? "Hide Values" : "Reveal Values"}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-fg-secondary transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60"
              disabled={busy}
            >
              {busy ? (
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
        }
      />

      <SectionBody width="narrow" className="space-y-4">
        {error && (
          <div className="rounded-xl border border-danger-border bg-danger-bg p-4 text-sm text-danger-fg">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-success-border bg-success-bg p-4 text-sm text-success-fg">
            {notice}
          </div>
        )}

        {loading && !data ? (
          <div className="space-y-3">
            <div className="h-24 animate-pulse rounded-xl border border-border/70 bg-card" />
            <div className="h-48 animate-pulse rounded-xl border border-border/70 bg-card" />
            <div className="h-48 animate-pulse rounded-xl border border-border/70 bg-card" />
          </div>
        ) : null}

        {data ? (
          <>
            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-xl border border-[var(--accent-brand-border)] bg-[var(--accent-brand-subtle)] p-4">
                <p className="text-sm font-semibold text-foreground">Start in Models for everyday setup</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the model you want, connect providers, and decide what new chats should use.
                </p>
                <a
                  href="/agents?tab=models"
                  className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  Open Models setup
                </a>
              </div>
              <div className="rounded-xl border border-border/70 bg-card p-4">
                <p className="text-sm font-semibold text-foreground">Use this page when you need details</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Inspect saved API keys, auth profiles, channel accounts, env values, and secrets audit results without changing your model setup flow.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {statusPill(data.sourceOfTruth.gatewayConfig, "Gateway Config")}
                {statusPill(data.sourceOfTruth.channelsStatus, "Channel Runtime")}
                {statusPill(data.sourceOfTruth.modelsStatus, "Model Auth Runtime")}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Agents</p>
                  <p className="mt-1 text-xs font-semibold">{data.summary.agents}</p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Model Providers Connected</p>
                  <p className="mt-1 text-xs font-semibold">
                    {data.summary.modelProvidersConnected}/{data.summary.modelProvidersTotal}
                  </p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Model Auth Profiles</p>
                  <p className="mt-1 text-xs font-semibold">{data.summary.authProfiles}</p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Channel Accounts Running</p>
                  <p className="mt-1 text-xs font-semibold">
                    {data.summary.channelAccountsRunning}/{data.summary.channelAccounts}
                  </p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Config Env Credentials</p>
                  <p className="mt-1 text-xs font-semibold">{data.summary.configEnvKeys}</p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Process Env Credentials</p>
                  <p className="mt-1 text-xs font-semibold">{data.summary.processEnvKeys}</p>
                </div>
                <div className="rounded-md border border-border/70 bg-muted/30 p-3 sm:col-span-2">
                  <p className="text-xs text-muted-foreground">Discovered Config Secrets</p>
                  <p className="mt-1 text-xs font-semibold">{data.summary.configSecrets}</p>
                </div>
              </div>
            </div>

            <SecretsPanel />

            <div className="rounded-xl border border-border/70 bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="inline-flex items-center gap-2 text-xs font-semibold text-foreground">
                  <Cpu className="h-4 w-4" />
                  Model Provider Auth
                </h2>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {data.summary.modelProvidersConnected} of {data.summary.modelProvidersTotal} providers connected
                {data.summary.authProfiles > 0 && ` · ${data.summary.authProfiles} auth profiles`}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                This section is for inspection. To connect providers, pick routes, or change the model used by chats, go to Models.
              </p>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-4">
              <h2 className="text-xs font-semibold text-foreground">Channel Accounts</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Logged-in chat accounts, status, and auth source.
              </p>
              <div className="mt-3 space-y-2">
                {data.channels.accounts.map((acct) => (
                  <div
                    key={`${acct.channel}:${acct.accountId}`}
                    className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium text-foreground">
                        {acct.channel} / {acct.accountId}
                      </p>
                      <p className={acct.running ? "text-success-fg" : "text-danger-fg"}>
                        {acct.running ? "running" : "stopped"}
                      </p>
                    </div>
                    <p className="mt-1 text-muted-foreground">
                      configured={String(acct.configured)} enabled={String(acct.enabled)} tokenSource={acct.tokenSource || "n/a"} mode={acct.mode || "n/a"}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      bot={acct.botUsername || "n/a"} ({acct.botId || "n/a"}) · probe={acct.probeOk == null ? "n/a" : String(acct.probeOk)} · inbound={formatAgo(acct.lastInboundAt)} · outbound={formatAgo(acct.lastOutboundAt)}
                    </p>
                    {acct.lastError ? (
                      <p className="mt-1 text-danger-fg">lastError: {acct.lastError}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>



            <div className="grid gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-border/70 bg-card p-4">
                <h2 className="text-xs font-semibold text-foreground">Config Env Credentials</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Vercel-style edit flow: current value plus double-entry confirmation.
                </p>
                <div className="mt-3 space-y-2">
                  {editableConfigEnvRows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">No env credential keys discovered.</p>
                  ) : null}
                  {editableConfigEnvRows.map((item) => {
                    const editor = getEnvEditor(item.key);
                    const saving = savingEnvKey === item.key;
                    return (
                      <div
                        key={item.key}
                        className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="font-medium text-foreground">{item.key}</p>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => patchEnvEditor(item.key, { show: !editor.show })}
                              className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                            >
                              {editor.show ? "Hide" : "Show"}
                            </button>
                            {!editor.editing ? (
                              <button
                                type="button"
                                onClick={() => startEditEnvKey(item.key)}
                                className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                              >
                                {item.present ? "Edit" : "Set"}
                              </button>
                            ) : (
                              <>
                              <button
                                type="button"
                                onClick={() => void saveEnvKey(item.key)}
                                className="rounded border border-success-border px-2 py-1 text-xs text-success-fg hover:bg-success-bg disabled:opacity-50"
                                disabled={saving}
                              >
                                {saving ? "Saving..." : "Save"}
                              </button>
                              <button
                                type="button"
                                onClick={() => cancelEditEnvKey(item.key)}
                                className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                              >
                                Cancel
                              </button>
                              </>
                            )}
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          source: {item.source}
                        </p>
                        <div className="mt-2 space-y-1">
                          <label className="block">
                            <span className="text-xs text-muted-foreground">Current value</span>
                            <input
                              type={revealSecrets || editor.show ? "text" : "password"}
                              readOnly
                              value={
                                item.present
                                  ? renderSecret(
                                      item.value,
                                      revealSecrets || editor.show,
                                      item.redacted
                                    )
                                  : ""
                              }
                              placeholder={item.present ? "" : "Not set"}
                              className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs text-muted-foreground"
                            />
                          </label>
                          {editor.editing && (
                            <>
                              <label className="block">
                                <span className="text-xs text-muted-foreground">New value</span>
                                <input
                                  type={editor.show ? "text" : "password"}
                                  value={editor.nextValue}
                                  onChange={(e) =>
                                    patchEnvEditor(item.key, { nextValue: e.target.value })
                                  }
                                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
                                />
                              </label>
                              <label className="block">
                                <span className="text-xs text-muted-foreground">Confirm new value</span>
                                <input
                                  type={editor.show ? "text" : "password"}
                                  value={editor.confirmValue}
                                  onChange={(e) =>
                                    patchEnvEditor(item.key, { confirmValue: e.target.value })
                                  }
                                  className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-xs"
                                />
                              </label>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="rounded-xl border border-border/70 bg-card p-4">
                <h2 className="text-xs font-semibold text-foreground">Process Env Credentials</h2>
                <div className="mt-3 space-y-1">
                  {data.envCredentials.process.map((item) => (
                    <p key={item.key} className="break-all text-xs text-muted-foreground">
                      <span className="text-foreground">{item.key}</span> ={" "}
                      <code>{renderSecret(item.value, revealSecrets, item.redacted)}</code>
                    </p>
                  ))}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border/70 bg-card p-4">
              <h2 className="text-xs font-semibold text-foreground">Config Secrets (Non-env)</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Credential-like fields discovered in parsed config (excluding <code>env</code>).
              </p>
              <div className="mt-3 max-h-96 space-y-1 overflow-y-auto">
                {data.configSecrets.map((secret) => (
                  <p key={secret.path} className="break-all text-xs text-muted-foreground">
                    <span className="text-foreground">{secret.path}</span> ={" "}
                    <code>{renderSecret(secret.value, revealSecrets, secret.redacted)}</code>
                  </p>
                ))}
              </div>
            </div>

            {data.warnings.length > 0 ? (
              <div className="rounded-xl border border-warning-border bg-warning-bg p-4 text-xs text-warning-fg">
                <div className="mb-2 inline-flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Partial data warnings
                </div>
                {data.warnings.map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </SectionBody>
    </SectionLayout>
  );
}
