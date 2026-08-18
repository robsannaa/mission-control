import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import {
  isNewChatSessionKey,
  textFromContent,
} from "@/app/api/chat/_lib/chat-sessions";
import { withRoute } from "@/lib/api-route";
import { badRequest, apiError } from "@/lib/api-errors";
import { chatCommandPostSchema } from "@/lib/schemas/chat";

export const dynamic = "force-dynamic";

/**
 * Run an OpenClaw slash command in a chat session.
 *
 * WHY THIS ROUTE EXISTS — verified against the live gateway, not guessed:
 *
 *   POST /v1/responses with input "/whoami" answers with *the model's* prose
 *   ("Clawbert — your AI companion…"). The OpenResponses endpoint does not run
 *   the command handler at all. So typing a slash command into a composer that
 *   posts to /api/chat produces a hallucinated answer that looks real.
 *
 *   The command handler lives behind the `chat.send` RPC:
 *     chat.send { sessionKey, message, idempotencyKey } -> { runId, status }
 *   and the reply lands in the transcript as an assistant turn with
 *   `provider: "openclaw"`, `model: "gateway-injected"` and
 *   `idempotencyKey === runId` (the matching user turn gets `<runId>:user`).
 *   /whoami through this path returns the real "🧭 Identity / Channel: webchat"
 *   block, instantly, with no model call.
 *
 * `chat.send` is non-blocking, so this route sends and then polls the
 * transcript for turns newer than the pre-send sequence number.
 */

const POLL_INTERVAL_MS = 350;
const POLL_TIMEOUT_MS = 40_000;
const TAIL_LIMIT = 12;

type HistoryMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number;
  model?: string;
  idempotencyKey?: string;
  __openclaw?: { seq?: number; id?: string };
};

type HistoryResult = { messages?: HistoryMessage[] };

function seqOf(message: HistoryMessage): number {
  const seq = message.__openclaw?.seq;
  return typeof seq === "number" ? seq : 0;
}

async function tail(sessionKey: string, limit: number): Promise<HistoryMessage[]> {
  try {
    const data = await gatewayCall<HistoryResult>(
      "chat.history",
      { sessionKey, limit },
      10_000,
    );
    return Array.isArray(data.messages) ? data.messages : [];
  } catch {
    // A session that does not exist yet has no history — that is not an error,
    // the command itself will create it.
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const POST = withRoute(
  { name: "/api/chat/command", bodySchema: chatCommandPostSchema },
  async (request, ctx) => {
  const sessionKey =
    typeof ctx.body.sessionKey === "string" ? ctx.body.sessionKey.trim() : "";
  const command = typeof ctx.body.command === "string" ? ctx.body.command.trim() : "";

  if (!command.startsWith("/")) {
    return badRequest("command must start with /");
  }
  // Shape check only: a command may target a session that does not exist yet
  // (the first thing typed in a brand new chat). Restricting the origin segment
  // to the chat allowlist means this can never address a channel, cron or
  // subagent session — the namespaces the gateway itself also reserves.
  if (!isNewChatSessionKey(sessionKey)) {
    return badRequest("invalid or non-chat session key");
  }

  const runId = `mc-${crypto.randomUUID()}`;

  try {
    const before = await tail(sessionKey, 1);
    const baselineSeq = before.length ? seqOf(before[before.length - 1]) : 0;

    await gatewayCall(
      "chat.send",
      { sessionKey, message: command, idempotencyKey: runId },
      20_000,
    );

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      if (request.signal?.aborted) {
        return NextResponse.json({ ok: true, pending: true, runId });
      }

      const messages = await tail(sessionKey, TAIL_LIMIT);
      const fresh = messages.filter(
        (message) =>
          message.role === "assistant" &&
          (seqOf(message) > baselineSeq ||
            message.idempotencyKey === runId),
      );
      if (fresh.length === 0) continue;

      const text = fresh
        .map((message) => textFromContent(message.content).trim())
        .filter(Boolean)
        .join("\n\n");
      if (!text) continue;

      return NextResponse.json({
        ok: true,
        pending: false,
        runId,
        text,
        // "gateway-injected" means the command handler answered directly, with
        // no model call — useful for the UI to label the turn honestly.
        handledByGateway: fresh.some((m) => m.model === "gateway-injected"),
      });
    }

    // Long-running commands (skill commands route to the model) are not a
    // failure — tell the client to keep reading the transcript.
    return NextResponse.json({ ok: true, pending: true, runId });
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    ctx.log.error({ err }, "chat/command failed");
    return apiError("The gateway could not run that command.", 502);
  }
  },
);
