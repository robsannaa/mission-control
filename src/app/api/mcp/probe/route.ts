import { NextResponse } from "next/server";
import { probeServer } from "@/lib/mcp";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp/probe?name=<server> — connect to one server and return its live
 * tool list + capabilities. Slower than the config reads (it opens the
 * transport), so the UI calls it lazily when a server is expanded.
 *
 * The server's own outbound target (its `url`, for an http/sse transport) is
 * validated as a parsed absolute URL with an allowed scheme set at write
 * time — `POST /api/mcp` create/update, `src/lib/schemas/automation.ts`
 * (T-02-39) — before it is ever persisted to config for this route to read
 * back and connect to. This route only resolves `name` against that
 * already-validated config.
 */
export const GET = withRoute({ name: "/api/mcp/probe" }, async (request, ctx) => {
  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!name) {
    return badRequest("name query parameter is required");
  }
  try {
    const result = await probeServer(name);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.error({ err: message }, "MCP probe error");
    const status = /invalid|no spaces/i.test(message) ? 400 : 502;
    return apiError(message, status);
  }
});
