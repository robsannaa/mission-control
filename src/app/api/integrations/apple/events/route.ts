import { NextResponse } from "next/server";
import { readAppleCalendarEvents } from "@/lib/apple-calendar";
import { withRoute } from "@/lib/api-route";
import { requireCapability } from "@/lib/capability-probes";
import { appleEventsQuerySchema, type AppleEventsQuery } from "@/lib/schemas/integrations";

export const dynamic = "force-dynamic";

/** Upcoming Apple Calendar events, read locally from the host's Calendar. */
export const GET = withRoute<unknown, AppleEventsQuery>(
  { name: "/api/integrations/apple/events", querySchema: appleEventsQuerySchema },
  async (_request, ctx) => {
    const refusal = await requireCapability("appleCalendar");
    if (refusal) return refusal;
    const daysParam = Number(ctx.query.days || "30");
    const result = await readAppleCalendarEvents(Number.isFinite(daysParam) ? daysParam : 30);
    return NextResponse.json(result, {
      headers: { "cache-control": "no-store" },
    });
  },
);
