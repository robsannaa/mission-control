import { NextResponse } from "next/server";
import { searchRegistry } from "@/lib/mcp-registry";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

/** GET /api/mcp/registry?search=<q> — search the official MCP Registry. */
export const GET = withRoute({ name: "/api/mcp/registry" }, async (request, ctx) => {
  const search = request.nextUrl.searchParams.get("search")?.trim() || "";
  try {
    const connectors = await searchRegistry(search, 30);
    return NextResponse.json({ connectors });
  } catch (error) {
    // Fail soft (200, not an error status): the curated shelf still works if
    // the registry is unreachable. This is a success shape, not the D-01
    // error envelope — out of scope for this phase (docs/API-CONTRACT.md §5).
    const message = error instanceof Error ? error.message : String(error);
    ctx.log.warn({ err: message }, "MCP registry search failed — falling back to the curated shelf");
    return NextResponse.json({ connectors: [], error: message }, { status: 200 });
  }
});
