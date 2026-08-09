/**
 * Local skill inventory via the Gateway `skills.status` RPC.
 *
 * `skills.status` (scope `operator.read`) returns one row per installed skill,
 * and each row carries the same fields as `openclaw skills info <name> --json`
 * — a superset of `skills list`. So a single call answers the list view, the
 * check view and every detail view, where the CLI needs one subprocess per
 * view (~2.5s each) and one more per skill opened.
 *
 * Note `skills.detail` and `skills.search` are *not* the detail/list methods
 * for installed skills: both query the remote ClawHub registry and return
 * publishing metadata (owner, downloads, moderation verdict). They are keyed by
 * `slug`, not `name`. `/api/skills/clawhub` is the route that wants those.
 */

import { gatewayCall, runCliJson } from "./openclaw";

export type SkillRequirements = {
  bins: string[];
  anyBins: string[];
  env: string[];
  config: string[];
  os: string[];
};

export type SkillStatusRow = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath?: string;
  baseDir?: string;
  skillKey?: string;
  emoji?: string;
  homepage?: string;
  always?: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter?: boolean;
  eligible: boolean;
  platformIncompatible?: boolean;
  modelVisible?: boolean;
  userInvocable?: boolean;
  commandVisible?: boolean;
  primaryEnv?: string;
  requirements?: SkillRequirements;
  missing?: SkillRequirements;
  configChecks?: unknown[];
  install?: { id: string; kind: string; label: string; bins?: string[] }[];
};

export type SkillsStatus = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  skills: SkillStatusRow[];
};

const EMPTY_REQUIREMENTS: SkillRequirements = {
  bins: [],
  anyBins: [],
  env: [],
  config: [],
  os: [],
};

function normalizeRequirements(value: unknown): SkillRequirements {
  if (!value || typeof value !== "object") return { ...EMPTY_REQUIREMENTS };
  const record = value as Record<string, unknown>;
  const list = (key: keyof SkillRequirements): string[] =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).map(String) : [];
  return {
    bins: list("bins"),
    anyBins: list("anyBins"),
    env: list("env"),
    config: list("config"),
    os: list("os"),
  };
}

function normalizeStatus(payload: Partial<SkillsStatus> | null): SkillsStatus {
  const skills = Array.isArray(payload?.skills) ? payload.skills : [];
  return {
    workspaceDir: String(payload?.workspaceDir || ""),
    managedSkillsDir: String(payload?.managedSkillsDir || ""),
    agentId: payload?.agentId,
    skills: skills
      .filter((row) => row && typeof row === "object")
      .map((row) => ({
        ...row,
        name: String(row?.name || ""),
        description: String(row?.description || ""),
        source: String(row?.source || "workspace"),
        bundled: Boolean(row?.bundled),
        disabled: Boolean(row?.disabled),
        blockedByAllowlist: Boolean(row?.blockedByAllowlist),
        eligible: Boolean(row?.eligible),
        requirements: normalizeRequirements(row?.requirements),
        missing: normalizeRequirements(row?.missing),
      })),
  };
}

/**
 * Fetch the skill inventory for one agent (the default agent when omitted).
 *
 * `agentId` must be a real id from `agents.list` — the gateway rejects an
 * unknown one outright rather than falling back to the default.
 */
export async function fetchSkillsStatus(
  agentId?: string,
  timeout = 15_000,
): Promise<SkillsStatus> {
  const payload = await gatewayCall<Partial<SkillsStatus>>(
    "skills.status",
    agentId ? { agentId } : {},
    timeout,
  );
  return normalizeStatus(payload);
}

/**
 * Same inventory via `openclaw skills list --json`. Rows lack the detail-only
 * fields (`filePath`, `requirements`, `install`, …), so this is a fallback for
 * the list and check views rather than an equivalent source.
 */
export async function fetchSkillsStatusViaCli(
  agentId?: string,
  timeout = 20_000,
): Promise<SkillsStatus> {
  const args = ["skills", "list"];
  if (agentId) args.push("--agent", agentId);
  return normalizeStatus(await runCliJson<Partial<SkillsStatus>>(args, timeout));
}

/**
 * Inventory from whichever source answers, preferring the RPC. Reports which
 * one won so callers can tell a full snapshot from a list-only one.
 */
export async function loadSkillsInventory(
  agentId?: string,
): Promise<{ status: SkillsStatus; source: "rpc" | "cli"; warning?: string }> {
  try {
    return { status: await fetchSkillsStatus(agentId), source: "rpc" };
  } catch (rpcErr) {
    const status = await fetchSkillsStatusViaCli(agentId);
    return {
      status,
      source: "cli",
      warning: `skills.status RPC unavailable (${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}); used the CLI instead.`,
    };
  }
}

function hasMissing(missing: SkillRequirements): boolean {
  return (
    missing.bins.length > 0 ||
    missing.anyBins.length > 0 ||
    missing.env.length > 0 ||
    missing.config.length > 0 ||
    missing.os.length > 0
  );
}

/**
 * Shape of `openclaw skills check --json` as of OpenClaw 2026.7.
 *
 * `missingRequirements[].missing` is a requirements object, not the flat string
 * list older versions returned, and `agentFiltered` / `notInjected` /
 * `modelVisible` / `commandVisible` are newer buckets.
 */
export type SkillsCheckPayload = {
  agentId?: string;
  workspaceDir: string;
  managedSkillsDir: string;
  summary: {
    total: number;
    eligible: number;
    modelVisible: number;
    commandVisible: number;
    disabled: number;
    blocked: number;
    agentFiltered: number;
    notInjected: number;
    missingRequirements: number;
  };
  eligible: string[];
  modelVisible: string[];
  commandVisible: string[];
  disabled: string[];
  blocked: string[];
  agentFiltered: string[];
  notInjected: string[];
  missingRequirements: {
    name: string;
    missing: SkillRequirements;
    install: SkillStatusRow["install"];
  }[];
};

/**
 * Derive the check view from a status snapshot instead of asking for it.
 *
 * The CLI computes these buckets from the same per-skill fields the snapshot
 * already carries, so this saves a second call. The buckets are independent,
 * matching the CLI: a disabled skill with a missing binary appears in both
 * `disabled` and `missingRequirements`.
 */
export function deriveSkillsCheck(status: SkillsStatus): SkillsCheckPayload {
  const eligible: string[] = [];
  const modelVisible: string[] = [];
  const commandVisible: string[] = [];
  const disabled: string[] = [];
  const blocked: string[] = [];
  const agentFiltered: string[] = [];
  const notInjected: string[] = [];
  const missingRequirements: SkillsCheckPayload["missingRequirements"] = [];

  for (const skill of status.skills) {
    if (skill.eligible) eligible.push(skill.name);
    if (skill.modelVisible) modelVisible.push(skill.name);
    if (skill.commandVisible) commandVisible.push(skill.name);
    if (skill.disabled) disabled.push(skill.name);
    if (skill.blockedByAllowlist) blocked.push(skill.name);
    if (skill.blockedByAgentFilter) agentFiltered.push(skill.name);
    if (skill.eligible && !skill.modelVisible && !skill.commandVisible) {
      notInjected.push(skill.name);
    }
    const missing = skill.missing ?? EMPTY_REQUIREMENTS;
    if (hasMissing(missing)) {
      missingRequirements.push({
        name: skill.name,
        missing,
        install: skill.install ?? [],
      });
    }
  }

  return {
    agentId: status.agentId,
    workspaceDir: status.workspaceDir,
    managedSkillsDir: status.managedSkillsDir,
    summary: {
      total: status.skills.length,
      eligible: eligible.length,
      modelVisible: modelVisible.length,
      commandVisible: commandVisible.length,
      disabled: disabled.length,
      blocked: blocked.length,
      agentFiltered: agentFiltered.length,
      notInjected: notInjected.length,
      missingRequirements: missingRequirements.length,
    },
    eligible,
    modelVisible,
    commandVisible,
    disabled,
    blocked,
    agentFiltered,
    notInjected,
    missingRequirements,
  };
}

/** Find one skill row by name or skill key. */
export function findSkillRow(
  status: SkillsStatus,
  name: string,
): SkillStatusRow | null {
  const needle = name.trim().toLowerCase();
  return (
    status.skills.find(
      (skill) =>
        skill.name.toLowerCase() === needle ||
        String(skill.skillKey || "").toLowerCase() === needle,
    ) ?? null
  );
}
