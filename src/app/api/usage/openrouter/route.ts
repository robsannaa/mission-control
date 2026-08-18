import { NextResponse } from "next/server";
import { fetchOpenRouterBilling } from "@/lib/openrouter-usage";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

export const GET = withRoute({ name: "/api/usage/openrouter" }, async () => {
  try {
    const result = await fetchOpenRouterBilling();
    return NextResponse.json(result);
  } catch (err) {
    // Manually constructed (not through an api-errors.ts builder): this
    // route's success and error shapes both key off `available`, matching
    // `OpenRouterBillingData`/`OpenRouterBillingUnavailable` in
    // src/lib/openrouter-usage.ts — the canonical `ok: false` envelope is
    // not layered on top, same "extra/different-shape body" precedent as
    // /api/usage's degraded-200 diagnostics payload.
    return NextResponse.json(
      { available: false, reason: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
