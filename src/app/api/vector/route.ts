import { NextRequest, NextResponse } from "next/server";
import { readdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "path";
import { runCliJson, gatewayCall } from "@/lib/openclaw";
import { getOpenClawHome, getDefaultWorkspace } from "@/lib/paths";
import { gatewayConfigPatch } from "@/lib/gateway-config";
import { buildModelsSummary } from "@/lib/models-summary";
import { gatewayMemoryIndex } from "@/lib/gateway-tools";

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
    vector: {
      enabled: boolean;
      available: boolean;
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

/* ── GET: status + search ─────────────────────────── */

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") || "status";

  try {
    if (scope === "status") {
      // Get memory status for all agents (kept as CLI — detailed runtime data)
      let agents: MemoryStatus[] = [];
      let agentsWarning: string | null = null;
      try {
        agents = await runCliJson<MemoryStatus[]>(
          ["memory", "status"],
          15000
        );
      } catch (err) {
        agentsWarning = String(err);
      }

      // Enrich with DB file sizes
      const enriched = await Promise.all(
        agents.map(async (a) => ({
          ...a,
          dbSizeBytes: await getDbFileSize(a.status.dbPath),
        }))
      );

      // Get embedding config + memorySearch from config.get
      let embeddingConfig: Record<string, unknown> | null = null;
      let memorySearch: Record<string, unknown> | null = null;
      let configHash: string | null = null;
      try {
        const configData = await gatewayCall<Record<string, unknown>>(
          "config.get",
          undefined,
          10000
        );
        configHash = (configData.hash as string) || null;
        const resolved = (configData.resolved || {}) as Record<string, unknown>;
        const agents_config = (resolved.agents || {}) as Record<string, unknown>;
        const defaults = (agents_config.defaults || {}) as Record<string, unknown>;
        embeddingConfig = {
          model: defaults.model || null,
          contextTokens: defaults.contextTokens || null,
        };
        memorySearch = (defaults.memorySearch || null) as Record<string, unknown> | null;
      } catch {
        // config not available
      }

      // Get authenticated embedding providers without spawning the CLI.
      let authProviders: string[] = [];
      try {
        const modelsSummary = await buildModelsSummary();
        authProviders = (modelsSummary.status.auth?.providers || [])
          .filter((provider) => provider.effective)
          .map((provider) => String(provider.provider || "").trim())
          .filter(Boolean);
      } catch {
        if (process.env.OPENAI_API_KEY) authProviders.push("openai");
        if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) authProviders.push("google");
      }

      return NextResponse.json({
        agents: enriched,
        embeddingConfig,
        memorySearch,
        configHash,
        authProviders,
        home: getOpenClawHome(),
        defaultWorkspace: await getDefaultWorkspace(),
        warning: agentsWarning || undefined,
      });
    }

    if (scope === "documents") {
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
      return NextResponse.json({
        workspaceDir,
        docs: entries,
        selectedExtraPaths,
      });
    }

    if (scope === "search") {
      const query = searchParams.get("q") || "";
      const agent = searchParams.get("agent") || "";
      const maxResults = searchParams.get("max") || "10";
      const minScore = searchParams.get("minScore") || "";

      if (!query || query.trim().length < 2) {
        return NextResponse.json({ results: [], query });
      }

      // `runCliJson` appends `--json` itself.
      const args = [
        "memory",
        "search",
        "--query",
        query.trim(),
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
        const output = await gatewayMemoryIndex({
          agent: agent || undefined,
          force: force || undefined,
        });

        return NextResponse.json({ ok: true, action, output });
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
          delete nextMemorySearch.extraPaths;
        }

        await patchMemorySearchConfig(hash, nextMemorySearch);

        let reindexWarning: string | undefined;
        if (body.reindex !== false) {
          try {
            await gatewayMemoryIndex({ force: true });
          } catch (err) {
            reindexWarning = err instanceof Error ? err.message : String(err);
          }
        }

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
