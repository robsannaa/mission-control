import { gatewayCall } from "@/lib/openclaw";

export type GatewaySession = {
  key?: string | null;
  kind?: string | null;
  agentId?: string | null;
  sessionId?: string | null;
  updatedAt?: number | string | null;
  ageMs?: number | string | null;
  inputTokens?: number | string | null;
  outputTokens?: number | string | null;
  totalTokens?: number | string | null;
  totalTokensFresh?: boolean | null;
  contextTokens?: number | string | null;
  modelProvider?: string | null;
  model?: string | null;
  thinkingLevel?: string | null;
  systemSent?: boolean | null;
  abortedLastRun?: boolean | null;
  status?: string | null;
  hasActiveRun?: boolean | null;
  startedAt?: number | string | null;
  endedAt?: number | string | null;
  runtimeMs?: number | string | null;
  estimatedCostUsd?: number | string | null;
  lastActivityAt?: number | string | null;
  origin?: { label?: string | null } | null;
  [key: string]: unknown;
};

type SessionsListResult = {
  count?: number;
  sessions?: GatewaySession[];
};

export type NormalizedGatewaySession = {
  key: string;
  kind: string;
  agentId: string | null;
  sessionId: string;
  updatedAt: number;
  ageMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalTokensFresh: boolean;
  contextTokens: number;
  modelProvider?: string;
  fullModel: string;
  model: string;
  thinkingLevel?: string;
  systemSent: boolean;
  abortedLastRun: boolean;
  status?: string;
  hasActiveRun: boolean;
  startedAt: number;
  endedAt: number;
  runtimeMs: number;
  estimatedCostUsd: number | null;
  lastActivityAt: number;
  originLabel?: string;
};

export type AgentSessionSummary = {
  sessionCount: number;
  totalTokens: number;
  lastActive: number;
};

function toEpochMs(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return num < 1_000_000_000_000 ? Math.trunc(num * 1000) : Math.trunc(num);
}

function toNonNegativeNumber(value: unknown): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return num;
}

export function inferAgentIdFromSessionKey(key: string): string | null {
  if (!key) return null;
  if (key.startsWith("agent:")) {
    const parts = key.split(":");
    if (parts.length >= 2 && parts[1]) return parts[1];
  }
  return null;
}

function normalizeGatewaySession(
  session: GatewaySession,
  now: number
): NormalizedGatewaySession {
  const key = String(session.key || "");
  const explicitAgentId =
    typeof session.agentId === "string" && session.agentId.trim().length > 0
      ? session.agentId.trim()
      : null;
  const updatedAt = toEpochMs(session.updatedAt);
  const rawAgeMs = toNonNegativeNumber(session.ageMs);
  const ageMs = rawAgeMs > 0 ? rawAgeMs : updatedAt > 0 ? Math.max(0, now - updatedAt) : 0;
  const sessionId = String(session.sessionId || key || "");
  const modelProvider = session.modelProvider ? String(session.modelProvider) : undefined;
  const model = String(session.model || "unknown");
  const inputTokens = toNonNegativeNumber(session.inputTokens);
  const outputTokens = toNonNegativeNumber(session.outputTokens);
  // Probe common field names for cache tokens from the catch-all [key: string]: unknown
  const cacheReadTokens = toNonNegativeNumber(
    session.cacheReadTokens ?? session.cacheReadInputTokens ?? session.cache_read_input_tokens ?? 0,
  );
  const cacheWriteTokens = toNonNegativeNumber(
    session.cacheWriteTokens ?? session.cacheCreationInputTokens ?? session.cache_creation_input_tokens ?? 0,
  );
  const totalTokensRaw = toNonNegativeNumber(session.totalTokens);
  // sessions.list may omit totalTokens while still exposing input/output.
  const totalTokens = totalTokensRaw > 0 ? totalTokensRaw : inputTokens + outputTokens;
  const fullModel = model.includes("/")
    ? model
    : modelProvider
      ? `${modelProvider}/${model}`
      : model;
  return {
    key,
    kind: String(session.kind || "direct"),
    agentId: explicitAgentId || inferAgentIdFromSessionKey(key),
    sessionId,
    updatedAt,
    ageMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    totalTokensFresh: Boolean(session.totalTokensFresh),
    contextTokens: toNonNegativeNumber(session.contextTokens),
    modelProvider,
    fullModel,
    model,
    thinkingLevel: session.thinkingLevel ? String(session.thinkingLevel) : undefined,
    systemSent: Boolean(session.systemSent),
    abortedLastRun: Boolean(session.abortedLastRun),
    status: session.status ? String(session.status) : undefined,
    hasActiveRun: Boolean(session.hasActiveRun),
    startedAt: toEpochMs(session.startedAt),
    endedAt: toEpochMs(session.endedAt),
    runtimeMs: toNonNegativeNumber(session.runtimeMs),
    estimatedCostUsd:
      session.estimatedCostUsd === null || session.estimatedCostUsd === undefined
        ? null
        : toNonNegativeNumber(session.estimatedCostUsd),
    lastActivityAt: toEpochMs(session.lastActivityAt),
    originLabel: session.origin?.label ? String(session.origin.label) : undefined,
  };
}

export async function fetchGatewaySessions(timeout = 12000): Promise<NormalizedGatewaySession[]> {
  const data = await gatewayCall<SessionsListResult>("sessions.list", undefined, timeout);
  const now = Date.now();
  const raw = Array.isArray(data.sessions) ? data.sessions : [];
  return raw
    .map((session) => normalizeGatewaySession(session, now))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function summarizeSessionsByAgent(
  sessions: NormalizedGatewaySession[]
): Map<string, AgentSessionSummary> {
  const out = new Map<string, AgentSessionSummary>();
  for (const session of sessions) {
    if (!session.agentId) continue;
    const prev = out.get(session.agentId) || {
      sessionCount: 0,
      totalTokens: 0,
      lastActive: 0,
    };
    prev.sessionCount += 1;
    prev.totalTokens += session.totalTokens;
    if (session.updatedAt > prev.lastActive) prev.lastActive = session.updatedAt;
    out.set(session.agentId, prev);
  }
  return out;
}
