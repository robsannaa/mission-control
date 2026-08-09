import { NextRequest, NextResponse } from "next/server";
import { readdir, realpath, stat } from "fs/promises";
import { join, relative, sep } from "path";
import { gatewayCall } from "@/lib/openclaw";
import { getDefaultWorkspace } from "@/lib/paths";

export const dynamic = "force-dynamic";

/**
 * Workspace file index for the composer's `@` picker.
 *
 * Path safety is structural rather than validated: the caller never supplies a
 * path. The root is resolved server-side from the agent's own workspace (the
 * gateway's `agents.list` reports it), the walk refuses to follow symlinks, and
 * every result is emitted as a workspace-relative path. There is therefore no
 * `..` to reject and no way to point this at ~/.ssh — unlike
 * /api/workspace/files, which takes an arbitrary `path` query parameter.
 */

const MAX_FILES = 4000;
const MAX_DEPTH = 6;
const MAX_RESULTS = 60;
const CACHE_TTL_MS = 20_000;

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "out",
  "target",
  "vendor",
  "__pycache__",
  ".venv",
  "venv",
]);

export type WorkspaceFile = {
  /** Workspace-relative, forward-slashed. */
  path: string;
  name: string;
  dir: string;
  size: number;
  mtime: number;
};

type Index = { root: string; files: WorkspaceFile[]; truncated: boolean };

const rootCache = new Map<string, { at: number; agentRoot: string }>();
const indexCache = new Map<string, { at: number; index: Index }>();

async function resolveRoot(agentId: string | undefined): Promise<string> {
  const cacheId = agentId || "__default__";
  const cached = rootCache.get(cacheId);
  if (cached && Date.now() - cached.at < 60_000) return cached.agentRoot;

  let root = "";
  try {
    const data = await gatewayCall<{
      defaultId?: string;
      agents?: Array<{ id?: string; workspace?: string }>;
    }>("agents.list", {}, 8000);
    const agents = Array.isArray(data.agents) ? data.agents : [];
    const wanted = agentId || data.defaultId;
    const match =
      agents.find((agent) => agent.id === wanted) ??
      agents.find((agent) => agent.id === data.defaultId) ??
      agents[0];
    root = typeof match?.workspace === "string" ? match.workspace : "";
  } catch {
    // Gateway down — fall through to the locally discoverable workspace.
  }
  if (!root) root = await getDefaultWorkspace();

  const resolved = await realpath(root).catch(() => root);
  rootCache.set(cacheId, { at: Date.now(), agentRoot: resolved });
  return resolved;
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: WorkspaceFile[],
): Promise<boolean> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out.length >= MAX_FILES;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return false;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (out.length >= MAX_FILES) return true;
    // Never traverse a symlink: that is the only way a walk rooted inside the
    // workspace could ever emit a path from outside it.
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      if (await walk(root, full, depth + 1, out)) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;

    try {
      const info = await stat(full);
      const rel = relative(root, full).split(sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      const slash = rel.lastIndexOf("/");
      out.push({
        path: rel,
        name: entry.name,
        dir: slash >= 0 ? rel.slice(0, slash) : "",
        size: info.size,
        mtime: info.mtimeMs,
      });
    } catch {
      // Unreadable entry — skip it rather than failing the whole picker.
    }
  }
  return out.length >= MAX_FILES;
}

async function buildIndex(root: string): Promise<Index> {
  const cached = indexCache.get(root);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.index;

  const files: WorkspaceFile[] = [];
  const truncated = await walk(root, root, 0, files);
  files.sort((a, b) => b.mtime - a.mtime);
  const index: Index = { root, files, truncated };
  indexCache.set(root, { at: Date.now(), index });
  return index;
}

/** Subsequence match — "wsnp" finds "workspace/notes/plan.md". */
function score(file: WorkspaceFile, query: string): number {
  if (!query) return file.mtime / 1e13;
  const path = file.path.toLowerCase();
  const name = file.name.toLowerCase();

  const nameIdx = name.indexOf(query);
  if (nameIdx === 0) return 1000 - name.length * 0.01;
  if (nameIdx > 0) return 800 - nameIdx;
  const pathIdx = path.indexOf(query);
  if (pathIdx >= 0) return 600 - pathIdx * 0.1;

  let cursor = 0;
  let hits = 0;
  for (const char of query) {
    const found = path.indexOf(char, cursor);
    if (found < 0) return -1;
    cursor = found + 1;
    hits += 1;
  }
  return 200 + hits;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId")?.trim() || undefined;
  const query = (searchParams.get("q") || "").trim().toLowerCase().slice(0, 120);

  try {
    const root = await resolveRoot(agentId);
    const index = await buildIndex(root);

    const scored: Array<{ file: WorkspaceFile; score: number }> = [];
    for (const file of index.files) {
      const value = score(file, query);
      if (value < 0) continue;
      scored.push({ file, score: value });
      // Without a query the index is already newest-first, so stop early.
      if (!query && scored.length >= MAX_RESULTS) break;
    }
    scored.sort((a, b) => b.score - a.score);

    return NextResponse.json(
      {
        root,
        truncated: index.truncated,
        total: index.files.length,
        files: scored.slice(0, MAX_RESULTS).map((entry) => entry.file),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("chat/files failed:", err);
    return NextResponse.json(
      { error: "Could not read the agent workspace." },
      { status: 502 },
    );
  }
}
