import { NextResponse } from "next/server";
import { getGoogleAccountHistory } from "@/lib/google-integrations-api";
import { withRoute } from "@/lib/api-route";
import { apiError } from "@/lib/api-errors";
import {
  agentIdQuerySchema,
  googleAccountRouteParamsSchema,
  type AgentIdQuery,
  type GoogleAccountRouteParams,
} from "@/lib/schemas/integrations";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const GET = withRoute<unknown, AgentIdQuery, GoogleAccountRouteParams>(
  {
    name: "/api/integrations/google/accounts/[id]/history",
    querySchema: agentIdQuerySchema,
    routeSchema: googleAccountRouteParamsSchema,
  },
  async (_request, ctx) => {
    try {
      return NextResponse.json(await getGoogleAccountHistory(ctx.params.id, ctx.query.agentId || null), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return apiError(message, message.includes("not found") ? 404 : 500);
    }
  },
);
