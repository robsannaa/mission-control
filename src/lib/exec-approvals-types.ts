/**
 * Exec approvals — CLIENT-SAFE types + helpers.
 *
 * Governs what an agent may run without stopping to ask. The headline control
 * is "Autonomous vs Guarded", derived from the effective `ask` mode:
 *   - Autonomous  → ask "off"      (agent never blocks; runs tools freely)
 *   - Guarded     → ask "on-miss"  (agent asks before anything not allowlisted)
 */

export type ExecMode = "autonomous" | "guarded";
export type AskMode = "off" | "on-miss" | "always";

export interface ExecScope {
  scopeLabel: string;
  configPath: string;
  mode?: { effective?: string; requested?: string };
  security?: { effective?: string };
  ask?: { effective?: AskMode | string };
  askFallback?: { effective?: string };
  allowedDecisions?: string[];
}

export interface ApprovalsSnapshot {
  path: string;
  exists: boolean;
  agents: Record<string, { allowlist?: string[] } & Record<string, unknown>>;
  defaults: Record<string, unknown>;
  scopes: ExecScope[];
  note?: string;
}

/**
 * The current headline mode. "Autonomous" means the agent never blocks:
 * either the exec mode is "full", or it's the default (auto) with asking off.
 */
export function deriveMode(snapshot: ApprovalsSnapshot): ExecMode {
  const exec = snapshot.scopes.find((s) => s.configPath === "tools.exec") ?? snapshot.scopes[0];
  const mode = exec?.mode?.effective;
  const ask = exec?.ask?.effective;
  if (mode === "full") return "autonomous";
  if ((mode === "auto" || mode === undefined) && (ask === "off" || ask === undefined)) return "autonomous";
  return "guarded";
}

/** Allowlist patterns for a given agent id (defaults to the wildcard agent). */
export function allowlistFor(snapshot: ApprovalsSnapshot, agentId = "*"): string[] {
  const entry = snapshot.agents?.[agentId];
  const list = entry?.allowlist;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}
