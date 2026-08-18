import { NextResponse } from "next/server";
import { buildGoogleIntegrationsSnapshot } from "@/lib/google-integrations-api";
import { withRoute } from "@/lib/api-route";
import { agentIdQuerySchema, type AgentIdQuery } from "@/lib/schemas/integrations";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const GET = withRoute<unknown, AgentIdQuery>(
  { name: "/api/integrations/google/accounts", querySchema: agentIdQuerySchema },
  async (_request, ctx) => {
    const snapshot = await buildGoogleIntegrationsSnapshot(ctx.query.agentId || null);
    return NextResponse.json(
      {
        generatedAt: snapshot.generatedAt,
        selectedAgentId: snapshot.selectedAgentId,
        accounts: snapshot.store.accounts,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
);
