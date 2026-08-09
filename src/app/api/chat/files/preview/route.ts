import { NextRequest, NextResponse } from "next/server";
import { readFile, stat } from "fs/promises";
import path from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { gatewayCall } from "@/lib/openclaw";

export const dynamic = "force-dynamic";

/**
 * A short preview of a workspace file, for the hover card on file references.
 *
 * Containment is the whole job here: the caller supplies a path, so the
 * resolved target must be proven to sit inside the agent's workspace before
 * anything is read. `path.resolve` + a prefix check on the resolved root is
 * what makes `../../../etc/passwd` a 400 rather than a disclosure.
 */

const MAX_BYTES = 8 * 1024;
const MAX_LINES = 40;

/** Text-ish extensions only — a preview of a binary is noise at best. */
const PREVIEWABLE = new Set([
  "md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "tsv", "log",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "sh", "bash", "zsh", "rs", "go",
  "rb", "java", "c", "h", "cpp", "sql", "css", "scss", "html", "xml", "env",
]);

async function resolveWorkspaceRoot(agentId?: string): Promise<string> {
  if (agentId) {
    try {
      const config = await gatewayCall<{
        config?: { agents?: { list?: Array<{ id?: string; workspace?: string }> } };
      }>("config.get", {}, 8000);
      const match = config.config?.agents?.list?.find((a) => a?.id === agentId);
      if (typeof match?.workspace === "string" && match.workspace) {
        return path.resolve(match.workspace);
      }
    } catch {
      // Fall through to the default workspace.
    }
  }
  return path.resolve(await getDefaultWorkspace());
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const relative = searchParams.get("path")?.trim();
  const agentId = searchParams.get("agentId")?.trim() || undefined;

  if (!relative) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (relative.length > 512 || relative.includes("\0")) {
    return NextResponse.json({ error: "invalid path" }, { status: 400 });
  }

  try {
    const root = await resolveWorkspaceRoot(agentId);
    const target = path.resolve(root, relative);

    // Containment check — the resolved path must be inside the workspace.
    if (target !== root && !target.startsWith(root + path.sep)) {
      return NextResponse.json({ error: "invalid path" }, { status: 400 });
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const ext = path.extname(target).slice(1).toLowerCase();
    if (!PREVIEWABLE.has(ext)) {
      return NextResponse.json({
        path: relative,
        previewable: false,
        size: info.size,
        modified: info.mtimeMs,
      });
    }

    const raw = await readFile(target, "utf-8");
    const lines = raw.split("\n");
    const preview = lines.slice(0, MAX_LINES).join("\n").slice(0, MAX_BYTES);

    return NextResponse.json(
      {
        path: relative,
        previewable: true,
        size: info.size,
        modified: info.mtimeMs,
        lines: lines.length,
        truncated: lines.length > MAX_LINES || raw.length > MAX_BYTES,
        preview,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    console.error("chat/files/preview failed:", err);
    return NextResponse.json(
      { error: "Could not read that file." },
      { status: 502 },
    );
  }
}
