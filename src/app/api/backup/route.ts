import { NextRequest, NextResponse } from "next/server";
import { createBackup, planBackup, verifyBackup } from "@/lib/backup";

export const dynamic = "force-dynamic";

/** GET — the backup plan (dry run: what would be included, where it lands). */
export async function GET() {
  try {
    const plan = await planBackup();
    return NextResponse.json(plan);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST — create a real backup, or verify an existing archive. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  try {
    if (action === "create") {
      const result = await createBackup();
      return NextResponse.json({ ok: true, ...result });
    }
    if (action === "verify") {
      const path = String(body.path || "");
      if (!path.trim()) return NextResponse.json({ error: "path is required" }, { status: 400 });
      // result already carries { ok, raw } where ok is the verification outcome.
      return NextResponse.json(await verifyBackup(path));
    }
    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
