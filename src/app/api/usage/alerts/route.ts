import { NextRequest, NextResponse } from "next/server";
import {
  createUsageAlertRule,
  deleteUsageAlertRule,
  evaluateAndStoreUsageAlerts,
  getProviderCapabilities,
  listRecentAlertFirings,
  listUsageAlertRules,
  normalizeAlertKind,
  normalizeScopeType,
  normalizeTimeline,
  pollPendingAlertFirings,
  previewUsageAlerts,
  readAlertRuntimeStatus,
  setAlertMonitorEnabled,
  updateUsageAlertRule,
} from "@/lib/usage-alerts";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { usageAlertsPollQuerySchema, usageAlertsPostSchema } from "@/lib/schemas/usage";

export const dynamic = "force-dynamic";

function toPositiveNumber(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

async function buildStatusPayload() {
  const [runtime, rules, evaluations, recentFirings] = await Promise.all([
    readAlertRuntimeStatus(),
    listUsageAlertRules(),
    previewUsageAlerts(),
    listRecentAlertFirings(20),
  ]);
  const rulesCompat = rules.map((rule) => ({
    ...rule,
    fullModel: rule.scopeType === "model" ? rule.scopeValue || "" : "",
    tokenLimit: rule.thresholdValue,
  }));
  const evaluationsCompat = evaluations.map((evaluation) => ({
    ...evaluation,
    provider:
      evaluation.scopeType === "provider"
        ? evaluation.scopeValue || "unknown"
        : evaluation.scopeType === "model"
          ? String(evaluation.scopeValue || "").split("/")[0] || "unknown"
          : "global",
    fullModel: evaluation.scopeType === "model" ? evaluation.scopeValue || "" : "",
    tokenLimit: evaluation.thresholdValue,
    observedTokens: evaluation.observedValue,
    totalModelTokens: evaluation.observedValue,
    sampleSessions: 0,
    staleSessions: 0,
  }));
  return NextResponse.json({
    ok: true,
    monitorEnabled: runtime.monitorEnabled,
    lastEvaluatedMs: runtime.lastEvaluatedMs,
    rules: rulesCompat,
    evaluations: evaluationsCompat,
    recentFirings,
    providerCapabilities: getProviderCapabilities(),
    timestamp: Date.now(),
  });
}

export const GET = withRoute(
  { name: "/api/usage/alerts", querySchema: usageAlertsPollQuerySchema },
  async (_request: NextRequest, ctx) => {
    if (ctx.query.poll === "1") {
      const alerts = await pollPendingAlertFirings(20);
      return NextResponse.json({ ok: true, alerts, timestamp: Date.now() });
    }
    return buildStatusPayload();
  },
);

export const POST = withRoute(
  { name: "/api/usage/alerts", bodySchema: usageAlertsPostSchema },
  async (_request: NextRequest, ctx) => {
  try {
    const body = ctx.body as Record<string, unknown>;
    const action = String(body.action || "").trim().toLowerCase();

    if (action === "status") {
      return buildStatusPayload();
    }
    if (action === "check") {
      const result = await evaluateAndStoreUsageAlerts();
      const runtime = await readAlertRuntimeStatus();
      const rules = await listUsageAlertRules();
      return NextResponse.json({
        ok: true,
        monitorEnabled: runtime.monitorEnabled,
        lastEvaluatedMs: runtime.lastEvaluatedMs,
        rules: rules.map((rule) => ({
          ...rule,
          fullModel: rule.scopeType === "model" ? rule.scopeValue || "" : "",
          tokenLimit: rule.thresholdValue,
        })),
        evaluations: result.evaluations.map((evaluation) => ({
          ...evaluation,
          provider:
            evaluation.scopeType === "provider"
              ? evaluation.scopeValue || "unknown"
              : evaluation.scopeType === "model"
                ? String(evaluation.scopeValue || "").split("/")[0] || "unknown"
                : "global",
          fullModel: evaluation.scopeType === "model" ? evaluation.scopeValue || "" : "",
          tokenLimit: evaluation.thresholdValue,
          observedTokens: evaluation.observedValue,
          totalModelTokens: evaluation.observedValue,
          sampleSessions: 0,
          staleSessions: 0,
        })),
        alerts: result.firings.map((firing) => ({ id: firing.id || `${firing.ruleId}:${firing.windowKey}`, message: firing.message })),
        recentFirings: result.firings,
        providerCapabilities: getProviderCapabilities(),
        timestamp: Date.now(),
      });
    }
    if (action === "poll-notifications") {
      const alerts = await pollPendingAlertFirings(20);
      return NextResponse.json({ ok: true, alerts, timestamp: Date.now() });
    }
    if (action === "set-monitor" || action === "set-monitor-enabled") {
      await setAlertMonitorEnabled(Boolean(body.monitorEnabled));
      const runtime = await readAlertRuntimeStatus();
      return NextResponse.json({ ok: true, monitorEnabled: runtime.monitorEnabled });
    }

    if (action === "create" || action === "create-rule") {
      const kind = normalizeAlertKind(body.kind) || "token-usage";
      const scopeType = normalizeScopeType(body.scopeType) || "model";
      const timeline = normalizeTimeline(body.timeline);
      const thresholdValue =
        toPositiveNumber(body.thresholdValue) ??
        toPositiveNumber(body.tokenLimit);
      const scopeValueRaw =
        body.scopeValue !== undefined ? String(body.scopeValue || "").trim() : String(body.fullModel || "").trim();
      const scopeValue = scopeType === "global" ? null : scopeValueRaw || null;

      if (!timeline) return badRequest("Timeline must be one of: last1h, last24h, last7d, todayUtc, monthUtc.");
      if (!thresholdValue) return badRequest("Threshold must be a positive number.");
      if (scopeType !== "global" && !scopeValue) return badRequest("scopeValue is required for model/provider rules.");

      await createUsageAlertRule({
        kind,
        scopeType,
        scopeValue,
        timeline,
        thresholdValue,
        deliveryMode: typeof body.deliveryMode === "string" ? body.deliveryMode : "none",
        deliveryChannel: typeof body.deliveryChannel === "string" ? body.deliveryChannel : null,
        deliveryTo: typeof body.deliveryTo === "string" ? body.deliveryTo : null,
        bestEffort: Boolean(body.bestEffort),
      });
      return buildStatusPayload();
    }

    if (action === "update" || action === "update-rule") {
      const ruleId = String(body.ruleId || "").trim();
      if (!ruleId) return badRequest("ruleId is required.");
      const patch: Parameters<typeof updateUsageAlertRule>[1] = {};
      const kind = body.kind === undefined ? null : normalizeAlertKind(body.kind);
      const scopeType = body.scopeType === undefined ? null : normalizeScopeType(body.scopeType);
      const timeline = body.timeline === undefined ? null : normalizeTimeline(body.timeline);
      if (body.kind !== undefined && !kind) return badRequest("Invalid alert kind.");
      if (body.scopeType !== undefined && !scopeType) return badRequest("Invalid scope type.");
      if (body.timeline !== undefined && !timeline) return badRequest("Invalid timeline.");
      if (kind) patch.kind = kind;
      if (scopeType) patch.scopeType = scopeType;
      if (body.scopeValue !== undefined) patch.scopeValue = String(body.scopeValue || "").trim() || null;
      if (timeline) patch.timeline = timeline;
      if (body.thresholdValue !== undefined || body.tokenLimit !== undefined) {
        const thresholdValue = toPositiveNumber(body.thresholdValue) ?? toPositiveNumber(body.tokenLimit);
        if (!thresholdValue) return badRequest("Threshold must be a positive number.");
        patch.thresholdValue = thresholdValue;
      }
      if (body.deliveryMode !== undefined) patch.deliveryMode = String(body.deliveryMode || "none");
      if (body.deliveryChannel !== undefined) patch.deliveryChannel = String(body.deliveryChannel || "").trim() || null;
      if (body.deliveryTo !== undefined) patch.deliveryTo = String(body.deliveryTo || "").trim() || null;
      if (body.bestEffort !== undefined) patch.bestEffort = Boolean(body.bestEffort);
      if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled);
      await updateUsageAlertRule(ruleId, patch);
      return buildStatusPayload();
    }

    if (action === "toggle" || action === "set-enabled") {
      const ruleId = String(body.ruleId || "").trim();
      if (!ruleId) return badRequest("ruleId is required.");
      await updateUsageAlertRule(ruleId, { enabled: Boolean(body.enabled) });
      return buildStatusPayload();
    }

    if (action === "delete" || action === "delete-rule") {
      const ruleId = String(body.ruleId || "").trim();
      if (!ruleId) return badRequest("ruleId is required.");
      await deleteUsageAlertRule(ruleId);
      return buildStatusPayload();
    }

    return badRequest(`Unknown action: ${action}`);
  } catch (err) {
    return serverError(String(err));
  }
  },
);
