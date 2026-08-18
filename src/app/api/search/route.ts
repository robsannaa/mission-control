import { NextRequest, NextResponse } from "next/server";
import { gatewayMemorySearch } from "@/lib/gateway-tools";
import { withRoute } from "@/lib/api-route";
import { searchQuerySchema } from "@/lib/schemas/search";

export const dynamic = "force-dynamic";

type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export const GET = withRoute(
  { name: "/api/search", querySchema: searchQuerySchema },
  async (_request: NextRequest, ctx) => {
    const query = ctx.query.q;

    if (!query || query.length < 2) {
      return NextResponse.json({ results: [], query: query || "" });
    }

    try {
      const data = await gatewayMemorySearch({ query });

      // Sanitize: strip any passwords or sensitive data from snippets
      const results = (data.results || []).map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: sanitizeSnippet(r.snippet),
        source: r.source,
      }));

      return NextResponse.json({ results, query });
    } catch (err) {
      ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Search API error");
      return NextResponse.json({ results: [], query, error: "Search failed" });
    }
  },
);

/** Strip potential sensitive data from snippets */
function sanitizeSnippet(text: string): string {
  // Redact anything that looks like a password or API key
  return text
    .replace(/password:\s*\S+/gi, "password: [REDACTED]")
    .replace(/api[_-]?key:\s*\S+/gi, "api_key: [REDACTED]")
    .replace(/token:\s*[A-Za-z0-9_\-]{20,}/g, "token: [REDACTED]");
}
