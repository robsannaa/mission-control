import { NextRequest, NextResponse } from "next/server";
import {
  allowlistAdd,
  allowlistRemove,
  getApprovals,
  setExecMode,
  type ExecMode,
} from "@/lib/exec-approvals";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getApprovals());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  try {
    if (action === "set-mode") {
      const mode = String(body.mode || "") as ExecMode;
      if (mode !== "autonomous" && mode !== "guarded") {
        return NextResponse.json({ error: "mode must be 'autonomous' or 'guarded'" }, { status: 400 });
      }
      await setExecMode(mode);
    } else if (action === "allowlist-add") {
      await allowlistAdd(String(body.pattern || ""), String(body.agent || "*"));
    } else if (action === "allowlist-remove") {
      await allowlistRemove(String(body.pattern || ""), String(body.agent || "*"));
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(await getApprovals()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|must be/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
