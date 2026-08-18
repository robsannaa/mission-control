import { NextRequest, NextResponse } from "next/server";
import { readdir, realpath, stat } from "fs/promises";
import { extname, join, relative } from "path";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound } from "@/lib/api-errors";
import { workspaceFilesGetQuerySchema, type WorkspaceFilesGetQuery } from "@/lib/schemas/workspace";

type WorkspaceFileRow = {
  relativePath: string;
  size: number;
  mtime: number;
  ext: string;
};

const MAX_FILES = 2000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
]);

function safeRelative(root: string, filePath: string): string {
  const rel = relative(root, filePath);
  return rel.replace(/\\/g, "/");
}

async function walkFiles(
  rootDir: string,
  currentDir: string,
  depth: number,
  out: WorkspaceFileRow[]
): Promise<boolean> {
  if (depth > MAX_DEPTH) return false;
  if (out.length >= MAX_FILES) return true;

  let entries;
  try {
    entries = await readdir(currentDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return false;
  }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (out.length >= MAX_FILES) return true;
    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const reachedLimit = await walkFiles(rootDir, fullPath, depth + 1, out);
      if (reachedLimit) return true;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const s = await stat(fullPath);
      if (!s.isFile()) continue;
      out.push({
        relativePath: safeRelative(rootDir, fullPath),
        size: s.size,
        mtime: s.mtimeMs,
        ext: extname(entry.name).toLowerCase(),
      });
    } catch {
      // best effort
    }
  }

  return out.length >= MAX_FILES;
}

/**
 * `path` here is deliberately not workspace-relative or root-confined — this
 * route browses whatever absolute directory an agent reports as its own
 * workspace (`src/components/agents-view.tsx` passes each agent's
 * server-reported `workspace` path straight through), so
 * `workspaceFilesGetQuerySchema` only bounds length and rejects a null byte
 * (see `src/lib/schemas/workspace.ts`).
 */
export const GET = withRoute<unknown, WorkspaceFilesGetQuery>(
  { name: "/api/workspace/files", querySchema: workspaceFilesGetQuerySchema },
  async (_request: NextRequest, ctx) => {
  const rawPath = (ctx.query.path || "").trim();
  if (!rawPath) {
    return badRequest("Missing required query param: path");
  }

  let workspacePath = rawPath;
  try {
    workspacePath = await realpath(rawPath);
  } catch {
    // keep raw path for better error message
  }

  let s;
  try {
    s = await stat(workspacePath);
  } catch {
    return notFound(`Workspace path not found: ${workspacePath}`);
  }
  if (!s.isDirectory()) {
    return badRequest(`Workspace path is not a directory: ${workspacePath}`);
  }

  const files: WorkspaceFileRow[] = [];
  const truncated = await walkFiles(workspacePath, workspacePath, 0, files);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return NextResponse.json({
    workspacePath,
    fileCount: files.length,
    truncated,
    files,
  });
  },
);
