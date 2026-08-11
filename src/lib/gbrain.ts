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
  | "timeline"
  | "sources"
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
  // Overview / health
  { id: "doctor", label: "Doctor", category: "overview", sub: "doctor", suffix: ["--json", "--fast"], json: true, description: "Full health check: resolver, skills, pgvector, RLS, embeddings." },
  { id: "stats", label: "Brain statistics", category: "overview", sub: "stats", description: "Pages, chunks, embeddings, links, timeline, and counts by type." },
  { id: "health", label: "Health dashboard", category: "overview", sub: "health", description: "Brain health dashboard." },
  { id: "features", label: "Feature usage", category: "overview", sub: "features", suffix: ["--json"], json: true, description: "Scan feature usage and recommend unused features." },
  { id: "storage-status", label: "Storage status", category: "overview", sub: "storage", prefix: ["status"], suffix: ["--json"], json: true, description: "Storage tier status: git-tracked vs. remote-only." },
  { id: "config-show", label: "Config", category: "overview", sub: "config", prefix: ["show"], description: "Brain configuration." },

  // Auto-jobs — dreaming, autopilot, Minions
  { id: "dream-dry", label: "Dream (dry run)", category: "auto-jobs", sub: "dream", suffix: ["--dry-run", "--json"], json: true, description: "Preview the overnight maintenance cycle without changing anything." },
  { id: "dream", label: "Dream now", category: "auto-jobs", sub: "dream", suffix: ["--json"], mutates: true, json: true, description: "Run the overnight maintenance cycle once (link/timeline extraction, salience, cleanup)." },
  { id: "jobs-stats", label: "Job stats", category: "auto-jobs", sub: "jobs", prefix: ["stats"], description: "Background-job (Minions) health dashboard: queue depth, throughput." },
  { id: "jobs-list", label: "Jobs", category: "auto-jobs", sub: "jobs", prefix: ["list"], args: [{ name: "status", flag: "--status", placeholder: "waiting|active|done|failed|dead" }, { name: "limit", flag: "--limit", placeholder: "20" }], description: "List background jobs." },
  { id: "jobs-get", label: "Job details", category: "auto-jobs", sub: "jobs", prefix: ["get"], args: [{ name: "id", placeholder: "job id", required: true }], description: "Job details and history." },
  { id: "jobs-retry", label: "Retry job", category: "auto-jobs", sub: "jobs", prefix: ["retry"], mutates: true, args: [{ name: "id", placeholder: "job id", required: true }], description: "Re-queue a failed/dead job." },
  { id: "jobs-cancel", label: "Cancel job", category: "auto-jobs", sub: "jobs", prefix: ["cancel"], mutates: true, args: [{ name: "id", placeholder: "job id", required: true }], description: "Cancel a job." },
  { id: "jobs-prune", label: "Prune old jobs", category: "auto-jobs", sub: "jobs", prefix: ["prune"], mutates: true, args: [{ name: "olderThan", flag: "--older-than", placeholder: "30d" }], description: "Clean up old jobs." },
  { id: "autopilot", label: "Autopilot", category: "auto-jobs", sub: "autopilot", description: "Self-maintaining brain daemon (continuous dream + jobs). Install/status." },

  // Search
  { id: "query", label: "Ask (hybrid)", category: "search", sub: "query", args: [{ name: "q", placeholder: "your question", required: true }], suffix: ["--json"], json: true, description: "Hybrid search with RRF ranking and query expansion." },
  { id: "search", label: "Keyword search", category: "search", sub: "search", args: [{ name: "q", placeholder: "keywords", required: true }], description: "Keyword (tsvector) search." },

  // Pages
  { id: "list", label: "List pages", category: "pages", sub: "list", args: [{ name: "type", flag: "--type", placeholder: "note|project|person|company…" }, { name: "tag", flag: "--tag", placeholder: "tag" }, { name: "n", flag: "-n", placeholder: "50" }], description: "List pages, optionally by type or tag." },
  { id: "get", label: "Read page", category: "pages", sub: "get", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Read a page." },
  { id: "history", label: "Page history", category: "pages", sub: "history", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Page version history." },
  { id: "capture", label: "Capture to inbox", category: "pages", sub: "capture", mutates: true, args: [{ name: "content", placeholder: "text to remember", required: true }], suffix: ["--json"], json: true, description: "Single entrypoint for getting content into the brain (writes to inbox/)." },
  { id: "delete", label: "Delete page", category: "pages", sub: "delete", mutates: true, dangerous: true, args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Delete a page." },

  // Links / graph
  { id: "graph-query", label: "Graph traversal", category: "links", sub: "graph-query", args: [{ name: "slug", placeholder: "page-slug", required: true }, { name: "type", flag: "--type", placeholder: "works_at|invested_in…" }, { name: "direction", flag: "--direction", placeholder: "in|out|both" }, { name: "depth", flag: "--depth", placeholder: "2" }], suffix: ["--json"], json: true, description: "Edge-based graph traversal with type/direction filters." },
  { id: "backlinks", label: "Backlinks", category: "links", sub: "backlinks", args: [{ name: "slug", placeholder: "page-slug", required: true }], description: "Incoming links to a page." },
  { id: "link-sources", label: "Link provenances", category: "links", sub: "link-sources", description: "List link provenances in use, with edge counts." },
  { id: "orphans", label: "Orphan pages", category: "links", sub: "orphans", suffix: ["--json"], json: true, description: "Pages with no inbound wikilinks." },

  // Timeline / salience / anomalies
  { id: "timeline", label: "Timeline", category: "timeline", sub: "timeline", args: [{ name: "slug", placeholder: "page-slug (optional)" }], description: "View the timeline." },
  { id: "salience", label: "Salience", category: "timeline", sub: "salience", args: [{ name: "days", flag: "--days", placeholder: "30" }], description: "Pages ranked by emotional + activity salience." },
  { id: "anomalies", label: "Anomalies", category: "timeline", sub: "anomalies", args: [{ name: "since", flag: "--since", placeholder: "2026-08-01" }], description: "Cohort-based statistical anomalies." },

  // Sources
  { id: "sources-list", label: "Sources", category: "sources", sub: "sources", prefix: ["list"], description: "Registered sources (multi-repo / multi-brain)." },
  { id: "sources-status", label: "Sources status", category: "sources", sub: "sources", prefix: ["status"], description: "Per-source dashboard: sync lag, embed coverage." },
  { id: "sync", label: "Sync sources", category: "sources", sub: "sync", mutates: true, suffix: ["--all"], description: "Git-to-brain incremental sync of all sources." },

  // Code indexing
  { id: "code-def", label: "Symbol definition", category: "code", sub: "code-def", args: [{ name: "symbol", placeholder: "symbol", required: true }], description: "Find the definition of a symbol across code pages." },
  { id: "code-refs", label: "Symbol references", category: "code", sub: "code-refs", args: [{ name: "symbol", placeholder: "symbol", required: true }], description: "Find all references to a symbol." },

  // Brain — ideation
  { id: "brainstorm", label: "Brainstorm", category: "brain", sub: "brainstorm", mutates: true, args: [{ name: "q", placeholder: "question", required: true }], suffix: ["--json"], json: true, description: "Bisociation idea generator (hybrid search + far-set + judge)." },
  { id: "lsd", label: "Lateral drift (LSD)", category: "brain", sub: "lsd", mutates: true, args: [{ name: "q", placeholder: "question", required: true }], suffix: ["--json"], json: true, description: "Lateral Synaptic Drift: inverted-judge brainstorm rewarding far ideas." },

  // Maintenance
  { id: "embed-stale", label: "Refresh embeddings", category: "maintenance", sub: "embed", mutates: true, suffix: ["--stale"], description: "Generate/refresh embeddings for stale pages." },
  { id: "lint", label: "Lint brain", category: "maintenance", sub: "lint", args: [{ name: "dir", placeholder: "dir or file", required: true }], description: "Catch LLM artifacts, placeholder dates, bad frontmatter." },
  { id: "check-backlinks", label: "Check backlinks", category: "maintenance", sub: "check-backlinks", args: [{ name: "mode", placeholder: "check|fix", required: true }], description: "Find/fix missing back-links across the brain." },
  { id: "extract-stale", label: "Extract (stale)", category: "maintenance", sub: "extract", mutates: true, suffix: ["--stale", "--json"], json: true, description: "Extract links/timeline for stale pages (idempotent)." },

  // Integration with OpenClaw
  { id: "integrations", label: "Integrations", category: "integration", sub: "integrations", description: "Integration recipes: senses (ingest) + reflexes (retrieval into OpenClaw)." },
  { id: "check-resolvable", label: "Skill tree check", category: "integration", sub: "check-resolvable", suffix: ["--json"], json: true, description: "Validate the OpenClaw skill tree (reachability / MECE / DRY)." },
];

export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set(
  GBRAIN_COMMANDS.map((c) => c.sub),
);

/** Look up a catalog command by id. */
export function gbrainCommand(id: string): GbrainCommand | undefined {
  return GBRAIN_COMMANDS.find((c) => c.id === id);
}
