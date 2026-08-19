import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api-route";
import { getCapabilitySnapshot, invalidateProbeCache } from "@/lib/capability-probes";
import { capabilitiesGetQuerySchema, type CapabilitiesGetQuery } from "@/lib/schemas/system";

export const dynamic = "force-dynamic";

/**
 * Serves the capability snapshot: the six boolean capability keys plus the
 * `hosted` deployment fact — never platform, probe paths, or error text
 * (T-03-06). `?refresh=1` invalidates the binary-probe cache before reading
 * so an install/removal on this instance is reflected without a rebuild or
 * redeploy (CAP-04).
 */
export const GET = withRoute<unknown, CapabilitiesGetQuery>(
  { name: "/api/capabilities", querySchema: capabilitiesGetQuerySchema },
  async (_request, ctx) => {
    if (ctx.query.refresh) {
      invalidateProbeCache();
    }
    const snapshot = await getCapabilitySnapshot();
    return NextResponse.json(snapshot, { headers: { "cache-control": "no-store" } });
  },
);
