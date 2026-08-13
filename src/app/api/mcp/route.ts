import { NextRequest, NextResponse } from "next/server";
import {
  getServerViews,
  oauthLogin,
  oauthLogout,
  removeServer,
  saveServer,
  setEnabled,
  setToolFilter,
  type SaveServerInput,
} from "@/lib/mcp";

export const dynamic = "force-dynamic";

/** GET — every configured MCP server, merged with live status + doctor, secrets redacted. */
export async function GET() {
  try {
    const result = await getServerViews();
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/**
 * POST — mutate MCP config. Secrets (headers, env, TLS keys) arrive here in the
 * request body and go straight to the CLI; they are never echoed back.
 */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");

  try {
    switch (action) {
      case "create":
      case "update": {
        const input = body.server as SaveServerInput | undefined;
        if (!input || !input.name) {
          return NextResponse.json({ error: "server payload with a name is required" }, { status: 400 });
        }
        await saveServer(input, action === "update");
        break;
      }
      case "enable":
      case "disable": {
        await setEnabled(String(body.name || ""), action === "enable");
        break;
      }
      case "tools": {
        await setToolFilter(
          String(body.name || ""),
          asStringArray(body.include),
          asStringArray(body.exclude),
        );
        break;
      }
      case "remove": {
        await removeServer(String(body.name || ""));
        break;
      }
      case "login": {
        const result = await oauthLogin(String(body.name || ""), body.code ? String(body.code) : undefined);
        // Return only the auth URL, never any tokens the CLI may have printed.
        return NextResponse.json({ ok: true, authUrl: result.authUrl });
      }
      case "logout": {
        await oauthLogout(String(body.name || ""));
        break;
      }
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    // Return the fresh, redacted state so the client re-renders from truth.
    // `ok:true` here means "the action succeeded" — distinct from doctor health.
    const { servers, path } = await getServerViews();
    return NextResponse.json({ ok: true, servers, path });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /invalid|required|needs a|no spaces/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
}
