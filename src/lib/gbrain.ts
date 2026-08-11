/**
 * G-Brain facade.
 *
 * G-Brain (a personal knowledge "brain" by Y Combinator's president) is NOT an
 * OpenClaw plugin or gateway tool — it is a standalone Bun CLI with a local
 * PGLite database at ~/.gbrain. So, unlike everything else Mission Control talks
 * to, there is no gateway RPC: we drive it by spawning the `gbrain` binary and
 * reading its stdout, exactly the way openclaw-cli.ts spawns `openclaw`.
 *
 * Detection is a cheap filesystem stat (~/.gbrain/config.json) so the whole
 * G-Brain tab only appears when a brain actually exists on this machine.
 *
 * Every invocation is gated by a first-token allowlist (COMMAND CATALOG below);
 * args are passed as an argv array to execFile (never a shell string), so there
 * is no command-injection surface.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

function gbrainHome(): string {
  return process.env.GBRAIN_HOME || join(homedir(), ".gbrain");
}

/** Resolve the gbrain binary: the known Bun install path, else rely on PATH. */
function gbrainBin(): string {
  const bun = join(homedir(), ".bun", "bin", "gbrain");
  return existsSync(bun) ? bun : "gbrain";
}

/* ── Detection ─────────────────────────────────────── */

export type GbrainDetection = {
  installed: boolean;
  engine?: string;
  schemaPack?: string;
  home?: string;
};

/**
 * Is a G-Brain present and initialized on this machine? The authoritative,
 * subprocess-free signal is ~/.gbrain/config.json with an engine set — it does
 * not depend on PATH, the gateway, or OpenClaw's plugin registry (none of which
 * know G-Brain exists).
 */
export function detectGbrain(): GbrainDetection {
  const home = gbrainHome();
  const cfgPath = join(home, "config.json");
  if (!existsSync(cfgPath)) return { installed: false };
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
      engine?: unknown;
      schema_pack?: unknown;
    };
    return {
      installed: true,
      engine: typeof cfg.engine === "string" ? cfg.engine : undefined,
      schemaPack: typeof cfg.schema_pack === "string" ? cfg.schema_pack : undefined,
      home,
    };
  } catch {
    // config.json exists but is unreadable — the brain is still "present".
    return { installed: true, home };
  }
}

/* ── Running commands ──────────────────────────────── */

/**
 * G-Brain prints a self-upgrade banner and, occasionally, a boxed "Doctor
 * notices" block ahead of real output. None of it is content; strip it so
 * callers get clean text or parseable JSON.
 */
const BANNER_RE =
  /UPGRADE_AVAILABLE|\bavailable\. Run:|self-upgrade|Doctor notices|state-migrations|Left plugin install index|^[│◇├╮╯╭╰─\s]*$/;

function stripBanner(out: string): string {
  return out
    .split("\n")
    .filter((line) => !BANNER_RE.test(line))
    .join("\n")
    .trim();
}

/** Best-effort: pull the last balanced JSON value out of mixed CLI output. */
function extractJson(text: string): unknown {
  const start = text.search(/[[{]/);
  if (start !== -1) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      /* fall through to line scan */
    }
  }
  for (const line of text.split("\n").reverse()) {
    const t = line.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.parse(t);
      } catch {
        /* keep scanning */
      }
    }
  }
  return undefined;
}

export type GbrainResult = {
  ok: boolean;
  stdout: string;
  json?: unknown;
  error?: string;
  exitCode?: number | null;
};

/**
 * Run an allowlisted gbrain command. The first argv token must be a known
 * subcommand (see GBRAIN_COMMANDS); everything else is passed through verbatim.
 */
export async function runGbrain(
  args: string[],
  opts?: { json?: boolean; timeoutMs?: number },
): Promise<GbrainResult> {
  const sub = args[0];
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
    return { ok: false, stdout: "", error: `G-Brain command not allowed: ${sub ?? "(none)"}` };
  }
  try {
    const { stdout } = await execFileAsync(gbrainBin(), args, {
      timeout: opts?.timeoutMs ?? 30_000,
      maxBuffer: 12 * 1024 * 1024,
      env: process.env,
    });
    const clean = stripBanner(stdout);
    return opts?.json ? { ok: true, stdout: clean, json: extractJson(clean) } : { ok: true, stdout: clean };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number | null; message?: string };
    const clean = stripBanner(String(e.stdout || ""));
    // Several gbrain commands exit non-zero yet still print usable JSON/text.
    if (opts?.json && clean) {
      const parsed = extractJson(clean);
      if (parsed !== undefined) return { ok: true, stdout: clean, json: parsed, exitCode: e.code ?? null };
    }
    return {
      ok: false,
      stdout: clean,
      error: stripBanner(String(e.stderr || e.message || "gbrain failed")) || "gbrain failed",
      exitCode: e.code ?? null,
    };
  }
}

/* ── Command catalog ───────────────────────────────── */

export type GbrainCategory =
  | "overview"
  | "auto-jobs"
  | "search"
  | "pages"
  | "links"
  | "tags"
  | "timeline"
  | "sources"
  | "files"
  | "code"
  | "brain"
  | "maintenance"
  | "integration";

export type GbrainArg = {
  name: string;
  flag?: string;
  placeholder?: string;
  required?: boolean;
  description?: string;
};

export type GbrainCommand = {
  /** argv tokens with `{name}` placeholders substituted from user input. */
  id: string;
  label: string;
  category: GbrainCategory;
  /** The gbrain subcommand (first argv token). */
  sub: string;
  /** Verb tokens placed right after `sub`, before args (e.g. jobs ["get"] <id>). */
  prefix?: string[];
  /** Fixed argv suffix appended after positional/flag args (e.g. ["--json"]). */
  suffix?: string[];
  args?: GbrainArg[];
  /** Reads-only vs mutates the brain. Mutations are confirmed in the UI. */
  mutates?: boolean;
  /** Destructive/irreversible — the UI must double-confirm. */
  dangerous?: boolean;
  json?: boolean;
  description: string;
};

/**
 * The whole surface, grouped for the UI. This is what lets the tab "see
 * everything G-Brain supports and perform every command" — bespoke screens
 * cover Overview / Auto-jobs / Search / Integration, and the Command palette
 * exposes the rest of this catalog directly.
 */
export const GBRAIN_COMMANDS: GbrainCommand[] = [
  // ── Overview / health / config ──────────────────────────────
  { id: "doctor", label: "Doctor", category: "overview", sub: "doctor", suffix: ["--json", "--fast"], json: true, description: "Full health check: resolver, skills, pgvector, RLS, embeddings." },
  { id: "stats", label: "Brain statistics", category: "overview", sub: "stats", description: "Pages, chunks, embeddings, links, timeline, and counts by type." },
  { id: "health", label: "Health dashboard", category: "overview", sub: "health", description: "Brain health dashboard: coverage, staleness, most-connected entities." },
  { id: "features", label: "Feature usage", category: "overview", sub: "features", suffix: ["--json"], json: true, description: "Scan feature usage and recommend unused features." },
  { id: "storage-status", label: "Storage status", category: "overview", sub: "storage", prefix: ["status"], suffix: ["--json"], json: true, description: "Storage tier status: git-tracked vs. remote-only." },
  { id: "config-show", label: "Config", category: "overview", sub: "config", prefix: ["show"], description: "Brain configuration." },
  { id: "config-get", label: "Get config value", category: "overview", sub: "config", prefix: ["get"], args: [{ name: "key", placeholder: "config key", required: true }], description: "Read one config value." },
  { id: "config-set", label: "Set config value", category: "overview", sub: "config", prefix: ["set"], mutates: true, args: [{ name: "key", placeholder: "config key", required: true }, { name: "value", placeholder: "new value", required: true }], description: "Set a config value." },
  { id: "check-update", label: "Check for updates", category: "overview", sub: "check-update", suffix: ["--json"], json: true, description: "Check whether a newer gbrain version is available." },
  { id: "version", label: "Version info", category: "overview", sub: "version", description: "gbrain version and build info." },
  { id: "tools-json", label: "Tool discovery (JSON)", category: "overview", sub: "--tools-json", description: "Machine-readable tool catalog, for MCP clients." },

  // ── Auto-jobs — dreaming, autopilot, Minions ────────────────
  { id: "dream-dry", label: "Dream (dry run)", category: "auto-jobs", sub: "dream", suffix: ["--dry-run", "--json"], json: true, description: "Preview the overnight maintenance cycle without changing anything." },
  { id: "dream", label: "Dream now", category: "auto-jobs", sub: "dream", suffix: ["--json"], mutates: true, json: true, description: "Run the overnight maintenance cycle once (link/timeline extraction, salience, cleanup)." },
  { id: "autopilot", label: "Autopilot", category: "auto-jobs", sub: "autopilot", description: "Self-maintaining brain daemon (continuous dream + jobs) — status." },
  { id: "jobs-stats", label: "Job stats", category: "auto-jobs", sub: "jobs", prefix: ["stats"], description: "Background-job (Minions) health dashboard: queue depth, throughput." },
  { id: "jobs-list", label: "Jobs", category: "auto-jobs", sub: "jobs", prefix: ["list"], args: [{ name: "status", flag: "--status", placeholder: "waiting|active|done|failed|dead" }, { name: "limit", flag: "--limit", placeholder: "20" }], description: "List background jobs." },
  { id: "jobs-get", label: "Job details", category: "auto-jobs", sub: "jobs", prefix: ["get"], args: [{ name: "id", placeholder: "job id", required: true }], description: "Job details and history." },
  { id: "jobs-submit", label: "Submit job", category: "auto-jobs", sub: "jobs", prefix: ["submit"], mutates: true, args: [{ name: "name", placeholder: "sync|embed|lint|import|extract|backlinks|autopilot-cycle", required: true }, { name: "params", flag: "--params", placeholder: '{"key":"value"} (JSON)' }], description: "Queue a background job for the Minions to run." },
  { id: "jobs-retry", label: "Retry job", category: "auto-jobs", sub: "jobs", prefix: ["retry"], mutates: true, args: [{ name: "id", placeholder: "job id", required: true }], description: "Re-queue a failed/dead job." },
  { id: "jobs-cancel", label: "Cancel job", category: "auto-jobs", sub: "jobs", prefix: ["cancel"], mutates: true, args: [{ name: "id", placeholder: "job id", required: true }], description: "Cancel a job." },
  { id: "jobs-delete", label: "Delete job record", category: "auto-jobs", sub: "jobs", prefix: ["delete"], mutates: true, dangerous: true, args: [{ name: "id", placeholder: "job id", required: true }], description: "Permanently delete a job record." },
  { id: "jobs-prune", label: "Prune old jobs", category: "auto-jobs", sub: "jobs", prefix: ["prune"], mutates: true, args: [{ name: "olderThan", flag: "--older-than", placeholder: "30d" }], description: "Clean up old finished jobs." },
  { id: "jobs-supervisor-status", label: "Worker supervisor status", category: "auto-jobs", sub: "jobs", prefix: ["supervisor", "status"], suffix: ["--json"], json: true, description: "Is the auto-restarting Minions worker running?" },
  { id: "jobs-supervisor-start", label: "Start worker supervisor", category: "auto-jobs", sub: "jobs", prefix: ["supervisor", "start"], mutates: true, suffix: ["--detach", "--json"], json: true, description: "Start the auto-restarting background worker (forks and returns)." },
  { id: "jobs-supervisor-stop", label: "Stop worker supervisor", category: "auto-jobs", sub: "jobs", prefix: ["supervisor", "stop"], mutates: true, suffix: ["--json"], json: true, description: "Gracefully stop the background worker supervisor." },

  // ── Search & ask ─────────────────────────────────────────────
  { id: "query", label: "Ask (hybrid)", category: "search", sub: "query", args: [{ name: "q", placeholder: "your question", required: true }], suffix: ["--json"], json: true, description: "Hybrid search with RRF ranking and query expansion." },
  { id: "ask", label: "Ask (alias)", category: "search", sub: "ask", args: [{ name: "q", placeholder: "your question", required: true }], suffix: ["--json"], json: true, description: "Alias for hybrid query/ask." },
  { id: "search", label: "Keyword search", category: "search", sub: "search", args: [{ name: "q", placeholder: "keywords", required: true }], description: "Keyword (tsvector) search." },

  // ── Pages ────────────────────────────────────────────────────
  { id: "list", label: "List pages", category: "pages", sub: "list", args: [{ name: "type", flag: "--type", placeholder: "note|project|person|company…" }, { name: "tag", flag: "--tag", placeholder: "tag" }, { name: "n", flag: "-n", placeholder: "50" }], description: "List pages, optionally by type or tag." },
  { id: "get", label: "Read page", category: "pages", sub: "get", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Read a page." },
  { id: "history", label: "Page history", category: "pages", sub: "history", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Page version history." },
  { id: "revert", label: "Revert page", category: "pages", sub: "revert", mutates: true, args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "versionId", placeholder: "version id (from history)", required: true }], description: "Revert a page to a previous version." },
  { id: "put", label: "Write / update page", category: "pages", sub: "put", mutates: true, args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "content", flag: "--content", placeholder: "full markdown, with frontmatter", required: true }], description: "Write or update a page directly (chunks, embeds, reconciles tags/links)." },
  { id: "capture", label: "Capture to inbox", category: "pages", sub: "capture", mutates: true, args: [{ name: "content", placeholder: "text to remember", required: true }], suffix: ["--json"], json: true, description: "Single entrypoint for getting content into the brain (writes to inbox/)." },
  { id: "delete", label: "Delete page", category: "pages", sub: "delete", mutates: true, dangerous: true, args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Delete a page." },

  // ── Links / graph ────────────────────────────────────────────
  { id: "graph-query", label: "Graph traversal", category: "links", sub: "graph-query", args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "type", flag: "--type", placeholder: "works_at|invested_in…" }, { name: "direction", flag: "--direction", placeholder: "in|out|both" }, { name: "depth", flag: "--depth", placeholder: "2" }], suffix: ["--json"], json: true, description: "Edge-based graph traversal with type/direction filters." },
  { id: "graph", label: "Graph (node list)", category: "links", sub: "graph", args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "depth", flag: "--depth", placeholder: "2" }], description: "Traverse the link graph and return reachable nodes." },
  { id: "backlinks", label: "Backlinks", category: "links", sub: "backlinks", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Incoming links to a page." },
  { id: "link-sources", label: "Link provenances", category: "links", sub: "link-sources", description: "List link provenances in use, with edge counts." },
  { id: "link", label: "Create link", category: "links", sub: "link", mutates: true, args: [{ name: "from", placeholder: "from-slug", required: true }, { name: "to", placeholder: "to-slug", required: true }, { name: "linkType", flag: "--link-type", placeholder: "works_at|invested_in…" }, { name: "linkSource", flag: "--link-source", placeholder: "manual" }], description: "Create a typed link between two pages." },
  { id: "unlink", label: "Remove link", category: "links", sub: "unlink", mutates: true, args: [{ name: "from", placeholder: "from-slug", required: true }, { name: "to", placeholder: "to-slug", required: true }, { name: "linkType", flag: "--link-type", placeholder: "works_at|invested_in…" }, { name: "linkSource", flag: "--link-source", placeholder: "manual" }], description: "Remove a link between two pages." },
  { id: "orphans", label: "Orphan pages", category: "links", sub: "orphans", suffix: ["--json"], json: true, description: "Pages with no inbound wikilinks." },
  { id: "reconcile-links-dry", label: "Reconcile code links (preview)", category: "links", sub: "reconcile-links", suffix: ["--dry-run"], description: "Preview doc ↔ implementation edge recomputation." },
  { id: "reconcile-links", label: "Reconcile code links", category: "links", sub: "reconcile-links", mutates: true, description: "Batch-recompute doc ↔ implementation edges." },

  // ── Tags ─────────────────────────────────────────────────────
  { id: "tags", label: "List tags", category: "tags", sub: "tags", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "List a page's tags." },
  { id: "tag", label: "Add tag", category: "tags", sub: "tag", mutates: true, args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "tag", placeholder: "tag", required: true }], description: "Add a tag to a page." },
  { id: "untag", label: "Remove tag", category: "tags", sub: "untag", mutates: true, args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "tag", placeholder: "tag", required: true }], description: "Remove a tag from a page." },

  // ── Timeline / salience / anomalies ─────────────────────────
  { id: "timeline", label: "Timeline", category: "timeline", sub: "timeline", args: [{ name: "slug", placeholder: "page-slug (optional)" }], description: "View the timeline." },
  { id: "timeline-add", label: "Add timeline entry", category: "timeline", sub: "timeline-add", mutates: true, args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "date", placeholder: "2026-08-11", required: true }, { name: "text", placeholder: "what happened", required: true }], description: "Add a timeline entry to a page." },
  { id: "salience", label: "Salience", category: "timeline", sub: "salience", args: [{ name: "days", flag: "--days", placeholder: "30" }, { name: "kind", flag: "--kind", placeholder: "page kind" }], description: "Pages ranked by emotional + activity salience." },
  { id: "anomalies", label: "Anomalies", category: "timeline", sub: "anomalies", args: [{ name: "since", flag: "--since", placeholder: "2026-08-01" }, { name: "sigma", flag: "--sigma", placeholder: "2" }], description: "Cohort-based statistical anomalies." },
  { id: "transcripts-recent", label: "Recent transcripts", category: "timeline", sub: "transcripts", prefix: ["recent"], args: [{ name: "days", flag: "--days", placeholder: "7" }], description: "Recent raw .txt transcripts (local-only)." },

  // ── Sources (multi-repo / multi-brain) + import/export/sync ──
  { id: "sources-list", label: "Sources", category: "sources", sub: "sources", prefix: ["list"], description: "Registered sources (multi-repo / multi-brain)." },
  { id: "sources-status", label: "Sources status", category: "sources", sub: "sources", prefix: ["status"], description: "Per-source dashboard: sync lag, embed coverage." },
  { id: "sources-current", label: "Current source", category: "sources", sub: "sources", prefix: ["current"], suffix: ["--json"], json: true, description: "Which source resolves right now, and why (flag/env/dotfile/default)." },
  { id: "sources-archived", label: "Archived sources", category: "sources", sub: "sources", prefix: ["archived"], suffix: ["--json"], json: true, description: "List soft-deleted sources and their purge expiry." },
  { id: "sources-add", label: "Add source", category: "sources", sub: "sources", prefix: ["add"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }, { name: "path", flag: "--path", placeholder: "/path/to/git/repo", required: true }, { name: "name", flag: "--name", placeholder: "display name" }], description: "Register a new source (must be a git repo with committed files)." },
  { id: "sources-remove", label: "Remove source", category: "sources", sub: "sources", prefix: ["remove"], mutates: true, dangerous: true, suffix: ["--confirm-destructive"], args: [{ name: "id", placeholder: "source-id", required: true }], description: "Permanently delete a source and all its data." },
  { id: "sources-archive", label: "Archive source", category: "sources", sub: "sources", prefix: ["archive"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Soft-delete a source: hide from search, keep data for 72h." },
  { id: "sources-restore", label: "Restore source", category: "sources", sub: "sources", prefix: ["restore"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Un-archive a soft-deleted source." },
  { id: "sources-purge", label: "Purge archived source(s)", category: "sources", sub: "sources", prefix: ["purge"], mutates: true, dangerous: true, suffix: ["--confirm-destructive"], args: [{ name: "id", placeholder: "source-id (blank = purge all expired)" }], description: "Permanently delete archived source(s)." },
  { id: "sources-rename", label: "Rename source", category: "sources", sub: "sources", prefix: ["rename"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }, { name: "newName", placeholder: "new display name", required: true }], description: "Rename a source's display name (id stays fixed)." },
  { id: "sources-default", label: "Set default source", category: "sources", sub: "sources", prefix: ["default"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Set the brain-level default source." },
  { id: "sources-federate", label: "Federate source", category: "sources", sub: "sources", prefix: ["federate"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Include a source in cross-source default search." },
  { id: "sources-unfederate", label: "Unfederate source", category: "sources", sub: "sources", prefix: ["unfederate"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Isolate a source from default search." },
  { id: "sources-set-cr-mode", label: "Set contextual-retrieval mode", category: "sources", sub: "sources", prefix: ["set-cr-mode"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }, { name: "mode", placeholder: "none|title|per_chunk_synopsis|unset", required: true }], description: "Per-source contextual-retrieval mode override." },
  { id: "sources-harden", label: "Harden source", category: "sources", sub: "sources", prefix: ["harden"], mutates: true, suffix: ["--json"], json: true, args: [{ name: "id", placeholder: "source-id or --all", required: true }], description: "Make a source repo durable: auto-push hook, cron pull, credential." },
  { id: "sources-unharden", label: "Unharden source", category: "sources", sub: "sources", prefix: ["unharden"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Remove durability cron/hook/credential wiring." },
  { id: "sources-pull", label: "Pull source", category: "sources", sub: "sources", prefix: ["pull"], mutates: true, args: [{ name: "id", placeholder: "source-id", required: true }], description: "Divergence-safe rebase-pull for a source (skip on dirty)." },
  { id: "sync-repo", label: "Sync (current source)", category: "sources", sub: "sync", mutates: true, args: [{ name: "repo", flag: "--repo", placeholder: "/path/to/repo (optional)" }], description: "Git-to-brain incremental sync." },
  { id: "sync-all", label: "Sync all sources", category: "sources", sub: "sync", mutates: true, suffix: ["--all"], description: "Git-to-brain incremental sync of every source with a local path." },
  { id: "sync-source", label: "Sync one source", category: "sources", sub: "sync", mutates: true, args: [{ name: "id", flag: "--source", placeholder: "source-id", required: true }], description: "Sync one specific source." },
  { id: "import", label: "Import directory", category: "sources", sub: "import", mutates: true, args: [{ name: "dir", placeholder: "path/to/markdown-dir", required: true }], description: "Bulk-import a markdown directory into the brain." },
  { id: "export", label: "Export to markdown", category: "sources", sub: "export", args: [{ name: "dir", flag: "--dir", placeholder: "./out/" }], description: "Export the brain to markdown files on disk." },
  { id: "export-restore", label: "Restore missing files", category: "sources", sub: "export", mutates: true, suffix: ["--restore-only"], args: [{ name: "repo", flag: "--repo", placeholder: "/path/to/repo" }, { name: "type", flag: "--type", placeholder: "page type" }, { name: "slugPrefix", flag: "--slug-prefix", placeholder: "slug prefix" }], description: "Restore files present in the brain but missing on disk." },

  // ── Files (blob storage) ────────────────────────────────────
  { id: "files-list", label: "List files", category: "files", sub: "files", prefix: ["list"], args: [{ name: "slug", placeholder: "page-slug (optional)" }], description: "List files stored for a page, or all files." },
  { id: "files-upload", label: "Upload file", category: "files", sub: "files", prefix: ["upload"], mutates: true, args: [{ name: "file", placeholder: "local file path", required: true }, { name: "page", flag: "--page", placeholder: "page-slug", required: true }], description: "Upload a file and link it to a page." },
  { id: "files-upload-raw", label: "Smart upload", category: "files", sub: "files", prefix: ["upload-raw"], mutates: true, args: [{ name: "file", placeholder: "local file path", required: true }, { name: "page", flag: "--page", placeholder: "page-slug", required: true }, { name: "type", flag: "--type", placeholder: "content type" }], description: "Size-aware upload with a .redirect.yaml pointer." },
  { id: "files-signed-url", label: "Signed URL", category: "files", sub: "files", prefix: ["signed-url"], args: [{ name: "path", placeholder: "stored file path", required: true }], description: "Generate a 1-hour signed URL for a stored file." },
  { id: "files-sync", label: "Sync directory to storage", category: "files", sub: "files", prefix: ["sync"], mutates: true, args: [{ name: "dir", placeholder: "path/to/dir", required: true }], description: "Bulk-upload a directory to storage." },
  { id: "files-verify", label: "Verify uploads", category: "files", sub: "files", prefix: ["verify"], description: "Verify all stored uploads match local files." },
  { id: "files-status", label: "Storage migration status", category: "files", sub: "files", prefix: ["status"], description: "Migration status of directories (mirrored / redirected)." },
  { id: "files-mirror", label: "Mirror directory", category: "files", sub: "files", prefix: ["mirror"], mutates: true, args: [{ name: "dir", placeholder: "path/to/dir", required: true }], description: "Mirror a directory's files to cloud storage (local copy kept)." },
  { id: "files-unmirror", label: "Unmirror directory", category: "files", sub: "files", prefix: ["unmirror"], mutates: true, args: [{ name: "dir", placeholder: "path/to/dir", required: true }], description: "Remove the mirror marker (files stay in storage)." },
  { id: "files-redirect", label: "Redirect directory", category: "files", sub: "files", prefix: ["redirect"], mutates: true, args: [{ name: "dir", placeholder: "path/to/dir", required: true }], description: "Replace local files with .redirect.yaml pointers." },
  { id: "files-restore", label: "Restore directory", category: "files", sub: "files", prefix: ["restore"], mutates: true, args: [{ name: "dir", placeholder: "path/to/dir", required: true }], description: "Download from storage and recreate local files." },
  { id: "files-clean", label: "Clean redirect pointers", category: "files", sub: "files", prefix: ["clean"], mutates: true, dangerous: true, suffix: ["--yes"], args: [{ name: "dir", placeholder: "path/to/dir", required: true }], description: "Delete redirect pointers — irreversible." },

  // ── Code indexing ────────────────────────────────────────────
  { id: "code-def", label: "Symbol definition", category: "code", sub: "code-def", args: [{ name: "symbol", placeholder: "symbol", required: true }, { name: "lang", flag: "--lang", placeholder: "language" }], description: "Find the definition of a symbol across code pages." },
  { id: "code-refs", label: "Symbol references", category: "code", sub: "code-refs", args: [{ name: "symbol", placeholder: "symbol", required: true }, { name: "lang", flag: "--lang", placeholder: "language" }], description: "Find all references to a symbol." },
  { id: "code-callers", label: "Symbol callers", category: "code", sub: "code-callers", args: [{ name: "symbol", placeholder: "symbol", required: true }], description: "Who calls this symbol?" },
  { id: "code-callees", label: "Symbol callees", category: "code", sub: "code-callees", args: [{ name: "symbol", placeholder: "symbol", required: true }], description: "What does this symbol call?" },
  { id: "reindex-code", label: "Reindex code pages", category: "code", sub: "reindex-code", mutates: true, suffix: ["--yes"], args: [{ name: "source", flag: "--source", placeholder: "source-id" }], description: "Explicit code-page reindex." },
  { id: "reindex-search-vector-dry", label: "Reindex search vectors (preview)", category: "code", sub: "reindex-search-vector", suffix: ["--dry-run", "--json"], json: true, description: "Preview recreating FTS triggers and backfilling search vectors." },
  { id: "reindex-search-vector", label: "Reindex search vectors", category: "code", sub: "reindex-search-vector", mutates: true, suffix: ["--yes", "--json"], json: true, description: "Recreate FTS triggers and backfill search vectors." },

  // ── Brain — ideation ─────────────────────────────────────────
  { id: "brainstorm", label: "Brainstorm", category: "brain", sub: "brainstorm", mutates: true, args: [{ name: "q", placeholder: "question", required: true }], suffix: ["--json"], json: true, description: "Bisociation idea generator (hybrid search + far-set + judge)." },
  { id: "lsd", label: "Lateral drift (LSD)", category: "brain", sub: "lsd", mutates: true, args: [{ name: "q", placeholder: "question", required: true }], suffix: ["--json"], json: true, description: "Lateral Synaptic Drift: inverted-judge brainstorm rewarding far ideas." },

  // ── Maintenance ──────────────────────────────────────────────
  { id: "embed-page", label: "Embed one page", category: "maintenance", sub: "embed", mutates: true, args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Generate/refresh embeddings for one page." },
  { id: "embed-stale", label: "Refresh stale embeddings", category: "maintenance", sub: "embed", mutates: true, suffix: ["--stale"], description: "Generate/refresh embeddings for stale pages." },
  { id: "embed-all", label: "Re-embed everything", category: "maintenance", sub: "embed", mutates: true, suffix: ["--all"], description: "Generate/refresh embeddings for every page." },
  { id: "lint", label: "Lint brain", category: "maintenance", sub: "lint", args: [{ name: "dir", placeholder: "dir or file", required: true }], description: "Catch LLM artifacts, placeholder dates, bad frontmatter." },
  { id: "lint-fix", label: "Lint & fix", category: "maintenance", sub: "lint", mutates: true, suffix: ["--fix"], args: [{ name: "dir", placeholder: "dir or file", required: true }], description: "Catch and fix LLM artifacts, placeholder dates, bad frontmatter." },
  { id: "check-backlinks", label: "Check / fix backlinks", category: "maintenance", sub: "check-backlinks", mutates: true, args: [{ name: "mode", placeholder: "check|fix", required: true }], description: "Find (or fix) missing back-links across the brain." },
  { id: "extract-stale", label: "Extract (stale)", category: "maintenance", sub: "extract", mutates: true, suffix: ["--stale", "--json"], json: true, description: "Extract links/timeline for stale pages (idempotent, cron-safe)." },
  { id: "extract", label: "Extract links/timeline", category: "maintenance", sub: "extract", mutates: true, suffix: ["--json"], json: true, args: [{ name: "kind", placeholder: "links|timeline|all", required: true }, { name: "source", flag: "--source", placeholder: "fs|db" }, { name: "since", flag: "--since", placeholder: "2026-08-01" }], description: "Extract links and/or timeline entries for matching pages." },
  { id: "extract-explain", label: "Explain an extraction kind", category: "maintenance", sub: "extract", suffix: ["--json"], json: true, args: [{ name: "kind", flag: "--explain", placeholder: "links|timeline|all", required: true }], description: "Full details on how an extraction kind works." },
  { id: "extract-status", label: "Extraction status", category: "maintenance", sub: "extract", prefix: ["status"], suffix: ["--json"], json: true, description: "Extraction status by source and kind." },
  { id: "backfill", label: "Run a backfill", category: "maintenance", sub: "backfill", mutates: true, args: [{ name: "kind", placeholder: "list (to see options) | backfill name", required: true }], description: "Run a registered backfill migration. Pass “list” to preview first." },
  { id: "publish", label: "Publish page", category: "maintenance", sub: "publish", mutates: true, args: [{ name: "page", placeholder: "page.md path", required: true }, { name: "password", flag: "--password", placeholder: "optional AES-256 password" }], description: "Generate a shareable HTML export, with private data stripped." },
  { id: "report", label: "Save report", category: "maintenance", sub: "report", mutates: true, args: [{ name: "type", flag: "--type", placeholder: "report name", required: true }, { name: "content", flag: "--content", placeholder: "report body", required: true }], description: "Save a timestamped report to brain/reports/." },
  { id: "migrate", label: "Migrate engine", category: "maintenance", sub: "migrate", mutates: true, dangerous: true, args: [{ name: "to", flag: "--to", placeholder: "supabase|pglite", required: true }], description: "Transfer the whole brain between engines." },
  { id: "migrate-embeddings", label: "Migrate embeddings", category: "maintenance", sub: "migrate", prefix: ["embeddings"], mutates: true, dangerous: true, args: [{ name: "to", flag: "--to", placeholder: "provider:model", required: true }], description: "Re-embed the whole brain onto another embedding provider." },
  { id: "upgrade", label: "Self-upgrade", category: "maintenance", sub: "upgrade", mutates: true, description: "Update the gbrain CLI itself to the latest version." },
  { id: "init", label: "Initialize brain", category: "maintenance", sub: "init", mutates: true, dangerous: true, description: "Create a brain (PGLite by default). Only meaningful where none exists yet." },

  // ── OpenClaw integration ─────────────────────────────────────
  { id: "integrations", label: "Integrations dashboard", category: "integration", sub: "integrations", description: "Integration recipes: senses (ingest) + reflexes (retrieval into OpenClaw)." },
  { id: "integrations-list", label: "List integrations", category: "integration", sub: "integrations", prefix: ["list"], suffix: ["--json"], json: true, description: "List available integration recipes." },
  { id: "integrations-show", label: "Show integration recipe", category: "integration", sub: "integrations", prefix: ["show"], args: [{ name: "id", placeholder: "integration id", required: true }], description: "Show one integration recipe's setup details." },
  { id: "integrations-status", label: "Integration status", category: "integration", sub: "integrations", prefix: ["status"], args: [{ name: "id", placeholder: "integration id", required: true }], description: "Check secrets + health for one integration." },
  { id: "integrations-doctor", label: "Integration health checks", category: "integration", sub: "integrations", prefix: ["doctor"], suffix: ["--json"], json: true, description: "Run health checks across configured integrations." },
  { id: "integrations-stats", label: "Integration signal stats", category: "integration", sub: "integrations", prefix: ["stats"], suffix: ["--json"], json: true, description: "Signal statistics for configured integrations." },
  { id: "check-resolvable", label: "Skill tree check", category: "integration", sub: "check-resolvable", suffix: ["--json"], json: true, description: "Validate the OpenClaw skill tree (reachability / MECE / DRY)." },
  { id: "check-resolvable-fix", label: "Skill tree check & fix", category: "integration", sub: "check-resolvable", mutates: true, suffix: ["--json", "--fix"], json: true, description: "Validate the OpenClaw skill tree and fix what it safely can." },
  { id: "connect", label: "Connect to remote gbrain", category: "integration", sub: "connect", mutates: true, suffix: ["--json"], json: true, args: [{ name: "mcpUrl", placeholder: "https://your-brain/mcp", required: true }, { name: "token", flag: "--token", placeholder: "bearer token", required: true }], description: "Wire this machine's agent to a remote gbrain over MCP." },
  { id: "call", label: "Raw tool call (advanced)", category: "integration", sub: "call", mutates: true, dangerous: true, args: [{ name: "tool", placeholder: "tool name", required: true }, { name: "json", placeholder: '{"...": "..."}', required: true }], description: "Invoke any MCP tool directly by name. For advanced/debug use." },
];

export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(
  GBRAIN_COMMANDS.map((c) => c.sub),
);

/** Look up a catalog command by id. */
export function gbrainCommand(id: string): GbrainCommand | undefined {
  return GBRAIN_COMMANDS.find((c) => c.id === id);
}
