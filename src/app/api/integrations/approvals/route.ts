import { NextResponse } from "next/server";
import { getGoogleApprovals } from "@/lib/google-integrations-api";
import { withRoute } from "@/lib/api-route";
import { agentIdQuerySchema, type AgentIdQuery } from "@/lib/schemas/integrations";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const GET = withRoute<unknown, AgentIdQuery>(
  { name: "/api/integrations/approvals", querySchema: agentIdQuerySchema },
  async (_request, ctx) => {
    return NextResponse.json(await getGoogleApprovals(ctx.query.agentId || null), {
      headers: { "Cache-Control": "no-store" },
    });
  },
);
