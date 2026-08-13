import { NextRequest, NextResponse } from "next/server";
import { readAppleCalendarEvents } from "@/lib/apple-calendar";

export const dynamic = "force-dynamic";

/** Upcoming Apple Calendar events, read locally from the host's Calendar. */
export async function GET(request: NextRequest) {
  const daysParam = Number(request.nextUrl.searchParams.get("days") || "30");
  const result = await readAppleCalendarEvents(Number.isFinite(daysParam) ? daysParam : 30);
  return NextResponse.json(result, {
    headers: { "cache-control": "no-store" },
  });
}
