import { NextRequest, NextResponse } from "next/server";
import { probeServer } from "@/lib/mcp";

export const dynamic = "force-dynamic";

/**
 * GET /api/mcp/probe?name=<server> — connect to one server and return its live
 * tool list + capabilities. Slower than the config reads (it opens the
 * transport), so the UI calls it lazily when a server is expanded.
 */
export async function GET(request: NextRequest) {
  const name = request.nextUrl.searchParams.get("name")?.trim();
  if (!name) {
    return NextResponse.json({ error: "name query parameter is required" }, { status: 400 });
  }
  try {
    const result = await probeServer(name);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /invalid|no spaces/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
