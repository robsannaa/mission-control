/**
 * MCP connector catalog — CLIENT-SAFE (pure data + normalization, no secrets,
 * no server imports).
 *
 * Two sources feed the "Browse connectors" gallery:
 *   1. FEATURED — a hand-curated, vetted shelf with known-good install recipes.
 *      Each recipe pre-fills the add form and asks only for the secret/OAuth it
 *      actually needs, so adding is one guided step.
 *   2. The official MCP Registry (registry.modelcontextprotocol.io) — searched
 *      live for the long tail and normalized into the same shape via
 *      `normalizeRegistryServer`.
 */

export type ConnectorCategory =
  | "calendar"
  | "productivity"
  | "development"
  | "communication"
  | "data"
  | "web"
  | "utility";

export type ConnectorBadge = "managed" | "official" | "verified" | "community";

/** A field the connector needs the user to supply (kept out of the catalog). */
export interface SecretSpec {
  /** Header name or env var key. */
  key: string;
  label: string;
  help?: string;
  placeholder?: string;
}

export type ConnectorRecipe =
  | {
      kind: "stdio";
      command: string;
      args: string[];
      env?: SecretSpec[];
    }
  | {
      kind: "http";
      url: string;
      transport: "streamable-http" | "sse";
      headers?: SecretSpec[];
      /** Server authenticates with an OAuth flow (use mcp login after adding). */
      oauth?: boolean;
    }
  | {
      /** Special: reuses Mission Control's native Google integration. */
      kind: "managed";
      provider: "google-calendar";
    };

export interface CatalogConnector {
  id: string;
  name: string; // default server name when added
  title: string; // display name
  description: string;
  category: ConnectorCategory;
  badge?: ConnectorBadge;
  /** Accent used for the monogram fallback when no real icon loads. */
  accent: string;
  /** Domain to pull the real brand favicon from (defaults to homepage host). */
  icon?: string;
  homepage?: string;
  /** Hidden in AgentBay hosted mode — depends on a self-hosted-only surface. */
  selfHostedOnly?: boolean;
  recipe: ConnectorRecipe;
}

/** Extract a bare hostname from a URL (or undefined). */
export function domainFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.includes("://") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

/** Real brand favicon via DuckDuckGo's icon service (privacy-friendly, reliable). */
export function faviconUrl(domain?: string): string | null {
  return domain ? `https://icons.duckduckgo.com/ip3/${domain}.ico` : null;
}

/**
 * Curated shelf. Recipes are sensible starting points — the add form stays
 * editable — chosen to bias toward zero-secret "just works" connectors first.
 */
export const FEATURED_CONNECTORS: CatalogConnector[] = [
  {
    id: "google-calendar",
    name: "google-calendar",
    title: "Google Calendar",
    description:
      "Your real calendar, in the Calendar tab and your agent's hands. Reuses Mission Control's Google sign-in — read and manage events in chat and cron.",
    category: "calendar",
    badge: "managed",
    accent: "#4285F4",
    icon: "calendar.google.com",
    homepage: "https://calendar.google.com",
    // The managed flow lights up the Calendar tab, which is self-hosted only.
    // Hosted users connect Google Calendar as a remote OAuth MCP via search.
    selfHostedOnly: true,
    recipe: { kind: "managed", provider: "google-calendar" },
  },
  {
    id: "context7",
    name: "context7",
    title: "Context7",
    description: "Up-to-date docs and code examples for any library, pulled in on demand. No key needed.",
    category: "development",
    badge: "verified",
    accent: "#7C3AED",
    homepage: "https://context7.com",
    recipe: { kind: "stdio", command: "npx", args: ["-y", "@upstash/context7-mcp"] },
  },
  {
    id: "playwright",
    name: "playwright",
    title: "Playwright Browser",
    description: "Let your agent drive a real browser — navigate, click, fill forms, and read pages.",
    category: "web",
    badge: "official",
    accent: "#2EAD33",
    icon: "playwright.dev",
    homepage: "https://github.com/microsoft/playwright-mcp",
    recipe: { kind: "stdio", command: "npx", args: ["-y", "@playwright/mcp@latest"] },
  },
  {
    id: "filesystem",
    name: "filesystem",
    title: "Filesystem",
    description: "Give your agent scoped read/write access to a folder you choose on this host.",
    category: "utility",
    badge: "official",
    accent: "#0EA5E9",
    icon: "modelcontextprotocol.io",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    recipe: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"],
    },
  },
  {
    id: "sequential-thinking",
    name: "sequential-thinking",
    title: "Sequential Thinking",
    description: "A structured reasoning tool for breaking hard problems into ordered, revisable steps.",
    category: "utility",
    badge: "official",
    accent: "#F59E0B",
    icon: "modelcontextprotocol.io",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    recipe: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
  {
    id: "github",
    name: "github",
    title: "GitHub",
    description: "Issues, pull requests, code search and repo actions — straight from your agent.",
    category: "development",
    badge: "official",
    accent: "#24292F",
    homepage: "https://github.com/github/github-mcp-server",
    recipe: {
      kind: "http",
      url: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http",
      oauth: true,
    },
  },
  {
    id: "linear",
    name: "linear",
    title: "Linear",
    description: "Create, update and triage Linear issues and projects without leaving the conversation.",
    category: "productivity",
    badge: "official",
    accent: "#5E6AD2",
    homepage: "https://linear.app",
    recipe: { kind: "http", url: "https://mcp.linear.app/mcp", transport: "streamable-http", oauth: true },
  },
  {
    id: "notion",
    name: "notion",
    title: "Notion",
    description: "Search your workspace and read or update pages and databases as tools.",
    category: "productivity",
    badge: "official",
    accent: "#0F0F0F",
    homepage: "https://notion.so",
    recipe: { kind: "http", url: "https://mcp.notion.com/mcp", transport: "streamable-http", oauth: true },
  },
  {
    id: "sentry",
    name: "sentry",
    title: "Sentry",
    description: "Pull in errors, issues and traces so your agent can debug production with real context.",
    category: "development",
    badge: "official",
    accent: "#362D59",
    homepage: "https://sentry.io",
    recipe: { kind: "http", url: "https://mcp.sentry.dev/mcp", transport: "streamable-http", oauth: true },
  },
  {
    id: "stripe",
    name: "stripe",
    title: "Stripe",
    description: "Look up customers, payments and invoices, and take account actions safely.",
    category: "data",
    badge: "official",
    accent: "#635BFF",
    homepage: "https://stripe.com",
    recipe: {
      kind: "stdio",
      command: "npx",
      args: ["-y", "@stripe/mcp", "--tools=all"],
      env: [
        {
          key: "STRIPE_SECRET_KEY",
          label: "Stripe secret key",
          help: "Use a restricted key. Starts with sk_ or rk_.",
          placeholder: "sk_live_…",
        },
      ],
    },
  },
];

// ── registry normalization ──────────────────────────────────────────────────

/** Minimal shape of one entry from GET /v0/servers. */
export interface RegistryServerRaw {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    websiteUrl?: string;
    repository?: { url?: string; source?: string };
    remotes?: Array<{
      type?: string;
      url?: string;
      headers?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean; value?: string }>;
    }>;
    packages?: Array<{
      registryType?: string;
      identifier?: string;
      runtimeHint?: string;
      transport?: { type?: string };
      environmentVariables?: Array<{ name?: string; description?: string; isRequired?: boolean; isSecret?: boolean }>;
      runtimeArguments?: Array<{ value?: string; name?: string }>;
    }>;
  };
  _meta?: Record<string, unknown>;
}

export interface RegistryConnector {
  id: string;
  title: string;
  description: string;
  category: ConnectorCategory;
  homepage?: string;
  recipe: ConnectorRecipe | null;
  /** Present but not auto-installable (no usable remote/package). */
  installable: boolean;
}

const RUNTIME_COMMAND: Record<string, string> = {
  npx: "npx",
  node: "node",
  uvx: "uvx",
  python: "python3",
  docker: "docker",
};

/** Turn "ai.smithery/mcp-google-calendar2" into a clean, DNS/word-friendly name. */
function slugFromName(fullName: string): string {
  const last = fullName.split("/").pop() || fullName;
  return last.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "server";
}

function toSecretSpec(h: { name?: string; description?: string }): SecretSpec {
  return { key: h.name || "", label: h.name || "Value", help: h.description };
}

export function normalizeRegistryServer(raw: RegistryServerRaw): RegistryConnector | null {
  const s = raw.server;
  if (!s?.name) return null;
  const title = s.title || slugFromName(s.name);
  const description = s.description || "";
  const homepage = s.websiteUrl || s.repository?.url;

  let recipe: ConnectorRecipe | null = null;

  const remote = s.remotes?.find((r) => r.url && (r.type === "streamable-http" || r.type === "sse"));
  if (remote?.url) {
    const headers = (remote.headers || []).filter((h) => h.isRequired || h.isSecret).map(toSecretSpec);
    const oauth = (remote.headers || []).some((h) => !h.value && (h.isSecret || h.isRequired)) && headers.length === 0;
    recipe = {
      kind: "http",
      url: remote.url,
      transport: remote.type === "sse" ? "sse" : "streamable-http",
      headers: headers.length ? headers : undefined,
      oauth: oauth || undefined,
    };
  } else {
    const pkg = s.packages?.find((p) => p.registryType && p.identifier);
    if (pkg?.identifier) {
      const command = RUNTIME_COMMAND[pkg.runtimeHint || ""] || (pkg.registryType === "pypi" ? "uvx" : "npx");
      const args = command === "npx" ? ["-y", pkg.identifier] : [pkg.identifier];
      const env = (pkg.environmentVariables || [])
        .filter((e) => e.isRequired || e.isSecret)
        .map((e) => ({ key: e.name || "", label: e.name || "Value", help: e.description }));
      recipe = { kind: "stdio", command, args, env: env.length ? env : undefined };
    }
  }

  return {
    id: slugFromName(s.name),
    title,
    description,
    homepage,
    category: guessCategory(`${title} ${description}`),
    recipe,
    installable: recipe !== null,
  };
}

function guessCategory(text: string): ConnectorCategory {
  const t = text.toLowerCase();
  if (/calendar|schedul|event|meeting/.test(t)) return "calendar";
  if (/git|deploy|ci\/cd|code|repo|debug|error|sentry|build/.test(t)) return "development";
  if (/slack|email|mail|message|chat|discord/.test(t)) return "communication";
  if (/notion|task|project|jira|linear|doc/.test(t)) return "productivity";
  if (/browser|web|scrap|http|search/.test(t)) return "web";
  if (/database|sql|payment|stripe|data|analytics/.test(t)) return "data";
  return "utility";
}

/** Two-letter monogram for the avatar. */
export function monogram(title: string): string {
  const words = title.replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/);
  if (words.length >= 2 && words[0] && words[1]) return (words[0][0]! + words[1][0]!).toUpperCase();
  return (title.slice(0, 2) || "MC").toUpperCase();
}

// ── recipe → add-form preset ──────────────────────────────────────────────────

/** Everything the add form needs to open pre-filled for one connector. */
export interface FormPreset {
  title: string;
  name: string;
  transport: "stdio" | "streamable-http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  /** Secret fields to pre-seed (key + guidance), value always blank. */
  secrets?: SecretSpec[];
  oauth?: boolean;
}

/** Convert a non-managed recipe into a form preset. Returns null for managed. */
export function recipeToPreset(name: string, title: string, recipe: ConnectorRecipe): FormPreset | null {
  if (recipe.kind === "managed") return null;
  if (recipe.kind === "stdio") {
    return { title, name, transport: "stdio", command: recipe.command, args: recipe.args, secrets: recipe.env };
  }
  return {
    title,
    name,
    transport: recipe.transport,
    url: recipe.url,
    secrets: recipe.headers,
    oauth: recipe.oauth,
  };
}
