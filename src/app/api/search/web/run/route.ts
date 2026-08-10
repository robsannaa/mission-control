import { NextRequest, NextResponse } from "next/server";
import { invokeGatewayTool, ToolNotAvailableError } from "@/lib/gateway-tools";
import { unwrapExternalContent, plainifySnippet, type NormalizedSearchResult, type WebSearchRunResponse } from "@/components/search/providers";

export const dynamic = "force-dynamic";

type WebSearchToolDetails = {
  query?: string;
  provider?: string;
  tookMs?: number;
  cached?: boolean;
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    description?: string;
    siteName?: string;
    published?: string;
  }>;
  content?: string;
};

type WebSearchToolResult = {
  details?: WebSearchToolDetails;
  content?: Array<{ type?: string; text?: string }>;
};

function parseDetailsFromText(text: string): WebSearchToolDetails | null {
  try {
    return JSON.parse(text) as WebSearchToolDetails;
  } catch {
    return null;
  }
}

/** Turn whatever the tool/gateway threw into one honest sentence a person can act on. */
function describeFailure(err: unknown): { reason: string; technical: string } {
  const technical = err instanceof Error ? err.message : String(err);
  const lower = technical.toLowerCase();

  if (err instanceof ToolNotAvailableError || lower.includes("not available") || lower.includes("404")) {
    return { reason: "Web search isn't turned on for this agent yet.", technical };
  }
  if (lower.includes("econnrefused") || lower.includes("fetch failed") || lower.includes("gateway closed") || lower.includes("1006")) {
    return { reason: "Mission Control can't reach OpenClaw right now. Check that the gateway is running.", technical };
  }
  if (lower.includes("abort") || lower.includes("timed out") || lower.includes("timeout")) {
    return { reason: "The search took too long and was stopped. Try again, or switch to a different provider.", technical };
  }
  if (lower.includes("401") || lower.includes("unauthorized") || lower.includes("invalid_api_key") || lower.includes("invalid api key") || lower.includes("403") || lower.includes("forbidden")) {
    return { reason: "The search provider rejected the saved key. Double-check the key and try again.", technical };
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return { reason: "The search provider is rate-limiting requests right now. Wait a moment and try again.", technical };
  }
  if (lower.includes("no provider") || lower.includes("not configured") || lower.includes("requires an api key") || lower.includes("missing api key")) {
    return { reason: "No search provider is set up yet. Pick one and add a key above.", technical };
  }
  return { reason: "The search failed and OpenClaw didn't give a specific reason.", technical };
}

function normalizeResults(details: WebSearchToolDetails): NormalizedSearchResult[] {
  const raw = Array.isArray(details.results) ? details.results : [];
  return raw
    .map((r) => ({
      title: plainifySnippet(unwrapExternalContent(r.title)) || "(untitled)",
      url: typeof r.url === "string" ? r.url : "",
      snippet: plainifySnippet(unwrapExternalContent(r.snippet ?? r.description ?? "")),
      siteName: typeof r.siteName === "string" ? r.siteName : undefined,
      published: typeof r.published === "string" ? r.published : undefined,
    }))
    .filter((r) => r.url || r.snippet || r.title !== "(untitled)");
}

export async function POST(request: NextRequest) {
  let query = "";
  try {
    const body = (await request.json()) as { query?: string; count?: number };
    query = String(body.query || "").trim();
    if (!query || query.length < 2) {
      return NextResponse.json(
        { ok: false, reason: "Type at least 2 characters to search." } satisfies WebSearchRunResponse,
        { status: 400 },
      );
    }
    const count = Math.min(Math.max(Number(body.count) || 5, 1), 10);

    const result = await invokeGatewayTool<WebSearchToolResult>("web_search", { query, count }, 45000);
    const details =
      result.details ||
      parseDetailsFromText(
        result.content?.map((c) => (c?.type === "text" ? String(c.text || "") : "")).filter(Boolean).join("\n") || "",
      );

    if (!details) {
      return NextResponse.json(
        { ok: false, reason: "OpenClaw returned a search response Mission Control couldn't read." } satisfies WebSearchRunResponse,
        { status: 502 },
      );
    }

    const response: WebSearchRunResponse = {
      ok: true,
      provider: details.provider || "unknown",
      tookMs: typeof details.tookMs === "number" ? details.tookMs : null,
      cached: Boolean(details.cached),
      results: normalizeResults(details),
    };
    return NextResponse.json(response);
  } catch (err) {
    const { reason, technical } = describeFailure(err);
    const response: WebSearchRunResponse = { ok: false, reason, technical };
    return NextResponse.json(response, { status: 502 });
  }
}
