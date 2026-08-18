import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import {
  assertChatSession,
  listChatSessions,
} from "@/app/api/chat/_lib/chat-sessions";
import { withRoute } from "@/lib/api-route";
import { badRequest, apiError } from "@/lib/api-errors";
import type pino from "pino";
import {
  chatSessionsGetQuerySchema,
  chatSessionsPatchSchema,
  chatSessionsDeleteQuerySchema,
} from "@/lib/schemas/chat";

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

function errorResponse(err: unknown, fallback: string, log: pino.Logger) {
  const pairing = pairingRequiredResponse(err);
  if (pairing) return pairing;
  // Gateway errors carry internal URLs and RPC frames — log them, return a
  // stable message the UI can show verbatim.
  log.error({ err }, "chat/sessions failed");
  return apiError(fallback, 502);
}

export const GET = withRoute(
  { name: "/api/chat/sessions", querySchema: chatSessionsGetQuerySchema },
  async (_request, ctx) => {
  const agentId = ctx.query.agentId?.trim() || undefined;
  const limit = ctx.query.limit;
  const includeArchived = ctx.query.archived === "1";

  try {
    const result = await listChatSessions({ agentId, limit, includeArchived });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    return errorResponse(err, "Could not reach the OpenClaw gateway.", ctx.log);
  }
  },
);

/**
 * Rename / pin / mark-read a conversation.
 *
 * `sessions.patch { key, label }` is verified live: the label comes straight
 * back out of `sessions.list` as both `label` and `displayName`, which is
 * exactly what `sessionTitleOf` prefers. That makes rename the honest fix for
 * unnamed sessions — derived titles are only a fallback.
 */
export const PATCH = withRoute(
  { name: "/api/chat/sessions", bodySchema: chatSessionsPatchSchema },
  async (_request, ctx) => {
  const key = ctx.body.key ?? "";
  const patch: Record<string, unknown> = { key };

  if (typeof ctx.body.label === "string") {
    const label = ctx.body.label.trim().slice(0, 120);
    if (!label) {
      return badRequest("a conversation name cannot be empty");
    }
    patch.label = label;
  }
  if (typeof ctx.body.pinned === "boolean") patch.pinned = ctx.body.pinned;
  if (typeof ctx.body.unread === "boolean") patch.unread = ctx.body.unread;
  if (typeof ctx.body.archived === "boolean") patch.archived = ctx.body.archived;

  if (Object.keys(patch).length < 2) {
    return badRequest("nothing to update");
  }

  try {
    const failure = await assertChatSession(key);
    if (failure) {
      return apiError(failure.message, failure.status);
    }
    await gatewayCall("sessions.patch", patch, 12_000);
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    return errorResponse(err, "Could not update this conversation.", ctx.log);
  }
  },
);

export const DELETE = withRoute(
  { name: "/api/chat/sessions", querySchema: chatSessionsDeleteQuerySchema },
  async (_request, ctx) => {
  const key = ctx.query.key ?? "";

  try {
    const failure = await assertChatSession(key);
    if (failure) {
      return apiError(failure.message, failure.status);
    }
    await gatewayCall("sessions.delete", { key }, 15_000);
    return NextResponse.json({ ok: true, key });
  } catch (err) {
    return errorResponse(err, "Could not delete this conversation.", ctx.log);
  }
  },
);
