import { NextRequest, NextResponse } from "next/server";
import { readFile, readdir, stat } from "fs/promises";
import { join } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { buildModelsSummary } from "@/lib/models-summary";
import { fetchGatewaySessions } from "@/lib/gateway-sessions";
import type { NormalizedGatewaySession } from "@/lib/gateway-sessions";
import { estimateCostUsd } from "@/lib/model-metadata";
import { fetchOpenRouterPricing } from "@/lib/openrouter-pricing";
import { ingestGatewaySessionsToLedger, readLedgerUsageSnapshot } from "@/lib/usage-ledger";
import { ensureProviderBillingFreshness, getAllProviderSnapshots } from "@/lib/provider-billing/shared";
import { readReconciliationSnapshot, runUsageReconciliation } from "@/lib/reconciliation";
import { ensureUsageScheduler } from "@/lib/usage-scheduler";
import type { UsageApiResponse } from "@/lib/usage-types";
import { withRoute } from "@/lib/api-route";

const OPENCLAW_HOME = getOpenClawHome();
export const dynamic = "force-dynamic";

type SessionEntry = {
  key: string;
  kind: string;
  updatedAt: number;
  ageMs: number;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalTokensFresh: boolean;
  model: string;
  fullModel: string;
  contextTokens: number;
  thinkingLevel?: string;
  systemSent?: boolean;
  abortedLastRun?: boolean;
  percentUsed?: number;
  remainingTokens?: number;
  estimatedCostUsd: number | null;
};

type ModelStatusData = {
  defaultModel: string;
  resolvedDefault: string;
  fallbacks: string[];
  imageModel: string;
  imageFallbacks: string[];
  aliases: Record<string, string>;
  allowed: string[];
  auth?: {
    providers: {
      provider: string;
      effective: { kind: string; detail: string };
      profiles: { count: number; oauth: number; token: number; apiKey: number };
    }[];
  };
};

type DiagnosticsSource = {
  ok: boolean;
  error: string | null;
};

type MissingPricingModel = {
  model: string;
  sessions: number;
  totalTokens: number;
};

type UsageDiagnostics = {
  sources: {
    gateway: DiagnosticsSource;
    usageLedgerWrite: DiagnosticsSource;
    historical: DiagnosticsSource;
    modelStatus: DiagnosticsSource;
    agentDirectory: DiagnosticsSource;
    sessionStorage: DiagnosticsSource & { failedAgents: string[] };
    scheduler: DiagnosticsSource;
    providerBilling: DiagnosticsSource;
    reconciliation: DiagnosticsSource;
  };
  pricing: {
    coveredSessions: number;
    uncoveredSessions: number;
    coveragePct: number;
    uncoveredModels: MissingPricingModel[];
  };
  warnings: string[];
};

type Period = "last1h" | "last24h" | "last7d" | "allTime";

type ActivityPoint = {
  ts: number;
  input: number;
  output: number;
  total: number;
  sessions: number;
};

type SessionWithAgent = SessionEntry & { agentId: string };

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 280);
  return String(err).slice(0, 280);
}

function modelProvider(fullModel: string): string {
  const provider = String(fullModel || "").split("/")[0]?.trim().toLowerCase();
  return provider || "unknown";
}

function emptyLedgerSnapshot(): Awaited<ReturnType<typeof readLedgerUsageSnapshot>> {
  const emptyBucket = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    sessions: 0,
  };
  const emptyUsdWindow = {
    usd: null,
    coveragePct: 0,
  };
  return {
    windows: {
      last1h: { ...emptyBucket },
      last24h: { ...emptyBucket },
      last7d: { ...emptyBucket },
      allTime: { ...emptyBucket },
    },
    activitySeries: {
      last1h: [],
      last24h: [],
      last7d: [],
      allTime: [],
    },
    activitySeriesByModel: {},
    historical: {
      byModel: {},
      byAgent: {},
      costTimeSeries: [],
      totalEstimatedUsd: 0,
      totalTokens: 0,
      rowCount: 0,
    },
    estimatedSpend: {
      totalUsd: null,
      windows: {
        last1h: { ...emptyUsdWindow },
        last24h: { ...emptyUsdWindow },
        last7d: { ...emptyUsdWindow },
        allTime: { ...emptyUsdWindow },
      },
      byModel: [],
    },
    localTelemetryMs: null,
  };
}

function emptyReconciliationSnapshot(): Awaited<ReturnType<typeof readReconciliationSnapshot>> {
  return {
    summary: {
      reconciledBuckets: 0,
      mismatchBuckets: 0,
      estimatedOnlyBuckets: 0,
      providerOnlyBuckets: 0,
      staleBuckets: 0,
    },
    rows: [],
    lastRunMs: null,
  };
}

export const GET = withRoute({ name: "/api/usage" }, async (request: NextRequest, ctx) => {
  try {
    const configPath = join(OPENCLAW_HOME, "openclaw.json");
    const config = await readJsonSafe<Record<string, unknown>>(configPath, {});
    const agentsConfig = (config.agents || {}) as Record<string, unknown>;
    const defaults = (agentsConfig.defaults || {}) as Record<string, unknown>;
    const configList = (agentsConfig.list || []) as Record<string, unknown>[];
    const defaultModelCfg = defaults.model as Record<string, unknown> | undefined;
    const defaultPrimary = (defaultModelCfg?.primary as string) || "unknown";
    const defaultFallbacks = (defaultModelCfg?.fallbacks as string[]) || [];

    const diagnostics: UsageDiagnostics = {
      sources: {
        gateway: { ok: true, error: null },
        usageLedgerWrite: { ok: true, error: null },
        historical: { ok: true, error: null },
        modelStatus: { ok: true, error: null },
        agentDirectory: { ok: true, error: null },
        sessionStorage: { ok: true, error: null, failedAgents: [] },
        scheduler: { ok: true, error: null },
        providerBilling: { ok: true, error: null },
        reconciliation: { ok: true, error: null },
      },
      pricing: {
        coveredSessions: 0,
        uncoveredSessions: 0,
        coveragePct: 100,
        uncoveredModels: [],
      },
      warnings: [],
    };

    // Fire-and-forget background work: scheduler, ingest, billing, and reconciliation.
    // These used to run synchronously and could timeout/lock the entire GET request,
    // causing 500 errors. Now they run concurrently and we catch errors gracefully.
    const schedulerP = ensureUsageScheduler(request.nextUrl.origin).catch((err: unknown) => {
      diagnostics.sources.scheduler.ok = false;
      diagnostics.sources.scheduler.error = errorMessage(err);
      diagnostics.warnings.push("Mission Control could not refresh its system-managed usage jobs.");
    });

    const configuredAgentIds: string[] = [];
    const discoveredAgentIds: string[] = [];
    for (const c of configList) {
      if (c.id) {
        const id = c.id as string;
        configuredAgentIds.push(id);
        discoveredAgentIds.push(id);
      }
    }
    try {
      const dirs = await readdir(join(OPENCLAW_HOME, "agents"), { withFileTypes: true });
      for (const d of dirs) {
        if (d.isDirectory() && !discoveredAgentIds.includes(d.name)) discoveredAgentIds.push(d.name);
      }
    } catch (err) {
      if (getErrorCode(err) !== "ENOENT") {
        diagnostics.sources.agentDirectory.ok = false;
        diagnostics.sources.agentDirectory.error = errorMessage(err);
        diagnostics.warnings.push("Agent directory scan failed; agent totals may be incomplete.");
      }
    }

    const allSessions: SessionWithAgent[] = [];
    let liveSessions: NormalizedGatewaySession[] = [];
    try {
      liveSessions = await fetchGatewaySessions(12000);
    } catch (err) {
      diagnostics.sources.gateway.ok = false;
      diagnostics.sources.gateway.error = errorMessage(err);
      diagnostics.warnings.push("Live gateway sessions are unavailable; live usage may be incomplete.");
    }

    // Run ingest, billing refresh, and reconciliation concurrently.
    // These are write operations that should not block the read path.
    const ingestP = ingestGatewaySessionsToLedger(liveSessions).catch((err: unknown) => {
      diagnostics.sources.usageLedgerWrite.ok = false;
      diagnostics.sources.usageLedgerWrite.error = errorMessage(err);
      diagnostics.warnings.push("Failed to persist usage deltas; historical windows may lag.");
    });
    const billingP = ensureProviderBillingFreshness().catch((err: unknown) => {
      diagnostics.sources.providerBilling.ok = false;
      diagnostics.sources.providerBilling.error = errorMessage(err);
      diagnostics.warnings.push("Provider billing collectors did not refresh cleanly.");
    });
    const reconcileP = runUsageReconciliation().catch((err: unknown) => {
      diagnostics.sources.reconciliation.ok = false;
      diagnostics.sources.reconciliation.error = errorMessage(err);
      diagnostics.warnings.push("Reconciliation did not complete; trust labels may be stale.");
    });

    // Give the fast local writes (ingest) a brief moment to land so the ledger
    // read below picks them up, but never wait on the slow ones (external
    // provider billing, reconciliation): those keep running in the background
    // and the next 30s poll reflects them. Waiting the old 8s here meant one
    // slow billing call could stall the whole page.
    await Promise.race([
      Promise.allSettled([schedulerP, ingestP, billingP, reconcileP]),
      new Promise((resolve) => setTimeout(resolve, 1200)),
    ]);

    const dynamicPricing = await fetchOpenRouterPricing().catch(() => null);
    const missingPricingModels = new Map<string, MissingPricingModel>();
    let missingPricingSessions = 0;

    for (const s of liveSessions) {
      const cost = estimateCostUsd(
        s.fullModel,
        s.inputTokens,
        s.outputTokens,
        s.cacheReadTokens,
        s.cacheWriteTokens,
        dynamicPricing || undefined,
      );
      if (cost == null) {
        missingPricingSessions += 1;
        const prev = missingPricingModels.get(s.fullModel) || {
          model: s.fullModel,
          sessions: 0,
          totalTokens: 0,
        };
        prev.sessions += 1;
        prev.totalTokens += s.totalTokens;
        missingPricingModels.set(s.fullModel, prev);
      }
      allSessions.push({
        key: s.key,
        kind: s.kind,
        updatedAt: s.updatedAt,
        ageMs: s.ageMs,
        sessionId: s.sessionId,
        inputTokens: s.inputTokens,
        outputTokens: s.outputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: s.cacheWriteTokens,
        totalTokens: s.totalTokens,
        totalTokensFresh: s.totalTokensFresh,
        model: s.model,
        fullModel: s.fullModel,
        contextTokens: s.contextTokens,
        thinkingLevel: s.thinkingLevel,
        systemSent: s.systemSent,
        abortedLastRun: s.abortedLastRun,
        percentUsed: s.contextTokens
          ? Math.round((s.totalTokens / Math.max(1, s.contextTokens)) * 100)
          : undefined,
        remainingTokens: s.contextTokens ? s.contextTokens - s.totalTokens : undefined,
        estimatedCostUsd: cost,
        agentId: s.agentId || "unknown",
      });
    }

    allSessions.sort((a, b) => b.updatedAt - a.updatedAt);

    const byModel: Record<string, {
      model: string;
      fullModel: string;
      sessions: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      contextTokens: number;
      agents: Set<string>;
      lastUsed: number;
      avgPercentUsed: number;
      estimatedCostUsd: number | null;
    }> = {};

    const byAgent: Record<string, {
      agentId: string;
      sessions: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      totalTokens: number;
      contextTokens: number;
      models: Set<string>;
      lastUsed: number;
      estimatedCostUsd: number | null;
    }> = {};

    let grandTotalInput = 0;
    let grandTotalOutput = 0;
    let grandTotalTokens = 0;
    let grandTotalCacheRead = 0;
    let grandTotalCacheWrite = 0;
    let grandTotalCostUsd = 0;
    let staleSessions = 0;
    let peakSession: SessionWithAgent | null = null;

    for (const s of allSessions) {
      grandTotalInput += s.inputTokens;
      grandTotalOutput += s.outputTokens;
      grandTotalTokens += s.totalTokens;
      grandTotalCacheRead += s.cacheReadTokens;
      grandTotalCacheWrite += s.cacheWriteTokens;
      if (s.estimatedCostUsd != null) grandTotalCostUsd += s.estimatedCostUsd;
      if (!s.totalTokensFresh) staleSessions += 1;
      if (!peakSession || s.totalTokens > peakSession.totalTokens) peakSession = s;

      if (!byModel[s.model]) {
        byModel[s.model] = {
          model: s.model,
          fullModel: s.fullModel,
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          agents: new Set(),
          lastUsed: 0,
          avgPercentUsed: 0,
          estimatedCostUsd: null,
        };
      }
      const bm = byModel[s.model];
      bm.sessions += 1;
      bm.inputTokens += s.inputTokens;
      bm.outputTokens += s.outputTokens;
      bm.cacheReadTokens += s.cacheReadTokens;
      bm.cacheWriteTokens += s.cacheWriteTokens;
      bm.totalTokens += s.totalTokens;
      bm.contextTokens = Math.max(bm.contextTokens, s.contextTokens);
      bm.agents.add(s.agentId);
      bm.lastUsed = Math.max(bm.lastUsed, s.updatedAt);
      if (s.estimatedCostUsd != null) {
        bm.estimatedCostUsd = (bm.estimatedCostUsd ?? 0) + s.estimatedCostUsd;
      }

      if (!byAgent[s.agentId]) {
        byAgent[s.agentId] = {
          agentId: s.agentId,
          sessions: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          contextTokens: 0,
          models: new Set(),
          lastUsed: 0,
          estimatedCostUsd: null,
        };
      }
      const ba = byAgent[s.agentId];
      ba.sessions += 1;
      ba.inputTokens += s.inputTokens;
      ba.outputTokens += s.outputTokens;
      ba.cacheReadTokens += s.cacheReadTokens;
      ba.cacheWriteTokens += s.cacheWriteTokens;
      ba.totalTokens += s.totalTokens;
      ba.contextTokens = Math.max(ba.contextTokens, s.contextTokens);
      ba.models.add(s.model);
      ba.lastUsed = Math.max(ba.lastUsed, s.updatedAt);
      if (s.estimatedCostUsd != null) {
        ba.estimatedCostUsd = (ba.estimatedCostUsd ?? 0) + s.estimatedCostUsd;
      }
    }

    for (const m of Object.values(byModel)) {
      if (m.contextTokens > 0 && m.sessions > 0) {
        m.avgPercentUsed = Math.round((m.totalTokens / m.sessions) / m.contextTokens * 100);
      }
    }

    let modelStatus: ModelStatusData | null = null;
    let configuredProviders: string[] = [];
    try {
      const summary = await buildModelsSummary();
      modelStatus = summary.status as ModelStatusData;
      configuredProviders = Array.isArray(summary.configuredProviders)
        ? summary.configuredProviders.map((provider) => String(provider).trim().toLowerCase()).filter(Boolean)
        : [];
    } catch (err) {
      diagnostics.sources.modelStatus.ok = false;
      diagnostics.sources.modelStatus.error = errorMessage(err);
      diagnostics.warnings.push("Model routing metadata is unavailable right now.");
    }

    const agentModels: { agentId: string; primary: string; fallbacks: string[] }[] = [];
    for (const cfg of configList) {
      const id = cfg.id as string;
      if (!id) continue;
      const agentModelCfg = cfg.model as Record<string, unknown> | undefined;
      const primary = (agentModelCfg?.primary as string) || defaultPrimary;
      const fallbacks = (agentModelCfg?.fallbacks as string[]) || defaultFallbacks;
      agentModels.push({ agentId: id, primary, fallbacks });
    }

    // Gather session file sizes concurrently per-agent with a cap to prevent slow I/O.
    const sessionFileSizes: { agentId: string; sizeBytes: number; fileCount: number }[] = [];
    const MAX_SESSION_AGENTS = 50;
    const sessionAgentSlice = discoveredAgentIds.slice(0, MAX_SESSION_AGENTS);
    const sessionSizeResults = await Promise.allSettled(
      sessionAgentSlice.map(async (agentId) => {
        const sessDir = join(OPENCLAW_HOME, "agents", agentId, "sessions");
        const files = await readdir(sessDir);
        let totalSize = 0;
        let count = 0;
        for (const f of files) {
          if (f.endsWith(".jsonl") && !f.includes(".deleted")) {
            try {
              const st = await stat(join(sessDir, f));
              totalSize += st.size;
              count += 1;
            } catch {
              // File may have been deleted between readdir and stat
            }
          }
        }
        return { agentId, sizeBytes: totalSize, fileCount: count };
      }),
    );
    for (const result of sessionSizeResults) {
      if (result.status === "fulfilled") {
        sessionFileSizes.push(result.value);
      } else {
        const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
        if (!errMsg.includes("ENOENT")) {
          diagnostics.sources.sessionStorage.ok = false;
          if (!diagnostics.sources.sessionStorage.error) {
            diagnostics.sources.sessionStorage.error = errMsg.slice(0, 280);
          }
        }
      }
    }
    if (!diagnostics.sources.sessionStorage.ok) {
      diagnostics.warnings.push("Session storage metrics failed for some agent(s).");
    }

    let ledger: Awaited<ReturnType<typeof readLedgerUsageSnapshot>> = emptyLedgerSnapshot();
    try {
      ledger = await readLedgerUsageSnapshot();
    } catch (err) {
      diagnostics.sources.historical.ok = false;
      diagnostics.sources.historical.error = errorMessage(err);
      diagnostics.warnings.push("Usage ledger storage is unavailable; showing live usage only.");
    }

    let providerBilling: Awaited<ReturnType<typeof getAllProviderSnapshots>> = [];
    try {
      providerBilling = await getAllProviderSnapshots();
    } catch (err) {
      diagnostics.sources.providerBilling.ok = false;
      if (!diagnostics.sources.providerBilling.error) {
        diagnostics.sources.providerBilling.error = errorMessage(err);
      }
      diagnostics.warnings.push("Provider billing snapshots are unavailable right now.");
    }

    let reconciliation: Awaited<ReturnType<typeof readReconciliationSnapshot>> =
      emptyReconciliationSnapshot();
    try {
      reconciliation = await readReconciliationSnapshot();
    } catch (err) {
      diagnostics.sources.reconciliation.ok = false;
      if (!diagnostics.sources.reconciliation.error) {
        diagnostics.sources.reconciliation.error = errorMessage(err);
      }
      diagnostics.warnings.push("Reconciliation data is temporarily unavailable.");
    }

    const uncoveredModels = Array.from(missingPricingModels.values()).sort((a, b) => b.sessions - a.sessions);
    const coveredSessions = allSessions.length - missingPricingSessions;
    diagnostics.pricing = {
      coveredSessions,
      uncoveredSessions: missingPricingSessions,
      coveragePct: allSessions.length ? Math.round((coveredSessions / allSessions.length) * 100) : 100,
      uncoveredModels,
    };
    if (missingPricingSessions > 0) {
      diagnostics.warnings.push(
        `${missingPricingSessions} session(s) are excluded from cost because pricing metadata is missing.`,
      );
    }

    const modelBreakdown = Object.values(byModel)
      .map((m) => ({ ...m, agents: Array.from(m.agents) }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const agentBreakdown = Object.values(byAgent)
      .map((a) => ({ ...a, models: Array.from(a.models) }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const activitySeriesByModel: Record<string, Record<Period, ActivityPoint[]>> = {};
    for (const model of modelBreakdown) {
      activitySeriesByModel[model.model] =
        ledger.activitySeriesByModel[model.fullModel] || ledger.activitySeries;
    }

    const response: UsageApiResponse & Record<string, unknown> = {
      ok: true,
      asOfMs: Date.now(),
      liveTelemetry: {
        totals: {
          sessions: allSessions.length,
          agents: configuredAgentIds.length,
          models: Object.keys(byModel).length,
          inputTokens: grandTotalInput,
          outputTokens: grandTotalOutput,
          reasoningTokens: 0,
          cacheReadTokens: grandTotalCacheRead,
          cacheWriteTokens: grandTotalCacheWrite,
          totalTokens: grandTotalTokens,
        },
        windows: ledger.windows,
        byModel: modelBreakdown.map((m) => ({
          fullModel: m.fullModel,
          provider: modelProvider(m.fullModel),
          sessions: m.sessions,
          totalTokens: m.totalTokens,
          inputTokens: m.inputTokens,
          outputTokens: m.outputTokens,
          estimatedCostUsd: m.estimatedCostUsd,
        })),
        byAgent: agentBreakdown.map((a) => ({
          agentId: a.agentId,
          sessions: a.sessions,
          totalTokens: a.totalTokens,
          estimatedCostUsd: a.estimatedCostUsd,
        })),
        sourceLabel: "Local telemetry",
      },
      estimatedSpend: {
        ...ledger.estimatedSpend,
        sourceLabel: "Estimated from local telemetry and pricing",
      },
      providerBilling: {
        providers: providerBilling,
        configuredProviders,
      },
      reconciliation: {
        summary: reconciliation.summary,
        rows: reconciliation.rows,
      },
      freshness: {
        localTelemetryMs: ledger.localTelemetryMs,
        providerBillingByProvider: Object.fromEntries(
          providerBilling.map((provider) => [provider.provider, provider.latestBucketStartMs]),
        ),
        reconciliationMs: reconciliation.lastRunMs,
      },
      coverage: {
        estimatedPricingCoveragePct: diagnostics.pricing.coveragePct,
        invoiceGradeProviders: providerBilling
          .filter((provider) => provider.billingMode === "invoice_api")
          .map((provider) => provider.provider),
        estimateOnlyProviders: [
          ...new Set(modelBreakdown.map((model) => modelProvider(model.fullModel))),
        ].filter((provider) => {
          const snapshot = providerBilling.find((entry) => entry.provider === provider);
          return snapshot?.billingMode !== "invoice_api";
        }),
      },
      diagnostics: {
        ...diagnostics,
        sourceErrors: Object.entries(diagnostics.sources)
          .filter(([, source]) => source.error)
          .map(([source, value]) => ({ source, error: value.error || "unknown" })),
      },

      // Backward-compatible fields for the existing Usage UI.
      totals: {
        sessions: allSessions.length,
        inputTokens: grandTotalInput,
        outputTokens: grandTotalOutput,
        totalTokens: grandTotalTokens,
        models: Object.keys(byModel).length,
        agents: configuredAgentIds.length,
        staleSessions,
      },
      liveCost: {
        totalEstimatedUsd: grandTotalCostUsd,
        totalCacheReadTokens: grandTotalCacheRead,
        totalCacheWriteTokens: grandTotalCacheWrite,
      },
      buckets: {
        last1h: {
          input: ledger.windows.last1h.inputTokens,
          output: ledger.windows.last1h.outputTokens,
          total: ledger.windows.last1h.totalTokens,
          sessions: ledger.windows.last1h.sessions,
        },
        last24h: {
          input: ledger.windows.last24h.inputTokens,
          output: ledger.windows.last24h.outputTokens,
          total: ledger.windows.last24h.totalTokens,
          sessions: ledger.windows.last24h.sessions,
        },
        last7d: {
          input: ledger.windows.last7d.inputTokens,
          output: ledger.windows.last7d.outputTokens,
          total: ledger.windows.last7d.totalTokens,
          sessions: ledger.windows.last7d.sessions,
        },
        allTime: {
          input: ledger.windows.allTime.inputTokens,
          output: ledger.windows.allTime.outputTokens,
          total: ledger.windows.allTime.totalTokens,
          sessions: ledger.windows.allTime.sessions,
        },
      },
      activitySeries: ledger.activitySeries,
      activitySeriesByModel,
      modelBreakdown,
      agentBreakdown,
      sessions: allSessions.slice(0, 50),
      peakSession: peakSession
        ? {
            sessionId: peakSession.sessionId,
            key: peakSession.key,
            agentId: peakSession.agentId,
            model: peakSession.model,
            totalTokens: peakSession.totalTokens,
            contextTokens: peakSession.contextTokens,
            percentUsed: peakSession.percentUsed,
          }
        : null,
      modelConfig: modelStatus
        ? {
            primary: modelStatus.defaultModel,
            fallbacks: modelStatus.fallbacks,
            imageModel: modelStatus.imageModel,
            aliases: modelStatus.aliases,
            allowed: modelStatus.allowed,
            authProviders: (modelStatus.auth?.providers || []).map((p) => ({
              provider: p.provider,
              authKind: p.effective?.kind || "unknown",
              profiles: p.profiles?.count || 0,
            })),
          }
        : null,
      agentModels,
      sessionFileSizes,
      historical: ledger.historical,
    };

    return NextResponse.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err: message }, "Usage API error");
    const stack = err instanceof Error ? err.stack?.split("\n").slice(0, 4).join("\n") : undefined;
    // Manually constructed (not through an api-errors.ts builder): this
    // response carries `hint`/`stack` fields the builders have no slot for,
    // alongside the canonical `ok: false, error` pair — same precedent as
    // `/api/config`'s and `/api/gateway`'s extra-field error bodies
    // (.planning/phases/02-server-contract-hardening/02-04-SUMMARY.md).
    return NextResponse.json(
      {
        ok: false,
        error: message.slice(0, 500),
        hint: message.includes("sqlite3")
          ? "SQLite is required for usage tracking. Install sqlite3 and restart."
          : message.includes("ENOSPC")
            ? "Disk is full. Free disk space and try again."
            : "Reload the page. If the issue persists, check the gateway status.",
        stack: process.env.NODE_ENV === "development" ? stack : undefined,
      },
      { status: 500 },
    );
  }
});
