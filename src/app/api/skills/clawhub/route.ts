/**
 * ClawHub catalog — browse, search and install published skills.
 *
 * OpenClaw talks to the registry itself, so the catalog is reachable through
 * the gateway: `skills.search`, `skills.detail`, `skills.install` (with
 * `source: "clawhub"`) and `skills.update`. That is the path used here.
 *
 * Previously every action shelled out to a standalone `clawhub` binary, which
 * is a separate install the dashboard cannot assume exists — when it was
 * missing the whole tab reported `CLAWHUB_NOT_FOUND` and disabled itself. It
 * also meant scraping slugs and versions out of a human-readable table with
 * regexes, and installing without the gateway's trust checks.
 *
 * The one thing the gateway has no equivalent for is browsing without a query:
 * `skills.search` requires one and returns nothing for the empty string. So
 * `action=explore` still prefers the external binary, and degrades to an empty
 * catalog with a notice rather than disabling search and install along with it.
 */

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { constants as fsConstants } from "fs";
import { access, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { gatewayCall } from "@/lib/openclaw";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);

type ExploreItem = {
  slug: string;
  displayName?: string;
  summary?: string;
  latestVersion?: { version?: string };
  stats?: {
    downloads?: number;
    installsCurrent?: number;
    installsAllTime?: number;
    stars?: number;
  };
  updatedAt?: number;
  developer?: string;
  author?: string;
};

type ExplorePayload = {
  items?: ExploreItem[];
  nextCursor?: string | null;
};

type SearchItem = {
  slug: string;
  version: string;
  summary: string;
  score?: number;
  developer?: string;
  author?: string;
  displayName?: string;
};

type InstalledItem = {
  slug: string;
  version: string;
};

type LockFile = {
  version?: number;
  skills?: Record<string, { version?: string; installedAt?: number }>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function parseLooseJson<T>(raw: string): T | null {
  const clean = stripAnsi(raw);
  const startObj = clean.indexOf("{");
  const startArr = clean.indexOf("[");
  const starts = [startObj, startArr].filter((v) => v >= 0).sort((a, b) => a - b);
  if (!starts.length) return null;
  const sliced = clean.slice(starts[0]);
  try {
    return JSON.parse(sliced) as T;
  } catch {
    return null;
  }
}

function parseSearch(stdout: string): SearchItem[] {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !l.startsWith("- Searching"));

  const items: SearchItem[] = [];
  for (const line of lines) {
    const strict = line.match(/^([a-z0-9][\w-]*)\s+v([A-Za-z0-9._-]+)\s+(.*?)\s+\(([\d.]+)\)$/i);
    if (strict) {
      items.push({
        slug: strict[1] || "",
        version: strict[2] || "latest",
        summary: strict[3] || "",
        score: Number(strict[4]),
      });
      continue;
    }

    const cols = line.split(/\s{2,}/).filter(Boolean);
    if (!cols.length) continue;
    const head = cols[0] || "";
    const hm = head.match(/^([a-z0-9][\w-]*)\s+v([A-Za-z0-9._-]+)$/i);
    if (!hm) continue;
    const scoreText = cols[2]?.match(/\(([\d.]+)\)/)?.[1];
    items.push({
      slug: hm[1] || "",
      version: hm[2] || "latest",
      summary: cols[1] || "",
      score: scoreText ? Number(scoreText) : undefined,
    });
  }
  return items;
}

function isValidSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]*$/i.test(slug);
}

/* ── Native registry access via the gateway ────────────────── */

/** One row of `skills.search`. Registry metadata, not local skill state. */
type RegistryHit = {
  slug?: string;
  displayName?: string;
  summary?: string;
  version?: string;
  score?: number;
  downloads?: number;
  updatedAt?: number;
  ownerHandle?: string;
  publisher?: string;
  official?: boolean;
  featured?: boolean;
  icon?: string | null;
  install?: { kind?: string; reference?: string | null };
  metrics?: { updatedAt?: number; rolling60DayInstalls?: number };
  native?: {
    skill?: { stats?: { stars?: number; downloads?: number; installs?: number } };
    owner?: { displayName?: string; handle?: string };
  };
};

/**
 * Flatten a registry hit into the card shape the catalog UI renders. Stats live
 * under `native.skill.stats` while headline counts are duplicated at the top
 * level, so prefer the top level and fall back to the nested copy.
 */
function toCatalogItem(hit: RegistryHit) {
  const stats = hit.native?.skill?.stats;
  const slug = String(hit.slug || "");
  const owner = hit.ownerHandle || hit.native?.owner?.handle;
  return {
    slug,
    // Slugs collide across owners — "weather" resolves to several skills, and
    // the registry answers a bare one with AMBIGUOUS_SKILL_SLUG. `@owner/slug`
    // is the form the installer disambiguates on.
    ref: owner && slug ? `@${owner}/${slug}` : undefined,
    displayName: hit.displayName || undefined,
    summary: hit.summary || "",
    version: hit.version || "latest",
    score: typeof hit.score === "number" ? hit.score : undefined,
    developer: owner || hit.publisher || undefined,
    official: Boolean(hit.official),
    featured: Boolean(hit.featured),
    icon: hit.icon ?? undefined,
    installReference: hit.install?.reference ?? undefined,
    updatedAt: hit.updatedAt ?? hit.metrics?.updatedAt ?? undefined,
    // `stats` is the shape the explore path returns; keep both so either
    // source renders identically.
    stats: {
      downloads: hit.downloads ?? stats?.downloads ?? 0,
      installsCurrent: hit.metrics?.rolling60DayInstalls ?? stats?.installs ?? 0,
      installsAllTime: stats?.installs ?? 0,
      stars: stats?.stars ?? 0,
    },
    downloads: hit.downloads ?? stats?.downloads ?? 0,
    stars: stats?.stars ?? 0,
  };
}

async function nativeSearch(query: string, limit: number) {
  const payload = await gatewayCall<{ results?: RegistryHit[] }>(
    "skills.search",
    { query, limit },
    30_000,
  );
  return (payload?.results ?? []).map(toCatalogItem).filter((item) => item.slug);
}

/** Installed ClawHub skills, straight from the lockfile the installer writes. */
async function nativeInstalled(): Promise<InstalledItem[]> {
  const workspace = await getDefaultWorkspace();
  for (const dir of [".clawhub", ".clawdhub"]) {
    const lock = await readLockFile(join(workspace, dir, "lock.json"));
    const entries = Object.entries(lock.skills || {});
    if (entries.length > 0) {
      return entries.map(([slug, meta]) => ({
        slug,
        version: String(meta?.version || ""),
      }));
    }
  }
  return [];
}

async function readLockFile(path: string): Promise<LockFile> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as LockFile;
    if (!parsed || typeof parsed !== "object") {
      return { version: 1, skills: {} };
    }
    if (!parsed.skills || typeof parsed.skills !== "object") {
      parsed.skills = {};
    }
    if (!parsed.version) {
      parsed.version = 1;
    }
    return parsed;
  } catch {
    return { version: 1, skills: {} };
  }
}

async function uninstallWorkspaceSkill(slug: string): Promise<{
  removedDir: boolean;
  removedLock: boolean;
}> {
  const workspace = await getDefaultWorkspace();
  const skillDir = join(workspace, "skills", slug);
  const lockPath = join(workspace, ".clawhub", "lock.json");

  let removedDir = false;
  let removedLock = false;

  try {
    await access(skillDir, fsConstants.F_OK);
    await rm(skillDir, { recursive: true, force: true });
    removedDir = true;
  } catch {
    // best effort
  }

  const lock = await readLockFile(lockPath);
  const skills = lock.skills || {};
  if (skills[slug]) {
    delete skills[slug];
    lock.skills = skills;
    await writeFile(lockPath, JSON.stringify(lock, null, 2) + "\n", "utf-8");
    removedLock = true;
  }

  return { removedDir, removedLock };
}

function shellEscape(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

async function runClawHub(args: string[], timeout = 30000): Promise<{ stdout: string; stderr: string }> {
  const workspace = await getDefaultWorkspace();
  const fullArgs = ["--no-input", "--workdir", workspace, ...args];
  // Spawn through a login shell so the user's PATH (from ~/.zshrc, ~/.bash_profile, etc.)
  // is available — fixes "clawhub not found" when the Next.js process has a limited env.
  const shell = process.env.SHELL || "/bin/sh";
  const cmd = ["clawhub", ...fullArgs.map(shellEscape)].join(" ");
  const { stdout, stderr } = await exec(shell, ["-lc", cmd], {
    cwd: workspace,
    timeout,
    env: { ...process.env, NO_COLOR: "1", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
  });
  return { stdout, stderr };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "explore";

  try {
    if (action === "search") {
      const q = (searchParams.get("q") || "").trim();
      const limit = clamp(Number(searchParams.get("limit") || 24), 1, 50);
      if (!q) return NextResponse.json({ items: [] });
      try {
        return NextResponse.json({ items: await nativeSearch(q, limit) });
      } catch (rpcErr) {
        try {
          const { stdout } = await runClawHub(["search", q, "--limit", String(limit)], 30000);
          return NextResponse.json({
            items: parseSearch(stdout),
            warning: `skills.search unavailable (${String(rpcErr)}); used the clawhub CLI.`,
          });
        } catch (cliErr) {
          // Report why the gateway refused, not that the optional CLI is
          // absent — the former is the actionable failure.
          throw isClawhubNotFound(cliErr) ? rpcErr : cliErr;
        }
      }
    }

    if (action === "list") {
      return NextResponse.json({ items: await nativeInstalled() });
    }

    if (action === "inspect") {
      const slug = (searchParams.get("slug") || "").trim();
      if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
      try {
        // `skills.detail` is keyed by slug alone — it always describes the
        // latest published version.
        return NextResponse.json(
          await gatewayCall<Record<string, unknown>>("skills.detail", { slug }, 20_000),
        );
      } catch (rpcErr) {
        try {
          const version = (searchParams.get("version") || "").trim();
          const args = ["inspect", slug, "--json"];
          if (version) args.push("--version", version);
          const { stdout } = await runClawHub(args, 20000);
          const parsed = parseLooseJson<Record<string, unknown>>(stdout);
          return NextResponse.json(
            parsed
              ? { ...parsed, warning: `skills.detail unavailable (${String(rpcErr)}); used the clawhub CLI.` }
              : { ok: false, raw: stdout },
          );
        } catch (cliErr) {
          // A bare slug several owners publish comes back as
          // AMBIGUOUS_SKILL_SLUG listing the qualified refs. Surface that
          // rather than blaming a missing optional CLI.
          throw isClawhubNotFound(cliErr) ? rpcErr : cliErr;
        }
      }
    }

    // Browse without a query. No gateway equivalent, so this is the one action
    // that still needs the standalone CLI.
    const limit = clamp(Number(searchParams.get("limit") || 24), 1, 100);
    const sort = (searchParams.get("sort") || "trending").trim();
    try {
      const { stdout } = await runClawHub(
        ["explore", "--limit", String(limit), "--sort", sort, "--json"],
        30000,
      );
      const parsed = parseLooseJson<ExplorePayload>(stdout);
      return NextResponse.json({
        items: parsed?.items || [],
        nextCursor: parsed?.nextCursor || null,
      });
    } catch (err) {
      if (!isClawhubNotFound(err)) throw err;
      // Report an empty catalog rather than CLAWHUB_NOT_FOUND: search, install
      // and update all work without the binary, and that code makes the client
      // disable them.
      return NextResponse.json({
        items: [],
        nextCursor: null,
        browseUnavailable: true,
        notice:
          "Browsing the catalog needs the standalone `clawhub` CLI. Search for a skill by name to install it without one.",
      });
    }
  } catch (err) {
    if (isClawhubNotFound(err)) {
      return NextResponse.json(
        { error: "ClawHub CLI not found.", code: "CLAWHUB_NOT_FOUND" },
        { status: 503 }
      );
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

function isClawhubNotFound(err: unknown): boolean {
  const e = err as NodeJS.ErrnoException;
  if (e?.code === "ENOENT") return true;
  const msg = (e?.message ?? String(err)).toLowerCase();
  // Direct spawn ENOENT (non-shell mode)
  if (msg.includes("enoent") && (msg.includes("clawhub") || msg.includes("spawn"))) return true;
  // Login shell returns exit code 127 when the command is not found
  const stderr = (e as { stderr?: string })?.stderr?.toLowerCase() ?? "";
  if (msg.includes("exit code 127") || stderr.includes("command not found") || stderr.includes("not found")) return true;
  return false;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;
    const slug = (body.slug as string | undefined)?.trim();
    const version = (body.version as string | undefined)?.trim();

    if (action === "install") {
      const ref = (body.ref as string | undefined)?.trim();
      // Prefer the owner-qualified `@owner/slug`: a bare slug that several
      // owners publish is rejected by the registry as ambiguous.
      const target = ref || slug;
      if (!target) return NextResponse.json({ error: "slug or ref required" }, { status: 400 });
      const force = Boolean(body.force);
      // `force` doubles as the client's "install it anyway" answer to a trust
      // warning, which is a separate acknowledgement on this API.
      const result = await gatewayCall<{
        ok?: boolean;
        message?: string;
        slug?: string;
        version?: string;
        warning?: string;
      }>(
        "skills.install",
        {
          source: "clawhub",
          slug: target,
          ...(version ? { version } : {}),
          ...(force ? { force: true, acknowledgeClawHubRisk: true } : {}),
        },
        120_000,
      );
      return NextResponse.json({
        ok: true,
        action,
        slug: result.slug ?? slug,
        version: result.version,
        output: [result.message, result.warning].filter(Boolean).join("\n"),
      });
    }

    if (action === "update") {
      const result = await gatewayCall<{ message?: string; ok?: boolean }>(
        "skills.update",
        {
          source: "clawhub",
          ...(slug ? { slug } : { all: true }),
          ...(body.force ? { acknowledgeClawHubRisk: true } : {}),
        },
        120_000,
      );
      return NextResponse.json({
        ok: true,
        action,
        slug: slug || null,
        output: result.message || "",
      });
    }

    if (action === "uninstall") {
      if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
      if (!isValidSlug(slug)) {
        return NextResponse.json({ error: "invalid slug" }, { status: 400 });
      }
      const result = await uninstallWorkspaceSkill(slug);
      if (!result.removedDir && !result.removedLock) {
        return NextResponse.json(
          { error: `Skill "${slug}" not found in workspace` },
          { status: 404 }
        );
      }
      return NextResponse.json({
        ok: true,
        action,
        slug,
        output: `Removed ${slug} from workspace skills.`,
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    if (isClawhubNotFound(err)) {
      return NextResponse.json(
        { error: "ClawHub CLI not found.", code: "CLAWHUB_NOT_FOUND" },
        { status: 503 }
      );
    }
    const e = err as { message?: string; stdout?: string; stderr?: string };
    const details = [e.message, e.stderr, e.stdout].filter(Boolean).join("\n");
    return NextResponse.json({ error: details || String(err) }, { status: 500 });
  }
}
