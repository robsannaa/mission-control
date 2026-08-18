import { NextResponse } from "next/server";
import { createBackup, planBackup, verifyBackup } from "@/lib/backup";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { backupPostSchema, type BackupPostInput } from "@/lib/schemas/updates";

export const dynamic = "force-dynamic";

/** GET — the backup plan (dry run: what would be included, where it lands). */
export const GET = withRoute({ name: "/api/backup" }, async () => {
  try {
    const plan = await planBackup();
    return NextResponse.json(plan);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : String(error));
  }
});

/**
 * POST — create a real backup, or verify an existing archive.
 *
 * T-02-56 (Tampering): a restore-adjacent `path` (the archive identifier for
 * `backup verify`) is format- and length-bounded in `backupArchivePathSchema`
 * before it is ever passed to `openclaw backup verify` — a malformed value
 * is rejected before that command runs. A genuinely *missing* path keeps its
 * own manual, no-`details` "path is required" check below (D-06).
 */
export const POST = withRoute<BackupPostInput>(
  { name: "/api/backup", bodySchema: backupPostSchema },
  async (_request, ctx) => {
  const body = ctx.body;
  const action = String(body.action || "");
  try {
    if (action === "create") {
      const result = await createBackup();
      return NextResponse.json({ ok: true, ...result });
    }
    if (action === "verify") {
      const path = (body.path || "").trim();
      if (!path) return badRequest("path is required");
      // result already carries { ok, raw } where ok is the verification outcome.
      return NextResponse.json(await verifyBackup(path));
    }
    return badRequest(`Unknown action: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
  },
);
