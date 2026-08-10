/**
 * Web search provider catalog — shared between the status API route, the
 * run API route, and the settings page.
 *
 * Facts here were verified live against OpenClaw 2026.7.1-2, not guessed:
 *   - config paths come from `openclaw`'s own docs (tools/web.md and the
 *     per-provider pages) and were cross-checked with `config.schema.lookup`.
 *   - the id used for `tools.web.search.provider` is NOT always the plugin id
 *     (Gemini is provider "gemini" but plugin "google"; Grok is provider
 *     "grok" but plugin "xai"; Kimi is provider "kimi" but plugin "moonshot").
 *   - `authKind` reflects how credentials really work for that provider:
 *       "key"        — a plain API key saved at plugins.entries.<pluginId>.config.webSearch.apiKey
 *       "keyless"    — no credential ever required (DuckDuckGo)
 *       "connection" — reuses a sign-in that lives elsewhere (Ollama's local
 *                      daemon sign-in, Codex's ChatGPT/OpenAI sign-in); Mission
 *                      Control has no key field to offer for these
 *       "baseUrl"    — needs a server URL, not a key (SearXNG)
 *
 * This catalog intentionally covers every provider documented in OpenClaw's
 * web-search docs, not just the ones installed on any one machine. The API
 * route filters it down to what is *actually installed* on the connected
 * OpenClaw at request time (`openclaw plugins list --json`), so a page never
 * offers a provider that would fail validation when saved.
 */

export type AuthKind = "key" | "keyless" | "connection" | "baseUrl";

export type ProviderMeta = {
  /** Value written to `tools.web.search.provider`. */
  id: string;
  /** Plugin id at `plugins.entries.<pluginId>`, where credentials live. */
  pluginId: string;
  label: string;
  /** One line: what a non-technical person gets. */
  tagline: string;
  /** A little more detail, shown when the row is expanded. */
  detail: string;
  /** Plain-language cost expectation. */
  cost: string;
  authKind: AuthKind;
  /** Env vars Mission Control checks for an existing credential, in priority order. */
  envVars: string[];
  /** Lower = wins auto-detection first. Omit for providers that never auto-win. */
  autoPrecedence?: number;
  docsPath: string;
};

export const PROVIDER_CATALOG: ProviderMeta[] = [
  {
    id: "duckduckgo",
    pluginId: "duckduckgo",
    label: "DuckDuckGo",
    tagline: "Free web search, nothing to sign up for.",
    detail:
      "Works immediately, no key. It's an unofficial integration, so DuckDuckGo can occasionally block results under heavy use.",
    cost: "Free",
    authKind: "keyless",
    envVars: [],
    docsPath: "/tools/duckduckgo-search",
  },
  {
    id: "ollama",
    pluginId: "ollama",
    label: "Ollama",
    tagline: "Uses your own Ollama connection.",
    detail:
      "Free if you already run Ollama locally and have run `ollama signin`. The hosted option (ollama.com) needs a key instead.",
    cost: "Free (local) or hosted pricing",
    authKind: "connection",
    envVars: ["OLLAMA_API_KEY"],
    docsPath: "/tools/ollama-search",
  },
  {
    id: "codex",
    pluginId: "codex",
    label: "Codex Hosted Search",
    tagline: "AI-written answers using your existing Codex/ChatGPT sign-in.",
    detail:
      "No separate key — it reuses the Codex app-server sign-in already connected to this OpenClaw.",
    cost: "Included with your Codex/ChatGPT plan",
    authKind: "connection",
    envVars: [],
    docsPath: "/plugins/codex-harness",
  },
  {
    id: "brave",
    pluginId: "brave",
    label: "Brave Search",
    tagline: "Search results with titles, links and short summaries.",
    detail: "Needs a Brave Search API key. Brave gives $5/month free credit, about 1,000 searches.",
    cost: "Free tier, then paid",
    authKind: "key",
    envVars: ["BRAVE_API_KEY"],
    autoPrecedence: 10,
    docsPath: "/tools/brave-search",
  },
  {
    id: "minimax",
    pluginId: "minimax",
    label: "MiniMax",
    tagline: "Search results with titles, links and short summaries.",
    detail: "Needs a MiniMax Token Plan key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["MINIMAX_CODE_PLAN_KEY", "MINIMAX_CODING_API_KEY", "MINIMAX_OAUTH_TOKEN", "MINIMAX_API_KEY"],
    autoPrecedence: 15,
    docsPath: "/tools/minimax-search",
  },
  {
    id: "gemini",
    pluginId: "google",
    label: "Google (Gemini)",
    tagline: "AI-written answers with sources, grounded in Google Search.",
    detail: "Needs a Gemini API key from Google AI Studio. Google offers a free usage tier.",
    cost: "Free tier, then paid",
    authKind: "key",
    envVars: ["GEMINI_API_KEY"],
    autoPrecedence: 20,
    docsPath: "/tools/gemini-search",
  },
  {
    id: "grok",
    pluginId: "xai",
    label: "Grok (xAI)",
    tagline: "AI-written answers with sources from Grok's web search.",
    detail: "Uses an existing xAI sign-in if you have one, or needs an xAI API key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["XAI_API_KEY"],
    autoPrecedence: 30,
    docsPath: "/tools/grok-search",
  },
  {
    id: "kimi",
    pluginId: "moonshot",
    label: "Kimi",
    tagline: "AI-written answers with sources via Moonshot's web search.",
    detail: "Needs a Kimi (Moonshot) API key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["KIMI_API_KEY", "MOONSHOT_API_KEY"],
    autoPrecedence: 40,
    docsPath: "/tools/kimi-search",
  },
  {
    id: "perplexity",
    pluginId: "perplexity",
    label: "Perplexity",
    tagline: "Search results with titles, links and short summaries.",
    detail: "Needs a Perplexity API key. Has a free trial, then billed by usage.",
    cost: "Free trial, then paid",
    authKind: "key",
    envVars: ["PERPLEXITY_API_KEY", "OPENROUTER_API_KEY"],
    autoPrecedence: 50,
    docsPath: "/tools/perplexity-search",
  },
  {
    id: "firecrawl",
    pluginId: "firecrawl",
    label: "Firecrawl",
    tagline: "Search results, best paired with deeper page extraction.",
    detail: "Needs a Firecrawl API key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["FIRECRAWL_API_KEY"],
    autoPrecedence: 60,
    docsPath: "/tools/firecrawl",
  },
  {
    id: "exa",
    pluginId: "exa",
    label: "Exa",
    tagline: "Search that also pulls out the readable content of pages.",
    detail: "Needs an Exa API key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["EXA_API_KEY"],
    autoPrecedence: 65,
    docsPath: "/tools/exa-search",
  },
  {
    id: "tavily",
    pluginId: "tavily",
    label: "Tavily",
    tagline: "Search results with topic and domain filtering.",
    detail: "Needs a Tavily API key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["TAVILY_API_KEY"],
    autoPrecedence: 70,
    docsPath: "/tools/tavily",
  },
  {
    id: "parallel",
    pluginId: "parallel",
    label: "Parallel",
    tagline: "Search results tuned for higher rate limits.",
    detail: "Needs a Parallel API key.",
    cost: "Paid API",
    authKind: "key",
    envVars: ["PARALLEL_API_KEY"],
    autoPrecedence: 75,
    docsPath: "/tools/parallel-search",
  },
  {
    id: "searxng",
    pluginId: "searxng",
    label: "SearXNG",
    tagline: "Your own self-hosted search server.",
    detail: "Needs the web address of a SearXNG server you run or trust — not a key.",
    cost: "Free (self-hosted)",
    authKind: "baseUrl",
    envVars: ["SEARXNG_BASE_URL"],
    autoPrecedence: 200,
    docsPath: "/tools/searxng-search",
  },
];

export const PROVIDER_BY_ID: Record<string, ProviderMeta> = Object.fromEntries(
  PROVIDER_CATALOG.map((p) => [p.id, p]),
);

/** Providers ordered by auto-detect precedence (lowest number first). */
export const AUTO_DETECT_ORDER = PROVIDER_CATALOG.filter(
  (p) => typeof p.autoPrecedence === "number",
).sort((a, b) => (a.autoPrecedence ?? 0) - (b.autoPrecedence ?? 0));

// ── Search result shape (shared by the run API route + the page) ────────

export type NormalizedSearchResult = {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
  published?: string;
};

export type WebSearchRunResponse =
  | {
      ok: true;
      provider: string;
      tookMs: number | null;
      cached: boolean;
      results: NormalizedSearchResult[];
    }
  | {
      ok: false;
      reason: string;
      technical?: string;
    };

/**
 * OpenClaw wraps text pulled from the open web in
 * `<<<EXTERNAL_UNTRUSTED_CONTENT ...>>> Source: Web Search --- <text> <<<END_EXTERNAL_UNTRUSTED_CONTENT ...>>>`
 * markers so the agent's model never confuses it with trusted instructions.
 * That wrapper is exactly right for the model and exactly wrong to show a
 * human, so unwrap it here before it reaches the page.
 */
const WRAPPER_RE =
  /<<<EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>[\s\S]*?---\s*\n?([\s\S]*?)\n?<<<END_EXTERNAL_UNTRUSTED_CONTENT[^>]*>>>/;

export function unwrapExternalContent(text: unknown): string {
  if (typeof text !== "string") return "";
  const match = text.match(WRAPPER_RE);
  return (match ? match[1] : text).trim();
}

/**
 * Provider snippets often carry raw markdown (`**bold**`, `##` headings,
 * `---` rules) meant for a model, not a reader. Strip just enough of it to
 * read as plain text without pulling in a full markdown parser for a
 * two-line snippet.
 */
export function plainifySnippet(text: string): string {
  return text
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
