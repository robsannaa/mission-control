import { runOpenResponsesText, guessMime } from "@/lib/openresponses";
import { getGatewayUrl, getGatewayToken } from "@/lib/paths";
import { triggerResponsesEndpointSetup, waitForResponsesEndpoint } from "@/lib/responses-endpoint";
import { withPassthroughRoute } from "@/lib/api-route";
import { chatPostSchema, type ChatPostInput } from "@/lib/schemas/streaming";
import type { Logger } from "pino";

/**
 * Chat endpoint that sends a message to an OpenClaw agent and returns the response.
 * Works with Vercel AI SDK v5's TextStreamChatTransport.
 *
 * Tries the Gateway's OpenResponses API first (streaming, token-by-token),
 * then a non-streaming gateway request. This route is gateway-only.
 *
 * Request body: { messages, agentId, sessionKey?, model?, ... }
 * Each UIMessage has { id, role, parts: [{ type: 'text', text }, { type: 'file', url, filename }] }
 *
 * Wrapped with `withPassthroughRoute` (docs/API-CONTRACT.md §4): the body
 * schema validates shape before any gateway call, but the streamed/plain-text
 * `Response` this handler returns is never touched by the wrapper.
 */

// ── Message extraction helpers ──────────────────────

function dataUrlToSafeMessagePart(
  dataUrl: string,
  filename: string,
): string {
  try {
    const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
    if (!base64) return `[Attached: ${filename} (empty)]`;
    const buf = Buffer.from(base64, "base64");
    if (buf.includes(0))
      return `[Attached: ${filename} (binary file - not included in message)]`;
    const text = buf.toString("utf-8");
    return `[Attached: ${filename}]\n${text}`;
  } catch {
    return `[Attached: ${filename} (could not decode)]`;
  }
}

type MessagePart = {
  type: string;
  text?: string;
  url?: string;
  filename?: string;
  mimeType?: string;
};

type Message = {
  role: string;
  parts?: MessagePart[];
  content?: string;
};

function normalizeRequestedSessionKey(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}


function extractContent(messages: Message[], systemContext?: string): {
  plainText: string;
  openResponsesInput: unknown;
} {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
  const textParts: string[] = [];
  const fileParts: string[] = [];
  const orItems: unknown[] = [];
  // Invisible context (e.g. the proactive check-in a nudge reply answers): it
  // reaches the agent as a system turn, so the user's visible bubble stays a
  // clean plain answer instead of an ugly "(Re your check-in: …)" prefix.
  const sys = systemContext?.trim();

  if (lastUserMsg?.parts) {
    for (const p of lastUserMsg.parts) {
      if (p.type === "text" && p.text) {
        textParts.push(p.text);
        orItems.push({ type: "message", role: "user", content: p.text });
      } else if (p.type === "file" && p.url) {
        const name = (p.filename || "file").replace(/\s+/g, " ");
        fileParts.push(dataUrlToSafeMessagePart(p.url, name));

        // Build native OpenResponses input items for files
        const mime = p.mimeType || guessMime(p.url, p.filename);
        if (mime.startsWith("image/")) {
          // data: URLs must go as base64; URL sources are for http(s) only.
          const inlineImage = p.url.match(/^data:[^;]+;base64,(.+)$/);
          orItems.push({
            type: "input_image",
            source: inlineImage
              ? {
                  type: "base64",
                  media_type: p.mimeType || "image/png",
                  data: inlineImage[1],
                }
              : { type: "url", url: p.url },
          });
        } else {
          const base64Match = p.url.match(/^data:[^;]+;base64,(.+)$/);
          if (base64Match) {
            orItems.push({
              type: "input_file",
              source: { type: "base64", media_type: mime, data: base64Match[1], filename: name },
            });
          }
        }
      }
    }
  } else if (lastUserMsg?.content) {
    textParts.push(lastUserMsg.content);
    orItems.push({ type: "message", role: "user", content: lastUserMsg.content });
  }

  if (sys) orItems.unshift({ type: "message", role: "system", content: sys });

  const textBlock = textParts.join("").trim();
  const fileBlock = fileParts.length ? "\n\n" + fileParts.join("\n\n---\n\n") : "";
  const plainText = (sys ? `[context] ${sys}\n\n` : "") + (textBlock + fileBlock).trim();

  // Flatten simple text-only to a plain string
  const openResponsesInput =
    orItems.length === 1 && (orItems[0] as { type: string }).type === "message"
      ? (orItems[0] as { content: string }).content
      : orItems;

  return { plainText, openResponsesInput };
}

// ── Streaming via OpenResponses API ─────────────────

/**
 * Derive a human-friendly label for a tool/function call.
 */
function toolDisplayName(name: string): string {
  // Strip common prefixes and make readable
  return name
    .replace(/^(functions?\.|tools?\.)/, "")
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse SSE chunks and extract text deltas + tool call activity from
 * OpenResponses events. Yields text fragments (including inline tool
 * call markers that the chat UI renders as collapsible blocks).
 */
async function* parseOpenResponsesStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  // Track in-flight tool calls so we can emit start/end markers
  const activeCalls = new Map<string, string>(); // callId → toolName

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6);
      if (data === "[DONE]") return;

      try {
        const event = JSON.parse(data);

        // ── Text deltas (existing) ──
        if (event.type === "response.output_text.delta" && event.delta) {
          yield event.delta;
          continue;
        }

        // ── Tool/function call started ──
        if (event.type === "response.output_item.added" && event.item) {
          const item = event.item;
          if (item.type === "function_call" && item.name) {
            const callId = item.call_id || item.id || `call_${Date.now()}`;
            const name = item.name;
            activeCalls.set(callId, name);
            yield `\n\n\u{200B}[[TOOL_START:${callId}:${name}:${toolDisplayName(name)}]]\u{200B}\n\n`;
            continue;
          }
          // Agent handoff / delegation
          if (item.type === "agent_handoff" || item.type === "agent_delegation") {
            const target = item.agent || item.name || item.target || "sub-agent";
            const callId = item.id || `handoff_${Date.now()}`;
            activeCalls.set(callId, `agent:${target}`);
            yield `\n\n\u{200B}[[AGENT_START:${callId}:${target}]]\u{200B}\n\n`;
            continue;
          }
        }

        // ── Tool/function call completed ──
        if (event.type === "response.output_item.done" && event.item) {
          const item = event.item;
          const callId = item.call_id || item.id || "";
          if (
            (item.type === "function_call" || item.type === "agent_handoff" || item.type === "agent_delegation") &&
            callId &&
            activeCalls.has(callId)
          ) {
            activeCalls.delete(callId);
            yield `\n\n\u{200B}[[TOOL_END:${callId}]]\u{200B}\n\n`;
            continue;
          }
        }

        // ── Function call arguments streaming (attach to existing block) ──
        if (event.type === "response.function_call_arguments.done") {
          const callId = event.call_id || "";
          if (callId && activeCalls.has(callId)) {
            try {
              const args = typeof event.arguments === "string"
                ? event.arguments
                : JSON.stringify(event.arguments);
              // Emit args as a detail line inside the tool block
              if (args && args !== "{}") {
                yield `\n\u{200B}[[TOOL_ARGS:${callId}:${args}]]\u{200B}\n`;
              }
            } catch { /* skip malformed args */ }
          }
          continue;
        }

        // ── Error events ──
        if (event.type === "response.failed" && event.response?.error) {
          yield `\n\nError: ${event.response.error.message || "Agent encountered an error"}`;
          return;
        }
      } catch {
        // Non-JSON SSE line — skip
      }
    }
  }

  // Process any remaining buffered line after stream ends
  if (buffer.trim()) {
    const line = buffer.trim();
    if (line.startsWith("data: ")) {
      const data = line.slice(6);
      if (data !== "[DONE]") {
        try {
          const event = JSON.parse(data);
          if (event.type === "response.output_text.delta" && event.delta) {
            yield event.delta;
          }
        } catch {
          // Non-JSON — skip
        }
      }
    }
  }
}

async function tryStreamingResponse(
  input: unknown,
  agentId: string,
  log: Logger,
  sessionKey?: string,
): Promise<Response | null> {
  let gwUrl: string;
  let token: string;
  try {
    gwUrl = await getGatewayUrl();
    token = getGatewayToken();
  } catch (e) {
    log.warn({ agentId, err: e instanceof Error ? e.message : String(e) }, "Gateway URL/token not available");
    return null;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-openclaw-agent-id": agentId,
  };
  if (sessionKey) headers["x-openclaw-session-key"] = sessionKey;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const orBody: Record<string, unknown> = {
    model: `openclaw:${agentId}`,
    input,
    stream: true,
  };

  const endpoint = `${gwUrl}/v1/responses`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000);

  let gwRes: Response;
  try {
    gwRes = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(orBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    log.warn({ agentId, endpoint, err: e instanceof Error ? e.message : String(e) }, "Gateway unreachable");
    return null;
  }

  if (!gwRes.ok || !gwRes.body) {
    clearTimeout(timeout);
    const status = gwRes.status;
    const text = await gwRes.text().catch(() => "");
    log.warn({ agentId, endpoint, status, snippet: text.slice(0, 200) }, "Gateway returned an error status");
    // Surface auth/config errors (4xx) directly instead of falling through
    if (text && status >= 400 && status < 500 && status !== 404) {
      return new Response(`Error: ${text.slice(0, 500)}`, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return null;
  }

  log.info({ agentId, session: sessionKey || "ephemeral" }, "Streaming via gateway OpenResponses API");

  // Stream text deltas as plain text for TextStreamChatTransport
  const reader = gwRes.body.getReader();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        for await (const delta of parseOpenResponsesStream(reader)) {
          ctrl.enqueue(encoder.encode(delta));
        }
      } catch {
        // Stream interrupted — ok
      } finally {
        clearTimeout(timeout);
        ctrl.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// ── Non-streaming gateway fallback ──────────────────

async function nonStreamingResponse(
  input: unknown,
  agentId: string,
  sessionKey?: string,
): Promise<Response | null> {
  try {
    const result = await runOpenResponsesText({
      input,
      agentId,
      sessionKey,
      timeoutMs: 180_000,
    });

    if (!result.ok) {
      // Surface auth/config errors from the gateway instead of swallowing them
      if (result.text && result.status >= 400 && result.status < 500) {
        return new Response(`Error: ${result.text}`, {
          status: result.status,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return null;
    }

    return new Response(result.text || "", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch {
    return null;
  }
}

function gatewayUnavailableResponse(): Response {
  return new Response(
    [
      "Mission Control could not send this message through the OpenClaw gateway.",
      "Chat on this page is API-only and no longer falls back to the CLI.",
      "Check that the gateway is online and that your model provider is configured, then try again.",
    ].join(" "),
    {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main handler ────────────────────────────────────

export const POST = withPassthroughRoute<ChatPostInput>(
  { name: "/api/chat", bodySchema: chatPostSchema },
  async (_request, ctx) => {
    const { body, log } = ctx;
    try {
      const messages: Message[] = body.messages || [];
      const agentId: string = body.agentId || body.agent || "main";
      const sessionKey = normalizeRequestedSessionKey(body.sessionKey);

      const nudgeContext = typeof body.nudgeContext === "string" ? body.nudgeContext : undefined;
      const { plainText, openResponsesInput } = extractContent(messages, nudgeContext);

      if (!plainText) {
        return new Response("Please send a message or attach a file.", {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // Ensure the OpenResponses endpoint is enabled (trigger setup if the
      // gateway health poll hasn't fired yet), then wait for it to complete.
      triggerResponsesEndpointSetup();
      await waitForResponsesEndpoint();

      const tryGatewayChatOnce = async (): Promise<Response | null> => {
        // Try streaming via OpenResponses API first
        const streamingRes = await tryStreamingResponse(
          openResponsesInput,
          agentId,
          log,
          sessionKey,
        );
        if (streamingRes) return streamingRes;

        // Try a non-streaming OpenResponses request.
        return nonStreamingResponse(
          openResponsesInput,
          agentId,
          sessionKey,
        );
      };

      // First attempt.
      let response = await tryGatewayChatOnce();
      if (response) return response;

      // Gateway can briefly flap during restarts. Retry once before surfacing an error.
      await delay(1200);
      response = await tryGatewayChatOnce();
      if (response) return response;

      return gatewayUnavailableResponse();
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) }, "Chat API error");
      const errMsg =
        err instanceof Error ? err.message : "Failed to get agent response";
      return new Response(`Error: ${errMsg}`, {
        status: 500,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
);
