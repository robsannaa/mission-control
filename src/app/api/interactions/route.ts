import { NextRequest, NextResponse } from "next/server";
import { answerAndResume, reEnableCronIfSettled, requestClarification } from "@/lib/awareness/engine";
import { resolveInteractionScope } from "@/lib/awareness/scope";
import { getInteraction, listInteractions, transitionInteraction } from "@/lib/awareness/store";
import type { InteractionStatus, WorkflowSourceKind } from "@/lib/awareness/types";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest, notFound, serverError } from "@/lib/api-errors";
import {
  interactionsGetQuerySchema,
  interactionsPostSchema,
  type InteractionsGetQuery,
  type InteractionsPostInput,
} from "@/lib/schemas/workspace";

export const dynamic = "force-dynamic";

export const GET = withRoute<unknown, InteractionsGetQuery>(
  { name: "/api/interactions", querySchema: interactionsGetQuerySchema },
  async (request: NextRequest, ctx) => {
  try {
    const scope = resolveInteractionScope(request);
    const id = ctx.query.id?.trim();
    if (id) {
      const interaction = await getInteraction(id, scope.tenantId);
      if (!interaction) {
        return notFound("Interaction not found");
      }
      return NextResponse.json({ interaction });
    }
    const status = (ctx.query.status || "active") as InteractionStatus | "active" | "all";
    const interactions = await listInteractions({
      tenantId: scope.tenantId,
      userId: scope.userId,
      status,
      sourceKind: (ctx.query.source || undefined) as WorkflowSourceKind | undefined,
      limit: Number(ctx.query.limit || 50),
    });
    return NextResponse.json({ interactions, count: interactions.length });
  } catch (error) {
    return serverError(error instanceof Error ? error.message : String(error));
  }
  },
);

export const POST = withRoute<InteractionsPostInput>(
  { name: "/api/interactions", bodySchema: interactionsPostSchema },
  async (request: NextRequest, ctx) => {
  try {
    const scope = resolveInteractionScope(request);
    const body = ctx.body as Record<string, unknown>;
    const action = String(body.action || "");
    if (action === "create") {
      const interaction = await requestClarification({
        ...(body.interaction as Record<string, unknown>),
        tenantId: scope.tenantId,
        userId: scope.userId,
      } as never);
      return NextResponse.json({ ok: true, interaction }, { status: 201 });
    }
    if (action === "answer") {
      const id = String(body.id || "");
      const answer = String(body.answer || "");
      if (!id || !answer.trim()) {
        return badRequest("id and answer are required");
      }
      const result = await answerAndResume({
        id,
        answer,
        tenantId: scope.tenantId,
        userId: scope.userId,
        channel: String(body.channel || "mission-control"),
        externalId: body.externalId ? String(body.externalId) : null,
      });
      return NextResponse.json({ ok: true, ...result }, { status: result.accepted ? 200 : 409 });
    }
    if (action === "skip" || action === "cancel") {
      const id = String(body.id || "");
      if (!id) return badRequest("id is required");
      const interaction = await transitionInteraction({
        id,
        tenantId: scope.tenantId,
        status: action === "skip" ? "skipped" : "cancelled",
      });
      // Lift any cron pause now that this question is terminally resolved (H1).
      await reEnableCronIfSettled(interaction);
      return NextResponse.json({ ok: true, interaction });
    }
    return badRequest("Unknown action");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /required|characters|transition/i.test(message) ? 400 : 500;
    return apiError(message, status);
  }
  },
);
