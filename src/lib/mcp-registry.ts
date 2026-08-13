/**
 * Official MCP Registry client — SERVER-ONLY.
 *
 * Reads the community/official registry at registry.modelcontextprotocol.io
 * (backed by Anthropic, GitHub, Microsoft, PulseMCP) and normalizes results
 * into the catalog's connector shape. Server-side so the browser never makes
 * the cross-origin call and we can cache + fail soft.
 */

import {
  normalizeRegistryServer,
  type RegistryConnector,
  type RegistryServerRaw,
} from "./mcp-catalog";

const REGISTRY_BASE = "https://registry.modelcontextprotocol.io/v0/servers";

export async function searchRegistry(query: string, limit = 30): Promise<RegistryConnector[]> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("search", query.trim());
  params.set("limit", String(Math.max(1, Math.min(limit, 50))));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(`${REGISTRY_BASE}?${params.toString()}`, {
      headers: { accept: "application/json" },
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Registry returned ${res.status}`);
    const body = (await res.json()) as { servers?: RegistryServerRaw[] };
    const raw = Array.isArray(body.servers) ? body.servers : [];
    const seen = new Set<string>();
    const out: RegistryConnector[] = [];
    for (const entry of raw) {
      const c = normalizeRegistryServer(entry);
      if (!c || seen.has(c.id)) continue;
      // Only surface things a user can actually add (a remote or a package).
      if (!c.installable) continue;
      seen.add(c.id);
      out.push(c);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}
