import { NextResponse } from "next/server";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { getOpenClawHome, getSystemSkillsDir, getDefaultWorkspaceSync, readConfigFile } from "@/lib/paths";
import { fetchGatewaySessions, type NormalizedGatewaySession } from "@/lib/gateway-sessions";
import { withRoute } from "@/lib/api-route";
import { serverError } from "@/lib/api-errors";

const OPENCLAW_HOME = getOpenClawHome();
export const dynamic = "force-dynamic";
const SYSTEM_CACHE_TTL_MS = 5000;

type AgentInfo = {
  id: string;
  name: string;
  workspace: string;
  model: string;
  fallbacks: string[];
  sessionCount: number;
  totalTokens: number;
  recentSessions: {
    key: string;
    updatedAt: number;
    totalTokens: number;
    origin?: string;
  }[];
};

type DeviceInfo = {
  deviceId: string;
  displayName?: string;
  platform: string;
  clientId: string;
  clientMode: string;
  role: string;
  roles: string[];
  lastUsedAt: number;
  createdAt: number;
};

type ChannelInfo = {
  name: string;
  enabled: boolean;
  accounts: string[];
  dmPolicy: string;
  groupPolicy?: string;
};

type SkillInfo = {
  name: string;
  source: "workspace" | "system";
  version?: string;
  description?: string;
  installedAt?: number;
};

type SessionInfo = {
  key: string;
  sessionId: string;
  updatedAt: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  origin?: string;
  agentId: string;
};

type SystemPayload = {
  agents: AgentInfo[];
  channels: ChannelInfo[];
  devices: DeviceInfo[];
  skills: SkillInfo[];
  sessions: SessionInfo[];
  gateway: {
    port: string | number;
    mode: string;
    version: string;
    /** Auth mode: token | password (from gateway.auth.mode). No value = auth not configured. */
    authMode?: "token" | "password";
    /** True if gateway.auth.token is set (value never sent). */
    tokenConfigured?: boolean;
    /** gateway.auth.allowTailscale (Tailscale clients can connect without token). */
    allowTailscale?: boolean;
  };
  models: { id: string; alias?: string }[];
  stats: {
    totalAgents: number;
    totalSessions: number;
    totalTokens: number;
    totalDevices: number;
    totalSkills: number;
    totalChannels: number;
    cronJobs: number;
  };
};

let systemCache: { payload: SystemPayload; expiresAt: number } | null = null;
let systemInFlight: Promise<SystemPayload> | null = null;

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function getAgents(
  config: Record<string, unknown>,
  sessionsByAgent: Map<string, NormalizedGatewaySession[]>
): Promise<AgentInfo[]> {
  const agents: AgentInfo[] = [];
  const agentsConfig = (config.agents || {}) as Record<string, unknown>;
  const defaults = (agentsConfig.defaults || {}) as Record<string, unknown>;
  const list = ((agentsConfig.list || []) as Record<string, unknown>[]);
  const listById = new Map<string, Record<string, unknown>>();
  for (const row of list) {
    const id = String(row.id || "").trim();
    if (id) listById.set(id, row);
  }

  const defaultModel = defaults.model as Record<string, unknown> | undefined;
  const defaultPrimary =
    (defaultModel?.primary as string) || "unknown";
  const defaultFallbacks =
    (defaultModel?.fallbacks as string[]) || [];
  const defaultWorkspace =
    (defaults.workspace as string) || getDefaultWorkspaceSync();

  const agentIds = new Set<string>([
    ...listById.keys(),
    ...sessionsByAgent.keys(),
  ]);
  // OpenClaw defaults to a "main" agent even when agents.list is omitted.
  if (agentIds.size === 0) {
    agentIds.add("main");
  } else if (!agentIds.has("main")) {
    agentIds.add("main");
  }

  for (const id of agentIds) {
    const agent = listById.get(id) || {};
    const name = (agent.name as string) || id;
    const agentModel = agent.model as Record<string, unknown> | undefined;
    const model = (agentModel?.primary as string) || defaultPrimary;
    const fallbacks =
      (agentModel?.fallbacks as string[]) || defaultFallbacks;
    const workspace =
      (agent.workspace as string) || defaultWorkspace;

    // Session stats from gateway source of truth.
    const agentSessions = sessionsByAgent.get(id) || [];
    const sessionCount = agentSessions.length;
    const totalTokens = agentSessions.reduce((sum, s) => sum + s.totalTokens, 0);
    const recentSessions: AgentInfo["recentSessions"] = agentSessions
      .map((s) => ({
        key: s.key,
        updatedAt: s.updatedAt,
        totalTokens: s.totalTokens,
        origin: s.originLabel,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    agents.push({
      id,
      name,
      workspace,
      model,
      fallbacks,
      sessionCount,
      totalTokens,
      recentSessions: recentSessions.slice(0, 10),
    });
  }

  agents.sort((a, b) => {
    if (a.id === "main" && b.id !== "main") return -1;
    if (a.id !== "main" && b.id === "main") return 1;
    return a.name.localeCompare(b.name);
  });

  return agents;
}

async function getChannels(
  config: Record<string, unknown>
): Promise<ChannelInfo[]> {
  const channels: ChannelInfo[] = [];
  const channelsConfig = (config.channels || {}) as Record<
    string,
    Record<string, unknown>
  >;

  for (const [name, ch] of Object.entries(channelsConfig)) {
    const accounts = ["default"];
    if (ch.accounts && typeof ch.accounts === "object") {
      accounts.push(...Object.keys(ch.accounts as Record<string, unknown>));
    }
    channels.push({
      name,
      enabled: (ch.enabled as boolean) !== false,
      accounts,
      dmPolicy: (ch.dmPolicy as string) || "pairing",
      groupPolicy: ch.groupPolicy as string,
    });
  }

  return channels;
}

async function getDevices(): Promise<DeviceInfo[]> {
  const pairedPath = join(OPENCLAW_HOME, "devices", "paired.json");
  const data = await readJsonSafe<Record<string, Record<string, unknown>>>(
    pairedPath,
    {}
  );

  return Object.values(data).map((d) => {
    // Find most recent token usage
    let lastUsedAt = 0;
    const tokens = (d.tokens || {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const t of Object.values(tokens)) {
      const lu = (t.lastUsedAtMs as number) || 0;
      if (lu > lastUsedAt) lastUsedAt = lu;
    }

    return {
      deviceId: ((d.deviceId as string) || "").substring(0, 12) + "...",
      displayName: d.displayName as string,
      platform: (d.platform as string) || "unknown",
      clientId: (d.clientId as string) || "unknown",
      clientMode: (d.clientMode as string) || "unknown",
      role: (d.role as string) || "unknown",
      roles: (d.roles as string[]) || [],
      lastUsedAt,
      createdAt: (d.createdAtMs as number) || 0,
    };
  });
}

async function getSkills(): Promise<SkillInfo[]> {
  const skills: SkillInfo[] = [];

  // Workspace skills from lock.json
  const lockPath = join(
    OPENCLAW_HOME,
    "workspace",
    ".clawhub",
    "lock.json"
  );
  const lockData = await readJsonSafe<{
    skills?: Record<string, { version?: string; installedAt?: number }>;
  }>(lockPath, {});
  if (lockData.skills) {
    for (const [name, info] of Object.entries(lockData.skills)) {
      skills.push({
        name,
        source: "workspace",
        version: info.version,
        installedAt: info.installedAt,
      });
    }
  }

  // Also check workspace/skills directory for local skills
  const wsSkillsDir = join(getDefaultWorkspaceSync(), "skills");
  try {
    const entries = await readdir(wsSkillsDir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !skills.find((s) => s.name === e.name)) {
        skills.push({ name: e.name, source: "workspace" });
      }
    }
  } catch {
    // skills dir may not exist
  }

  // System skills
  try {
    const sysSkillsPath = await getSystemSkillsDir();
    const entries = await readdir(sysSkillsPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        skills.push({ name: e.name, source: "system" });
      }
    }
  } catch {
    // system skills dir may not exist
  }

  return skills;
}

function toSessionInfo(sessions: NormalizedGatewaySession[]): SessionInfo[] {
  return sessions
    .map((s) => ({
      key: s.key,
      sessionId: s.sessionId || s.key,
      updatedAt: s.updatedAt,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      totalTokens: s.totalTokens,
      contextTokens: s.contextTokens,
      origin: s.originLabel,
      agentId: s.agentId || "unknown",
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export const GET = withRoute({ name: "/api/system" }, async (_request, { log }) => {
  try {
    const now = Date.now();
    if (systemCache && now < systemCache.expiresAt) {
      return NextResponse.json(systemCache.payload);
    }
    if (systemInFlight) {
      return NextResponse.json(await systemInFlight);
    }

    systemInFlight = (async () => {
      const config = await readConfigFile();

      const gatewaySessions = await fetchGatewaySessions(10000).catch(() => []);
      const sessions = toSessionInfo(gatewaySessions);
      const sessionsByAgent = new Map<string, NormalizedGatewaySession[]>();
      for (const s of gatewaySessions) {
        const id = String(s.agentId || "").trim();
        if (!id || id === "unknown") continue;
        const existing = sessionsByAgent.get(id) || [];
        existing.push(s);
        sessionsByAgent.set(id, existing);
      }

      const [agents, channels, devices, skills] = await Promise.all([
        getAgents(config, sessionsByAgent),
        getChannels(config),
        getDevices(),
        getSkills(),
      ]);

      // Extract safe config info (NO secrets)
      const gateway = (config.gateway || {}) as Record<string, unknown>;
      const auth = (gateway.auth || {}) as Record<string, unknown>;
      const meta = (config.meta || {}) as Record<string, unknown>;
      const gatewayPort = typeof gateway.port === "number" || typeof gateway.port === "string"
        ? gateway.port
        : 18789;
      const authMode = auth.mode === "password" ? "password" : auth.mode === "token" ? "token" : undefined;
      const tokenConfigured = typeof auth.token === "string" && auth.token.trim().length > 0;
      const allowTailscale = auth.allowTailscale !== false;

      const payload: SystemPayload = {
        agents,
        channels,
        devices,
        skills,
        sessions: sessions.slice(0, 100), // Limit to 100 most recent
        gateway: {
          port: gatewayPort,
          mode: (gateway.mode as string) || "local",
          version: (meta.lastTouchedVersion as string) || "unknown",
          authMode,
          tokenConfigured,
          allowTailscale,
        },
        models: extractModelAliases(config),
        stats: {
          totalAgents: agents.length,
          totalSessions: sessions.length,
          totalTokens: sessions.reduce((sum, s) => sum + s.totalTokens, 0),
          totalDevices: devices.length,
          totalSkills: skills.length,
          totalChannels: channels.length,
          cronJobs: 0, // Fetched separately via /api/cron
        },
      };

      systemCache = {
        payload,
        expiresAt: Date.now() + SYSTEM_CACHE_TTL_MS,
      };
      return payload;
    })();

    try {
      return NextResponse.json(await systemInFlight);
    } finally {
      systemInFlight = null;
    }
  } catch (err) {
    log.error({ err: String(err) }, "System API error");
    return serverError(String(err));
  }
});

function extractModelAliases(
  config: Record<string, unknown>
): { id: string; alias?: string }[] {
  const agents = (config.agents || {}) as Record<string, unknown>;
  const defaults = (agents.defaults || {}) as Record<string, unknown>;
  const models = (defaults.models || {}) as Record<
    string,
    { alias?: string }
  >;
  return Object.entries(models).map(([id, info]) => ({
    id,
    alias: info.alias,
  }));
}
