import { NextResponse } from "next/server";
import { buildModelsSummary } from "@/lib/models-summary";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

export const GET = withRoute({ name: "/api/models/summary" }, async () => {
  const summary = await buildModelsSummary();
  return NextResponse.json(summary, {
    headers: { "Cache-Control": "no-store" },
  });
});
