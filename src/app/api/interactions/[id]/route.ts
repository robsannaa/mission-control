import { NextRequest, NextResponse } from "next/server";
import { resolveInteractionScope } from "@/lib/awareness/scope";
import { getInteraction } from "@/lib/awareness/store";
import { withRoute } from "@/lib/api-route";
import { notFound, serverError } from "@/lib/api-errors";
import { interactionRouteParamsSchema, type InteractionRouteParams } from "@/lib/schemas/workspace";

export const dynamic = "force-dynamic";

/**
 * T-02-59 (Elevation of Privilege): the `[id]` segment is validated against
 * `interactionRouteParamsSchema` (the `crypto.randomUUID()`-shaped format
 * `src/lib/awareness/store.ts` always mints) before this handler runs, so an
 * unvalidated segment can no longer select a record lookup.
 */
export const GET = withRoute<unknown, unknown, InteractionRouteParams>(
  { name: "/api/interactions/[id]", routeSchema: interactionRouteParamsSchema },
  async (request: NextRequest, ctx) => {
  try {
    const scope = resolveInteractionScope(request);
    const interaction = await getInteraction(ctx.params.id, scope.tenantId);
    if (!interaction) {
      return notFound("Interaction not found");
    }
    return NextResponse.json({ interaction });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : String(error));
  }
  },
);
