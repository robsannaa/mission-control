import { NextResponse } from "next/server";
import {
  isCalendarProvider,
  isExternalCalendarProvider,
  removeCalendarAccount,
  upsertCalendarAccount,
  updateCalendarProviderSettings,
  type CalendarAccountConnection,
} from "@/lib/calendar-store";
import { buildCalendarSnapshot, syncCalendarAccount } from "@/lib/calendar-sync";
import { withRoute } from "@/lib/api-route";
import { calendarGetQuerySchema, calendarPostSchema } from "@/lib/schemas/knowledge";
import { badRequest, notFound, serverError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function isHostedCalendarDisabled(): boolean {
  return (
    process.env.AGENTBAY_HOSTED === "true" ||
    process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true"
  );
}

export const GET = withRoute(
  { name: "/api/calendar", querySchema: calendarGetQuerySchema },
  async (_request, ctx) => {
  if (isHostedCalendarDisabled()) {
    return notFound("Calendar is unavailable in hosted mode");
  }
  try {
    const days = ctx.query.days ?? 14;
    return NextResponse.json(await buildCalendarSnapshot(days), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    ctx.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Calendar GET error",
    );
    return serverError(error instanceof Error ? error.message : String(error));
  }
  },
);

export const POST = withRoute(
  { name: "/api/calendar", bodySchema: calendarPostSchema },
  async (_request, ctx) => {
  if (isHostedCalendarDisabled()) {
    return notFound("Calendar is unavailable in hosted mode");
  }
  const body = ctx.body;
  try {
    const action = String(body?.action || "");
    const days = body.days ?? 14;

    switch (action) {
      case "save-provider-settings": {
        const provider = String(body?.provider || "");
        if (!isCalendarProvider(provider)) {
          return badRequest(`Unknown provider: ${provider}`);
        }
        await updateCalendarProviderSettings(provider, {
          enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
          importEvents:
            typeof body?.importEvents === "boolean" ? body.importEvents : undefined,
          importReminders:
            typeof body?.importReminders === "boolean" ? body.importReminders : undefined,
          writeBack: typeof body?.writeBack === "boolean" ? body.writeBack : undefined,
          readOnlyByDefault:
            typeof body?.readOnlyByDefault === "boolean"
              ? body.readOnlyByDefault
              : undefined,
        });
        return NextResponse.json(await buildCalendarSnapshot(days));
      }

      case "add-account": {
        const provider = String(body?.provider || "");
        if (!isExternalCalendarProvider(provider)) {
          return badRequest("provider must be google, apple, or zoho");
        }
        await upsertCalendarAccount({
          id: typeof body?.id === "string" ? body.id : undefined,
          provider,
          label: String(body?.label || ""),
          providerAccountId: String(body?.providerAccountId || ""),
          connection: body?.connection as CalendarAccountConnection | undefined,
          enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
          readOnly: typeof body?.readOnly === "boolean" ? body.readOnly : undefined,
          importEvents:
            typeof body?.importEvents === "boolean" ? body.importEvents : undefined,
          importReminders:
            typeof body?.importReminders === "boolean"
              ? body.importReminders
              : undefined,
          writeBack: typeof body?.writeBack === "boolean" ? body.writeBack : undefined,
        });
        return NextResponse.json(await buildCalendarSnapshot(days));
      }

      case "remove-account": {
        const accountId = String(body?.accountId || "");
        if (!accountId) {
          return badRequest("accountId is required");
        }
        await removeCalendarAccount(accountId);
        return NextResponse.json(await buildCalendarSnapshot(days));
      }

      case "sync-account": {
        const accountId = String(body?.accountId || "");
        if (!accountId) {
          return badRequest("accountId is required");
        }
        const result = await syncCalendarAccount(accountId, days);
        return NextResponse.json({
          ok: true,
          result,
          snapshot: await buildCalendarSnapshot(days),
        });
      }

      default:
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (error) {
    ctx.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Calendar POST error",
    );
    return serverError(error instanceof Error ? error.message : String(error));
  }
  },
);
