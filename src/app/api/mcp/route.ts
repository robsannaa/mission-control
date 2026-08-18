import { NextResponse } from "next/server";
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
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest, serverError } from "@/lib/api-errors";
import { mcpPostSchema } from "@/lib/schemas/automation";

export const dynamic = "force-dynamic";

/** GET — every configured MCP server, merged with live status + doctor, secrets redacted. */
export const GET = withRoute({ name: "/api/mcp" }, async (request, ctx) => {
  try {
    const result = await getServerViews();
    return NextResponse.json(result);
  } catch (error) {
    ctx.log.error({ err: error instanceof Error ? error.message : String(error) }, "MCP GET error");
    return serverError(error instanceof Error ? error.message : String(error));
  }
});

/**
 * POST — mutate MCP config. Secrets (headers, env, TLS keys) arrive here in the
 * request body and go straight to the CLI; they are never echoed back.
 */
export const POST = withRoute(
  { name: "/api/mcp", bodySchema: mcpPostSchema },
  async (request, ctx) => {
    const body = ctx.body as Record<string, unknown> & { action: string };
    const action = body.action;

    try {
      switch (action) {
        case "create":
        case "update": {
          const input = body.server as SaveServerInput | undefined;
          if (!input || !input.name) {
            return badRequest("server payload with a name is required");
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
          // Unreachable in practice — mcpPostSchema's discriminated union
          // already rejects any action outside the literal set above.
          return badRequest(`Unknown action: ${action}`);
      }
      // Return the fresh, redacted state so the client re-renders from truth.
      // `ok:true` here means "the action succeeded" — distinct from doctor health.
      const { servers, path } = await getServerViews();
      return NextResponse.json({ ok: true, servers, path });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.log.error({ err: message }, "MCP POST error");
      const status = /invalid|required|needs a|no spaces/i.test(message) ? 400 : 500;
      return apiError(message, status);
    }
  },
);

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === "string" && x.trim()).map((x) => (x as string).trim());
}
