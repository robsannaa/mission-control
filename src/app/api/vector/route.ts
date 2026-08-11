import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "path";
import { runCliJson, gatewayCall } from "@/lib/openclaw";
import { describeReindexFailure } from "@/lib/vector-errors";
import { getOpenClawHome, getDefaultWorkspace } from "@/lib/paths";
import { gatewayConfigPatch } from "@/lib/gateway-config";
import { buildModelsSummary } from "@/lib/models-summary";
import { gatewayMemoryIndex } from "@/lib/gateway-tools";
import type { ProviderAvailability } from "@/components/vector/types";

export const dynamic = "force-dynamic";

/* ── Types ────────────────────────────────────────── */

type MemoryStatus = {
  agentId: string;
  status: {
    backend: string;
    files: number;
    chunks: number;
    dirty: boolean;
    workspaceDir: string;
    dbPath: string;
    provider: string;
    model: string;
    requestedProvider: string;
    sources: string[];
    extraPaths: string[];
    sourceCounts: { source: string; files: number; chunks: number }[];
    cache: { enabled: boolean; entries: number };
    fts: { enabled: boolean; available: boolean };
    // `available` is only populated by `memory status --deep` (an extra
    // provider round-trip). Plain status leaves it undefined — "not probed,"
    // not "unavailable." This route intentionally never asks for --deep, to
    // stay fast, so treat this as optional everywhere it's read.
    vector: {
      enabled: boolean;
      available?: boolean;
      extensionPath?: string;
      dims?: number;
    };
    batch: {
      enabled: boolean;
      failures: number;
      limit: number;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMs: number;
    };
  };
  scan: {
    sources: { source: string; totalFiles: number; issues: string[] }[];
    totalFiles: number;
    issues: string[];
  };
};

type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

/* ── Helpers ──────────────────────────────────────── */

function sanitizeSnippet(text: string): string {
  return text
    .replace(/password:\s*\S+/gi, "password: [REDACTED]")
    .replace(/api[_-]?key:\s*\S+/gi, "api_key: [REDACTED]")
    .replace(/token:\s*[A-Za-z0-9_\-]{20,}/g, "token: [REDACTED]")
    .replace(/shpat_[A-Za-z0-9]+/g, "[REDACTED]");
}

async function getDbFileSize(dbPath: string): Promise<number> {
  try {
    const s = await stat(dbPath);
    return s.size;
  } catch {
    return 0;
  }
}

async function deleteIfExists(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveNamespaceDbPath(agentId: string): Promise<string | null> {
  try {
    const rows = await runCliJson<MemoryStatus[]>(["memory", "status"], 15000);
    const match = Array.isArray(rows)
      ? rows.find((row) => String(row.agentId || "").trim() === agentId)
      : null;
    const dbPath = String(match?.status?.dbPath || "").trim();
    return dbPath || null;
  } catch {
    return null;
  }
}

/** Returns all root-level .md files in the workspace (excluding MEMORY.md) for memorySearch.extraPaths. */
async function getWorkspaceReferencePaths(): Promise<string[]> {
  try {
    const workspace = await getDefaultWorkspace();
    const entries = await readdir(workspace, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "MEMORY.md" && e.name !== "memory.md")
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const INDEXABLE_FILE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const INDEX_SCAN_SKIP_DIRS = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
]);
const MAX_INDEXABLE_DOCS = 2000;

type VectorDocEntry = {
  path: string;
  selected: boolean;
  source: "workspace" | "custom";
};

function normalizePathForConfig(input: string): string {
  return input.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
}

async function getResolvedMemorySearchConfig(): Promise<{
  hash: string;
  memorySearch: Record<string, unknown>;
}> {
  const configData = await gatewayCall<Record<string, unknown>>(
    "config.get",
    undefined,
    10000
  );
  const hash = String(configData.hash || "");
  const resolved = (configData.resolved || {}) as Record<string, unknown>;
  const agentsConfig = (resolved.agents || {}) as Record<string, unknown>;
  const defaults = (agentsConfig.defaults || {}) as Record<string, unknown>;
  const currentMemorySearch = (defaults.memorySearch || {}) as Record<string, unknown>;
  return { hash, memorySearch: currentMemorySearch };
}

async function patchMemorySearchConfig(
  baseHash: string,
  memorySearch: Record<string, unknown>,
  restartDelayMs?: number,
  replacePaths?: string[],
): Promise<void> {
  const patchRaw = JSON.stringify({
    agents: {
      defaults: {
        memorySearch,
      },
    },
  });
  await gatewayConfigPatch(
    {
      raw: patchRaw,
      baseHash,
      ...(typeof restartDelayMs === "number" ? { restartDelayMs } : {}),
      ...(replacePaths && replacePaths.length > 0 ? { replacePaths } : {}),
    },
    15000,
  );
}

async function listWorkspaceIndexableDocs(workspaceDir: string): Promise<string[]> {
  const workspaceRoot = resolve(workspaceDir);
  const out: string[] = [];
  const visited = new Set<string>();

  async function walk(current: string, depth: number): Promise<void> {
    if (out.length >= MAX_INDEXABLE_DOCS) return;
    if (depth > 8) return;

    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= MAX_INDEXABLE_DOCS) return;
      const fullPath = resolve(current, entry.name);
      if (visited.has(fullPath)) continue;
      visited.add(fullPath);

      if (entry.isDirectory()) {
        if (entry.name === "memory") continue; // indexed by default source
        if (INDEX_SCAN_SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;
      if (entry.name.toUpperCase() === "MEMORY.MD") continue; // indexed by default source
      const ext = extname(entry.name).toLowerCase();
      if (!INDEXABLE_FILE_EXTENSIONS.has(ext)) continue;

      const rel = relative(workspaceRoot, fullPath).split(sep).join("/");
      if (!rel || rel.startsWith("..")) continue;
      out.push(rel);
    }
  }

  await walk(workspaceRoot, 0);
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function sanitizeExtraPaths(rawPaths: unknown): string[] {
  if (!Array.isArray(rawPaths)) return [];
  const normalized = rawPaths
    .map((value) => normalizePathForConfig(String(value || "")))
    .filter(Boolean);
  return [...new Set(normalized)];
}

/* ── Server-side cache ──────────────────────────────
 * `openclaw memory status` is a real CLI subprocess call (the gateway denies
 * `exec` over HTTP by default, so there is no faster transport for it — see
 * `src/lib/transports/auto-transport.ts`). On this install it costs ~2s: the
 * CLI has to boot the full plugin loader before it can answer. That cost is
 * real and we do not hide it on a cold load (the client shows a skeleton
 * instead), but there is no reason to pay it again for a manual refresh, a
 * remount, or a tab switch a few seconds later. Module-scope cache is correct
 * here because Mission Control runs as one long-lived Node process per
 * deployment (self-hosted or hosted) — not a request-per-lambda model.
 */
type StatusPayload = Record<string, unknown>;
let statusCache: { data: StatusPayload; expiresAt: number } | null = null;
let documentsCache: { data: StatusPayload; expiresAt: number } | null = null;
const STATUS_CACHE_TTL_MS = 8_000;
const DOCUMENTS_CACHE_TTL_MS = 20_000;

function invalidateVectorCaches(): void {
  statusCache = null;
  documentsCache = null;
}

/** Is a local Ollama server answering at the default address? Cheap, fast, best-effort. */
async function probeOllama(): Promise<{ reachable: boolean; embeddingModels: string[] }> {
  try {
    const res = await fetch("http://127.0.0.1:11434/api/tags", {
      signal: AbortSignal.timeout(700),
    });
    if (!res.ok) return { reachable: false, embeddingModels: [] };
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = Array.isArray(data.models)
      ? data.models.map((m) => String(m?.name || m?.model || "")).filter(Boolean)
      : [];
    // Heuristic: Ollama has no API-level "is this an embedding model" flag,
    // so we go by naming convention (every common embedding model on Ollama's
    // library — nomic-embed-text, mxbai-embed-large, qwen3-embedding, bge-m3's
    // "embed" alias — includes "embed" in its tag).
    const embeddingModels = names.filter((n) => /embed/i.test(n));
    return { reachable: true, embeddingModels };
  } catch {
    return { reachable: false, embeddingModels: [] };
  }
}

/**
 * Is `@openclaw/llama-cpp-provider` installed? Required for `memorySearch.provider: "local"`
 * (see docs/concepts/memory-search.md) — without it, "Local" cannot actually run, so the UI
 * must not offer it as a plain one-click option. Reads the plugin registry OpenClaw already
 * maintains on disk; no subprocess.
 */
async function isLocalEmbeddingPluginInstalled(): Promise<boolean> {
  try {
    const raw = await readFile(join(getOpenClawHome(), "plugins", "installs.json"), "utf-8");
    const data = JSON.parse(raw) as {
      plugins?: Array<{ pluginId?: string; packageName?: string; enabled?: boolean }>;
    };
    const list = Array.isArray(data.plugins) ? data.plugins : [];
    return list.some(
      (p) =>
        (p.pluginId === "llama-cpp-provider" || p.packageName === "@openclaw/llama-cpp-provider") &&
        p.enabled !== false
    );
  } catch {
    return false;
  }
}

/* ── GET: status + search ─────────────────────────── */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") || "status";

  try {
    if (scope === "status") {
      const bypassCache = searchParams.get("fresh") === "1";
      if (!bypassCache && statusCache && Date.now() < statusCache.expiresAt) {
        return NextResponse.json({ ...statusCache.data, cached: true });
      }

      // Every independent read runs concurrently. The CLI call dominates
      // (~2s on a stock install — see the cache comment above); nothing else
      // should stack serially behind it.
      const [agentsResult, configResult, modelsSummaryResult, ollamaResult, localPluginResult] =
        await Promise.allSettled([
          runCliJson<MemoryStatus[]>(["memory", "status"], 15000),
          gatewayCall<Record<string, unknown>>("config.get", undefined, 10000),
          buildModelsSummary(),
          probeOllama(),
          isLocalEmbeddingPluginInstalled(),
        ]);

      const agents = agentsResult.status === "fulfilled" ? agentsResult.value : [];
      const agentsWarning =
        agentsResult.status === "rejected" ? String(agentsResult.reason) : null;

      // Enrich with DB file sizes (cheap fs stats, parallel).
      const enriched = await Promise.all(
        agents.map(async (a) => ({
          ...a,
          dbSizeBytes: await getDbFileSize(a.status.dbPath),
        }))
      );

      let embeddingConfig: Record<string, unknown> | null = null;
      let memorySearch: Record<string, unknown> | null = null;
      let configHash: string | null = null;
      if (configResult.status === "fulfilled") {
        const configData = configResult.value;
        configHash = (configData.hash as string) || null;
        const resolved = (configData.resolved || {}) as Record<string, unknown>;
        const agentsConfig = (resolved.agents || {}) as Record<string, unknown>;
        const defaults = (agentsConfig.defaults || {}) as Record<string, unknown>;
        embeddingConfig = {
          model: defaults.model || null,
          contextTokens: defaults.contextTokens || null,
        };
        memorySearch = (defaults.memorySearch || null) as Record<string, unknown> | null;
      }

      let authProviders: string[] = [];
      if (modelsSummaryResult.status === "fulfilled") {
        authProviders = (modelsSummaryResult.value.status.auth?.providers || [])
          .filter((provider) => provider.effective)
          .map((provider) => String(provider.provider || "").trim())
          .filter(Boolean);
      } else {
        if (process.env.OPENAI_API_KEY) authProviders.push("openai");
        if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) authProviders.push("google");
      }

      const ollama =
        ollamaResult.status === "fulfilled"
          ? ollamaResult.value
          : { reachable: false, embeddingModels: [] };
      const localPluginInstalled =
        localPluginResult.status === "fulfilled" ? localPluginResult.value : false;

      const providerAvailability: ProviderAvailability = {
        openai: { keyPresent: authProviders.includes("openai") },
        google: { keyPresent: authProviders.includes("google") },
        ollama,
        local: { pluginInstalled: localPluginInstalled },
      };

      const payload: StatusPayload = {
        agents: enriched,
        embeddingConfig,
        memorySearch,
        configHash,
        authProviders,
        providerAvailability,
        home: getOpenClawHome(),
        defaultWorkspace: await getDefaultWorkspace(),
        warning: agentsWarning || undefined,
        degraded: Boolean(agentsWarning),
      };

      statusCache = { data: payload, expiresAt: Date.now() + STATUS_CACHE_TTL_MS };
      return NextResponse.json(payload);
    }

    if (scope === "documents") {
      const bypassCache = searchParams.get("fresh") === "1";
      if (!bypassCache && documentsCache && Date.now() < documentsCache.expiresAt) {
        return NextResponse.json({ ...documentsCache.data, cached: true });
      }

      const workspaceDir = await getDefaultWorkspace();
      const docs = await listWorkspaceIndexableDocs(workspaceDir);
      let selectedExtraPaths: string[] = [];
      try {
        const { memorySearch } = await getResolvedMemorySearchConfig();
        selectedExtraPaths = sanitizeExtraPaths(memorySearch.extraPaths);
      } catch {
        // config may not exist yet
      }

      const selectedSet = new Set(selectedExtraPaths);
      const entries: VectorDocEntry[] = docs.map((path) => ({
        path,
        selected: selectedSet.has(path),
        source: "workspace",
      }));

      // Keep already-configured extra paths visible even if they are outside workspace scan.
      for (const path of selectedExtraPaths) {
        if (docs.includes(path)) continue;
        entries.push({ path, selected: true, source: "custom" });
      }

      entries.sort((a, b) => a.path.localeCompare(b.path));
      const payload: StatusPayload = { workspaceDir, docs: entries, selectedExtraPaths };
      documentsCache = { data: payload, expiresAt: Date.now() + DOCUMENTS_CACHE_TTL_MS };
      return NextResponse.json(payload);
    }

    if (scope === "search") {
      const query = searchParams.get("q") || "";
      const agent = searchParams.get("agent") || "";
      const maxResults = searchParams.get("max") || "10";
      const minScore = searchParams.get("minScore") || "";

      if (!query || query.trim().length < 2) {
        return NextResponse.json({ results: [], query });
      }

      const args = [
        "memory",
        "search",
        "--query",
        query.trim(),
        "--json",
        "--max-results",
        String(parseInt(maxResults, 10) || 10),
      ];
      if (agent) args.push("--agent", agent);
      if (minScore) args.push("--min-score", minScore);
      const parsed = await runCliJson<{ results?: SearchResult[] }>(args, 30000);
      const data = { results: Array.isArray(parsed.results) ? parsed.results : [] };

      const results = (data.results || []).map((r) => ({
        ...r,
        snippet: sanitizeSnippet(r.snippet),
      }));

      return NextResponse.json({ results, query });
    }

    return NextResponse.json({ error: "Unknown scope" }, { status: 400 });
  } catch (err) {
    console.error("Vector API GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST: reindex + config updates ──────────────── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      case "reindex": {
        const agent = body.agent as string | undefined;
        const force = body.force as boolean | undefined;
        try {
          const output = await gatewayMemoryIndex({
            agent: agent || undefined,
            force: force || undefined,
          });
          invalidateVectorCaches();
          return NextResponse.json({ ok: true, action, output });
        } catch (err) {
          // A reindex can fail for reasons the user can actually act on — a
          // slow/large memory, no embedding provider, a local model that isn't
          // running. Surface which one in plain words with HTTP 200 + ok:false
          // (the UI shows `error` as a calm message) instead of an opaque 500.
          invalidateVectorCaches();
          return NextResponse.json({ ok: false, action, error: describeReindexFailure(err) });
        }
      }

      case "delete-namespace": {
        const agent = String(body.agent || "").trim();
        if (!agent) {
          return NextResponse.json(
            { error: "agent required" },
            { status: 400 }
          );
        }

        const dbPath = await resolveNamespaceDbPath(agent);
        if (!dbPath) {
          return NextResponse.json(
            { error: `No memory namespace found for agent ${agent}` },
            { status: 404 }
          );
        }

        const resolvedDbPath = resolve(dbPath);
        const allowedRoot = resolve(getOpenClawHome(), "memory");
        const dbDir = dirname(resolvedDbPath);
        if (dbDir !== allowedRoot) {
          return NextResponse.json(
            { error: "Refusing to delete namespace outside the OpenClaw memory directory" },
            { status: 400 }
          );
        }

        const deletedFiles = (
          await Promise.all([
            deleteIfExists(resolvedDbPath).then((ok) => (ok ? resolvedDbPath : null)),
            deleteIfExists(`${resolvedDbPath}-wal`).then((ok) => (ok ? `${resolvedDbPath}-wal` : null)),
            deleteIfExists(`${resolvedDbPath}-shm`).then((ok) => (ok ? `${resolvedDbPath}-shm` : null)),
          ])
        ).filter((value): value is string => Boolean(value));

        if (deletedFiles.length === 0) {
          return NextResponse.json(
            { error: `Namespace files were not found for agent ${agent}` },
            { status: 404 }
          );
        }

        invalidateVectorCaches();
        return NextResponse.json({
          ok: true,
          action,
          agent,
          deletedFiles,
        });
      }

      case "setup-memory": {
        // One-click setup: enable memorySearch with given provider/model; optional local model path
        const setupProvider = body.provider as string;
        const setupModel = body.model as string;
        const localModelPath = body.localModelPath as string | undefined;

        if (!setupProvider || !setupModel) {
          return NextResponse.json(
            { error: "provider and model required" },
            { status: 400 }
          );
        }

        const setupConfig = await gatewayCall<Record<string, unknown>>(
          "config.get",
          undefined,
          10000
        );
        const setupHash = setupConfig.hash as string;

        const memorySearch: Record<string, unknown> = {
          enabled: true,
          provider: setupProvider,
          model: setupModel,
          sources: ["memory"],
        };
        if (setupProvider === "local" && localModelPath?.trim()) {
          memorySearch.local = { modelPath: localModelPath.trim() };
        }
        const referencePaths = await getWorkspaceReferencePaths();
        if (referencePaths.length > 0) {
          memorySearch.extraPaths = referencePaths;
        }

        const setupPatch = JSON.stringify({
          agents: {
            defaults: {
              memorySearch,
            },
          },
        });

        await gatewayConfigPatch(
          { raw: setupPatch, baseHash: setupHash },
          15000,
        );

        // Trigger initial index (includes extraPaths)
        try {
          await gatewayMemoryIndex();
        } catch {
          // indexing can fail if no memory files yet, that's fine
        }

        invalidateVectorCaches();
        return NextResponse.json({ ok: true, action, provider: setupProvider, model: setupModel });
      }

      case "disable-memory": {
        // Turn off vector memory without losing config (sets enabled: false)
        const { hash: disableHash, memorySearch: currentMs } = await getResolvedMemorySearchConfig();
        if (!currentMs || Object.keys(currentMs).length === 0) {
          return NextResponse.json({ ok: true, action, message: "Nothing to disable" });
        }
        const disabledMs = { ...currentMs, enabled: false };
        await patchMemorySearchConfig(disableHash, disabledMs);
        invalidateVectorCaches();
        return NextResponse.json({ ok: true, action });
      }

      case "update-embedding-model": {
        // Update embedding provider/model and optional memorySearch options (local path, fallback, cache)
        const provider = body.provider as string;
        const model = body.model as string;
        const localModelPath = body.localModelPath as string | undefined;
        const fallback = body.fallback as string | undefined;
        const cacheEnabled = body.cacheEnabled as boolean | undefined;

        if (!provider || !model) {
          return NextResponse.json(
            { error: "provider and model required" },
            { status: 400 }
          );
        }

        const { hash, memorySearch: currentMemorySearch } = await getResolvedMemorySearchConfig();

        const memorySearch: Record<string, unknown> = {
          ...currentMemorySearch,
          enabled: currentMemorySearch.enabled ?? true,
          provider,
          model,
          sources: currentMemorySearch.sources ?? ["memory"],
        };
        if (provider === "local" && localModelPath !== undefined) {
          memorySearch.local = {
            ...((currentMemorySearch.local as Record<string, unknown>) || {}),
            modelPath: localModelPath.trim() || undefined,
          };
        }
        if (fallback !== undefined) {
          memorySearch.fallback = fallback === "none" || fallback === "" ? "none" : fallback;
        }
        if (cacheEnabled !== undefined) {
          memorySearch.cache = {
            ...((currentMemorySearch.cache as Record<string, unknown>) || {}),
            enabled: cacheEnabled,
          };
        }
        const existingExtra = (currentMemorySearch.extraPaths as string[] | undefined) ?? [];
        const referencePaths = await getWorkspaceReferencePaths();
        const mergedExtra = [...new Set([...existingExtra, ...referencePaths])];
        if (mergedExtra.length > 0) {
          memorySearch.extraPaths = mergedExtra;
        }

        await patchMemorySearchConfig(hash, memorySearch);

        invalidateVectorCaches();
        return NextResponse.json({ ok: true, action, provider, model });
      }

      case "set-extra-paths": {
        const inputPaths = sanitizeExtraPaths(body.extraPaths);
        const workspaceDir = await getDefaultWorkspace();
        const workspaceRoot = resolve(workspaceDir);
        const normalizedExtra: string[] = [];
        const skippedPaths: string[] = [];

        for (const p of inputPaths) {
          const isAbsolute = p.startsWith("/") || /^[A-Za-z]:\//.test(p);
          const resolvedPath = isAbsolute ? resolve(p) : resolve(workspaceRoot, p);

          try {
            const fileStat = await stat(resolvedPath);
            if (fileStat.isFile()) {
              const ext = extname(resolvedPath).toLowerCase();
              if (!INDEXABLE_FILE_EXTENSIONS.has(ext)) {
                skippedPaths.push(p);
                continue;
              }
            } else if (!fileStat.isDirectory()) {
              skippedPaths.push(p);
              continue;
            }
          } catch {
            skippedPaths.push(p);
            continue;
          }

          normalizedExtra.push(isAbsolute ? resolvedPath : p);
        }

        const { hash, memorySearch: currentMemorySearch } = await getResolvedMemorySearchConfig();
        const nextMemorySearch: Record<string, unknown> = {
          ...currentMemorySearch,
          enabled: currentMemorySearch.enabled ?? true,
          sources: currentMemorySearch.sources ?? ["memory"],
        };

        if (normalizedExtra.length > 0) {
          nextMemorySearch.extraPaths = normalizedExtra;
        } else {
          // `config.patch` is a JSON merge patch (RFC 7386): omitting a key
          // means "leave it alone," not "delete it." Clearing the last extra
          // path needs an explicit null, or the previous list silently survives.
          nextMemorySearch.extraPaths = null;
        }

        // This action always sends the user's complete, intended selection —
        // a shrink or a clear is a deliberate replacement, not accidental data
        // loss, so tell config.patch to allow it instead of having it reject
        // the write outright (`config.patch would remove entries from array
        // path(s)`).
        await patchMemorySearchConfig(hash, nextMemorySearch, undefined, [
          "agents.defaults.memorySearch.extraPaths",
        ]);

        let reindexWarning: string | undefined;
        if (body.reindex !== false) {
          try {
            await gatewayMemoryIndex({ force: true });
          } catch (err) {
            reindexWarning = err instanceof Error ? err.message : String(err);
          }
        }

        invalidateVectorCaches();
        return NextResponse.json({
          ok: true,
          action,
          extraPaths: normalizedExtra,
          ...(reindexWarning ? { warning: `Reindex skipped: ${reindexWarning}` } : {}),
          ...(skippedPaths.length > 0 ? { skippedPaths } : {}),
        });
      }

      case "ensure-extra-paths": {
        // Merge all root-level .md workspace files into memorySearch.extraPaths and reindex
        const { hash, memorySearch: currentMemorySearch } = await getResolvedMemorySearchConfig();
        const existingExtra = (currentMemorySearch.extraPaths as string[] | undefined) ?? [];
        const referencePaths = await getWorkspaceReferencePaths();
        const mergedExtra = [...new Set([...existingExtra, ...referencePaths])];
        if (mergedExtra.length === 0) {
          return NextResponse.json({ ok: true, action, extraPaths: [], message: "No reference .md files found in workspace root" });
        }
        const memorySearch = {
          ...currentMemorySearch,
          extraPaths: mergedExtra,
        };
        await patchMemorySearchConfig(hash, memorySearch);

        // Also persist extraPaths to disk — gateway config.patch doesn't reliably
        // write extraPaths to openclaw.json, so CLI indexing would see stale config.
        try {
          const home = getOpenClawHome();
          const configPath = join(home, "openclaw.json");
          let diskConfig: Record<string, unknown> = {};
          try {
            const raw = await readFile(configPath, "utf-8");
            diskConfig = JSON.parse(raw) as Record<string, unknown>;
          } catch { /* fresh */ }
          const diskAgents = (diskConfig.agents || {}) as Record<string, unknown>;
          const diskDefaults = (diskAgents.defaults || {}) as Record<string, unknown>;
          const diskMs = (diskDefaults.memorySearch || {}) as Record<string, unknown>;
          diskMs.extraPaths = mergedExtra;
          diskDefaults.memorySearch = diskMs;
          diskAgents.defaults = diskDefaults;
          diskConfig.agents = diskAgents;
          await writeFile(configPath, JSON.stringify(diskConfig, null, 2) + "\n", "utf-8");
        } catch {
          // Non-fatal — gateway may still have it in-memory
        }

        // Reindex is best-effort — the config patch (extraPaths) already succeeded
        let reindexWarning: string | undefined;
        try {
          await gatewayMemoryIndex({ force: true });
        } catch (err) {
          reindexWarning = `Reindex skipped: ${err instanceof Error ? err.message : String(err)}`;
        }
        invalidateVectorCaches();
        return NextResponse.json({ ok: true, action, extraPaths: mergedExtra, ...(reindexWarning ? { warning: reindexWarning } : {}) });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("Vector API POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
