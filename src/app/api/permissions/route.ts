import { NextResponse } from "next/server";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { gatewayCall, runCli, runCliJson } from "@/lib/openclaw";
import { gatewayConfigPatch } from "@/lib/gateway-config";
import { withRoute } from "@/lib/api-route";
import { badRequest } from "@/lib/api-errors";
import { permissionsPostSchema } from "@/lib/schemas/system";

export const dynamic = "force-dynamic";

type RawAllowlistEntry = {
  id?: string;
  pattern?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

type ScopeConfig = {
  allowlist?: RawAllowlistEntry[] | string[];
  security?: string;
  ask?: string;
  askFallback?: string;
  autoAllowSkills?: boolean;
};

type ApprovalsFile = {
  version?: number;
  socket?: {
    path?: string;
    token?: string;
  };
  defaults?: ScopeConfig;
  agents?: Record<string, ScopeConfig>;
};

type ApprovalsSnapshot = {
  path?: string;
  exists?: boolean;
  hash?: string;
  file?: ApprovalsFile;
};

type SandboxExplain = {
  docsUrl?: string;
  agentId?: string;
  sessionKey?: string;
  sandbox?: {
    mode?: string;
    scope?: string;
    perSession?: boolean;
    workspaceAccess?: string;
    workspaceRoot?: string;
    sessionIsSandboxed?: boolean;
    tools?: {
      allow?: string[];
      deny?: string[];
      sources?: {
        allow?: { source?: string; key?: string };
        deny?: { source?: string; key?: string };
      };
    };
  };
  elevated?: {
    enabled?: boolean;
    allowedByConfig?: boolean;
    alwaysAllowedByConfig?: boolean;
    allowFrom?: Record<string, unknown>;
    failures?: string[];
  };
  fixIt?: string[];
};

type AllowlistEntry = {
  agentId: string;
  pattern: string;
  id?: string;
  lastUsedAt?: number;
  lastUsedCommand?: string;
  lastResolvedPath?: string;
};

type ExecPolicyScope = {
  scope: "defaults" | "agent";
  agentId?: string;
  security?: string;
  ask?: string;
  askFallback?: string;
  autoAllowSkills?: boolean;
  allowlistCount: number;
};

type CapabilityFlag = {
  id: string;
  label: string;
  allowed: boolean;
  tools: string[];
  reason: string;
};

// Derived from docs: https://docs.openclaw.ai/gateway/protocol#tool-groups
const TOOL_GROUPS: Record<string, string[]> = {
  "group:runtime": ["exec", "bash", "process"],
  "group:filesystem": ["read", "write", "edit", "apply_patch", "image"],
  "group:session": [
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "subagents",
  ],
  "group:memory": ["memories_list", "memories_get"],
  "group:ui": ["browser", "canvas"],
  "group:automation": ["gateway", "cron"],
  "group:messaging": ["message"],
  "group:nodes": ["nodes"],
  "group:openclaw": [
    "exec",
    "bash",
    "process",
    "read",
    "write",
    "edit",
    "apply_patch",
    "image",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "session_status",
    "subagents",
    "memories_list",
    "memories_get",
    "browser",
    "canvas",
    "gateway",
    "cron",
    "message",
    "nodes",
  ],
};

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseLooseJson<T>(raw: string): T | null {
  const clean = stripAnsi(raw).trim();
  const startObj = clean.indexOf("{");
  const startArr = clean.indexOf("[");
  const starts = [startObj, startArr].filter((n) => n >= 0).sort((a, b) => a - b);
  if (!starts.length) return null;
  const sliced = clean.slice(starts[0]);
  try {
    return JSON.parse(sliced) as T;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function uniqSorted(values: unknown): string[] {
  return [...new Set(asArray(values).map((v) => String(v).trim()).filter(Boolean))].sort();
}

function normalizeAllowlistEntries(agentId: string, raw: unknown): AllowlistEntry[] {
  return asArray(raw)
    .map((item) => {
      if (typeof item === "string") return { pattern: item } satisfies RawAllowlistEntry;
      if (item && typeof item === "object") return item as RawAllowlistEntry;
      return null;
    })
    .filter((v): v is RawAllowlistEntry => Boolean(v?.pattern))
    .map((v) => ({
      agentId,
      pattern: String(v.pattern || ""),
      id: v.id ? String(v.id) : undefined,
      lastUsedAt: typeof v.lastUsedAt === "number" ? v.lastUsedAt : undefined,
      lastUsedCommand: v.lastUsedCommand ? String(v.lastUsedCommand) : undefined,
      lastResolvedPath: v.lastResolvedPath ? String(v.lastResolvedPath) : undefined,
    }));
}

function buildAllowlistEntries(file: ApprovalsFile | undefined): AllowlistEntry[] {
  if (!file) return [];
  const out: AllowlistEntry[] = [];
  out.push(...normalizeAllowlistEntries("*", file.defaults?.allowlist));
  for (const [agentId, cfg] of Object.entries(file.agents || {})) {
    out.push(...normalizeAllowlistEntries(agentId, cfg.allowlist));
  }
  out.sort((a, b) => {
    if (a.agentId !== b.agentId) return a.agentId.localeCompare(b.agentId);
    return a.pattern.localeCompare(b.pattern);
  });
  return out;
}

function redactApprovalsSnapshot(snapshot: ApprovalsSnapshot): ApprovalsSnapshot {
  const clone = structuredClone(snapshot);
  if (clone.file?.socket?.token) clone.file.socket.token = "••••••••";
  return clone;
}

function buildExecPolicies(file: ApprovalsFile | undefined): ExecPolicyScope[] {
  if (!file) return [];
  const out: ExecPolicyScope[] = [];
  const defaults = file.defaults || {};
  out.push({
    scope: "defaults",
    security: defaults.security,
    ask: defaults.ask,
    askFallback: defaults.askFallback,
    autoAllowSkills: defaults.autoAllowSkills,
    allowlistCount: normalizeAllowlistEntries("*", defaults.allowlist).length,
  });
  for (const [agentId, cfg] of Object.entries(file.agents || {})) {
    out.push({
      scope: "agent",
      agentId,
      security: cfg.security,
      ask: cfg.ask,
      askFallback: cfg.askFallback,
      autoAllowSkills: cfg.autoAllowSkills,
      allowlistCount: normalizeAllowlistEntries(agentId, cfg.allowlist).length,
    });
  }
  return out;
}

function expandConfiguredTools(rawTools: string[]): Set<string> {
  const out = new Set<string>();
  for (const toolRaw of rawTools) {
    const tool = toolRaw.toLowerCase();
    out.add(tool);
    if (tool.startsWith("group:")) {
      for (const member of TOOL_GROUPS[tool] || []) out.add(member);
    }
  }
  return out;
}

function capabilityModel(
  sandbox: SandboxExplain["sandbox"],
  elevated: SandboxExplain["elevated"],
  allowlist: AllowlistEntry[],
  file: ApprovalsFile | undefined
) {
  const allowConfigured = uniqSorted(sandbox?.tools?.allow).map((v) => v.toLowerCase());
  const denyConfigured = uniqSorted(sandbox?.tools?.deny).map((v) => v.toLowerCase());
  const allowExpanded = expandConfiguredTools(allowConfigured);
  const denyExpanded = expandConfiguredTools(denyConfigured);
  const allowMode = allowConfigured.length > 0 ? "allowlist" : "open-denylist";

  const isToolAllowed = (tool: string): boolean => {
    const t = tool.toLowerCase();
    if (denyExpanded.has("*") || denyExpanded.has(t)) return false;
    if (allowMode === "open-denylist") return true;
    return allowExpanded.has("*") || allowExpanded.has(t);
  };

  const evaluateFlag = (id: string, label: string, tools: string[]): CapabilityFlag => {
    const allowedCount = tools.filter((t) => isToolAllowed(t)).length;
    if (allowedCount === tools.length) {
      return {
        id,
        label,
        tools,
        allowed: true,
        reason:
          tools.length === 1
            ? `${tools[0]} is currently allowed by sandbox policy.`
            : `All ${tools.length} tools in this group are currently allowed.`,
      };
    }
    if (allowedCount > 0) {
      return {
        id,
        label,
        tools,
        allowed: true,
        reason: `${allowedCount}/${tools.length} tools in this group are currently allowed.`,
      };
    }
    return {
      id,
      label,
      tools,
      allowed: false,
      reason:
        allowMode === "allowlist"
          ? "None of these tools are included in the current sandbox allowlist."
          : "All tools in this group are currently denied by sandbox policy.",
    };
  };

  const flags: CapabilityFlag[] = [
    evaluateFlag("runtime", "Runtime Command Tools", TOOL_GROUPS["group:runtime"] || []),
    evaluateFlag("filesystem", "Filesystem Mutation Tools", ["write", "edit", "apply_patch"]),
    evaluateFlag("sessions", "Session Control Tools", TOOL_GROUPS["group:session"] || []),
    evaluateFlag("messaging", "Messaging Tool", TOOL_GROUPS["group:messaging"] || []),
    evaluateFlag("automation", "Gateway/Cron Tools", TOOL_GROUPS["group:automation"] || []),
  ];

  flags.push({
    id: "elevated",
    label: "Elevated Exec Gate",
    tools: ["tools.elevated.enabled"],
    allowed: Boolean(elevated?.enabled),
    reason: elevated?.enabled
      ? "Elevated execution is enabled."
      : "Elevated execution is disabled.",
  });

  return {
    sandboxMode: sandbox?.mode || "unknown",
    sessionIsSandboxed: Boolean(sandbox?.sessionIsSandboxed),
    workspaceAccess: sandbox?.workspaceAccess || "unknown",
    toolPolicyMode: allowMode,
    allowedToolsConfigured: allowConfigured,
    deniedToolsConfigured: denyConfigured,
    flags,
    allowlistCount: allowlist.length,
    policyScopeCount: buildExecPolicies(file).length,
  };
}

async function readSnapshot() {
  const [approvals, sandbox] = await Promise.all([
    runCliJson<ApprovalsSnapshot>(["approvals", "get"], 12000),
    runCliJson<SandboxExplain>(["sandbox", "explain"], 12000),
  ]);

  const sanitizedApprovals = redactApprovalsSnapshot(approvals);
  const allowlist = buildAllowlistEntries(sanitizedApprovals.file);
  const execPolicies = buildExecPolicies(sanitizedApprovals.file);
  const capabilities = capabilityModel(
    sandbox.sandbox,
    sandbox.elevated,
    allowlist,
    sanitizedApprovals.file
  );

  return {
    ts: Date.now(),
    approvals: sanitizedApprovals,
    allowlist,
    execPolicies,
    sandbox,
    capabilities,
  };
}

function cliError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function mutateAllowlist(action: "add" | "remove", agentId: string, pattern: string) {
  const args = [
    "approvals",
    "allowlist",
    action,
    "--json",
    "--agent",
    agentId || "*",
    pattern,
  ];
  const raw = await runCli(args, 12000);
  const parsed = parseLooseJson<ApprovalsSnapshot>(raw);
  if (!parsed) {
    throw new Error(`Failed to parse CLI response for ${action} allowlist.`);
  }
  return redactApprovalsSnapshot(parsed);
}

const VALID_SECURITY = ["deny", "allowlist", "full"] as const;
const VALID_ASK = ["off", "on-miss", "always"] as const;
const VALID_ASK_FALLBACK = ["deny", "allowlist", "full"] as const;

async function setApprovalsDefaults(updates: { security?: string; ask?: string; askFallback?: string }) {
  const raw = await runCliJson<ApprovalsSnapshot>(["approvals", "get"], 12000);
  const file = raw?.file;
  if (!file) throw new Error("No approvals file in response.");
  const defaults = { ...file.defaults } as ScopeConfig;
  if (updates.security !== undefined) {
    if (!VALID_SECURITY.includes(updates.security as (typeof VALID_SECURITY)[number])) {
      throw new Error(`Invalid security: ${updates.security}. Use: ${VALID_SECURITY.join(", ")}`);
    }
    defaults.security = updates.security;
  }
  if (updates.ask !== undefined) {
    if (!VALID_ASK.includes(updates.ask as (typeof VALID_ASK)[number])) {
      throw new Error(`Invalid ask: ${updates.ask}. Use: ${VALID_ASK.join(", ")}`);
    }
    defaults.ask = updates.ask;
  }
  if (updates.askFallback !== undefined) {
    if (!VALID_ASK_FALLBACK.includes(updates.askFallback as (typeof VALID_ASK_FALLBACK)[number])) {
      throw new Error(`Invalid askFallback: ${updates.askFallback}. Use: ${VALID_ASK_FALLBACK.join(", ")}`);
    }
    defaults.askFallback = updates.askFallback;
  }
  const next: ApprovalsFile = {
    ...file,
    defaults,
  };
  const tmpPath = join(tmpdir(), `exec-approvals-${Date.now()}.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf-8");
    await runCli(["approvals", "set", "--file", tmpPath], 12000);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

/**
 * GET /api/permissions — exec-approval and elevated-tool policy snapshot.
 *
 * Deliberately never returns an error status: on a CLI/gateway failure it
 * serves a minimal, explicitly-degraded snapshot instead (`degraded: true`),
 * so the dashboard stays usable while the instance is unreachable. Kept as
 * an internal try/catch (not thrown) so `withRoute`'s own catch never sees
 * this failure and never converts it into a 500.
 */
export const GET = withRoute({ name: "/api/permissions" }, async (_request, { log }) => {
  try {
    const snapshot = await readSnapshot();
    return NextResponse.json(snapshot);
  } catch (err) {
    log.warn({ err: cliError(err) }, "Permissions snapshot unavailable — returning degraded payload");
    return NextResponse.json({
      ts: Date.now(),
      approvals: {},
      allowlist: [],
      execPolicies: [],
      sandbox: {
        sandbox: {
          mode: "unknown",
          workspaceAccess: "unknown",
          sessionIsSandboxed: false,
          tools: { allow: [], deny: [] },
        },
        elevated: { enabled: false },
      },
      capabilities: {
        sandboxMode: "unknown",
        sessionIsSandboxed: false,
        workspaceAccess: "unknown",
        toolPolicyMode: "allowlist",
        allowedToolsConfigured: [],
        deniedToolsConfigured: [],
        flags: [],
        allowlistCount: 0,
        policyScopeCount: 0,
      },
      warning: cliError(err),
      degraded: true,
    });
  }
});

/**
 * POST /api/permissions — exec-approval and elevated-tool policy writes.
 *
 * `permissionsPostSchema` rejects an unrecognized `action` (and any known
 * action's malformed shape) before this handler ever runs, so no policy
 * write is reached on a bad payload (T-02-44). Every error path below
 * returns through an `@/lib/api-errors` builder, so every error body
 * carries `ok: false` (D-01). A thrown error from `mutateAllowlist` /
 * `gatewayConfigPatch` / `setApprovalsDefaults` (e.g. an invalid
 * security/ask/askFallback enum value) is left to `withRoute`'s own catch,
 * which preserves the pre-migration 500 status and message text exactly
 * (D-06 — existing status codes are preserved as-is in this phase, even
 * though a 400 would arguably fit an invalid-enum-value case better).
 */
export const POST = withRoute(
  { name: "/api/permissions", bodySchema: permissionsPostSchema },
  async (_request, { body }) => {
    if (body.action === "allow-pattern" || body.action === "revoke-pattern") {
      const pattern = String(body.pattern || "").trim();
      const agentId = String(body.agentId || "*").trim() || "*";
      if (!pattern) {
        return badRequest("pattern is required");
      }
      await mutateAllowlist(body.action === "allow-pattern" ? "add" : "remove", agentId, pattern);
      const snapshot = await readSnapshot();
      return NextResponse.json({ ok: true, action: body.action, snapshot });
    }

    if (body.action === "set-elevated") {
      const enabled = Boolean(body.enabled);
      const cfg = await gatewayCall<{ hash?: string }>("config.get", undefined, 12000);
      const baseHash = String(cfg.hash || "");
      await gatewayConfigPatch(
        {
          raw: JSON.stringify({ tools: { elevated: { enabled } } }),
          baseHash,
        },
        12000,
      );
      const snapshot = await readSnapshot();
      return NextResponse.json({
        ok: true,
        action: body.action,
        enabled,
        restartRecommended: true,
        snapshot,
      });
    }

    // action === "set-approvals-defaults" — the only remaining variant of
    // `permissionsPostSchema`'s discriminated union.
    const security = body.security !== undefined ? String(body.security).trim() : undefined;
    const ask = body.ask !== undefined ? String(body.ask).trim() : undefined;
    const askFallback = body.askFallback !== undefined ? String(body.askFallback).trim() : undefined;
    if (!security && !ask && !askFallback) {
      return badRequest("At least one of security, ask, askFallback is required");
    }
    await setApprovalsDefaults({ security, ask, askFallback });
    const snapshot = await readSnapshot();
    return NextResponse.json({ ok: true, action: body.action, snapshot });
  },
);
