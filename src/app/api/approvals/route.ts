import { NextRequest, NextResponse } from "next/server";
import {
  allowlistAdd,
  allowlistRemove,
  getApprovals,
  setExecMode,
  type ExecMode,
} from "@/lib/exec-approvals";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest, serverError } from "@/lib/api-errors";
import { approvalsPostSchema, type ApprovalsPostInput } from "@/lib/schemas/workspace";

export const dynamic = "force-dynamic";

export const GET = withRoute({ name: "/api/approvals" }, async () => {
  try {
    return NextResponse.json(await getApprovals());
  } catch (error) {
    return serverError(error instanceof Error ? error.message : String(error));
  }
});

export const POST = withRoute<ApprovalsPostInput>(
  { name: "/api/approvals", bodySchema: approvalsPostSchema },
  async (_request: NextRequest, ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const action = String(body.action || "");
  try {
    if (action === "set-mode") {
      const mode = String(body.mode || "") as ExecMode;
      if (mode !== "autonomous" && mode !== "guarded") {
        return badRequest("mode must be 'autonomous' or 'guarded'");
      }
      await setExecMode(mode);
    } else if (action === "allowlist-add") {
      await allowlistAdd(String(body.pattern || ""), String(body.agent || "*"));
    } else if (action === "allowlist-remove") {
      await allowlistRemove(String(body.pattern || ""), String(body.agent || "*"));
    } else {
      return badRequest(`Unknown action: ${action}`);
    }
    return NextResponse.json({ ok: true, ...(await getApprovals()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|must be/i.test(message) ? 400 : 500;
    return apiError(message, status);
  }
  },
);
