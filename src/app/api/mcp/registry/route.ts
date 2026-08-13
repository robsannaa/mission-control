import { NextRequest, NextResponse } from "next/server";
import { searchRegistry } from "@/lib/mcp-registry";

export const dynamic = "force-dynamic";

/** GET /api/mcp/registry?search=<q> — search the official MCP Registry. */
export async function GET(request: NextRequest) {
  const search = request.nextUrl.searchParams.get("search")?.trim() || "";
  try {
    const connectors = await searchRegistry(search, 30);
    return NextResponse.json({ connectors });
  } catch (error) {
    // Fail soft: the curated shelf still works if the registry is unreachable.
    return NextResponse.json(
      { connectors: [], error: error instanceof Error ? error.message : String(error) },
      { status: 200 },
    );
  }
}
