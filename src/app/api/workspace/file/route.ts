import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { normalize, resolve } from "path";
import { getDefaultWorkspace } from "@/lib/paths";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest, notFound } from "@/lib/api-errors";
import { workspaceFileGetQuerySchema, type WorkspaceFileGetQuery } from "@/lib/schemas/workspace";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
]);

/**
 * GET /api/workspace/file?path=relative/path/to/file.png
 * Serves a single file from the workspace (e.g. for kanban task attachments).
 * Path must be relative to workspace root; no directory traversal (..) allowed.
 *
 * T-02-55 (Information Disclosure): `path` is bounded, traversal-rejecting
 * and absolute-prefix-rejecting in `workspaceFileGetQuerySchema` before this
 * handler runs — no filesystem read is attempted for a rejected path. The
 * `resolve()`/`startsWith()` containment check below stays as
 * defense-in-depth (same precedent as the docs route in plan 02-08).
 */
export const GET = withRoute<unknown, WorkspaceFileGetQuery>(
  { name: "/api/workspace/file", querySchema: workspaceFileGetQuerySchema },
  async (_request: NextRequest, ctx) => {
  const rawPath = (ctx.query.path || "").trim();
  if (!rawPath) {
    return badRequest("Missing required query param: path");
  }

  const normalized = normalize(rawPath).replace(/\\/g, "/");

  try {
    const workspace = await getDefaultWorkspace();
    const resolved = resolve(workspace, normalized);
    if (!resolved.startsWith(workspace)) {
      return apiError("Invalid path", 403);
    }
    const fullPath = resolved;
    const content = await readFile(fullPath);

    const ext = normalized.toLowerCase().slice(normalized.lastIndexOf("."));
    const isImage = IMAGE_EXTENSIONS.has(ext);
    const contentType = isImage
      ? (ext === ".svg"
          ? "image/svg+xml"
          : ext === ".ico"
            ? "image/x-icon"
            : ext === ".jpg"
              ? "image/jpeg"
              : `image/${ext.slice(1)}`)
      : "application/octet-stream";

    return new NextResponse(content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch {
    return notFound("File not found or not readable");
  }
  },
);
