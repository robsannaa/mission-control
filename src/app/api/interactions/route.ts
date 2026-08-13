import { NextRequest, NextResponse } from "next/server";
import { answerAndResume, reEnableCronIfSettled, requestClarification } from "@/lib/awareness/engine";
import { resolveInteractionScope } from "@/lib/awareness/scope";
import { getInteraction, listInteractions, transitionInteraction } from "@/lib/awareness/store";
import type { InteractionStatus, WorkflowSourceKind } from "@/lib/awareness/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const scope = resolveInteractionScope(request);
    const params = request.nextUrl.searchParams;
    const id = params.get("id")?.trim();
    if (id) {
      const interaction = await getInteraction(id, scope.tenantId);
      if (!interaction) {
        return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
      }
      return NextResponse.json({ interaction });
    }
    const status = (params.get("status") || "active") as InteractionStatus | "active" | "all";
    const interactions = await listInteractions({
      tenantId: scope.tenantId,
      userId: scope.userId,
      status,
      sourceKind: (params.get("source") || undefined) as WorkflowSourceKind | undefined,
      limit: Number(params.get("limit") || 50),
    });
    return NextResponse.json({ interactions, count: interactions.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const scope = resolveInteractionScope(request);
    const body = await request.json() as Record<string, unknown>;
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
        return NextResponse.json({ error: "id and answer are required" }, { status: 400 });
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
      if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });
      const interaction = await transitionInteraction({
        id,
        tenantId: scope.tenantId,
        status: action === "skip" ? "skipped" : "cancelled",
      });
      // Lift any cron pause now that this question is terminally resolved (H1).
      await reEnableCronIfSettled(interaction);
      return NextResponse.json({ ok: true, interaction });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /not found/i.test(message) ? 404 : /required|characters|transition/i.test(message) ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
