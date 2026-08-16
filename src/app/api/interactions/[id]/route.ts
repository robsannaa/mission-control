import { NextRequest, NextResponse } from "next/server";
import { resolveInteractionScope } from "@/lib/awareness/scope";
import { getInteraction } from "@/lib/awareness/store";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params;
    const normalized = id.trim();
    if (!normalized) {
      return NextResponse.json({ error: "Interaction id is required" }, { status: 400 });
    }
    const scope = resolveInteractionScope(request);
    const interaction = await getInteraction(normalized, scope.tenantId);
    if (!interaction) {
      return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
    }
    return NextResponse.json({ interaction });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
