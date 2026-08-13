/**
 * Backup — SERVER-ONLY. Wraps `openclaw backup create|verify`.
 * Output is human text (not JSON), so we use runCli + parseBackupOutput.
 */

import { runCli, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import { parseBackupOutput, type BackupResult, type BackupVerifyResult } from "./backup-types";

export * from "./backup-types";

/** Preview what a backup would include, without writing anything. */
export async function planBackup(): Promise<BackupResult> {
  const out = await runCli(["backup", "create", "--dry-run"], 30_000);
  return parseBackupOutput(out);
}

/** Write a real backup archive and return its path + manifest. */
export async function createBackup(): Promise<BackupResult> {
  // Backups can be large (sessions + workspaces); allow the longer budget.
  const out = await runCli(["backup", "create"], Math.max(CONFIG_WRITE_TIMEOUT_MS, 120_000));
  return parseBackupOutput(out);
}

/** Validate an existing archive and its embedded manifest. */
export async function verifyBackup(path: string): Promise<BackupVerifyResult> {
  const clean = String(path || "").trim();
  if (!clean) throw new Error("An archive path is required");
  try {
    const out = await runCli(["backup", "verify", clean], 60_000);
    return { ok: !/invalid|error|fail/i.test(out), raw: out };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, raw: message };
  }
}
