"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  TerminalSquare,
  Lock,
  Unlock,
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Sparkles,
  Plus,
  Trash2,
  Activity,
  Bell,
  Smartphone,
  UserCheck,
  UserX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";

type PermissionSnapshot = {
  ts: number;
  approvals: {
    path?: string;
    exists?: boolean;
    hash?: string;
  };
  allowlist: Array<{
    agentId: string;
    pattern: string;
    id?: string;
    lastUsedAt?: number;
    lastUsedCommand?: string;
    lastResolvedPath?: string;
  }>;
  execPolicies: Array<{
    scope: "defaults" | "agent";
    agentId?: string;
    security?: string;
    ask?: string;
    askFallback?: string;
    autoAllowSkills?: boolean;
    allowlistCount: number;
  }>;
  sandbox: {
    sandbox?: {
      mode?: string;
      workspaceAccess?: string;
      sessionIsSandboxed?: boolean;
      tools?: {
        allow?: string[];
        deny?: string[];
      };
    };
    elevated?: {
      enabled?: boolean;
      allowedByConfig?: boolean;
      alwaysAllowedByConfig?: boolean;
    };
  };
  capabilities: {
    sandboxMode: string;
    sessionIsSandboxed: boolean;
    workspaceAccess: string;
    toolPolicyMode: "allowlist" | "open-denylist";
    allowedToolsConfigured: string[];
    deniedToolsConfigured: string[];
    flags: Array<{ id: string; label: string; allowed: boolean; reason: string }>;
    allowlistCount: number;
    policyScopeCount: number;
  };
};

type AgentItem = { id: string };

type DeviceToken = {
  role: string;
  scopes: string[];
  lastUsedAtMs?: number;
};

type PairedDevice = {
  deviceId: string;
  displayName?: string;
  platform: string;
  clientId: string;
  clientMode: string;
  roles: string[];
  tokens: DeviceToken[];
};

type PendingDeviceRequest = {
  requestId?: string;
  deviceId: string;
  displayName?: string;
  platform: string;
  clientMode: string;
  requestedRole?: string;
  requestedScopes?: string[];
  expiresAtMs?: number;
};

const QUICK_PERMISSIONS: Array<{
  label: string;
  pattern: string;
  why: string;
}> = [
  { label: "Allow rm", pattern: "**/rm", why: "Permit delete command execution when requested by agent workflows." },
  { label: "Allow pkill", pattern: "**/pkill", why: "Permit process termination by name." },
  { label: "Allow killall", pattern: "**/killall", why: "Permit broad process termination by executable name." },
  { label: "Allow kill", pattern: "**/kill", why: "Permit process termination by PID." },
  { label: "Allow chmod", pattern: "**/chmod", why: "Permit permission-mode changes on files/directories." },
  { label: "Allow chown", pattern: "**/chown", why: "Permit ownership changes on files/directories." },
  { label: "Allow systemctl", pattern: "**/systemctl", why: "Permit service lifecycle commands on Linux systems." },
];

function formatAgo(ts?: number): string {
  if (!ts) return "never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function PermissionsView({ embedded = false }: { embedded?: boolean } = {}) {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot | null>(null);
  const [agents, setAgents] = useState<AgentItem[]>([]);
  const [pairedDevices, setPairedDevices] = useState<PairedDevice[]>([]);
  const [pendingDevices, setPendingDevices] = useState<PendingDeviceRequest[]>([]);
  const [selectedAgent, setSelectedAgent] = useState("*");
  const [pattern, setPattern] = useState("");
  const [loading, setLoading] = useState(true);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  /** Which button is in progress: "grant" | "defaults" | "quick:<pattern>" | "revoke:<pattern>" | "elevated-enable" | "elevated-disable" */
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [deviceMutating, setDeviceMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);

  const loadDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const res = await fetch("/api/devices", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const warningText =
        typeof data.warning === "string" && data.warning.trim()
          ? data.warning.trim()
          : null;
      if (warningText) {
        setApiWarning((prev) => prev || warningText);
      }
      if (data.degraded === true) {
        setApiDegraded(true);
      }
      setPairedDevices(Array.isArray(data.paired) ? (data.paired as PairedDevice[]) : []);
      setPendingDevices(Array.isArray(data.pending) ? (data.pending as PendingDeviceRequest[]) : []);
    } catch (err) {
      setError((prev) => prev || (err instanceof Error ? err.message : String(err)));
      setApiWarning((prev) => prev || (err instanceof Error ? err.message : String(err)));
      setApiDegraded(true);
    } finally {
      setDevicesLoading(false);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setApiWarning(null);
    setApiDegraded(false);
    try {
      const [permRes, agentsRes] = await Promise.all([
        fetch("/api/permissions", { cache: "no-store" }),
        fetch("/api/agents", { cache: "no-store" }).catch(() => null),
      ]);
      if (!permRes.ok) throw new Error(`HTTP ${permRes.status}`);
      const perm = (await permRes.json()) as PermissionSnapshot;
      const permWarning =
        perm && "warning" in perm && typeof perm.warning === "string" && perm.warning.trim()
          ? perm.warning.trim()
          : null;
      if (permWarning) setApiWarning(permWarning);
      if (perm && "degraded" in perm && perm.degraded === true) setApiDegraded(true);
      setSnapshot(perm);
      setError(null);
      await loadDevices();

      if (agentsRes?.ok) {
        const data = await agentsRes.json();
        const list = Array.isArray(data.agents) ? (data.agents as AgentItem[]) : [];
        setAgents(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadDevices]);

  useEffect(() => {
    void load();
  }, [load]);

  const mutate = useCallback(
    async (body: Record<string, unknown>, actionKey?: string | null) => {
      setMutating(true);
      setPendingAction(actionKey ?? null);
      setNotice(null);
      try {
        const res = await fetch("/api/permissions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
        const next = (data.snapshot || data) as PermissionSnapshot;
        setSnapshot(next);
        setError(null);
        setNotice("Permissions updated.");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setMutating(false);
        setPendingAction(null);
      }
    },
    []
  );

  const scopedAllowlist = useMemo(() => {
    const rows = snapshot?.allowlist || [];
    if (selectedAgent === "*") return rows;
    return rows.filter((r) => r.agentId === selectedAgent || r.agentId === "*");
  }, [snapshot?.allowlist, selectedAgent]);

  const allowlistSet = useMemo(() => {
    const set = new Set<string>();
    for (const row of snapshot?.allowlist || []) {
      if (selectedAgent === "*" || row.agentId === "*" || row.agentId === selectedAgent) {
        set.add(row.pattern);
      }
    }
    return set;
  }, [snapshot?.allowlist, selectedAgent]);

  const handleAddPattern = useCallback(() => {
    const normalized = pattern.trim();
    if (!normalized) return;
    void mutate({ action: "allow-pattern", agentId: selectedAgent, pattern: normalized }, "grant");
    setPattern("");
  }, [mutate, pattern, selectedAgent]);

  const handleRevokePattern = useCallback(
    (value: string, agentId: string) => {
      void mutate({ action: "revoke-pattern", agentId, pattern: value }, `revoke:${value}`);
    },
    [mutate]
  );

  const toggleQuickPattern = useCallback(
    async (value: string) => {
      if (allowlistSet.has(value)) {
        const entries = (snapshot?.allowlist || []).filter(
          (e) => e.pattern === value && (selectedAgent === "*" || e.agentId === selectedAgent)
        );
        for (const e of entries) {
          await mutate({ action: "revoke-pattern", agentId: e.agentId, pattern: value }, `quick:${value}`);
        }
      } else {
        void mutate({ action: "allow-pattern", agentId: selectedAgent, pattern: value }, `quick:${value}`);
      }
    },
    [allowlistSet, mutate, selectedAgent, snapshot?.allowlist]
  );

  const setElevated = useCallback(
    (enabled: boolean) => {
      void mutate({ action: "set-elevated", enabled }, enabled ? "elevated-enable" : "elevated-disable");
    },
    [mutate]
  );

  const mutateDevice = useCallback(
    async (body: Record<string, unknown>, successMsg: string) => {
      setDeviceMutating(true);
      setNotice(null);
      try {
        const res = await fetch("/api/devices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok || data.error) {
          throw new Error(String(data?.error || `HTTP ${res.status}`));
        }
        await loadDevices();
        setNotice(successMsg);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setDeviceMutating(false);
      }
    },
    [loadDevices]
  );

  const approveDevice = useCallback(
    (requestId: string) => {
      void mutateDevice({ action: "approve", requestId }, "Pairing request approved.");
    },
    [mutateDevice]
  );

  const rejectDevice = useCallback(
    (requestId: string) => {
      void mutateDevice({ action: "reject", requestId }, "Pairing request rejected.");
    },
    [mutateDevice]
  );

  const revokeDeviceRole = useCallback(
    (deviceId: string, role: string) => {
      void mutateDevice({ action: "revoke", deviceId, role }, `Revoked ${role} token.`);
    },
    [mutateDevice]
  );

  const elevatedEnabled = Boolean(snapshot?.sandbox?.elevated?.enabled);
  const initialLoading = loading && !snapshot;

  const defaultsScope = (snapshot?.execPolicies || []).find((s) => s.scope === "defaults");
  const [editSecurity, setEditSecurity] = useState<string>("allowlist");
  const [editAsk, setEditAsk] = useState<string>("on-miss");
  const [editAskFallback, setEditAskFallback] = useState<string>("deny");
  useEffect(() => {
    if (defaultsScope) {
      setEditSecurity(defaultsScope.security || "allowlist");
      setEditAsk(defaultsScope.ask || "on-miss");
      setEditAskFallback(defaultsScope.askFallback || "deny");
    }
  }, [snapshot?.ts, defaultsScope, defaultsScope?.security, defaultsScope?.ask, defaultsScope?.askFallback]);
  const saveApprovalsDefaults = useCallback(() => {
    void mutate(
      {
        action: "set-approvals-defaults",
        security: editSecurity,
        ask: editAsk,
        askFallback: editAskFallback,
      },
      "defaults"
    );
  }, [mutate, editSecurity, editAsk, editAskFallback]);

  const content = (
    <>
      <SectionHeader
        title={
          <span className="flex items-center gap-2 text-sm">
            <Shield className="h-4 w-4 text-info-fg" />
            Permission Control
          </span>
        }
        description="Inspect, grant, and revoke exec allowlist entries and elevated gate. Changes apply immediately via openclaw approvals."
        titleClassName="text-sm"
        descriptionClassName="text-sm"
        metaClassName="text-xs"
        meta={
          <>
            Exec approvals:{" "}
            <a
              href="https://docs.openclaw.ai/tools/exec#exec-approvals-companion-app-node-host"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground hover:underline"
            >
              docs.openclaw.ai/tools/exec
            </a>
            {" · "}
            <code className="text-muted-foreground">approvals get</code> + <code className="text-muted-foreground">sandbox explain</code>
          </>
        }
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading || mutating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/80 disabled:opacity-60"
            >
              {(loading || mutating) ? (
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
        className={cn("bg-card/60", embedded && "border-b border-foreground/10")}
      />

      <SectionBody
        width="wide"
        padding="compact"
        innerClassName="space-y-4"
        className={embedded ? "overflow-visible" : undefined}
      >
        {initialLoading && (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {Array.from({ length: 4 }).map((_, idx) => (
                <div key={`stat-skeleton-${idx}`} className="rounded-xl border border-foreground/10 bg-card/70 p-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="mt-2 h-6 w-20" />
                  <Skeleton className="mt-2 h-3 w-32" />
                </div>
              ))}
            </div>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
                <Skeleton className="mb-3 h-4 w-36" />
                <div className="space-y-2">
                  {Array.from({ length: 4 }).map((_, idx) => (
                    <div key={`cap-skeleton-${idx}`} className="rounded-xl border border-foreground/10 p-3">
                      <Skeleton className="h-4 w-40" />
                      <Skeleton className="mt-2 h-3 w-56" />
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
                <Skeleton className="mb-3 h-4 w-40" />
                <div className="space-y-2">
                  {Array.from({ length: 5 }).map((_, idx) => (
                    <Skeleton key={`action-skeleton-${idx}`} className="h-16 w-full rounded-xl" />
                  ))}
                </div>
              </section>
            </div>

            <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
              <Skeleton className="mb-3 h-4 w-44" />
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {Array.from({ length: 6 }).map((_, idx) => (
                  <Skeleton key={`quick-skeleton-${idx}`} className="h-20 w-full rounded-xl" />
                ))}
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-2">
              <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
                <Skeleton className="mb-3 h-4 w-32" />
                <div className="space-y-2">
                  {Array.from({ length: 6 }).map((_, idx) => (
                    <Skeleton key={`allowlist-skeleton-${idx}`} className="h-14 w-full rounded-xl" />
                  ))}
                </div>
              </section>
              <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
                <Skeleton className="mb-3 h-4 w-28" />
                <Skeleton className="h-20 w-full rounded-xl" />
                <Skeleton className="mt-2 h-20 w-full rounded-xl" />
              </section>
            </div>
          </>
        )}

        {!initialLoading && (
          <>
        {error && (
          <div className="rounded-xl border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-success-border bg-success-bg px-3 py-2 text-xs text-success-fg">
            {notice}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="rounded-xl border border-foreground/10 bg-card/70 p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Sandbox Mode</p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {snapshot?.capabilities.sandboxMode || "—"}
            </p>
            <p className="text-xs text-fg-subtle">
              workspace: {snapshot?.capabilities.workspaceAccess || "unknown"}
            </p>
          </div>
          <div className="rounded-xl border border-foreground/10 bg-card/70 p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Elevated Exec</p>
            <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
              {elevatedEnabled ? (
                <>
                  <ShieldAlert className="h-4 w-4 text-warning-fg" /> <span className="text-warning-fg">Enabled</span>
                </>
              ) : (
                <>
                  <ShieldCheck className="h-4 w-4 text-success-fg" /> <span className="text-success-fg">Disabled</span>
                </>
              )}
            </p>
            <p className="text-xs text-fg-subtle">
              controls privileged exec escalation
            </p>
          </div>
          <div className="rounded-xl border border-danger-border bg-danger-bg p-3">
            <p className="text-xs uppercase tracking-wider text-danger-fg">Tool Policy Mode</p>
            <p className="mt-1 text-sm font-semibold text-danger-fg">
              {snapshot?.capabilities.toolPolicyMode || "—"}
            </p>
            <p className="text-xs text-danger-fg">from sandbox explain</p>
          </div>
          <div className="rounded-xl border border-info-border bg-info-bg p-3">
            <p className="text-xs uppercase tracking-wider text-info-fg">Policy Scopes</p>
            <p className="mt-1 text-sm font-semibold text-info-fg">
              {snapshot?.capabilities.policyScopeCount ?? 0}
            </p>
            <p className="text-xs text-info-fg">
              defaults + agent overrides
            </p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Activity className="h-3.5 w-3.5" />
                Capability Matrix
              </h2>
              <span className="text-xs text-fg-subtle">
                sandboxed: {snapshot?.capabilities.sessionIsSandboxed ? "yes" : "no"}
              </span>
            </div>
            <div className="space-y-2">
              {(snapshot?.capabilities.flags || []).map((flag) => (
                <div
                  key={flag.id}
                  className={cn(
                    "rounded-xl border px-3 py-2",
                    flag.allowed
                      ? "border-success-border bg-success-bg"
                      : "border-border-strong/20 bg-muted-foreground/5"
                  )}
                >
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-xs font-medium text-foreground">{flag.label}</p>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium",
                        flag.allowed
                          ? "bg-success-bg text-success-fg"
                          : "bg-muted-foreground/20 text-fg-secondary dark:text-fg-subtle"
                      )}
                    >
                      {flag.allowed ? <CheckCircle2 className="h-3 w-3" /> : <CircleX className="h-3 w-3" />}
                      {flag.allowed ? "allowed" : "blocked"}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{flag.reason}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" />
              Permission actions
            </h2>
            <p className="mb-3 text-xs text-muted-foreground">
              Set the scope below, then grant or revoke. Changes apply immediately.
            </p>

            <div className="rounded-xl border border-foreground/10 bg-background/40 p-2.5">
              <p className="text-xs uppercase tracking-wide text-fg-subtle">Agent scope</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Choose whose allowlist you view and edit. <strong className="text-foreground">*</strong> = defaults (all agents).
              </p>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="mt-2 w-full rounded-md border border-foreground/10 bg-card px-2 py-1.5 text-xs text-foreground outline-none"
              >
                <option value="*">* (all agents)</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2 rounded-xl border border-foreground/10 bg-background/40 p-2.5">
              <p className="text-xs uppercase tracking-wide text-fg-subtle">Elevated Execution</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Controls whether escalated exec approvals can be used.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setElevated(true)}
                  disabled={mutating || elevatedEnabled}
                  className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-warning-bg px-2 py-1 text-xs text-warning-fg disabled:opacity-50"
                >
                  {pendingAction === "elevated-enable" ? (
                    <span className="inline-flex items-center gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                    </span>
                  ) : <Unlock className="h-3 w-3" />}
                  Enable
                </button>
                <button
                  type="button"
                  onClick={() => setElevated(false)}
                  disabled={mutating || !elevatedEnabled}
                  className="inline-flex items-center gap-1 rounded-md border border-success-border bg-success-bg px-2 py-1 text-xs text-success-fg disabled:opacity-50"
                >
                  {pendingAction === "elevated-disable" ? (
                    <span className="inline-flex items-center gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                    </span>
                  ) : <Lock className="h-3 w-3" />}
                  Disable
                </button>
              </div>
            </div>

            <div className="mt-2 rounded-xl border border-foreground/10 bg-background/40 p-2.5">
              <p className="text-xs uppercase tracking-wide text-fg-subtle">Grant command pattern</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Adds to the scope selected above ({selectedAgent === "*" ? "all agents" : selectedAgent}).
              </p>
              <div className="mt-2 flex gap-2">
                <input
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  placeholder='e.g. **/pkill or /usr/bin/git'
                  className="min-w-0 flex-1 rounded-md border border-foreground/10 bg-card px-2 py-1.5 text-xs text-foreground outline-none"
                />
                <button
                  type="button"
                  onClick={handleAddPattern}
                  disabled={mutating || !pattern.trim()}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted disabled:opacity-50"
                >
                  {pendingAction === "grant" ? (
                    <span className="inline-flex items-center gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                    </span>
                  ) : <Plus className="h-3 w-3" />}
                  Grant
                </button>
              </div>
            </div>

            <div className="mt-2 rounded-xl border border-foreground/10 bg-background/40 p-2.5">
              <p className="text-xs uppercase tracking-wide text-fg-subtle">
                Exec Approval Policy
              </p>
              <div className="mt-1.5 space-y-1.5">
                {(snapshot?.execPolicies || []).map((scope) => (
                  <div
                    key={`${scope.scope}:${scope.agentId || "*"}`}
                    className="rounded-md border border-foreground/10 bg-card/60 px-2 py-1.5 text-xs"
                  >
                    <p className="font-medium text-foreground">
                      {scope.scope === "defaults" ? "defaults" : `agent:${scope.agentId}`}
                    </p>
                    <p className="text-muted-foreground">
                      security: {scope.security || "default"} • ask: {scope.ask || "default"} • askFallback:{" "}
                      {scope.askFallback || "default"}
                    </p>
                    <p className="text-muted-foreground">
                      autoAllowSkills: {String(scope.autoAllowSkills ?? false)} • allowlist: {scope.allowlistCount}
                    </p>
                  </div>
                ))}
                {(snapshot?.execPolicies || []).length === 0 && (
                  <p className="text-xs text-muted-foreground">No explicit approval policy scopes found.</p>
                )}
              </div>
              <p className="mt-2 text-xs text-muted-foreground">Edit defaults (applies to all agents unless overridden per-agent):</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">security</span>
                  <select
                    value={editSecurity}
                    onChange={(e) => setEditSecurity(e.target.value)}
                    className="rounded border border-foreground/15 bg-card px-2 py-1 text-xs text-foreground"
                  >
                    <option value="deny">deny</option>
                    <option value="allowlist">allowlist</option>
                    <option value="full">full</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">ask</span>
                  <select
                    value={editAsk}
                    onChange={(e) => setEditAsk(e.target.value)}
                    className="rounded border border-foreground/15 bg-card px-2 py-1 text-xs text-foreground"
                  >
                    <option value="off">off</option>
                    <option value="on-miss">on-miss</option>
                    <option value="always">always</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">askFallback</span>
                  <select
                    value={editAskFallback}
                    onChange={(e) => setEditAskFallback(e.target.value)}
                    className="rounded border border-foreground/15 bg-card px-2 py-1 text-xs text-foreground"
                  >
                    <option value="deny">deny</option>
                    <option value="allowlist">allowlist</option>
                    <option value="full">full</option>
                  </select>
                </label>
                <button
                  type="button"
                  onClick={saveApprovalsDefaults}
                  disabled={mutating}
                  className="inline-flex items-center gap-1 rounded border border-info-border bg-info-bg px-2 py-1 text-xs font-medium text-info-fg disabled:opacity-50"
                >
                  {pendingAction === "defaults" ? (
                    <span className="inline-flex items-center gap-0.5">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                    </span>
                  ) : null}
                  Save defaults
                </button>
              </div>
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
          <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5" />
            Quick command presets
          </h2>
          <p className="mb-2 text-xs text-muted-foreground">
            One-click Grant adds to the scope above. Revoke removes it from every scope where it exists (shown when granted).
          </p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {QUICK_PERMISSIONS.map((item) => {
              const active = allowlistSet.has(item.pattern);
              const grantedScopes = (snapshot?.allowlist || [])
                .filter((e) => e.pattern === item.pattern && (selectedAgent === "*" || e.agentId === selectedAgent))
                .map((e) => e.agentId)
                .filter((id, i, arr) => arr.indexOf(id) === i);
              return (
                <div key={item.pattern} className="rounded-xl border border-foreground/10 bg-background/40 px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="text-xs font-medium text-foreground">{item.label}</p>
                      <p className="text-xs text-muted-foreground">{item.pattern}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleQuickPattern(item.pattern)}
                      disabled={mutating}
                      className={cn(
                        "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium",
                        active
                          ? "border-danger-border bg-danger-bg text-danger-fg"
                          : "border-success-border bg-success-bg text-success-fg"
                      )}
                    >
                      {pendingAction === `quick:${item.pattern}` ? (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                        </span>
                      ) : null}
                      {active ? "Revoke" : "Grant"}
                    </button>
                  </div>
                  {active && grantedScopes.length > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Granted for: {grantedScopes.map((s) => (s === "*" ? "all agents" : s)).join(", ")}
                    </p>
                  )}
                  <p className={cn("text-xs text-muted-foreground", active && grantedScopes.length > 0 && "mt-0.5")}>
                    {item.why}
                  </p>
                </div>
              );
            })}
          </div>
        </section>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
            <h2 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <TerminalSquare className="h-3.5 w-3.5" />
              Exec allowlist
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Patterns allowed for <code>exec</code> when <code>security=allowlist</code>. Each row is one entry; <strong className="text-foreground">Revoke</strong> removes that entry from the scope shown (agent: …).
            </p>
            {loading && !snapshot ? (
              <div className="py-10 text-center text-xs text-muted-foreground">Loading permissions…</div>
            ) : scopedAllowlist.length === 0 ? (
              <div className="rounded-xl border border-dashed border-foreground/10 px-3 py-8 text-center text-xs text-muted-foreground">
                No allowlist entries for this scope.
              </div>
            ) : (
              <div className="max-h-96 space-y-1.5 overflow-y-auto pr-0.5">
                {scopedAllowlist.map((entry) => (
                  <div
                    key={`${entry.agentId}-${entry.pattern}`}
                    className="rounded-xl border border-foreground/10 bg-background/40 px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-mono text-xs text-foreground">{entry.pattern}</p>
                        <p className="text-xs text-muted-foreground">
                          agent: {entry.agentId} • last used: {formatAgo(entry.lastUsedAt)}
                        </p>
                        {(entry.lastUsedCommand || entry.lastResolvedPath) && (
                          <p className="truncate text-xs text-muted-foreground">
                            {entry.lastUsedCommand ? `cmd: ${entry.lastUsedCommand}` : ""}
                            {entry.lastUsedCommand && entry.lastResolvedPath ? " • " : ""}
                            {entry.lastResolvedPath ? `path: ${entry.lastResolvedPath}` : ""}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRevokePattern(entry.pattern, entry.agentId)}
                        disabled={mutating}
                        className="inline-flex items-center gap-1 rounded-md border border-danger-border bg-danger-bg px-2 py-1 text-xs font-medium text-danger-fg disabled:opacity-50"
                      >
                        {pendingAction === `revoke:${entry.pattern}` ? (
                          <span className="inline-flex items-center gap-0.5">
                            <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                            <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                            <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                          </span>
                        ) : <Trash2 className="h-3 w-3" />}
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
            <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Tool Policy
            </h2>
            <p className="mb-2 text-xs text-muted-foreground">
              Mode: <code>{snapshot?.capabilities.toolPolicyMode || "unknown"}</code>
            </p>
            <div className="rounded-xl border border-success-border bg-success-bg p-2.5">
              <p className="text-xs uppercase tracking-wide text-success-fg">Configured Allow</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(snapshot?.capabilities.allowedToolsConfigured || []).map((tool) => (
                  <span
                    key={`allow-${tool}`}
                    className="rounded-md border border-success-border bg-success-bg px-1.5 py-0.5 text-xs text-success-fg"
                  >
                    {tool}
                  </span>
                ))}
                {(snapshot?.capabilities.allowedToolsConfigured || []).length === 0 && (
                  <span className="text-xs text-success-fg">none (open mode)</span>
                )}
              </div>
            </div>
            <div className="mt-2 rounded-xl border border-border-strong/20 bg-muted-foreground/5 p-2.5">
              <p className="text-xs uppercase tracking-wide text-fg-secondary dark:text-fg-subtle">Configured Deny</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(snapshot?.capabilities.deniedToolsConfigured || []).map((tool) => (
                  <span
                    key={`deny-${tool}`}
                    className="rounded-md border border-border-strong/25 bg-muted-foreground/12 px-1.5 py-0.5 text-xs text-fg-secondary dark:text-foreground"
                  >
                    {tool}
                  </span>
                ))}
                {(snapshot?.capabilities.deniedToolsConfigured || []).length === 0 && (
                  <span className="text-xs text-fg-secondary dark:text-foreground">none</span>
                )}
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Approvals file: <code>{snapshot?.approvals.path || "unknown"}</code>
            </p>
          </section>
        </div>

        <section className="rounded-2xl border border-foreground/10 bg-card/60 p-3">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              <Bell className="h-3.5 w-3.5" />
              Device Access
            </h2>
            <button
              type="button"
              onClick={() => void loadDevices()}
              disabled={devicesLoading || deviceMutating}
              className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/80 disabled:opacity-60"
            >
              {(devicesLoading || deviceMutating) ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh Devices
            </button>
          </div>

          <p className="mb-3 text-xs text-muted-foreground">
            Pairing and device tokens control which clients can access your gateway.
          </p>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="rounded-xl border border-warning-border bg-warning-bg p-2.5">
              <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold text-warning-fg">
                <UserCheck className="h-3.5 w-3.5" />
                Pending Requests ({pendingDevices.length})
              </h3>
              {devicesLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                </div>
              ) : pendingDevices.length === 0 ? (
                <p className="text-xs text-muted-foreground">No pending pairing requests.</p>
              ) : (
                <div className="space-y-2">
                  {pendingDevices.map((request) => (
                    <div
                      key={request.requestId || request.deviceId}
                      className="rounded-lg border border-foreground/10 bg-card/70 px-3 py-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-foreground">
                            {request.displayName || request.platform || request.deviceId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {request.clientMode || "unknown"} • role {request.requestedRole || "node"}
                          </p>
                        </div>
                        <Smartphone className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      </div>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => approveDevice(request.requestId || request.deviceId)}
                          disabled={deviceMutating}
                          className="inline-flex items-center gap-1 rounded-md border border-success-border bg-success-bg px-2 py-1 text-xs font-medium text-success-fg disabled:opacity-50"
                        >
                          <UserCheck className="h-3 w-3" />
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => rejectDevice(request.requestId || request.deviceId)}
                          disabled={deviceMutating}
                          className="inline-flex items-center gap-1 rounded-md border border-danger-border bg-danger-bg px-2 py-1 text-xs font-medium text-danger-fg disabled:opacity-50"
                        >
                          <UserX className="h-3 w-3" />
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="rounded-xl border border-foreground/10 bg-background/40 p-2.5">
              <h3 className="mb-2 text-xs font-semibold text-foreground">
                Paired Devices ({pairedDevices.length})
              </h3>
              {devicesLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                  <Skeleton className="h-12 w-full rounded-lg" />
                </div>
              ) : pairedDevices.length === 0 ? (
                <p className="text-xs text-muted-foreground">No paired devices.</p>
              ) : (
                <div className="max-h-64 space-y-2 overflow-y-auto pr-0.5">
                  {pairedDevices.map((device) => (
                    <div
                      key={device.deviceId}
                      className="rounded-lg border border-foreground/10 bg-card/70 px-3 py-2 text-xs"
                    >
                      <p className="truncate font-medium text-foreground">
                        {device.displayName || device.platform || device.deviceId}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {device.clientMode || "unknown"} • {device.clientId || "client"}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {(device.roles || []).map((role) => (
                          <button
                            key={`${device.deviceId}:${role}`}
                            type="button"
                            onClick={() => revokeDeviceRole(device.deviceId, role)}
                            disabled={deviceMutating}
                            className="rounded-md border border-danger-border bg-danger-bg px-1.5 py-0.5 text-xs text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-50"
                            title={`Revoke ${role} token`}
                          >
                            revoke:{role}
                          </button>
                        ))}
                        {(device.roles || []).length === 0 && (
                          <span className="text-xs text-muted-foreground">No roles reported.</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
        </>
        )}
      </SectionBody>
    </>
  );

  if (embedded) {
    return (
      <div className="overflow-hidden rounded-2xl border border-foreground/10 bg-card/40">
        {content}
      </div>
    );
  }

  return <SectionLayout>{content}</SectionLayout>;
}
