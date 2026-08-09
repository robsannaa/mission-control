import { NextRequest, NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import {
  assertChatSession,
  listChatSessions,
} from "@/app/api/chat/_lib/chat-sessions";

export const dynamic = "force-dynamic";

/**
 * The chat surface's own session index.
 *
 * `/api/sessions` returns every session on the gateway — cron runs, subagent
 * scratch sessions and private channel transcripts included — with a heavy
 * per-row payload and empty labels. This route answers the narrower question
 * the chat page actually asks: "which conversations did the user have here,
 * and what should each one be called?" It applies the same classification from
 * src/lib/session-kinds.ts and derives a readable title server-side, cached,
 * so the browser never has to fan out one history request per row.
 */

function errorResponse(err: unknown, fallback: string) {
  const pairing = pairingRequiredResponse(err);
  if (pairing) return pairing;
  // Gateway errors carry internal URLs and RPC frames — log them, return a
  // stable message the UI can show verbatim.
  console.error("chat/sessions failed:", err);
  return NextResponse.json({ error: fallback }, { status: 502 });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const agentId = searchParams.get("agentId")?.trim() || undefined;
  const rawLimit = Number(searchParams.get("limit"));
  const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : undefined;
  const includeArchived = searchParams.get("archived") === "1";

  try {
    const result = await listChatSessions({ agentId, limit, includeArchived });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err, "Could not reach the OpenClaw gateway.");
  }
}

type PatchBody = {
  key?: unknown;
  label?: unknown;
  pinned?: unknown;
  unread?: unknown;
  archived?: unknown;
};

/**
 * Rename / pin / mark-read a conversation.
 *
 * `sessions.patch { key, label }` is verified live: the label comes straight
 * back out of `sessions.list` as both `label` and `displayName`, which is
 * exactly what `sessionTitleOf` prefers. That makes rename the honest fix for
 * unnamed sessions — derived titles are only a fallback.
 */
export async function PATCH(request: NextRequest) {
  let body: PatchBody;
  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const key = typeof body.key === "string" ? body.key.trim() : "";
  const patch: Record<string, unknown> = { key };

  if (typeof body.label === "string") {
    const label = body.label.trim().slice(0, 120);
    if (!label) {
      return NextResponse.json(
        { error: "a conversation name cannot be empty" },
        { status: 400 },
      );
    }
    patch.label = label;
  }
  if (typeof body.pinned === "boolean") patch.pinned = body.pinned;
  if (typeof body.unread === "boolean") patch.unread = body.unread;
  if (typeof body.archived === "boolean") patch.archived = body.archived;

  if (Object.keys(patch).length < 2) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  try {
    const failure = await assertChatSession(key);
    if (failure) {
      return NextResponse.json(
        { error: failure.message },
        { status: failure.status },
      );
    }
    await gatewayCall("sessions.patch", patch, 12_000);
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    return errorResponse(err, "Could not update this conversation.");
  }
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get("key")?.trim() || "";

  try {
    const failure = await assertChatSession(key);
    if (failure) {
      return NextResponse.json(
        { error: failure.message },
        { status: failure.status },
      );
    }
    await gatewayCall("sessions.delete", { key }, 15_000);
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    return errorResponse(err, "Could not delete this conversation.");
  }
}
