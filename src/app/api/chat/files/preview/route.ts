import { readFile, stat } from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { getDefaultWorkspace } from "@/lib/paths";
import { gatewayCall } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound, apiError } from "@/lib/api-errors";
import { chatFilesPreviewGetQuerySchema } from "@/lib/schemas/chat";

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

export const GET = withRoute(
  { name: "/api/chat/files/preview", querySchema: chatFilesPreviewGetQuerySchema },
  async (_request, ctx) => {
  const relative = ctx.query.path?.trim();
  const agentId = ctx.query.agentId?.trim() || undefined;

  if (!relative) {
    return badRequest("path is required");
  }

  try {
    const root = await resolveWorkspaceRoot(agentId);
    const target = path.resolve(root, relative);

    // Containment check — the resolved path must be inside the workspace.
    // Defense-in-depth: the schema already rejected traversal segments and
    // absolute-path prefixes before this handler ever ran.
    if (target !== root && !target.startsWith(root + path.sep)) {
      return badRequest("invalid path");
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      return notFound("not found");
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
    ctx.log.error({ err }, "chat/files/preview failed");
    return apiError("Could not read that file.", 502);
  }
  },
);
