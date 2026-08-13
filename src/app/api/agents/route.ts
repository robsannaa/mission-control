import { NextRequest, NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
import { getOpenClawHome, getDefaultWorkspaceSync } from "@/lib/paths";
import { runCli, parseJsonFromCliOutput } from "@/lib/openclaw";
import { fetchGatewaySessions, summarizeSessionsByAgent } from "@/lib/gateway-sessions";
import {
  gatewayCallWithRetry,
  patchConfig as applyConfigPatchWithRetry,
  fetchConfig,
  extractBindings,
} from "@/lib/gateway-config";
import {
  routeBindingLabel,
  type AgentRouteBinding,
  type ConfiguredTopologyChannel,
} from "@/lib/agent-topology";

const OPENCLAW_HOME = getOpenClawHome();
export const dynamic = "force-dynamic";

// CliAgent type removed — agents list now derived from config.get RPC

type AgentFull = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  fallbackModels: string[];
  workspace: string;
  agentDir: string;
  isDefault: boolean;
  sessionCount: number;
  lastActive: number | null;
  totalTokens: number;
  bindings: string[];
  channels: string[];
  identitySnippet: string | null;
  identityTheme: string | null;
  identityAvatar: string | null;
  identitySource: string | null;
  skills: string[] | null;
  subagents: string[];
  runtimeSubagents: Array<{
    sessionKey: string;
    sessionId: string;
    shortId: string;
    model: string;
    totalTokens: number;
    lastActive: number;
    ageMs: number;
    status: "running" | "recent";
  }>;
  status: "active" | "idle" | "unknown";
};

const SUBAGENT_RECENT_WINDOW_MS = 30 * 60 * 1000;
const SUBAGENT_ACTIVE_WINDOW_MS = 2 * 60 * 1000;
const AGENTS_CACHE_TTL_MS = 5000;
const AGENTS_CACHE_MAX_STALE_MS = 60000;

type AgentsGetPayload = {
  agents: AgentFull[];
  owner: string | null;
  defaultModel: string;
  defaultFallbacks: string[];
  configuredChannels: ConfiguredTopologyChannel[];
  routeBindings: AgentRouteBinding[];
};

let agentsCache: { payload: AgentsGetPayload; expiresAt: number; fetchedAt: number } | null = null;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function isSubagentSessionKey(key: string): boolean {
  return key.includes(":subagent:");
}

function shortSubagentId(key: string, sessionId: string): string {
  const fromKey = key.split(":").pop() || "";
  if (fromKey) return fromKey.slice(0, 8);
  return sessionId.slice(0, 8);
}

function connectedChannelAccountsFromStatus(raw: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const markConnected = (channel: string, accountId: string) => {
    if (!channel) return;
    const accounts = out.get(channel) || new Set<string>();
    accounts.add(accountId || "default");
    out.set(channel, accounts);
  };
  const obj = asRecord(raw);
  const channels = asRecord(obj.channels);
  for (const [channel, rowRaw] of Object.entries(channels)) {
    const row = asRecord(rowRaw);
    const probe = asRecord(row.probe);
    if (row.running === true || probe.ok === true) {
      markConnected(channel, "default");
    }
  }

  const channelAccounts = asRecord(obj.channelAccounts);
  for (const [channel, entriesRaw] of Object.entries(channelAccounts)) {
    const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
    for (const entryRaw of entries) {
      const entry = asRecord(entryRaw);
      const probe = asRecord(entry.probe);
      if (
        entry.running === true ||
        probe.ok === true
      ) {
        const accountId = String(
          entry.accountId || entry.id || entry.name || "default",
        ).trim();
        markConnected(channel, accountId);
      }
    }
  }

  return out;
}

function configuredChannelInventory(
  rawChannels: Record<string, unknown>,
  connected: Map<string, Set<string>>,
  routeBindings: AgentRouteBinding[],
): ConfiguredTopologyChannel[] {
  const channelNames = new Set<string>([
    ...Object.keys(rawChannels),
    ...connected.keys(),
    ...routeBindings.map((binding) => binding.channel),
  ]);

  return Array.from(channelNames)
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((channel) => {
      const channelCfg = asRecord(rawChannels[channel]);
      const accountsCfg = asRecord(channelCfg.accounts);
      const configuredAccountIds = Object.keys(accountsCfg);
      const connectedAccountIds = Array.from(connected.get(channel) || []);
      const bindingAccountIds = routeBindings
        .filter((binding) => binding.channel === channel && binding.accountId !== "*")
        .map((binding) => binding.accountId || "default");
      const accountIds = Array.from(
        new Set([
          ...configuredAccountIds,
          ...connectedAccountIds,
          ...bindingAccountIds,
          ...(configuredAccountIds.length === 0 ? ["default"] : []),
        ]),
      ).filter(Boolean);
      const defaultAccount =
        (typeof channelCfg.defaultAccount === "string" && channelCfg.defaultAccount.trim()) ||
        (accountIds.includes("default") ? "default" : accountIds[0] || "default");
      const channelEnabled = channelCfg.enabled !== false;
      const connectedAccounts = connected.get(channel) || new Set<string>();

      return {
        channel,
        enabled: channelEnabled,
        connected: connectedAccounts.size > 0,
        defaultAccount,
        accounts: accountIds.map((id) => {
          const accountCfg = asRecord(accountsCfg[id]);
          return {
            id,
            name: typeof accountCfg.name === "string" ? accountCfg.name : undefined,
            enabled: channelEnabled && accountCfg.enabled !== false,
            connected:
              connectedAccounts.has(id) ||
              (id === defaultAccount && connectedAccounts.has("default")),
          };
        }),
      };
    });
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function readTextSafe(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

// gatewayCallWithRetry and applyConfigPatchWithRetry imported from @/lib/gateway-config

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const key = String(entry || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function cloneConfigRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => ({ ...asRecord(row) }));
}

function buildBindingsForAgent(
  agentId: string,
  bindingsValue: unknown,
  existingBindingsValue: unknown,
): Record<string, unknown>[] {
  const nextBindings = cloneConfigRows(existingBindingsValue).filter(
    (binding) => String(binding.agentId || "").trim() !== agentId,
  );

  for (const binding of normalizeStringList(bindingsValue)) {
    const [channelRaw, ...accountParts] = binding.split(":");
    const channel = channelRaw?.trim() || "";
    if (!channel) continue;
    const accountId = accountParts.join(":").trim() || "default";
    nextBindings.push({
      agentId,
      match: {
        channel,
        accountId,
      },
    });
  }

  return nextBindings;
}

function extractIdentityFields(markdown: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(?:[-*]\s*)?(?:\*\*)?([^:*]+?)(?:\*\*)?\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const value = match[2].trim();
    if (!value) continue;
    if (key === "name") out.name = value;
    else if (key === "emoji") out.emoji = value;
    else if (key === "theme") out.theme = value;
    else if (key === "avatar") out.avatar = value;
  }
  return out;
}

async function createAgentViaCli(body: Record<string, unknown>) {
  const name = String(body.name || "").trim();
  const workspace =
    String(body.workspace || "").trim() ||
    join(getOpenClawHome(), `workspace-${name}`);
  const agentDir = String(body.agentDir || "").trim();

  const args = ["agents", "add", name, "--non-interactive", "--json", "--workspace", workspace];
  if (agentDir) {
    args.push("--agent-dir", agentDir);
  }
  if (body.model) {
    args.push("--model", String(body.model));
  }
  for (const binding of normalizeStringList(body.bindings)) {
    args.push("--bind", binding);
  }

  const output = await runCli(args, 30000);
  let result: Record<string, unknown> = {};
  try {
    result = parseJsonFromCliOutput<Record<string, unknown>>(
      output,
      "openclaw agents add --json",
    );
  } catch {
    result = { raw: output };
  }

  try {
    const configData = await gatewayCallWithRetry<Record<string, unknown>>(
      "config.get",
      undefined,
      10000,
    );
    const parsed = asRecord(configData.parsed);
    const agentsSection = asRecord(parsed.agents);
    const agentsList = cloneConfigRows(agentsSection.list);
    const agentIdx = agentsList.findIndex((agent) => String(agent.id || "") === name);
    if (agentIdx >= 0) {
      const entry = { ...agentsList[agentIdx] };
      const displayName = String(body.displayName || "").trim();
      if (displayName) {
        entry.name = displayName;
      }

      const model = String(body.model || "").trim();
      const fallbacks = normalizeStringList(body.fallbacks);
      if (model) {
        entry.model = fallbacks.length > 0 ? { primary: model, fallbacks } : model;
      }

      const subagentsList = normalizeStringList(body.subagents);
      if (subagentsList.length > 0) {
        entry.subagents = {
          ...asRecord(entry.subagents),
          allowAgents: subagentsList,
        };
      }

      if (body.default === true) {
        entry.default = true;
        for (let i = 0; i < agentsList.length; i++) {
          if (i !== agentIdx && "default" in agentsList[i]) {
            delete agentsList[i].default;
          }
        }
      }

      agentsList[agentIdx] = entry;
      const patch: Record<string, unknown> = {
        agents: { list: agentsList },
      };
      if ("bindings" in body) {
        patch.bindings = buildBindingsForAgent(name, body.bindings, parsed.bindings);
      }
      await applyConfigPatchWithRetry(patch);
    }
  } catch (error) {
    console.warn("Agent create: post-create config patch failed", error);
  }

  return NextResponse.json({
    ok: true,
    action: "create",
    name,
    workspace,
    agentDir: agentDir || undefined,
    fallback: "cli",
    ...result,
  });
}

function buildSyntheticMainAgent(
  defaults: Record<string, unknown>,
  defaultWorkspace: string,
): Record<string, unknown> {
  const synthetic: Record<string, unknown> = { id: "main", default: true };
  if (defaults.model !== undefined) synthetic.model = defaults.model;
  if (defaults.workspace !== undefined) synthetic.workspace = defaultWorkspace;
  if (defaults.identity !== undefined) synthetic.identity = defaults.identity;
  if (defaults.subagents !== undefined) synthetic.subagents = defaults.subagents;
  return synthetic;
}

/**
 * Rich agent discovery — configured agents are the source of truth.
 * Runtime sessions enrich known agents, but do not create new rows.
 */
export async function GET() {
  try {
    const now = Date.now();
    if (agentsCache && now < agentsCache.expiresAt) {
      return NextResponse.json({ ...agentsCache.payload, stale: false });
    }

    // 1. Get config via gateway RPC (replaces both CLI agents list and file read)
    let configData: Awaited<ReturnType<typeof fetchConfig>> | null = null;
    try {
      configData = await fetchConfig(10000);
    } catch {
      // Gateway might not be available — fall back to file
    }

    // Fallback: read config from file if gateway unavailable
    let config: Record<string, unknown> = {};
    if (configData) {
      config = configData.parsed;
    } else {
      const configPath = join(OPENCLAW_HOME, "openclaw.json");
      config = await readJsonSafe<Record<string, unknown>>(configPath, {});
    }

    const agentsConfig = (config.agents || {}) as Record<string, unknown>;
    const defaults = (agentsConfig.defaults || {}) as Record<string, unknown>;
    const configList = (agentsConfig.list || []) as Record<string, unknown>[];

    // Also incorporate the resolved config — the gateway may compute additional
    // agent entries (from defaults, inheritance, or overlays) that the raw
    // parsed config does not contain.
    const resolved = configData ? configData.resolved : {};
    const resolvedAgents = asRecord(asRecord(resolved).agents);
    const resolvedDefaults = asRecord(resolvedAgents.defaults);
    const resolvedList = Array.isArray(resolvedAgents.list)
      ? (resolvedAgents.list as Record<string, unknown>[]).filter(
          (v) => v && typeof v === "object" && !Array.isArray(v)
        )
      : [];

    // Merge parsed + resolved defaults: prefer resolved for model/workspace
    const defaultModelRaw = resolvedDefaults.model || defaults.model;
    const defaultModel = typeof defaultModelRaw === "string"
      ? { primary: defaultModelRaw }
      : (defaultModelRaw as Record<string, unknown> | undefined);
    const defaultPrimary = (defaultModel?.primary as string) || "unknown";
    const defaultFallbacks = (defaultModel?.fallbacks as string[]) || [];
    const defaultWorkspace =
      (resolvedDefaults.workspace as string) ||
      (defaults.workspace as string) ||
      getDefaultWorkspaceSync();

    // Merge agent lists: parsed entries + resolved entries not already present
    const mergedList = [...configList];
    const parsedIds = new Set(configList.map((c) => String(c.id || "")));
    for (const r of resolvedList) {
      const rid = String(r.id || "");
      if (rid && !parsedIds.has(rid)) {
        mergedList.push(r);
      }
    }
    if (mergedList.length === 0) {
      mergedList.push(buildSyntheticMainAgent(defaults, defaultWorkspace));
    }

    const discoveredDefaultAgentId =
      (mergedList.find((c) => c.default === true)?.id as string | undefined) ||
      (mergedList.find((c) => String(c.id || "") === "main")?.id as string | undefined) ||
      (mergedList.find((c) => typeof c.id === "string")?.id as string | undefined) ||
      "main";

    // Bindings from config (gateway or file).
    const configBindingsByAgent = new Map<string, string[]>();
    const configBindings = configData
      ? extractBindings(configData)
      : ((config.bindings || []) as Record<string, unknown>[]).map((b) => {
          const match = asRecord(b.match);
          const peer = asRecord(match.peer);
          return {
            ...b,
            agentId: String(b.agentId || ""),
            match: {
              channel: String(match.channel || ""),
              accountId: typeof match.accountId === "string" ? match.accountId : undefined,
              peer:
                typeof peer.kind === "string" && typeof peer.id === "string"
                  ? { kind: peer.kind, id: peer.id }
                  : undefined,
              guildId: typeof match.guildId === "string" ? match.guildId : undefined,
              teamId: typeof match.teamId === "string" ? match.teamId : undefined,
              roles: Array.isArray(match.roles)
                ? match.roles.map((role) => String(role || "").trim()).filter(Boolean)
                : undefined,
            },
          };
        });
    const routeBindings: AgentRouteBinding[] = [];
    configBindings.forEach((binding, order) => {
      const agentId = (binding.agentId || discoveredDefaultAgentId).trim();
      const channel = binding.match.channel.trim();
      const accountId = (binding.match.accountId || "").trim() || null;
      if (!channel) return;
      const routeBinding: AgentRouteBinding = {
        order,
        type: typeof binding.type === "string" ? binding.type : "route",
        agentId,
        channel,
        accountId,
        peer: binding.match.peer,
        guildId: binding.match.guildId,
        teamId: binding.match.teamId,
        roles: binding.match.roles,
        comment: typeof binding.comment === "string" ? binding.comment : undefined,
      };
      routeBindings.push(routeBinding);
      const label = routeBindingLabel(routeBinding);
      const existing = configBindingsByAgent.get(agentId) || [];
      if (!existing.includes(label)) existing.push(label);
      configBindingsByAgent.set(agentId, existing);
    });

    // Use gateway RPC for channel status (replaces CLI "channels status --probe")
    const channelStatusRaw = await gatewayCallWithRetry<Record<string, unknown>>(
      "channels.status",
      {},
      12000,
    ).catch(() => ({}));
    const connectedChannelAccounts = connectedChannelAccountsFromStatus(channelStatusRaw);
    const configuredChannels = configuredChannelInventory(
      (config.channels || {}) as Record<string, unknown>,
      connectedChannelAccounts,
      routeBindings,
    );
    const connectedChannels = new Set(connectedChannelAccounts.keys());

    // Build a lookup from merged config list.
    // Start with parsed entries, then layer resolved data on top for richer
    // metadata (the resolved config contains computed names, models, identities).
    const configMap = new Map<string, Record<string, unknown>>();
    for (const c of mergedList) {
      if (c.id) configMap.set(c.id as string, c);
    }
    // Enrich parsed entries with resolved data (resolved has computed fields
    // like identity.name that may be missing from the raw parsed config)
    for (const r of resolvedList) {
      const rid = String(r.id || "");
      if (!rid) continue;
      const existing = configMap.get(rid);
      if (existing) {
        // Merge resolved fields into parsed entry (parsed takes precedence
        // for user-set values, resolved fills in computed/inherited fields)
        const merged = { ...r, ...existing };
        // But for identity, prefer resolved if parsed has no identity
        if (!existing.identity && r.identity) {
          merged.identity = r.identity;
        }
        configMap.set(rid, merged);
      }
    }

    // Session state comes from gateway RPC (source of truth), not local files.
    let gatewaySessions = [] as Awaited<ReturnType<typeof fetchGatewaySessions>>;
    let sessionsByAgent = new Map<string, { sessionCount: number; totalTokens: number; lastActive: number }>();
    const runtimeSubagentsByAgent = new Map<
      string,
      AgentFull["runtimeSubagents"]
    >();
    try {
      gatewaySessions = await fetchGatewaySessions(10000);
      sessionsByAgent = summarizeSessionsByAgent(gatewaySessions);

      const now = Date.now();
      for (const session of gatewaySessions) {
        if (!isSubagentSessionKey(session.key)) continue;
        if (!session.agentId) continue;
        if (!session.updatedAt) continue;
        const ageMs = Math.max(0, now - session.updatedAt);
        if (ageMs > SUBAGENT_RECENT_WINDOW_MS) continue;
        const row: AgentFull["runtimeSubagents"][number] = {
          sessionKey: session.key,
          sessionId: session.sessionId,
          shortId: shortSubagentId(session.key, session.sessionId),
          model: session.fullModel || "unknown",
          totalTokens: session.totalTokens,
          lastActive: session.updatedAt,
          ageMs,
          status: ageMs <= SUBAGENT_ACTIVE_WINDOW_MS ? "running" : "recent",
        };
        const existing = runtimeSubagentsByAgent.get(session.agentId) || [];
        existing.push(row);
        runtimeSubagentsByAgent.set(session.agentId, existing);
      }

      for (const [agentId, rows] of runtimeSubagentsByAgent.entries()) {
        rows.sort((a, b) => b.lastActive - a.lastActive);
        runtimeSubagentsByAgent.set(agentId, rows.slice(0, 6));
      }
    } catch {
      // Keep agents page usable even if gateway session RPC is temporarily unavailable.
    }

    const agents: AgentFull[] = [];
    const workspaceIdentityCache = new Map<string, string | null>();

    // Determine the set of agent ids to process from configured/resolved agent definitions only.
    // Runtime sessions and stray directories may contain temporary helpers (e.g. tmp-probe)
    // or foreign agent ids (e.g. Codex), which should not appear in the Agents page.
    const agentIds = new Set<string>();
    for (const cfg of mergedList) {
      if (cfg.id) agentIds.add(cfg.id as string);
    }

    for (const id of agentIds) {
      const cfg = configMap.get(id) || {};
      const identityCfg =
        cfg.identity && typeof cfg.identity === "object"
          ? (cfg.identity as Record<string, unknown>)
          : {};
      const identityTheme =
        typeof identityCfg.theme === "string" ? identityCfg.theme : null;
      const identityAvatar =
        typeof identityCfg.avatar === "string" ? identityCfg.avatar : null;
      const identitySource: string | null = null;

      // Name / emoji — strip markdown template hints like "_(or ...)"
      const rawName =
        (typeof identityCfg.name === "string" ? identityCfg.name : null) ||
        (cfg.name as string) ||
        id;
      const name = rawName.replace(/\s*_\(.*?\)_?\s*/g, "").trim() || rawName;
      const rawEmoji =
        (typeof identityCfg.emoji === "string" ? identityCfg.emoji : null) ||
        "🤖";
      const emoji = rawEmoji.replace(/\s*_\(.*?\)_?\s*/g, "").trim() || rawEmoji;

      // Model — prefer config-level names over CLI's resolved provider model IDs
      // (CLI returns the resolved model after auth failover, e.g. "amazon-bedrock/anthropic.claude-3-sonnet-..."
      //  which is not what the user configured)
      const agentModelCfg = cfg.model as
        | string
        | Record<string, unknown>
        | undefined;
      let model: string;
      let fallbackModels: string[];
      if (typeof agentModelCfg === "string") {
        // Per-agent model set as a plain string
        model = agentModelCfg;
        fallbackModels = defaultFallbacks;
      } else if (agentModelCfg && typeof agentModelCfg === "object") {
        // Per-agent model set as { primary, fallbacks }
        model = (agentModelCfg.primary as string) || defaultPrimary;
        fallbackModels = (agentModelCfg.fallbacks as string[]) || defaultFallbacks;
      } else {
        // No per-agent override — use the configured defaults (NOT the CLI resolved model)
        model = defaultPrimary;
        fallbackModels = defaultFallbacks;
      }

      // Workspace
      const workspace =
        (cfg.workspace as string) || defaultWorkspace;
      const agentDir = join(OPENCLAW_HOME, "agents", id, "agent");

      // Skills (per-agent allowlist — flat array of skill names)
      const skillsCfg = cfg.skills;
      const skills: string[] | null = Array.isArray(skillsCfg)
        ? (skillsCfg as unknown[]).map((s) => String(s)).filter(Boolean)
        : null;

      // Subagents
      const subagentsCfg = cfg.subagents as
        | Record<string, unknown>
        | undefined;
      const subagents = (subagentsCfg?.allowAgents as string[]) || [];

      // Bindings / channels
      const persistedBindings = configBindingsByAgent.get(id) || [];
      const bindings = Array.from(
        new Set(persistedBindings.filter((b) => Boolean(b)))
      );
      const channels: string[] = [];
      for (const b of bindings) {
        const ch = b.split(" ")[0];
        if (ch && !channels.includes(ch)) channels.push(ch);
      }
      if (id === discoveredDefaultAgentId || cfg.default === true) {
        for (const ch of connectedChannels) {
          if (!channels.includes(ch)) channels.push(ch);
        }
      }

      // Sessions & tokens from gateway truth.
      const sessionSummary = sessionsByAgent.get(id);
      const sessionCount = sessionSummary?.sessionCount || 0;
      const lastActive = sessionSummary && sessionSummary.lastActive > 0
        ? sessionSummary.lastActive
        : null;
      const totalTokens = sessionSummary?.totalTokens || 0;
      const runtimeSubagents = runtimeSubagentsByAgent.get(id) || [];

      // Identity snippet (first few meaningful lines)
      let identitySnippet: string | null = null;
      let idFile = workspaceIdentityCache.get(workspace);
      if (idFile === undefined) {
        idFile = await readTextSafe(join(workspace, "IDENTITY.md"));
        workspaceIdentityCache.set(workspace, idFile);
      }
      if (idFile) {
        const lines = idFile
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("#"))
          .slice(0, 6)
          .join("\n");
        identitySnippet = lines.slice(0, 500);
      }

      // Status
      const now = Date.now();
      const fiveMinAgo = now - 5 * 60 * 1000;
      const status: AgentFull["status"] = lastActive
        ? lastActive > fiveMinAgo
          ? "active"
          : "idle"
        : "unknown";

      agents.push({
        id,
        name,
        emoji,
        model,
        fallbackModels,
        workspace,
        agentDir,
        isDefault: Boolean(cfg.default === true || id === discoveredDefaultAgentId),
        sessionCount,
        lastActive,
        totalTokens,
        bindings,
        channels,
        identitySnippet,
        identityTheme,
        identityAvatar,
        identitySource,
        skills,
        subagents,
        runtimeSubagents,
        status,
      });
    }

    // Get owner info from IDENTITY.md of the default workspace
    let ownerName: string | null = null;
    try {
      const defaultAgent = agents.find((a) => a.isDefault);
      if (defaultAgent?.identitySnippet) {
        // Try to parse owner from bindings or just use generic
      }
      // Also check the main identity file for owner hints
      const mainIdentity = await readTextSafe(
        join(defaultWorkspace, "IDENTITY.md")
      );
      if (mainIdentity) {
        const nameMatch = mainIdentity.match(
          /\*\*Name:\*\*\s*(.+?)(?:\n|$)/
        );
        if (nameMatch) ownerName = nameMatch[1].trim();
      }
    } catch {
      // ok
    }

    const payload: AgentsGetPayload = {
      agents,
      owner: ownerName,
      defaultModel: defaultPrimary,
      defaultFallbacks,
      configuredChannels,
      routeBindings,
    };
    const writtenAt = Date.now();
    agentsCache = {
      payload,
      expiresAt: writtenAt + AGENTS_CACHE_TTL_MS,
      fetchedAt: writtenAt,
    };

    return NextResponse.json({ ...payload, stale: false });
  } catch (err) {
    console.error("Agents API error:", err);

    // Serve stale cache during gateway outages (up to maxStale window).
    const now = Date.now();
    if (agentsCache && now < agentsCache.fetchedAt + AGENTS_CACHE_MAX_STALE_MS) {
      console.warn("Agents API: serving stale cache due to error:", String(err));
      return NextResponse.json({ ...agentsCache.payload, stale: true });
    }

    // No cache at all — return a minimal empty response rather than 503.
    console.warn("Agents API: no cache available, returning empty response:", String(err));
    return NextResponse.json({
      agents: [],
      owner: null,
      defaultModel: "unknown",
      defaultFallbacks: [],
      configuredChannels: [],
      routeBindings: [],
      stale: true,
    });
  }
}

/**
 * POST /api/agents - Create a new agent or perform agent actions.
 *
 * Body:
 *   { action: "create", name: "work", model?: "provider/model", workspace?: "/path", bindings?: ["whatsapp:biz"] }
 */
export async function POST(request: NextRequest) {
  try {
    // Invalidate GET cache for any mutation action.
    agentsCache = null;

    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      case "create": {
        const name = (body.name as string)?.trim();
        if (!name) {
          return NextResponse.json(
            { error: "Agent name is required" },
            { status: 400 }
          );
        }

        // Validate name: alphanumeric + hyphens only
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
          return NextResponse.json(
            { error: "Agent name must start with a letter/number and contain only letters, numbers, hyphens, or underscores" },
            { status: 400 }
          );
        }

        const workspace =
          (body.workspace as string)?.trim() ||
          join(getOpenClawHome(), `workspace-${name}`);
        const agentDir = (body.agentDir as string)?.trim();
        try {
          if (agentDir) {
            return await createAgentViaCli(body as Record<string, unknown>);
          }

          const result = await gatewayCallWithRetry<Record<string, unknown>>(
            "agents.create",
            { name, workspace },
            30000,
          );

          const configData = await gatewayCallWithRetry<Record<string, unknown>>(
            "config.get",
            undefined,
            10000,
          );
          const parsed = asRecord(configData.parsed);
          const agentsSection = asRecord(parsed.agents);
          const agentsList = cloneConfigRows(agentsSection.list);
          const agentIdx = agentsList.findIndex((agent) => String(agent.id || "") === name);

          if (agentIdx >= 0) {
            const entry = { ...agentsList[agentIdx] };
            const displayName = String(body.displayName || "").trim();
            if (displayName) {
              entry.name = displayName;
            }

            const model = String(body.model || "").trim();
            const fallbacks = normalizeStringList(body.fallbacks);
            if (model) {
              entry.model = fallbacks.length > 0 ? { primary: model, fallbacks } : model;
            }

            const subagentsList = normalizeStringList(body.subagents);
            if (subagentsList.length > 0) {
              entry.subagents = {
                ...asRecord(entry.subagents),
                allowAgents: subagentsList,
              };
            }

            if (body.default === true) {
              entry.default = true;
              for (let i = 0; i < agentsList.length; i++) {
                if (i !== agentIdx && "default" in agentsList[i]) {
                  delete agentsList[i].default;
                }
              }
            }

            agentsList[agentIdx] = entry;
            const patch: Record<string, unknown> = {
              agents: { list: agentsList },
            };
            if ("bindings" in body) {
              patch.bindings = buildBindingsForAgent(name, body.bindings, parsed.bindings);
            }
            await applyConfigPatchWithRetry(patch);
          }

          return NextResponse.json({
            ok: true,
            action,
            name,
            workspace,
            ...result,
          });
        } catch (error) {
          console.warn("Agent create: gateway create failed, falling back to CLI", error);
          return await createAgentViaCli(body as Record<string, unknown>);
        }
      }

      case "update": {
        const id = body.id as string;
        if (!id) {
          return NextResponse.json(
            { error: "Agent ID is required" },
            { status: 400 }
          );
        }

        const configData = await gatewayCallWithRetry<Record<string, unknown>>(
          "config.get",
          undefined,
          10000,
        );
        const parsed = asRecord(configData.parsed);
        const agentsSection = asRecord(parsed.agents);
        const agentsList = cloneConfigRows(agentsSection.list);
        let agentIdx = agentsList.findIndex((a) => a.id === id);
        // If agent exists only at runtime (e.g. default "main") but not in config, upsert an entry
        if (agentIdx === -1) {
          agentIdx = agentsList.length;
          agentsList.push({ id });
        }
        const agent = { ...agentsList[agentIdx] };

        // Update model
        if ("model" in body) {
          const newModel = body.model as string | null;
          const newFallbacks = (body.fallbacks || []) as string[];
          if (!newModel) {
            // Empty = inherit default, remove override
            delete agent.model;
          } else if (newFallbacks.length > 0) {
            agent.model = { primary: newModel, fallbacks: newFallbacks };
          } else {
            agent.model = newModel;
          }
        }

        // Update per-agent skill allowlist
        if ("skills" in body) {
          const skillsValue = body.skills;
          if (skillsValue === null || skillsValue === undefined) {
            // null/undefined = remove override, inherit all global skills
            delete agent.skills;
          } else if (Array.isArray(skillsValue)) {
            const skillNames = (skillsValue as unknown[])
              .map((s) => String(s || "").trim())
              .filter(Boolean);
            // Empty array = explicitly allow no skills; non-empty = allowlist
            agent.skills = skillNames;
          }
        }

        // Update subagents
        if ("subagents" in body) {
          const subs = (body.subagents || []) as string[];
          if (subs.length > 0) {
            agent.subagents = {
              ...((agent.subagents as Record<string, unknown>) || {}),
              allowAgents: subs,
            };
          } else {
            // Explicitly set empty allowAgents so the patch clears it
            // (deleting the key won't override during a config merge).
            agent.subagents = { allowAgents: [] };
          }
        }

        // Update display name shown in dashboard/config
        if ("displayName" in body) {
          const displayName = String(body.displayName || "").trim();
          if (displayName) agent.name = displayName;
          else delete agent.name;
        }

        // Update default marker
        if ("default" in body) {
          if (body.default === true) {
            agent.default = true;
            for (let i = 0; i < agentsList.length; i++) {
              if (i !== agentIdx) {
                const peer = agentsList[i] as Record<string, unknown>;
                if ("default" in peer) delete peer.default;
              }
            }
          } else if (body.default === false && agent.default === true) {
            delete agent.default;
          }
        }

        // Update bindings
        let nextBindings: Record<string, unknown>[] | undefined;
        if ("bindings" in body) {
          nextBindings = buildBindingsForAgent(id, body.bindings, parsed.bindings);
        }

        agentsList[agentIdx] = agent;
        const patch: Record<string, unknown> = {
          agents: { list: agentsList },
        };
        if (nextBindings) {
          patch.bindings = nextBindings;
        }
        await applyConfigPatchWithRetry(patch);

        return NextResponse.json({ ok: true, action: "update", id });
      }

      case "reorder": {
        const nextOrder = Array.isArray(body.agentIds)
          ? body.agentIds.map((v: unknown) => String(v || "").trim()).filter(Boolean)
          : [];
        if (nextOrder.length === 0) {
          return NextResponse.json(
            { error: "agentIds is required" },
            { status: 400 }
          );
        }

        const configData = await gatewayCallWithRetry<Record<string, unknown>>(
          "config.get",
          undefined,
          10000,
        );
        const parsed = asRecord(configData.parsed);
        const agentsSection = asRecord(parsed.agents);
        const agentsList = cloneConfigRows(agentsSection.list);
        if (agentsList.length === 0) {
          return NextResponse.json(
            { error: "No agents.list entries found in config to reorder." },
            { status: 400 }
          );
        }

        const byId = new Map<string, Record<string, unknown>>();
        for (const row of agentsList) {
          const id = String(row.id || "").trim();
          if (!id) continue;
          byId.set(id, row);
        }

        const seen = new Set<string>();
        const orderedRows: Record<string, unknown>[] = [];
        for (const id of nextOrder) {
          if (seen.has(id)) continue;
          const row = byId.get(id);
          if (!row) continue;
          seen.add(id);
          orderedRows.push(row);
        }
        for (const row of agentsList) {
          const id = String(row.id || "").trim();
          if (!id || seen.has(id)) continue;
          orderedRows.push(row);
        }

        try {
          await gatewayCallWithRetry<Record<string, unknown>>(
            "config.set",
            {
              path: "agents.list",
              value: orderedRows,
            },
            12000,
          );
        } catch {
          await applyConfigPatchWithRetry({
            agents: { list: orderedRows },
          });
        }
        return NextResponse.json({ ok: true, action: "reorder", count: orderedRows.length });
      }

      case "set-identity": {
        const id = String(body.id || "").trim();
        if (!id) {
          return NextResponse.json(
            { error: "Agent ID is required" },
            { status: 400 }
          );
        }

        const fromIdentity = body.fromIdentity === true;
        const identityFile = String(body.identityFile || "").trim();
        const explicitIdentity: Record<string, string> = {};
        const name = String(body.name || "").trim();
        if (name) explicitIdentity.name = name;
        const emoji = String(body.emoji || "").trim();
        if (emoji) explicitIdentity.emoji = emoji;
        const theme = String(body.theme || "").trim();
        if (theme) explicitIdentity.theme = theme;
        const avatar = String(body.avatar || "").trim();
        if (avatar) explicitIdentity.avatar = avatar;

        const nextIdentity: Record<string, string> = {};

        if (fromIdentity) {
          const workspace =
            String(body.workspace || "").trim() ||
            getDefaultWorkspaceSync();
          const identityPath = identityFile || join(workspace, "IDENTITY.md");
          const markdown = await readTextSafe(identityPath);
          if (!markdown) {
            return NextResponse.json(
              { error: "No IDENTITY.md found in this agent's workspace. Create one first, or set identity fields manually above." },
              { status: 400 },
            );
          }
          Object.assign(nextIdentity, extractIdentityFields(markdown));
        }

        Object.assign(nextIdentity, explicitIdentity);

        if (Object.keys(nextIdentity).length === 0) {
          return NextResponse.json(
            { error: "Provide identity fields or enable fromIdentity." },
            { status: 400 }
          );
        }

        const configData = await gatewayCallWithRetry<Record<string, unknown>>(
          "config.get",
          undefined,
          10000,
        );
        const parsed = asRecord(configData.parsed);
        const agentsSection = asRecord(parsed.agents);
        const agentsList = cloneConfigRows(agentsSection.list);
        let agentIdx = agentsList.findIndex((agent) => String(agent.id || "") === id);
        if (agentIdx === -1) {
          agentIdx = agentsList.length;
          agentsList.push({ id });
        }
        const agent = { ...agentsList[agentIdx] };
        agent.identity = {
          ...asRecord(agent.identity),
          ...nextIdentity,
        };
        agentsList[agentIdx] = agent;

        await applyConfigPatchWithRetry({
          agents: { list: agentsList },
        });

        return NextResponse.json({ ok: true, action, id, identity: nextIdentity });
      }

      case "save-identity-markdown": {
        const id = String(body.id || "").trim();
        const workspace = String(body.workspace || "").trim();
        const markdown = typeof body.markdown === "string" ? body.markdown : "";
        if (!id) {
          return NextResponse.json(
            { error: "Agent ID is required" },
            { status: 400 }
          );
        }
        if (!workspace) {
          return NextResponse.json(
            { error: "Workspace is required" },
            { status: 400 }
          );
        }
        const resolvedWorkspace = resolve(workspace);
        if (!resolvedWorkspace.startsWith(OPENCLAW_HOME)) {
          return NextResponse.json(
            { error: "Workspace path is outside OPENCLAW_HOME" },
            { status: 400 }
          );
        }
        const identityPath = join(resolvedWorkspace, "IDENTITY.md");
        await mkdir(dirname(identityPath), { recursive: true });
        await writeFile(identityPath, markdown, "utf-8");
        return NextResponse.json({
          ok: true,
          action,
          id,
          path: identityPath,
          bytes: Buffer.byteLength(markdown, "utf-8"),
        });
      }

      case "delete": {
        const id = String(body.id || "").trim();
        if (!id) {
          return NextResponse.json(
            { error: "Agent ID is required" },
            { status: 400 }
          );
        }

        try {
          const result = await gatewayCallWithRetry<Record<string, unknown>>(
            "agents.delete",
            { agentId: id },
            30000,
          );
          return NextResponse.json({ ok: true, action, id, ...result });
        } catch (error) {
          console.warn("Agent delete: gateway delete failed, falling back to CLI", error);
          const force = body.force !== false;
          const args = ["agents", "delete", id, "--json"];
          if (force) args.push("--force");
          const output = await runCli(args, 30000);
          let result: Record<string, unknown> = {};
          try {
            result = parseJsonFromCliOutput<Record<string, unknown>>(
              output,
              "openclaw agents delete --json"
            );
          } catch {
            result = { raw: output };
          }
          return NextResponse.json({ ok: true, action, id, fallback: "cli", ...result });
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("Agents API POST error:", err);
    const msg = String(err);
    // Make gateway errors user-friendly
    if (msg.includes("already exists") || msg.includes("Agent already")) {
      return NextResponse.json(
        { error: `An agent with this name already exists` },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
