/**
 * Typed wrappers for Gateway HTTP endpoints.
 *
 * Provides high-level helpers for `/tools/invoke` and `/hooks/wake`,
 * replacing CLI subprocess calls for memory search, memory index, and
 * agent wake operations.
 *
 * Pattern follows `src/app/api/web-search/route.ts:invokeGatewayWebSearch()`.
 */

import { getGatewayToken, getGatewayUrl } from "./paths";
import { runCli } from "./openclaw";

/** Thrown when the gateway returns 404 for a tool (not registered / not available). */
export class ToolNotAvailableError extends Error {
  constructor(tool: string, detail?: string) {
    super(detail || `Tool not available: ${tool}`);
    this.name = "ToolNotAvailableError";
  }
}

// ── Types ────────────────────────────────────────

type ToolInvokeEnvelope<T> = {
  ok?: boolean;
  result?: T;
  error?: {
    message?: string;
  };
};

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

type MemorySearchToolResult = {
  results?: MemorySearchResult[];
  content?: Array<{ type?: string; text?: string }>;
};

type MemoryIndexToolResult = {
  output?: string;
  content?: Array<{ type?: string; text?: string }>;
};

// ── Base invoke ──────────────────────────────────

export async function invokeGatewayTool<T>(
  tool: string,
  args: Record<string, unknown>,
  timeout = 30000,
): Promise<T> {
  const gwUrl = await getGatewayUrl();
  const token = getGatewayToken();
  const response = await fetch(`${gwUrl}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ tool, args, action: "json" }),
    signal: AbortSignal.timeout(timeout),
  });

  const body = (await response.json().catch(() => null)) as
    | ToolInvokeEnvelope<T>
    | null;

  if (!response.ok) {
    const detail =
      body?.error?.message ||
      (body ? JSON.stringify(body) : response.statusText);
    if (response.status === 404) {
      throw new ToolNotAvailableError(tool, detail);
    }
    throw new Error(`Gateway ${tool} failed (${response.status}): ${detail}`);
  }

  if (!body?.ok || !body.result) {
    throw new Error(body?.error?.message || `Gateway ${tool} returned no result`);
  }

  return body.result;
}

// ── Memory search ────────────────────────────────

export async function gatewayMemorySearch(opts: {
  query: string;
  agent?: string;
  maxResults?: number;
  minScore?: string;
}): Promise<{ results: MemorySearchResult[] }> {
  const args: Record<string, unknown> = { query: opts.query };
  if (opts.agent) args.agent = opts.agent;
  if (opts.maxResults) args.max_results = opts.maxResults;
  if (opts.minScore) {
    const parsed = parseFloat(opts.minScore);
    if (!Number.isNaN(parsed)) args.min_score = parsed;
  }

  try {
    const result = await invokeGatewayTool<MemorySearchToolResult>(
      "memory_search",
      args,
      30000,
    );

    if (Array.isArray(result.results)) {
      return { results: result.results };
    }

    // Fallback: parse from content blocks
    const text = Array.isArray(result.content)
      ? result.content
          .map((item) => (item?.type === "text" ? String(item.text || "") : ""))
          .filter(Boolean)
          .join("\n")
      : "";

    if (!text) {
      return { results: [] };
    }

    try {
      const parsed = JSON.parse(text) as { results?: MemorySearchResult[] };
      return { results: Array.isArray(parsed.results) ? parsed.results : [] };
    } catch {
      return { results: [] };
    }
  } catch (err) {
    // Memory search not available — return empty results instead of crashing
    if (err instanceof ToolNotAvailableError) {
      return { results: [] };
    }
    throw err;
  }
}

// ── Memory index ─────────────────────────────────

/*
 * A full reindex re-embeds every chunk, which is minutes of work on a large
 * memory or a cold local embedding model — the 60s default aborted mid-run and
 * surfaced as an opaque "reindex failed (500)" (issue #80). Give it real room.
 */
const REINDEX_TIMEOUT_MS = 240_000;

export async function gatewayMemoryIndex(opts?: {
  agent?: string;
  force?: boolean;
}): Promise<string> {
  const args: Record<string, unknown> = {};
  if (opts?.agent) args.agent = opts.agent;
  if (opts?.force) args.force = true;

  try {
    const result = await invokeGatewayTool<MemoryIndexToolResult>(
      "memory_index",
      args,
      REINDEX_TIMEOUT_MS,
    );

    if (result.output) return result.output;

    return result.content
      ?.map((item) => (item?.type === "text" ? String(item.text || "") : ""))
      .filter(Boolean)
      .join("\n") || "";
  } catch (err) {
    // Gateway doesn't expose memory_index — fall back to CLI. OpenClaw denies
    // exec-class tools on the HTTP endpoint by default, so on most installs
    // this 404s and the CLI path below is the one that actually runs.
    if (err instanceof ToolNotAvailableError) {
      const cliArgs = ["memory", "index"];
      if (opts?.agent) cliArgs.push("--agent", opts.agent);
      if (opts?.force) cliArgs.push("--force");
      return runCli(cliArgs, REINDEX_TIMEOUT_MS);
    }
    throw err;
  }
}

// ── Wake agent ───────────────────────────────────

export async function gatewayWakeAgent(opts: {
  text?: string;
  mode?: string;
}): Promise<string> {
  const text = opts.text || "Check for urgent follow-ups";
  const mode = opts.mode || "now";
  const gwUrl = await getGatewayUrl();
  const token = getGatewayToken();
  try {
    const response = await fetch(`${gwUrl}/hooks/wake`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ text, mode }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => null);

    if (!response.ok) {
      const detail = body?.error?.message || body?.error || response.statusText;
      throw new Error(`Gateway wake failed (${response.status}): ${detail}`);
    }

    return typeof body?.output === "string" ? body.output : JSON.stringify(body || {});
  } catch {
    // Compatibility fallback for gateway builds without /hooks/wake.
    return runCli(["system", "event", "--text", text, "--mode", mode], 20000);
  }
}
