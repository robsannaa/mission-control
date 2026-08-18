import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import {
  classifySessionKind,
  sessionKindOf,
  sessionTitleOf,
} from "@/lib/session-kinds";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound, apiError } from "@/lib/api-errors";
import { chatHistoryGetQuerySchema, DEFAULT_CHAT_HISTORY_LIMIT } from "@/lib/schemas/chat";

export const dynamic = "force-dynamic";

/**
 * Read one session's transcript so the chat UI can resume a past conversation.
 *
 * Two guards matter here and are deliberate:
 *
 * 1. KIND ALLOWLIST. A session key is a bearer-ish identifier: anyone who can
 *    call this route can name any session on the gateway. Channel sessions
 *    (telegram, whatsapp, ...) are private conversations that merely share an
 *    agent, so they are never readable through the dashboard's chat history.
 *    See src/lib/session-kinds.ts for the classification.
 * 2. BOUNDED READS. Transcripts here routinely exceed 30k tokens; the gateway
 *    supports `limit`, so we always send one. Unbounded reads made every
 *    session switch pull a full history through this route.
 */

type HistoryMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
};

type HistoryResult = {
  sessionKey?: string;
  sessionId?: string;
  messages?: HistoryMessage[];
  sessionInfo?: { kind?: string; label?: string; displayName?: string };
  thinkingLevel?: unknown;
};

type SessionSummary = {
  key?: string;
  kind?: string;
  label?: string;
  displayName?: string;
};

export const GET = withRoute(
  { name: "/api/chat/history", querySchema: chatHistoryGetQuerySchema },
  async (_request, ctx) => {
  const sessionKey = ctx.query.sessionKey;

  if (!sessionKey) {
    return badRequest("sessionKey is required");
  }

  const limit = ctx.query.limit ?? DEFAULT_CHAT_HISTORY_LIMIT;

  try {
    // Resolve the session's kind from the gateway's own listing rather than
    // trusting the caller's key shape, then enforce the allowlist before
    // reading any content.
    const listing = await gatewayCall<{ sessions?: SessionSummary[] }>(
      "sessions.list",
      { limit: 500 },
      10000,
    );
    const sessions = Array.isArray(listing.sessions) ? listing.sessions : [];
    const match = sessions.find((s) => s.key === sessionKey);

    if (!match) {
      return notFound("session not found");
    }

    const kind = sessionKindOf(match);
    const classification = classifySessionKind(kind);
    if (!classification.isInspectable) {
      // Deliberately not 403-with-detail: do not confirm what kind of private
      // session this is. It simply is not available here.
      // Built manually (not via forbidden()) because `detail` is an extra
      // top-level field the client reads that the shared builder has no slot
      // for — same precedent as 02-04's config 409/max-cap bodies.
      return NextResponse.json(
        {
          ok: false,
          error: "session not available",
          detail:
            "This session belongs to a channel conversation and is not readable from the dashboard.",
        },
        { status: 403 },
      );
    }

    const data = await gatewayCall<HistoryResult>(
      "chat.history",
      { sessionKey, limit },
      15000,
    );

    return NextResponse.json({
      sessionKey,
      sessionId: data.sessionId ?? null,
      kind,
      title: sessionTitleOf(match),
      isChat: classification.isChat,
      messages: Array.isArray(data.messages) ? data.messages : [],
      limit,
      truncated: Array.isArray(data.messages) && data.messages.length >= limit,
    });
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;

    // Gateway errors can carry internal URLs and RPC details — log them, but
    // hand the browser a stable, generic message.
    ctx.log.error({ err }, "chat/history failed");
    return apiError("Could not load this conversation from the gateway.", 502);
  }
  },
);
