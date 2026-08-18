import { NextResponse } from "next/server";
import { readdir, readFile, stat, writeFile, unlink, rename, copyFile, mkdir } from "fs/promises";
import { join, resolve, extname, dirname, basename } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { withRoute } from "@/lib/api-route";
import {
  docsDeleteQuerySchema,
  docsGetQuerySchema,
  docsPatchSchema,
  docsPostSchema,
  docsPutSchema,
} from "@/lib/schemas/knowledge";
import { badRequest, conflict, serverError } from "@/lib/api-errors";

const OPENCLAW_HOME = getOpenClawHome();

/** Resolve a user-supplied path safely within OPENCLAW_HOME. Returns null if traversal is detected. */
function safePath(filePath: string): string | null {
  const cleaned = filePath.replace(/^\/+/, "");
  const full = resolve(OPENCLAW_HOME, cleaned);
  if (!full.startsWith(OPENCLAW_HOME + "/") && full !== OPENCLAW_HOME) return null;
  return full;
}

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "second-brain",
  "browser",
  "logs",
  "identity",
  "devices",
  "telegram",
  "completions",
  "cron",
  "agents",
]);

type FileInfo = {
  path: string;
  name: string;
  mtime: string;
  size: number;
  tag: string;
  workspace: string;
  ext: string;
};

async function discoverWorkspaces(): Promise<{ name: string; dir: string }[]> {
  try {
    const entries = await readdir(OPENCLAW_HOME, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith("workspace"))
      .map((e) => ({ name: e.name, dir: join(OPENCLAW_HOME, e.name) }));
  } catch {
    return [];
  }
}

async function scanDir(
  dir: string,
  prefix: string,
  wsName: string,
  maxDepth = 3,
  depth = 0
): Promise<FileInfo[]> {
  if (depth >= maxDepth) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const results: FileInfo[] = [];
  for (const entry of entries) {
    const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && /\.(md|json|txt|epub|mobi)$/i.test(entry.name)) {
      try {
        const s = await stat(fullPath);
        const ext = extname(entry.name).toLowerCase();
        results.push({
          path: `${wsName}/${relPath}`,
          name: entry.name,
          mtime: s.mtime.toISOString(),
          size: s.size,
          tag: detectTag(relPath, entry.name),
          workspace: wsName,
          ext,
        });
      } catch {
        // skip
      }
    } else if (
      entry.isDirectory() &&
      !entry.name.startsWith(".") &&
      !SKIP_DIRS.has(entry.name)
    ) {
      const sub = await scanDir(fullPath, relPath, wsName, maxDepth, depth + 1);
      results.push(...sub);
    }
  }
  return results;
}

function detectTag(relPath: string, name: string): string {
  const nameUpper = name.toUpperCase();
  const corePromptFiles = new Set([
    "AGENTS.MD",
    "SOUL.MD",
    "TOOLS.MD",
    "IDENTITY.MD",
    "USER.MD",
    "HEARTBEAT.MD",
    "BOOTSTRAP.MD",
    "BOOT.MD",
    "MEMORY.MD",
  ]);

  if (corePromptFiles.has(nameUpper)) return "Core Prompt";
  if (/^\d{4}-\d{2}-\d{2}/.test(name) && relPath.includes("memory")) return "Journal";
  if (name === "INDEX.md" && relPath.includes("memory")) return "Journal";
  if (name.startsWith("overnight-log")) return "Journal";
  if (/newsletter/i.test(relPath)) return "Newsletters";
  if (/youtube|video|script/i.test(relPath)) return "YouTube Scripts";
  if (/content/i.test(relPath)) return "Content";
  if (/TOOLS|NOTES/i.test(name)) return "Notes";
  if (/skill/i.test(relPath)) return "Notes";
  return "Other";
}

export const GET = withRoute(
  { name: "/api/docs", querySchema: docsGetQuerySchema },
  async (_request, ctx) => {
  const filePath = ctx.query.path;
  try {
    if (filePath) {
      const fullPath = safePath(filePath);
      if (!fullPath) return badRequest("invalid path");
      const content = await readFile(fullPath, "utf-8");
      const words = content.split(/\s+/).filter(Boolean).length;
      const size = Buffer.byteLength(content, "utf-8");
      return NextResponse.json({ content, words, size, path: filePath.replace(/^\/+/, "") });
    }
    const workspaces = await discoverWorkspaces();
    let allDocs: FileInfo[] = [];
    for (const ws of workspaces) {
      const docs = await scanDir(ws.dir, "", ws.name);
      allDocs.push(...docs);
    }
    allDocs.sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
    allDocs = allDocs.slice(0, 200);
    const tags = Array.from(new Set(allDocs.map((d) => d.tag)));
    const extensions = Array.from(new Set(allDocs.map((d) => d.ext)));
    return NextResponse.json({ docs: allDocs, tags, extensions });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Docs API error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);

/** POST - create a new document */
export const POST = withRoute(
  { name: "/api/docs", bodySchema: docsPostSchema },
  async (_request, ctx) => {
  try {
    const { workspace, filename, content = "" } = ctx.body;
    if (!workspace || !filename) {
      return badRequest("workspace and filename required");
    }
    // Sanitize filename
    const sanitized = filename.replace(/[/\\:*?"<>|]/g, "").trim();
    if (!sanitized) {
      return badRequest("invalid filename");
    }
    if (!/\.(md|json|txt)$/i.test(sanitized)) {
      return badRequest("unsupported file type — use .md, .json, or .txt");
    }
    // Build path: workspace/filename
    const logicalPath = `${workspace}/${sanitized}`;
    const fullPath = safePath(logicalPath);
    if (!fullPath) {
      return badRequest("invalid path");
    }
    // Prevent overwriting
    try {
      await stat(fullPath);
      return conflict("file already exists");
    } catch {
      // Good — file doesn't exist
    }
    // Ensure directory exists
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, "utf-8");
    const words = content.split(/\s+/).filter(Boolean).length;
    const size = Buffer.byteLength(content, "utf-8");
    const s = await stat(fullPath);
    return NextResponse.json({
      ok: true,
      doc: {
        path: logicalPath,
        name: sanitized,
        mtime: s.mtime.toISOString(),
        size,
        tag: detectTag(sanitized, sanitized),
        workspace,
        ext: extname(sanitized).toLowerCase(),
      },
      words,
    });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Docs POST error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);

export const PUT = withRoute(
  { name: "/api/docs", bodySchema: docsPutSchema },
  async (_request, ctx) => {
  try {
    const { path: filePath, content } = ctx.body;
    if (typeof filePath !== "string" || typeof content !== "string") {
      return badRequest("path and content required");
    }
    if (!/\.(md|json|txt)$/i.test(filePath)) {
      return badRequest("unsupported file type");
    }
    const fullPath = safePath(filePath);
    if (!fullPath) return badRequest("invalid path");
    await writeFile(fullPath, content, "utf-8");
    const words = content.split(/\s+/).filter(Boolean).length;
    const size = Buffer.byteLength(content, "utf-8");
    return NextResponse.json({ ok: true, path: filePath.replace(/^\/+/, ""), words, size });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Docs PUT error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);

/** DELETE - delete a file */
export const DELETE = withRoute(
  { name: "/api/docs", querySchema: docsDeleteQuerySchema },
  async (_request, ctx) => {
  try {
    const filePath = ctx.query.path;
    if (!filePath) {
      return badRequest("path required");
    }
    const fullPath = safePath(filePath);
    if (!fullPath) return badRequest("invalid path");
    // Verify it exists and is a file
    const s = await stat(fullPath);
    if (!s.isFile()) {
      return badRequest("not a file");
    }
    await unlink(fullPath);
    return NextResponse.json({ ok: true, path: filePath, deleted: true });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Docs DELETE error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);

/** PATCH - rename or duplicate a file */
export const PATCH = withRoute(
  { name: "/api/docs", bodySchema: docsPatchSchema },
  async (_request, ctx) => {
  try {
    const { action, path: filePath, newName } = ctx.body;
    if (!filePath || !action) {
      return badRequest("action and path required");
    }
    const fullPath = safePath(filePath);
    if (!fullPath) return badRequest("invalid path");
    const logicalPath = filePath.replace(/^\/+/, "");

    if (action === "rename") {
      if (!newName) {
        return badRequest("newName required");
      }
      // Sanitize new name
      const sanitizedName = newName.replace(/[/\\:*?"<>|]/g, "").trim();
      if (!sanitizedName) {
        return badRequest("invalid name");
      }
      const dir = dirname(fullPath);
      const newFullPath = join(dir, sanitizedName);
      await rename(fullPath, newFullPath);
      // Build the new logical path
      const parentLogical = logicalPath.substring(0, logicalPath.lastIndexOf("/"));
      const newLogicalPath = parentLogical
        ? `${parentLogical}/${sanitizedName}`
        : sanitizedName;
      return NextResponse.json({ ok: true, path: newLogicalPath, oldPath: logicalPath });
    }

    if (action === "duplicate") {
      const dir = dirname(fullPath);
      const ext = extname(filePath);
      const base = basename(filePath, ext);
      // Find a unique name
      let suffix = 1;
      let dupPath: string;
      do {
        dupPath = join(dir, `${base} (copy${suffix > 1 ? ` ${suffix}` : ""})${ext}`);
        suffix++;
      } while (await stat(dupPath).then(() => true).catch(() => false));
      await copyFile(fullPath, dupPath);
      // Build logical path
      const parentLogical = logicalPath.substring(0, logicalPath.lastIndexOf("/"));
      const dupName = basename(dupPath);
      const dupLogical = parentLogical ? `${parentLogical}/${dupName}` : dupName;
      return NextResponse.json({ ok: true, path: dupLogical, name: dupName });
    }

    return badRequest(`unknown action: ${action}`);
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Docs PATCH error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);
