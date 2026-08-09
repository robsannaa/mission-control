import { NextRequest, NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import {
  classifySessionKind,
  sessionKindOf,
  sessionTitleOf,
} from "@/lib/session-kinds";

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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

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

/** Session keys are `agent:<id>:<kind>:<uuid>` — reject anything exotic early. */
const SESSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,256}$/;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionKey = searchParams.get("sessionKey")?.trim();

  if (!sessionKey) {
    return NextResponse.json({ error: "sessionKey is required" }, { status: 400 });
  }
  if (!SESSION_KEY_RE.test(sessionKey)) {
    return NextResponse.json({ error: "invalid sessionKey" }, { status: 400 });
  }

  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

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
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    const kind = sessionKindOf(match);
    const classification = classifySessionKind(kind);
    if (!classification.isInspectable) {
      // Deliberately not 403-with-detail: do not confirm what kind of private
      // session this is. It simply is not available here.
      return NextResponse.json(
        {
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
    console.error("chat/history failed:", err);
    return NextResponse.json(
      { error: "Could not load this conversation from the gateway." },
      { status: 502 },
    );
  }
}
