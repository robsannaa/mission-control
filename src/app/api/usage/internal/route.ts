import { NextRequest, NextResponse } from "next/server";
import { getGatewayToken } from "@/lib/paths";
import { fetchGatewaySessions } from "@/lib/gateway-sessions";
import { ingestGatewaySessionsToLedger } from "@/lib/usage-ledger";
import { maybeCollectProvider } from "@/lib/provider-billing/shared";
import { runUsageReconciliation } from "@/lib/reconciliation";
import { evaluateAndStoreUsageAlerts } from "@/lib/usage-alerts";
import { ensureUsageScheduler } from "@/lib/usage-scheduler";
import { withRoute } from "@/lib/api-route";
import { badRequest, unauthorized } from "@/lib/api-errors";
import { usageInternalQuerySchema } from "@/lib/schemas/usage";

export const dynamic = "force-dynamic";

async function handleTask(task: string, request: NextRequest) {
  if (task === "ingest") {
    const sessions = await fetchGatewaySessions(12000);
    const result = await ingestGatewaySessionsToLedger(sessions);
    return NextResponse.json({ ok: true, task, ...result });
  }
  if (task === "collect-provider") {
    const provider = String(request.nextUrl.searchParams.get("provider") || "").trim();
    const supportedProviders = ["openrouter", "openai", "anthropic"] as const;
    type SupportedProvider = (typeof supportedProviders)[number];
    if (!supportedProviders.includes(provider as SupportedProvider)) {
      return badRequest("Unsupported provider");
    }
    const result = await maybeCollectProvider(provider as SupportedProvider);
    return NextResponse.json({ ok: true, task, result });
  }
  if (task === "reconcile") {
    const result = await runUsageReconciliation();
    return NextResponse.json({ ok: true, task, summary: result.summary, rows: result.rows.length });
  }
  if (task === "alerts") {
    const result = await evaluateAndStoreUsageAlerts();
    return NextResponse.json({ ok: true, task, evaluations: result.evaluations.length, firings: result.firings.length });
  }
  if (task === "ensure-scheduler") {
    const result = await ensureUsageScheduler(request.nextUrl.origin);
    return NextResponse.json({ ok: true, task, result });
  }
  return badRequest("Unknown task");
}

function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.MISSION_CONTROL_USAGE_WEBHOOK_TOKEN || getGatewayToken();
  if (!expected) return false;
  const token =
    request.nextUrl.searchParams.get("token") ||
    request.headers.get("x-mission-control-token") ||
    "";
  return token === expected;
}

export const GET = withRoute(
  { name: "/api/usage/internal", querySchema: usageInternalQuerySchema },
  async (request: NextRequest, ctx) => {
    if (!isAuthorized(request)) return unauthorized();
    const task = (ctx.query.task || "").trim();
    return handleTask(task, request);
  },
);

export const POST = withRoute(
  { name: "/api/usage/internal", querySchema: usageInternalQuerySchema },
  async (request: NextRequest, ctx) => {
    if (!isAuthorized(request)) return unauthorized();
    const task = (ctx.query.task || "").trim();
    return handleTask(task, request);
  },
);
