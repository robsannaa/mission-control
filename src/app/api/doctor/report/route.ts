/**
 * `GET /api/doctor/report` — one shareable report, secrets removed.
 *
 * Query parameters:
 * - `format=markdown` (default) → `text/markdown`, ready to paste into a
 *   support thread or save as a file.
 * - `format=json` → `{ snapshot, markdown }` for a client that wants to render
 *   it itself.
 * - `transcript=1` → append the full (already redacted) command output. Off by
 *   default because it is large and rarely what a helper needs first.
 * - `refresh=1` → re-check before generating, instead of reporting the cached
 *   snapshot. The read-only pass is used either way.
 *
 * The report never invents a clean bill of health: if nothing has run it says
 * so, and if a source failed the provenance table shows the failure rather than
 * quietly omitting the row.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSnapshot, peekTranscript } from "@/lib/doctor-snapshot";
import { renderReportMarkdown } from "@/lib/doctor-share-report";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const format = params.get("format") === "json" ? "json" : "markdown";
  const includeTranscript = params.get("transcript") === "1";
  const force = params.get("refresh") === "1";

  const snapshot = await getSnapshot({ force });
  const markdown = renderReportMarkdown(snapshot, {
    includeTranscript,
    transcript: includeTranscript ? peekTranscript() : undefined,
  });

  if (format === "json") return NextResponse.json({ snapshot, markdown });

  const stamp = new Date(snapshot.ts).toISOString().replace(/[:.]/g, "-");
  return new NextResponse(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `inline; filename="openclaw-health-${stamp}.md"`,
      "Cache-Control": "no-store",
    },
  });
}
