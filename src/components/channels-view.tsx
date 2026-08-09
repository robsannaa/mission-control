"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Plug,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Unplug,
} from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ScreenLoadingState } from "@/components/ui/loading-state";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { cn } from "@/lib/utils";

type ChannelStatus = {
  channel: string;
  label: string;
  icon: string;
  setupType: "token" | "qr" | "cli" | "auto";
  setupCommand?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  docsUrl: string;
  setupHint?: string;
  managed: boolean;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  error?: string;
  accounts: string[];
  botUsername?: string;
  statuses: {
    channel: string;
    account: string;
    status: string;
    linked?: boolean;
    connected?: boolean;
    error?: string;
  }[];
};

type AgentRow = {
  id: string;
  name: string;
  isDefault: boolean;
  bindings: string[];
};

type AgentsResponse = {
  agents?: AgentRow[];
};

type PairingRequest = {
  channel: string;
  code: string;
  account?: string;
  senderId?: string;
  senderName?: string;
  message?: string;
  createdAt?: string;
};

function normalizeChannel(value: string): string | null {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;
  return text;
}

function splitBinding(binding: string): { channel: string; account: string } {
  const [channelRaw, ...rest] = String(binding || "").split(":");
  return {
    channel: channelRaw.trim().toLowerCase(),
    account: rest.join(":").trim().toLowerCase() || "default",
  };
}

function isDefaultBindingForChannel(binding: string, channel: string): boolean {
  const parsed = splitBinding(binding);
  return parsed.channel === channel && parsed.account === "default";
}

function defaultAgentForChannel(agents: AgentRow[], channel: string): string {
  const owner = agents.find((agent) =>
    (agent.bindings || []).some((binding) => isDefaultBindingForChannel(binding, channel))
  );
  return owner?.id || "";
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function getChannelBadge(channel: ChannelStatus): { label: string; className: string } {
  if (channel.connected) {
    return {
      label: "Connected",
      className: "border-success-border bg-success-bg text-success-fg",
    };
  }
  if (channel.configured || channel.enabled) {
    return {
      label: "Configured",
      className: "border-warning-border bg-warning-bg text-warning-fg",
    };
  }
  return {
    label: "Not connected",
    className: "border-border-strong/70 bg-muted text-fg-secondary dark:border-border dark:text-fg-subtle",
  };
}

export function ChannelsView() {
  const [channels, setChannels] = useState<ChannelStatus[]>([]);
  const [gatewayOffline, setGatewayOffline] = useState(false);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [pairingRequests, setPairingRequests] = useState<PairingRequest[]>([]);
  const [botHandles, setBotHandles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [agentsLoading, setAgentsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tokenDrafts, setTokenDrafts] = useState<Record<string, string>>({});
  const [routeDrafts, setRouteDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [routeBusyChannel, setRouteBusyChannel] = useState<string | null>(null);
  const [approvingKey, setApprovingKey] = useState<string | null>(null);

  const fetchChannels = useCallback(async () => {
    const res = await fetch("/api/channels?scope=all", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Channels request failed (${res.status})`);
    }
    setGatewayOffline(data?.gatewayOffline === true);
    const rows = Array.isArray(data?.channels) ? data.channels : [];
    const next: ChannelStatus[] = rows
      .map((row: Record<string, unknown>): ChannelStatus | null => {
        const channel = normalizeChannel(String(row.channel || row.id || ""));
        if (!channel) return null;
        const statuses = Array.isArray(row.statuses)
          ? row.statuses.filter((s): s is ChannelStatus["statuses"][number] => Boolean(s) && typeof s === "object")
          : [];
        const setupType = row.setupType === "qr" || row.setupType === "cli" || row.setupType === "auto"
          ? row.setupType
          : "token";
        return {
          channel,
          label: String(row.label || channel),
          icon: String(row.icon || "💬"),
          setupType,
          setupCommand: typeof row.setupCommand === "string" ? row.setupCommand : undefined,
          tokenLabel: typeof row.tokenLabel === "string" ? row.tokenLabel : undefined,
          tokenPlaceholder: typeof row.tokenPlaceholder === "string" ? row.tokenPlaceholder : undefined,
          docsUrl: String(row.docsUrl || ""),
          setupHint: typeof row.setupHint === "string" ? row.setupHint : undefined,
          managed: row.managed === true,
          enabled: row.enabled === true,
          configured: row.configured === true,
          connected: row.connected === true || statuses.some((s) => s.connected === true || s.linked === true),
          error: typeof row.error === "string" ? row.error : undefined,
          accounts: Array.isArray(row.accounts) ? row.accounts.map((v) => String(v)) : [],
          botUsername: typeof row.botUsername === "string" ? row.botUsername : undefined,
          statuses,
        } satisfies ChannelStatus;
      })
      .filter((row: ChannelStatus | null): row is ChannelStatus => row !== null);

    setChannels(next);
    setBotHandles((prev) => {
      const merged = { ...prev };
      for (const channel of next) {
        const normalized = channel.botUsername?.trim() || "";
        if (normalized) {
          merged[channel.channel] = normalized;
        }
      }
      return merged;
    });
    return next;
  }, []);

  const fetchAgents = useCallback(async () => {
    const res = await fetch("/api/agents", { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as AgentsResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || `Agents request failed (${res.status})`);
    }
    const next = Array.isArray(data.agents) ? data.agents : [];
    setAgents(next);
    return next;
  }, []);

  const fetchPairing = useCallback(async () => {
    const res = await fetch("/api/pairing", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return;
    const rows = Array.isArray(data?.dm) ? data.dm : [];
    const next = rows
      .map((row: Record<string, unknown>): PairingRequest | null => {
        const channel = normalizeChannel(String(row.channel || ""));
        const code = String(row.code || "").trim();
        if (!channel || !code) return null;
        return {
          channel,
          code,
          account: typeof row.account === "string" ? row.account : undefined,
          senderId: typeof row.senderId === "string" ? row.senderId : undefined,
          senderName: typeof row.senderName === "string" ? row.senderName : undefined,
          message: typeof row.message === "string" ? row.message : undefined,
          createdAt: typeof row.createdAt === "string" ? row.createdAt : undefined,
        } satisfies PairingRequest;
      })
      .filter((row: PairingRequest | null): row is PairingRequest => row !== null);
    setPairingRequests(next);
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    const [channelsResult, agentsResult] = await Promise.allSettled([fetchChannels(), fetchAgents(), fetchPairing()]);
    if (channelsResult.status === "rejected") {
      throw channelsResult.reason;
    }
    if (agentsResult.status === "rejected") {
      setError(agentsResult.reason instanceof Error ? agentsResult.reason.message : String(agentsResult.reason));
    }
  }, [fetchAgents, fetchChannels, fetchPairing]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setAgentsLoading(true);
      try {
        await Promise.all([fetchChannels(), fetchPairing()]);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
      try {
        await fetchAgents();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setAgentsLoading(false);
      }
    })();
  }, [fetchAgents, fetchChannels, fetchPairing]);

  const shouldPollPairing = useMemo(
    () => channels.some((ch) => ch.enabled || ch.configured),
    [channels]
  );
  useSmartPoll(fetchPairing, { intervalMs: 5000, enabled: shouldPollPairing });

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const channel of channels) {
      next[channel.channel] = defaultAgentForChannel(agents, channel.channel);
    }
    setRouteDrafts(next);
  }, [agents, channels]);

  const pairingByChannel = useMemo(() => {
    const groups: Record<string, PairingRequest[]> = {};
    for (const req of pairingRequests) {
      (groups[req.channel] ||= []).push(req);
    }
    return groups;
  }, [pairingRequests]);

  const upsertAgentBindings = useCallback(async (agentId: string, bindings: string[]) => {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "update", id: agentId, bindings }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.ok !== true) {
      throw new Error(data?.error || `Failed to update agent bindings (${res.status})`);
    }
  }, []);

  const resolveBotHandle = useCallback(async (channel: string, token: string) => {
    const clean = token.trim();
    if (!clean) return;
    try {
      const res = await fetch("/api/onboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get-bot-info", channel, token: clean }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.ok && typeof data?.username === "string" && data.username.trim()) {
        setBotHandles((prev) => ({ ...prev, [channel]: String(data.username).trim() }));
      }
    } catch {
      // best effort
    }
  }, []);

  const setDefaultRoute = useCallback(
    async (channel: string, nextAgentId: string, opts?: { silent?: boolean }) => {
      setRouteBusyChannel(channel);
      setError(null);
      try {
        const updates: Array<{ id: string; bindings: string[] }> = [];
        for (const agent of agents) {
          const current = Array.isArray(agent.bindings) ? agent.bindings : [];
          const withoutDefault = current.filter((binding) => !isDefaultBindingForChannel(binding, channel));
          const nextBindings = [...withoutDefault];
          if (nextAgentId && agent.id === nextAgentId) {
            nextBindings.push(channel);
          }
          if (!sameStringArray(current, nextBindings)) {
            updates.push({ id: agent.id, bindings: nextBindings });
          }
        }
        for (const update of updates) {
          await upsertAgentBindings(update.id, update.bindings);
        }
        await fetchAgents();
        setRouteDrafts((prev) => ({ ...prev, [channel]: nextAgentId }));
        if (!opts?.silent) {
          setNotice(
            nextAgentId
              ? `${channel} now routes to ${nextAgentId}.`
              : `${channel} default route cleared.`
          );
        }
      } finally {
        setRouteBusyChannel(null);
      }
    },
    [agents, fetchAgents, upsertAgentBindings]
  );

  const mutateChannel = useCallback(
    async (channel: string, action: "connect" | "disconnect" | "delete", token?: string) => {
      setBusyKey(`${action}:${channel}`);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/channels", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            channel,
            ...(action === "connect" ? { token } : {}),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data?.ok !== true) {
          throw new Error(data?.error || `Failed to ${action} ${channel} (${res.status})`);
        }
        if (action === "connect" && token) {
          await resolveBotHandle(channel, token);
        }
        if (action !== "connect") {
          await setDefaultRoute(channel, "", { silent: true });
        } else {
          const alreadyRouted = defaultAgentForChannel(agents, channel);
          if (!alreadyRouted) {
            const fallbackAgent = agents.find((agent) => agent.isDefault)?.id || agents[0]?.id || "";
            if (fallbackAgent) {
              await setDefaultRoute(channel, fallbackAgent, { silent: true });
            }
          }
        }
        await Promise.all([fetchChannels(), fetchPairing()]);
        setNotice(
          action === "connect"
            ? `${channel} connected. Send a DM to your bot, then approve pairing below.`
            : action === "disconnect"
              ? `${channel} disconnected and default routing cleared.`
              : `${channel} configuration deleted and default routing cleared.`
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyKey(null);
      }
    },
    [agents, fetchChannels, fetchPairing, resolveBotHandle, setDefaultRoute]
  );

  const handleApprove = useCallback(async (request: PairingRequest) => {
    const key = `${request.channel}:${request.code}:${request.account || "default"}`;
    setApprovingKey(key);
    setError(null);
    try {
      const res = await fetch("/api/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve-dm",
          channel: request.channel,
          code: request.code,
          account: request.account,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok !== true) {
        throw new Error(data?.error || `Pairing approve failed (${res.status})`);
      }
      await fetchPairing();
      setNotice(`${request.channel} pairing approved.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApprovingKey(null);
    }
  }, [fetchPairing]);

  if (loading) {
    return (
      <SectionLayout>
        <SectionHeader title="Channels" description="Manage your agents' chat channels after onboarding." bordered />
        <SectionBody>
          <ScreenLoadingState />
        </SectionBody>
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      <SectionHeader
        title="Channels"
        description="Connect chat channels, approve pairing requests, and choose which agent receives each channel."
        bordered
        actions={(
          <button
            type="button"
            onClick={() => {
              setAgentsLoading(true);
              void refreshAll().finally(() => setAgentsLoading(false));
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-fg-secondary transition-colors hover:bg-muted"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        )}
      />
      <SectionBody width="content" innerClassName="space-y-4">
        {error && (
          <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-xs text-danger-fg">
            {error}
          </div>
        )}
        {notice && (
          <div className="rounded-xl border border-success-border bg-success-bg px-4 py-3 text-xs text-success-fg">
            {notice}
          </div>
        )}

        {gatewayOffline ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-10 text-center">
            <PlugZap className="h-8 w-8 text-warning-fg" />
            <div>
              <p className="text-sm font-semibold text-foreground">Gateway offline</p>
              <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Mission Control could not reach the OpenClaw gateway, so channel status is unknown.
                Your channels may still be configured — this is not the same as &quot;not connected&quot;.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setAgentsLoading(true);
                void refreshAll().finally(() => setAgentsLoading(false));
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-warning-border px-3 py-2 text-xs font-semibold text-warning-fg transition-colors hover:bg-warning-bg"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry
            </button>
          </div>
        ) : (
        channels.map((state) => {
          const channel = state.channel;
          const badge = getChannelBadge(state);
          const pending = pairingByChannel[channel] || [];
          const tokenDraft = tokenDrafts[channel] || "";
          const connectBusy = busyKey === `connect:${channel}`;
          const disconnectBusy = busyKey === `disconnect:${channel}`;
          const deleteBusy = busyKey === `delete:${channel}`;
          const saveRouteBusy = routeBusyChannel === channel;
          const tokenSetup = state.setupType === "token";

          return (
            <section key={channel} className="space-y-3 rounded-xl border border-border bg-white/85 p-4 dark:bg-background">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-base">{state.icon}</span>
                  <h2 className="text-sm font-semibold text-foreground">{state.label}</h2>
                  <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide", badge.className)}>
                    {badge.label}
                  </span>
                </div>
                {state.docsUrl ? (
                  <a
                    href={state.docsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-[var(--accent-brand-text)] hover:text-[var(--accent-brand)]"
                  >
                    Setup guide
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>

              {state.setupHint && (
                <p className="text-xs text-muted-foreground">{state.setupHint}</p>
              )}
              {state.error && (
                <p className="inline-flex items-center gap-1 text-xs text-danger-fg">
                  <AlertTriangle className="h-3 w-3" />
                  {state.error}
                </p>
              )}

              <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border/80 bg-muted/70 p-3 dark:border-border dark:bg-background">
                {tokenSetup ? (
                  <>
                    <label className="min-w-[220px] flex-1">
                      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                        {state.tokenLabel || "Bot Token"}
                      </span>
                      <input
                        type="password"
                        value={tokenDraft}
                        onChange={(e) => setTokenDrafts((prev) => ({ ...prev, [channel]: e.target.value }))}
                        placeholder={state.tokenPlaceholder || "Paste bot token"}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground outline-none focus:border-border-strong dark:bg-sidebar"
                      />
                    </label>
                    <button
                      type="button"
                      disabled={!tokenDraft.trim() || connectBusy || disconnectBusy || deleteBusy}
                      onClick={() => void mutateChannel(channel, "connect", tokenDraft.trim())}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
                    >
                      {connectBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plug className="h-3.5 w-3.5" />}
                      Connect
                    </button>
                  </>
                ) : (
                  <div className="min-w-[220px] flex-1">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
                      {state.setupType === "qr" ? "QR link setup" : "CLI setup"}
                    </span>
                    {state.setupCommand ? (
                      <code className="block w-full truncate rounded-lg border border-border bg-card px-3 py-2 font-mono text-[11px] text-fg-secondary dark:bg-sidebar">
                        {state.setupCommand}
                      </code>
                    ) : null}
                  </div>
                )}
                <button
                  type="button"
                  disabled={(!state.enabled && !state.configured) || connectBusy || disconnectBusy || deleteBusy}
                  onClick={() => void mutateChannel(channel, "disconnect")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-fg-secondary transition-colors hover:bg-muted disabled:opacity-40"
                >
                  {disconnectBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unplug className="h-3.5 w-3.5" />}
                  Disconnect
                </button>
                <button
                  type="button"
                  disabled={(!state.enabled && !state.configured) || connectBusy || disconnectBusy || deleteBusy}
                  onClick={() => void mutateChannel(channel, "delete")}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-danger-border px-3 py-2 text-xs font-semibold text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-40"
                >
                  {deleteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Delete config
                </button>
              </div>

              <div className="rounded-lg border border-border/80 bg-muted/70 p-3 dark:border-border dark:bg-background">
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold text-fg-secondary">
                  <ShieldCheck className="h-3.5 w-3.5 text-success-fg" />
                  Pairing approvals
                </div>
                {state.enabled || state.configured ? (
                  <>
                    <p className="mb-2 text-xs text-muted-foreground">
                      Send any DM to your {state.label} bot
                      {botHandles[channel] ? (
                        <>
                          {" "}(
                          {channel === "telegram" ? (
                            <a
                              href={`https://t.me/${botHandles[channel].replace(/^@/, "")}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="font-mono text-[var(--accent-brand-text)] hover:text-[var(--accent-brand)]"
                            >
                              {botHandles[channel]}
                            </a>
                          ) : (
                            <span className="font-mono text-[var(--accent-brand-text)]">
                              {botHandles[channel]}
                            </span>
                          )}
                          )
                        </>
                      ) : null}
                      , then approve it here.
                    </p>
                    {pending.length === 0 ? (
                      <p className="text-xs text-fg-subtle">No pending requests.</p>
                    ) : (
                      <div className="space-y-2">
                        {pending.map((req) => {
                          const key = `${req.channel}:${req.code}:${req.account || "default"}`;
                          const isApproving = approvingKey === key;
                          return (
                            <div
                              key={key}
                              className="rounded-lg border border-border bg-card px-3 py-2 text-xs dark:bg-background"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="space-y-0.5">
                                  <p className="font-semibold text-foreground">
                                    {req.senderName || req.senderId || "Unknown sender"}
                                  </p>
                                  <p className="font-mono text-[11px] text-fg-secondary">{req.code}</p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleApprove(req)}
                                  disabled={isApproving}
                                  className="inline-flex items-center gap-1 rounded-control bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-primary-foreground hover:bg-primary/88 disabled:opacity-50"
                                >
                                  {isApproving ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                                  Approve
                                </button>
                              </div>
                              {req.message ? (
                                <p className="mt-1 line-clamp-1 text-[11px] italic text-muted-foreground">
                                  &quot;{req.message}&quot;
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-fg-subtle">Connect the channel first to receive pairing requests.</p>
                )}
              </div>

              <div className="rounded-lg border border-border/80 bg-muted/70 p-3 dark:border-border dark:bg-background">
                <div className="mb-2 text-xs font-semibold text-fg-secondary">Default routing</div>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={routeDrafts[channel] || ""}
                    onChange={(e) => setRouteDrafts((prev) => ({ ...prev, [channel]: e.target.value }))}
                    disabled={agentsLoading}
                    className="min-w-[220px] flex-1 rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground outline-none focus:border-border-strong dark:bg-sidebar"
                  >
                    <option value="">{agentsLoading ? "Loading agents..." : "No default route"}</option>
                    {agents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name} ({agent.id}){agent.isDefault ? " · default" : ""}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={saveRouteBusy || agentsLoading}
                    onClick={() => void setDefaultRoute(channel, routeDrafts[channel] || "")}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-semibold text-fg-secondary transition-colors hover:bg-muted disabled:opacity-40"
                  >
                    {saveRouteBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                    Save route
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-fg-subtle">
                  This manages the default binding (`{channel}:default`). For account-specific bindings, use{" "}
                  <Link href="/agents" className="text-[var(--accent-brand-text)] hover:text-[var(--accent-brand)]">
                    Agents
                  </Link>.
                </p>
              </div>
            </section>
          );
        })
        )}
      </SectionBody>
    </SectionLayout>
  );
}
