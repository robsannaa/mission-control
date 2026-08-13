import { NextRequest, NextResponse } from "next/server";
import { access, readFile, realpath, rm, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import { resolve, sep } from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { configuredTransport, gatewayCall, runLocalCliCapture } from "@/lib/openclaw";
import { loadSkillsInventory } from "@/lib/skills-status";
import type {
  InstalledSkillCatalogItem,
  SkillCatalogCapabilities,
  SkillCatalogItem,
  SkillCatalogSource,
  SkillTrustSignal,
} from "@/lib/skills-catalog";

export const dynamic = "force-dynamic";

const CLAWHUB_ORIGIN = "https://clawhub.ai";
const SKILLS_SH_ORIGIN = "https://skills.sh";

type RegistryHit = {
  id?: string;
  slug?: string;
  displayName?: string;
  summary?: string;
  version?: string | null;
  score?: number;
  downloads?: number;
  updatedAt?: number;
  ownerHandle?: string;
  source?: string;
  canonicalUrl?: string;
  official?: boolean;
  featured?: boolean;
  install?: { kind?: string; reference?: string | null; sourceUrl?: string | null };
  links?: { canonical?: string | null; source?: string | null };
  publisher?: { displayName?: string; handle?: string; official?: boolean } | string;
  metrics?: { updatedAt?: number; rolling60DayInstalls?: number };
  sourceIdentity?: { owner?: string | null; repo?: string | null };
  trust?: {
    clawHubVerdict?: string | null;
    installability?: string;
    sourceFreshness?: string;
    visibility?: string;
    upstreamScanners?: unknown;
  };
  native?: {
    owner?: { displayName?: string; handle?: string };
    skill?: { isSuspicious?: boolean; stats?: { stars?: number; downloads?: number; installs?: number } };
  };
};

type ExploreItem = {
  slug?: string;
  displayName?: string;
  summary?: string;
  updatedAt?: number;
  latestVersion?: { version?: string };
  stats?: { downloads?: number; installs?: number; stars?: number };
};

type SkillsShItem = {
  id?: string;
  slug?: string;
  name?: string;
  source?: string;
  installs?: number;
  sourceType?: string;
  installUrl?: string | null;
  url?: string;
  isDuplicate?: boolean;
  isOfficial?: boolean;
  skillId?: string;
  weeklyInstalls?: number[];
};

type LockFile = {
  version?: number;
  skills?: Record<string, { version?: string; installedAt?: number }>;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizedSource(hit: RegistryHit): SkillCatalogSource {
  const source = String(hit.source || hit.install?.kind || "clawhub").toLowerCase();
  if (source === "skills-sh" || source === "skills.sh" || source === "skills_sh") return "skills-sh";
  if (source === "git" || source === "github") return "git";
  return "clawhub";
}

function normalizeSignalStatus(value: unknown): SkillTrustSignal["status"] {
  const status = String(value || "").toLowerCase();
  if (["pass", "passed", "clean", "safe", "ok"].includes(status)) return "pass";
  if (["fail", "failed", "malicious", "blocked", "unsafe"].includes(status)) return "fail";
  if (["warn", "warning", "suspicious", "review"].includes(status)) return "warn";
  return "unknown";
}

function normalizeSignals(value: unknown): SkillTrustSignal[] {
  if (!value) return [];
  const rows = Array.isArray(value)
    ? value
    : typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).map(([provider, result]) => ({ provider, result }))
      : [];
  return rows.map((row, index) => {
    const record = row && typeof row === "object" ? row as Record<string, unknown> : {};
    const nested = record.result && typeof record.result === "object"
      ? record.result as Record<string, unknown>
      : record;
    return {
      provider: String(record.provider || record.name || nested.provider || nested.name || `Scanner ${index + 1}`),
      status: normalizeSignalStatus(nested.status || nested.verdict || nested.result),
      message: typeof nested.message === "string" ? nested.message : undefined,
    };
  });
}

function toCatalogItem(hit: RegistryHit): SkillCatalogItem | null {
  const slug = String(hit.slug || "").trim();
  if (!slug) return null;
  const source = normalizedSource(hit);
  const stats = hit.native?.skill?.stats;
  const owner = hit.ownerHandle || hit.sourceIdentity?.owner || hit.native?.owner?.handle || undefined;
  const publisherObject = typeof hit.publisher === "object" ? hit.publisher : null;
  const installKind = source === "skills-sh" ? "skills-sh" : source === "git" ? "git" : "clawhub";
  const installReference = hit.install?.reference || (
    source === "clawhub" && owner ? `${owner}/${slug}` : null
  );
  const signals = normalizeSignals(hit.trust?.upstreamScanners);
  const verdict = hit.trust?.clawHubVerdict || null;
  const verdictStatus = normalizeSignalStatus(verdict);
  const blocked = hit.trust?.installability === "blocked" || verdictStatus === "fail" || signals.some((signal) => signal.status === "fail");
  const warning = Boolean(hit.native?.skill?.isSuspicious) || verdictStatus === "warn" || signals.some((signal) => signal.status === "warn");
  const unscanned = source !== "clawhub" || hit.trust?.sourceFreshness === "observed-only" || (!verdict && signals.length === 0);
  const canonicalPath = hit.canonicalUrl || hit.links?.canonical || undefined;
  return {
    id: String(hit.id || `${source}:${installReference || slug}`),
    slug,
    displayName: hit.displayName || slug,
    summary: hit.summary || "",
    source,
    installKind,
    installReference,
    canonicalUrl: canonicalPath
      ? canonicalPath.startsWith("http") ? canonicalPath : `${CLAWHUB_ORIGIN}${canonicalPath}`
      : undefined,
    sourceUrl: hit.install?.sourceUrl || hit.links?.source || undefined,
    owner,
    publisher: publisherObject?.displayName || publisherObject?.handle || (typeof hit.publisher === "string" ? hit.publisher : hit.native?.owner?.displayName),
    version: hit.version || undefined,
    score: typeof hit.score === "number" ? hit.score : undefined,
    downloads: hit.downloads ?? stats?.downloads ?? 0,
    installsCurrent: hit.metrics?.rolling60DayInstalls ?? stats?.installs ?? 0,
    stars: stats?.stars ?? 0,
    updatedAt: hit.updatedAt ?? hit.metrics?.updatedAt,
    official: Boolean(hit.official || publisherObject?.official),
    featured: Boolean(hit.featured),
    trust: {
      status: blocked ? "blocked" : warning ? "warning" : unscanned ? "unscanned" : "trusted",
      installability: blocked ? "blocked" : hit.trust?.installability === "installable" ? "installable" : "unknown",
      sourceFreshness: hit.trust?.sourceFreshness,
      verdict,
      signals,
    },
  };
}

function fromExplore(item: ExploreItem): SkillCatalogItem | null {
  const slug = String(item.slug || "").trim();
  if (!slug) return null;
  return {
    id: `clawhub:${slug}`,
    slug,
    displayName: item.displayName || slug,
    summary: item.summary || "",
    source: "clawhub",
    installKind: "clawhub",
    installReference: slug,
    version: item.latestVersion?.version || undefined,
    downloads: item.stats?.downloads ?? 0,
    installsCurrent: item.stats?.installs ?? 0,
    stars: item.stats?.stars ?? 0,
    updatedAt: item.updatedAt,
    trust: {
      status: "unscanned",
      installability: "unknown",
      sourceFreshness: "native",
      verdict: null,
      signals: [],
    },
  };
}

function fromSkillsSh(item: SkillsShItem): SkillCatalogItem | null {
  const source = String(item.source || "").trim();
  const slug = String(item.slug || item.skillId || "").trim();
  if (!source || !slug) return null;
  const id = String(item.id || `${source}/${slug}`);
  const canonicalUrl = item.url || `${SKILLS_SH_ORIGIN}/${id}`;
  const sourceUrl = item.installUrl || (/^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}` : undefined);
  return {
    id: `skills-sh:${id}`,
    slug,
    displayName: item.name || slug,
    summary: `Agent Skill published from ${source}.`,
    source: "skills-sh",
    installKind: "skills-sh",
    installReference: `skills-sh:${source}/${slug}`,
    canonicalUrl,
    sourceUrl,
    owner: source.split("/")[0] || undefined,
    downloads: item.installs ?? 0,
    installsCurrent: Array.isArray(item.weeklyInstalls) && item.weeklyInstalls.length > 0
      ? item.weeklyInstalls[item.weeklyInstalls.length - 1]
      : undefined,
    official: Boolean(item.isOfficial),
    trust: {
      status: "unscanned",
      installability: "unknown",
      sourceFreshness: "skills-sh",
      verdict: null,
      signals: [],
    },
  };
}

function parseSkillsShPage(html: string): SkillsShItem[] {
  const match = html.match(/\\"initialSkills\\":(\[[\s\S]*?\]),\\"totalSkills/);
  if (!match?.[1]) throw new Error("Skills.sh public catalog format changed");
  return JSON.parse(match[1].replace(/\\"/g, '"')) as SkillsShItem[];
}

async function fetchSkillsShApi(path: string): Promise<SkillsShItem[] | null> {
  const token = process.env.VERCEL_OIDC_TOKEN?.trim();
  if (!token) return null;
  const response = await fetch(`${SKILLS_SH_ORIGIN}${path}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Skills.sh catalog returned HTTP ${response.status}`);
  const payload = await response.json() as { data?: SkillsShItem[] };
  return Array.isArray(payload.data) ? payload.data : [];
}

async function publicSkillsShCatalog(): Promise<SkillsShItem[]> {
  const response = await fetch(`${SKILLS_SH_ORIGIN}/`, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`Skills.sh public catalog returned HTTP ${response.status}`);
  return parseSkillsShPage(await response.text());
}

async function browseSkillsSh(sort: string, limit: number): Promise<SkillCatalogItem[]> {
  const view = sort === "trending" ? "trending" : "all-time";
  const apiItems = await fetchSkillsShApi(`/api/v1/skills?view=${view}&page=0&per_page=${clamp(limit, 1, 100)}`);
  const items = apiItems || await publicSkillsShCatalog();
  return items
    .map(fromSkillsSh)
    .filter((item): item is SkillCatalogItem => Boolean(item))
    .slice(0, limit);
}

async function searchSkillsSh(query: string, limit: number): Promise<SkillCatalogItem[]> {
  const apiItems = query.length >= 2
    ? await fetchSkillsShApi(`/api/v1/skills/search?q=${encodeURIComponent(query)}&limit=${clamp(limit, 1, 100)}`)
    : null;
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = apiItems || (await publicSkillsShCatalog()).filter((item) => {
    const haystack = `${item.name || ""} ${item.skillId || ""} ${item.source || ""}`.toLocaleLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  return items
    .map(fromSkillsSh)
    .filter((item): item is SkillCatalogItem => Boolean(item))
    .slice(0, limit);
}

function mergeCatalogItems(...groups: SkillCatalogItem[][]): SkillCatalogItem[] {
  const merged = new Map<string, SkillCatalogItem>();
  for (const item of groups.flat()) {
    const key = `${item.source}:${item.installReference || item.slug}`.toLocaleLowerCase();
    if (!merged.has(key)) merged.set(key, item);
  }
  return [...merged.values()];
}

async function searchCatalog(query: string, limit: number): Promise<SkillCatalogItem[]> {
  const payload = await gatewayCall<{ results?: RegistryHit[] }>("skills.search", { query, limit }, 30_000);
  return (payload.results || []).map(toCatalogItem).filter((item): item is SkillCatalogItem => Boolean(item));
}

async function browseCatalog(sort: string, limit: number): Promise<SkillCatalogItem[]> {
  const params = new URLSearchParams({ sort, limit: String(limit) });
  const response = await fetch(`${CLAWHUB_ORIGIN}/api/v1/skills?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`ClawHub catalog returned HTTP ${response.status}`);
  const payload = await response.json() as { items?: ExploreItem[]; nextCursor?: string | null };
  return (payload.items || []).map(fromExplore).filter((item): item is SkillCatalogItem => Boolean(item));
}

async function readLockFile(path: string): Promise<LockFile> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as LockFile;
    return parsed && typeof parsed === "object" ? { version: parsed.version || 1, skills: parsed.skills || {} } : { version: 1, skills: {} };
  } catch {
    return { version: 1, skills: {} };
  }
}

function localSource(source: string, bundled: boolean): SkillCatalogSource {
  const value = source.toLowerCase();
  if (bundled || value.includes("bundled")) return "bundled";
  if (value.includes("plugin")) return "plugin";
  if (value.includes("git")) return "git";
  if (value.includes("skills-sh") || value.includes("skills.sh")) return "skills-sh";
  if (value.includes("clawhub") || value.includes("workspace")) return "clawhub";
  return "local";
}

async function installedCatalog(): Promise<InstalledSkillCatalogItem[]> {
  const [{ status }, workspace] = await Promise.all([loadSkillsInventory(), getDefaultWorkspace()]);
  const locks = await Promise.all([
    readLockFile(resolve(workspace, ".clawhub", "lock.json")),
    readLockFile(resolve(workspace, ".clawdhub", "lock.json")),
  ]);
  const versions = Object.assign({}, ...locks.map((lock) => lock.skills || {})) as Record<string, { version?: string }>;
  return status.skills.map((skill) => {
    const slug = skill.skillKey || skill.name;
    return {
      id: `${localSource(skill.source, skill.bundled)}:${slug}`,
      slug,
      name: skill.name,
      version: String(versions[slug]?.version || ""),
      source: localSource(skill.source, skill.bundled),
      enabled: !skill.disabled,
      bundled: skill.bundled,
      skillKey: skill.skillKey || skill.name,
      filePath: skill.filePath,
    };
  });
}

async function catalogCapabilities(): Promise<SkillCatalogCapabilities> {
  const safeLocalExecution = configuredTransport() !== "http";
  let openClawVersion: string | null = null;
  let skillsShInstall = false;
  let gitInstall = false;
  if (safeLocalExecution) {
    const [versionResult, installHelp] = await Promise.all([
      runLocalCliCapture(["--version"], 8_000).catch(() => null),
      runLocalCliCapture(["skills", "install", "--help"], 8_000).catch(() => null),
    ]);
    if (versionResult?.code === 0) openClawVersion = versionResult.stdout.trim().replace(/^openclaw\s+/i, "") || null;
    const help = `${installHelp?.stdout || ""}\n${installHelp?.stderr || ""}`;
    skillsShInstall = /skills-sh:/i.test(help);
    gitInstall = /git:/i.test(help);
  }
  return {
    openClawVersion,
    catalogBrowse: true,
    catalogSearch: true,
    clawHubInstall: true,
    skillsShInstall,
    gitInstall,
    archiveInstall: false,
    safeLocalExecution,
    updateInUi: true,
    reasons: {
      ...(!skillsShInstall ? { "skills-sh": safeLocalExecution
        ? "This OpenClaw version can browse Skills.sh but cannot install Skills.sh references yet. Update OpenClaw from this app to enable it."
        : "Skills.sh installs require Mission Control to run on the OpenClaw host until the gateway exposes a structured source-install RPC." } : {}),
      ...(!gitInstall ? { git: safeLocalExecution
        ? "This OpenClaw version does not advertise Git skill installation. Update OpenClaw from this app to enable it."
        : "Git installs require Mission Control to run on the OpenClaw host until the gateway exposes a structured source-install RPC." } : {}),
      archive: "Archive installation is disabled until this gateway exposes the staged skills upload RPC.",
    },
  };
}

function isValidClawHubReference(value: string): boolean {
  return /^@?[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(value) || /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}

function isValidSkillsShReference(value: string): boolean {
  return /^skills-sh:[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.\/-]*$/i.test(value);
}

function isValidGitReference(value: string): boolean {
  if (!/^git:[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*(?:@[a-z0-9][a-z0-9_.\/-]*)?$/i.test(value)) return false;
  return !value.includes("..") && !/[\s;&|`$<>\\]/.test(value);
}

async function disableInstalledSkill(skillKey: string): Promise<void> {
  try {
    await gatewayCall("skills.update", { skillKey, enabled: false }, 15_000);
  } catch {
    // Older gateways may not expose toggles for freshly-installed skills. The
    // UI still refreshes readiness and lets the user disable it immediately.
  }
}

async function installExternal(
  reference: string,
  source: "skills-sh" | "git",
  agentId?: string,
  scope?: "workspace" | "global",
): Promise<{ stdout: string; stderr: string }> {
  const available = await catalogCapabilities();
  if ((source === "skills-sh" && !available.skillsShInstall) || (source === "git" && !available.gitInstall)) {
    throw new Error(available.reasons[source] || "This source is not supported by the connected OpenClaw version.");
  }
  if (source === "skills-sh" && !isValidSkillsShReference(reference)) throw new Error("Invalid Skills.sh reference. Use skills-sh:owner/repository/skill.");
  if (source === "git" && !isValidGitReference(reference)) throw new Error("Invalid Git reference. Use git:owner/repository or git:owner/repository@ref.");
  const args = ["skills", "install", reference];
  if (agentId) args.push("--agent", agentId);
  else if (scope === "global") args.push("--global");
  const result = await runLocalCliCapture(args, 180_000);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || "OpenClaw could not install this skill.");
  return result;
}

async function removeInstalledSkill(slug: string): Promise<boolean> {
  const [{ status }, workspace] = await Promise.all([loadSkillsInventory(), getDefaultWorkspace()]);
  const row = status.skills.find((skill) => skill.name === slug || skill.skillKey === slug);
  if (!row || row.bundled || !row.filePath) return false;
  const allowedRoot = await realpath(resolve(workspace, "skills")).catch(() => resolve(workspace, "skills"));
  const target = await realpath(resolve(row.filePath, "..")).catch(() => resolve(row.filePath as string, ".."));
  if (target !== allowedRoot && !target.startsWith(`${allowedRoot}${sep}`)) {
    throw new Error("This skill is outside the workspace. Manage it from the scope where it was installed.");
  }
  await access(target, fsConstants.F_OK);
  await rm(target, { recursive: true, force: false });

  for (const dir of [".clawhub", ".clawdhub"]) {
    const lockPath = resolve(workspace, dir, "lock.json");
    const lock = await readLockFile(lockPath);
    let changed = false;
    for (const key of Object.keys(lock.skills || {})) {
      if (key === slug || key.endsWith(`/${slug}`)) {
        delete lock.skills?.[key];
        changed = true;
      }
    }
    if (changed) await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, "utf-8");
  }
  return true;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "explore";
  try {
    if (action === "capabilities") return NextResponse.json(await catalogCapabilities());
    if (action === "list") return NextResponse.json({ items: await installedCatalog() });
    if (action === "search") {
      const query = String(searchParams.get("q") || "").trim();
      if (!query) return NextResponse.json({ items: [] });
      const limit = clamp(Number(searchParams.get("limit") || 28), 1, 50);
      const [clawHubItems, skillsShItems] = await Promise.all([
        searchCatalog(query, limit),
        searchSkillsSh(query, limit).catch(() => []),
      ]);
      return NextResponse.json({ items: mergeCatalogItems(clawHubItems, skillsShItems) });
    }
    if (action === "inspect") {
      const slug = String(searchParams.get("slug") || "").trim();
      if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
      return NextResponse.json(await gatewayCall<Record<string, unknown>>("skills.detail", { slug }, 20_000));
    }
    const sort = String(searchParams.get("sort") || "trending");
    const limit = clamp(Number(searchParams.get("limit") || 28), 1, 100);
    const [clawHubItems, skillsShItems] = await Promise.all([
      browseCatalog(sort, limit),
      browseSkillsSh(sort, limit).catch(() => []),
    ]);
    return NextResponse.json({ items: mergeCatalogItems(clawHubItems, skillsShItems) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const action = String(body.action || "");
    const slug = String(body.slug || "").trim();
    const source = String(body.source || "clawhub") as SkillCatalogSource;
    const reference = String(body.installReference || body.ref || slug).trim();

    if (action === "install") {
      if (source === "clawhub") {
        if (!isValidClawHubReference(reference)) return NextResponse.json({ error: "Invalid ClawHub reference." }, { status: 400 });
        const result = await gatewayCall<{ slug?: string; version?: string; message?: string; warning?: string }>(
          "skills.install",
          {
            source: "clawhub",
            slug: reference,
            ...(body.version ? { version: String(body.version) } : {}),
            ...(body.acknowledgeRisk ? { force: true, acknowledgeClawHubRisk: true } : {}),
          },
          120_000,
        );
        await disableInstalledSkill(result.slug || slug);
        return NextResponse.json({ ok: true, ...result, output: [result.message, result.warning].filter(Boolean).join("\n") });
      }
      if (source === "skills-sh" || source === "git") {
        if (source === "skills-sh" && !isValidSkillsShReference(reference)) {
          return NextResponse.json({ error: "Invalid Skills.sh reference. Use skills-sh:owner/repository/skill.", code: "INVALID_SKILL_REFERENCE" }, { status: 400 });
        }
        if (source === "git" && !isValidGitReference(reference)) {
          return NextResponse.json({ error: "Invalid Git reference. Use git:owner/repository or git:owner/repository@ref.", code: "INVALID_SKILL_REFERENCE" }, { status: 400 });
        }
        const result = await installExternal(
          reference,
          source,
          typeof body.agentId === "string" ? body.agentId.trim() || undefined : undefined,
          body.scope === "global" ? "global" : "workspace",
        );
        await disableInstalledSkill(slug || reference.split("/").pop() || reference);
        return NextResponse.json({ ok: true, slug: slug || reference.split("/").pop(), output: [result.stdout, result.stderr].filter(Boolean).join("\n") });
      }
      return NextResponse.json({ error: `Installation from ${source} is not supported.` }, { status: 400 });
    }

    if (action === "update") {
      if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 });
      if (source === "git" || source === "skills-sh") {
        const result = await installExternal(reference, source, undefined, "workspace");
        return NextResponse.json({ ok: true, slug, output: [result.stdout, result.stderr].filter(Boolean).join("\n") });
      }
      const result = await gatewayCall<{ message?: string }>("skills.update", {
        source: "clawhub",
        slug,
        ...(body.acknowledgeRisk ? { acknowledgeClawHubRisk: true } : {}),
      }, 120_000);
      return NextResponse.json({ ok: true, slug, output: result.message || "" });
    }

    if (action === "uninstall") {
      if (!slug || !/^[a-z0-9][a-z0-9_-]*$/i.test(slug)) return NextResponse.json({ error: "Valid slug required" }, { status: 400 });
      const removed = await removeInstalledSkill(slug);
      if (!removed) return NextResponse.json({ error: "Only workspace-installed skills can be uninstalled. Built-in, shared, and global skills are protected." }, { status: 409 });
      return NextResponse.json({ ok: true, slug, scope: "workspace" });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const suspicious = /suspicious|risk|virus|malicious|unsafe/i.test(message);
    return NextResponse.json({ error: message, code: suspicious ? "TRUST_REVIEW_REQUIRED" : "SKILL_ACTION_FAILED" }, { status: suspicious ? 409 : 500 });
  }
}
