import { NextRequest, NextResponse } from "next/server";
import {
  isCalendarProvider,
  isExternalCalendarProvider,
  removeCalendarAccount,
  upsertCalendarAccount,
  updateCalendarProviderSettings,
} from "@/lib/calendar-store";
import { buildCalendarSnapshot, syncCalendarAccount } from "@/lib/calendar-sync";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function isHostedCalendarDisabled(): boolean {
  return (
    process.env.AGENTBAY_HOSTED === "true" ||
    process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true"
  );
}

function parseDays(value: string | null): number {
  const parsed = Number(value || "14");
  if (!Number.isFinite(parsed)) return 14;
  return Math.max(1, Math.min(Math.round(parsed), 60));
}

export async function GET(request: NextRequest) {
  if (isHostedCalendarDisabled()) {
    return NextResponse.json({ error: "Calendar is unavailable in hosted mode" }, { status: 404 });
  }
  try {
    const days = parseDays(request.nextUrl.searchParams.get("days"));
    return NextResponse.json(await buildCalendarSnapshot(days), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    // Bug fix 2026-08-16: malformed JSON body throws SyntaxError from `request.json()`.
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${error.message}` },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  if (isHostedCalendarDisabled()) {
    return NextResponse.json({ error: "Calendar is unavailable in hosted mode" }, { status: 404 });
  }
  try {
    const body = await request.json();
    const action = String(body?.action || "");
    const days = parseDays(typeof body?.days === "number" ? String(body.days) : null);

    switch (action) {
      case "save-provider-settings": {
        const provider = String(body?.provider || "");
        if (!isCalendarProvider(provider)) {
          return NextResponse.json({ error: `Unknown provider: ${provider}` }, { status: 400 });
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
          return NextResponse.json(
            { error: "provider must be google, apple, or zoho" },
            { status: 400 }
          );
        }
        await upsertCalendarAccount({
          id: typeof body?.id === "string" ? body.id : undefined,
          provider,
          label: String(body?.label || ""),
          providerAccountId: String(body?.providerAccountId || ""),
          connection: body?.connection,
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
          return NextResponse.json({ error: "accountId is required" }, { status: 400 });
        }
        await removeCalendarAccount(accountId);
        return NextResponse.json(await buildCalendarSnapshot(days));
      }

      case "sync-account": {
        const accountId = String(body?.accountId || "");
        if (!accountId) {
          return NextResponse.json({ error: "accountId is required" }, { status: 400 });
        }
        const result = await syncCalendarAccount(accountId, days);
        return NextResponse.json({
          ok: true,
          result,
          snapshot: await buildCalendarSnapshot(days),
        });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    // Bug fix 2026-08-16: malformed JSON body throws SyntaxError from `request.json()`.
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${error.message}` },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
