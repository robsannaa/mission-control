/**
 * Backup — CLIENT-SAFE types + output parsing (no server imports).
 * The server module `@/lib/backup` re-exports these.
 */

export interface BackupEntry {
  label: string;
  detail: string;
}

export interface BackupResult {
  archivePath: string | null;
  included: BackupEntry[];
  skipped: BackupEntry[];
  dryRun: boolean;
  raw: string;
}

export interface BackupVerifyResult {
  ok: boolean;
  raw: string;
}

/** Strip ANSI colour codes and stray control characters the CLI may emit. */
function stripControl(text: string): string {
  return String(text || "")
    // ANSI colour / SGR sequences (ESC [ ... m)
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    // stray control chars, keeping tab (09), newline (0a), carriage return (0d)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

/** Parse the human output of `openclaw backup create [--dry-run]`. */
export function parseBackupOutput(text: string): BackupResult {
  const raw = stripControl(text).replace(/\r/g, "");
  const lines = raw.split("\n");
  const archiveLine = lines.find((l) => /^Backup archive:/i.test(l.trim()));
  const archivePath = archiveLine ? archiveLine.replace(/^Backup archive:\s*/i, "").trim() : null;

  const included: BackupEntry[] = [];
  const skipped: BackupEntry[] = [];
  let bucket: "included" | "skipped" | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (/^Included\b/i.test(t)) bucket = "included";
    else if (/^Skipped\b/i.test(t)) bucket = "skipped";
    else if (t.startsWith("- ") && bucket) {
      const body = t.slice(2);
      const idx = body.indexOf(":");
      const entry: BackupEntry =
        idx >= 0
          ? { label: body.slice(0, idx).trim(), detail: body.slice(idx + 1).trim() }
          : { label: body.trim(), detail: "" };
      (bucket === "included" ? included : skipped).push(entry);
    }
  }

  return {
    archivePath,
    included,
    skipped,
    dryRun: /Dry run only/i.test(raw),
    raw: raw.trim(),
  };
}

/** Basename of an archive path for display. */
export function archiveName(path: string | null): string | null {
  if (!path) return null;
  return path.split("/").pop() || path;
}
