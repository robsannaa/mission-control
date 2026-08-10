/** Shared types for the Vector Memory page (`vector-view.tsx` + `vector/**`). */

export type SourceCount = { source: string; files: number; chunks: number };

export type AgentMemory = {
  agentId: string;
  dbSizeBytes: number;
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
    sourceCounts: SourceCount[];
    cache: { enabled: boolean; entries: number };
    fts: { enabled: boolean; available: boolean };
    // `available` is only populated by `memory status --deep` (a real extra
    // provider round-trip). Plain status — what this page uses to stay fast —
    // leaves it undefined, which means "not probed," not "unavailable." Never
    // treat the two the same.
    vector: { enabled: boolean; available?: boolean; extensionPath?: string; dims?: number };
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
  scan: { sources: { source: string; totalFiles: number; issues: string[] }[]; totalFiles: number; issues: string[] };
};

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
};

export type VectorDocOption = { path: string; selected: boolean; source: "workspace" | "custom" };

export type Toast = { message: string; type: "success" | "error" };

/** What we could actually verify about each embedding provider on THIS install. */
export type ProviderAvailability = {
  openai: { keyPresent: boolean };
  google: { keyPresent: boolean };
  ollama: { reachable: boolean; embeddingModels: string[] };
  local: { pluginInstalled: boolean };
};

export type StatusResponse = {
  agents: AgentMemory[];
  embeddingConfig: Record<string, unknown> | null;
  memorySearch: Record<string, unknown> | null;
  configHash: string | null;
  authProviders: string[];
  providerAvailability: ProviderAvailability;
  home: string;
  defaultWorkspace: string;
  warning?: string;
  degraded?: boolean;
  cached?: boolean;
};
