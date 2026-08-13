/**
 * Exec approvals — SERVER-ONLY. Wraps `openclaw approvals` + `config set`.
 *
 * The autonomous/guarded switch writes the `tools.exec` policy (mode + ask) and
 * then runs `openclaw doctor` so the change is validated immediately — per the
 * project rule to always doctor after editing openclaw.json.
 */

import { runCli, runCliJson, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import {
  type ApprovalsSnapshot,
  type ExecMode,
  type ExecScope,
} from "./exec-approvals-types";

export * from "./exec-approvals-types";

interface RawApprovals {
  path?: string;
  exists?: boolean;
  file?: { defaults?: Record<string, unknown>; agents?: Record<string, Record<string, unknown>> };
  effectivePolicy?: { scopes?: ExecScope[]; note?: string };
}

export async function getApprovals(): Promise<ApprovalsSnapshot> {
  const raw = await runCliJson<RawApprovals>(["approvals", "get"], 20_000);
  return {
    path: raw.path || "",
    exists: Boolean(raw.exists),
    agents: (raw.file?.agents ?? {}) as ApprovalsSnapshot["agents"],
    defaults: raw.file?.defaults ?? {},
    scopes: Array.isArray(raw.effectivePolicy?.scopes) ? raw.effectivePolicy!.scopes! : [],
    note: raw.effectivePolicy?.note,
  };
}

/**
 * Flip the exec policy between fully autonomous (never blocks) and guarded
 * (asks before running). OpenClaw's config treats `tools.exec.mode` as a
 * shorthand that CANNOT be combined with the granular `security`/`ask` fields,
 * so we clear those first, then set the single `mode`:
 *   - autonomous → mode "full" (runs everything, never asks)
 *   - guarded    → mode "ask"  (asks before each exec)
 */
export async function setExecMode(mode: ExecMode): Promise<void> {
  // Clear the granular fields that conflict with the mode shorthand (no-op if unset).
  await runCli(["config", "unset", "tools.exec.security"], CONFIG_WRITE_TIMEOUT_MS).catch(() => {});
  await runCli(["config", "unset", "tools.exec.ask"], CONFIG_WRITE_TIMEOUT_MS).catch(() => {});
  const value = mode === "autonomous" ? "full" : "ask";
  await runCli(["config", "set", "tools.exec.mode", value], CONFIG_WRITE_TIMEOUT_MS);
  // Validate the edited config immediately (always doctor after editing config).
  await runCli(["doctor"], 30_000).catch(() => {});
}

export async function allowlistAdd(pattern: string, agent = "*"): Promise<void> {
  const p = String(pattern || "").trim();
  if (!p) throw new Error("A pattern is required");
  await runCli(["approvals", "allowlist", "add", p, "--agent", agent], CONFIG_WRITE_TIMEOUT_MS);
}

export async function allowlistRemove(pattern: string, agent = "*"): Promise<void> {
  const p = String(pattern || "").trim();
  if (!p) throw new Error("A pattern is required");
  await runCli(["approvals", "allowlist", "remove", p, "--agent", agent], CONFIG_WRITE_TIMEOUT_MS);
}
