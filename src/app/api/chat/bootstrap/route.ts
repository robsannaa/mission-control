import { NextResponse } from "next/server";
import { buildChatBootstrap } from "@/lib/chat-bootstrap";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

/**
 * Not migrated onto `src/lib/api-errors.ts` builders: the degraded response
 * below (`{ agents: [], models: [], ..., warnings, degraded: true }`) is a
 * client contract of its own — the chat page reads `warnings`/`degraded` on
 * a 500, not a canonical `{ ok: false, error }` body. Forcing it through a
 * builder would change what the client reads. Success/degraded-response
 * shapes are out of scope this phase (docs/API-CONTRACT.md §5) — same
 * precedent as `/api/status`'s stale-cache fallback (02-PATTERNS.md).
 * Still wrapped with `withRoute` (no schemas) for structured request
 * logging, matching every other route in this batch.
 */
export const GET = withRoute({ name: "/api/chat/bootstrap" }, async () => {
  try {
    const payload = await buildChatBootstrap();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      {
        agents: [],
        models: [],
        connectedProviders: [],
        warnings: [String(error)],
        degraded: true,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
});
