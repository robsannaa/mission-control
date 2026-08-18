import { getGatewayUrl, getGatewayToken, getDefaultAgentId } from "@/lib/paths";
import { guessMime } from "@/lib/openresponses";
import { triggerResponsesEndpointSetup, waitForResponsesEndpoint } from "@/lib/responses-endpoint";
import { withPassthroughRoute } from "@/lib/api-route";
import { apiError } from "@/lib/api-errors";
import { chatStreamPostSchema, type ChatStreamPostInput } from "@/lib/schemas/streaming";

/**
 * Streaming chat endpoint — proxies SSE from the Gateway's OpenResponses API.
 *
 * POST /api/chat/stream
 * Body: { agent, messages: [{ role, id, parts }], model?, sessionKey? }
 *
 * Streams back SSE events from the gateway's POST /v1/responses endpoint.
 * If the gateway doesn't support OpenResponses (404/502), returns a specific
 * status so the client can fall back to the non-streaming /api/chat endpoint.
 *
 * Wrapped with `withPassthroughRoute` (docs/API-CONTRACT.md §4): the body
 * schema validates shape before any gateway call is made, but once the SSE
 * `Response` is constructed below, the wrapper returns it untouched — no
 * status read, no body inspection.
 */
export const POST = withPassthroughRoute<ChatStreamPostInput>(
  { name: "/api/chat/stream", bodySchema: chatStreamPostSchema },
  async (request, ctx) => {
    const start = Date.now();
    const { body, log } = ctx;
    try {
      const messages = body.messages || [];
      // "main" is `agents.list`'s mainKey, not necessarily a real agent id — the
      // RPC rejects unknown ids and the CLI silently resolves them to the wrong
      // workspace (see getDefaultAgent in lib/paths.ts). When the request does
      // not name an agent, ask the gateway which agent is actually the default.
      const requestedAgent: string =
        (typeof body.agentId === "string" && body.agentId.trim()) ||
        (typeof body.agent === "string" && body.agent.trim()) ||
        "";
      const agentId = requestedAgent || (await getDefaultAgentId()) || "";
      if (!agentId) {
        log.info({ status: 502, durationMs: Date.now() - start, error: "no_default_agent" });
        return apiError("Could not resolve the default agent — is the gateway running?", 502);
      }
      const model: string | undefined = body.model?.trim() || undefined;
      const sessionKey: string | undefined = typeof body.sessionKey === "string" && body.sessionKey.trim()
        ? body.sessionKey.trim()
        : undefined;

      // Extract last user message — text + file attachments as OpenResponses input items
      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      const inputItems: unknown[] = [];

      /*
       * OpenResponses shape: input_text / input_image / input_file are content
       * PARTS inside a message, not top-level input items. The previous code
       * pushed a { type: "message" } item and then sibling input_image /
       * input_file items into the same array, which the gateway rejects with
       * "input: Invalid input" — so every attachment silently failed while
       * text-only messages worked.
       */
      if (lastUserMsg?.parts) {
        const contentParts: unknown[] = [];

        for (const p of lastUserMsg.parts) {
          if (p.type === "text" && p.text) {
            contentParts.push({ type: "input_text", text: p.text });
          } else if (p.type === "file" && p.url) {
            const mime = p.mimeType || guessMime(p.url, p.filename);
            // Browsers hand us data: URLs; the gateway wants those as base64.
            // URL sources are for real http(s) URLs and can be disabled by config.
            const inline = p.url.match(/^data:[^;]+;base64,(.+)$/);

            if (mime.startsWith("image/")) {
              contentParts.push({
                type: "input_image",
                source: inline
                  ? { type: "base64", media_type: mime, data: inline[1] }
                  : { type: "url", url: p.url },
              });
            } else if (inline) {
              contentParts.push({
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: mime,
                  data: inline[1],
                  filename: p.filename || "file",
                },
              });
            }
          }
        }

        if (contentParts.length > 0) {
          const onlyText =
            contentParts.length === 1 &&
            (contentParts[0] as { type: string }).type === "input_text";
          inputItems.push({
            type: "message",
            role: "user",
            // A lone text part stays a plain string — the simplest valid form.
            content: onlyText
              ? (contentParts[0] as { text: string }).text
              : contentParts,
          });
        }
      } else if (lastUserMsg?.content) {
        inputItems.push({
          type: "message",
          role: "user",
          content: lastUserMsg.content,
        });
      }

      // Flatten: if there's only simple text, use a plain string input
      // A single text-only message may be sent as a plain string. A message whose
      // content is an array of parts must stay wrapped: flattening it puts
      // input_text/input_image at the top level, which is not a valid input item
      // and fails the whole request with "input: Invalid input".
      const soleMessageContent =
        inputItems.length === 1 &&
        (inputItems[0] as { type: string }).type === "message"
          ? (inputItems[0] as { content: unknown }).content
          : undefined;
      const input =
        typeof soleMessageContent === "string"
          ? soleMessageContent
          : inputItems.length > 0
            ? inputItems
            : "";

      if (!input || (typeof input === "string" && !input.trim())) {
        return new Response("Please send a message or attach a file.", {
          status: 400,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "x-openclaw-agent-id": agentId,
          },
        });
      }

      // Ensure the OpenResponses endpoint is enabled before hitting the gateway
      triggerResponsesEndpointSetup();
      await waitForResponsesEndpoint();

      const gwUrl = await getGatewayUrl();
      const token = getGatewayToken();

      // Build OpenResponses request
      const orBody: Record<string, unknown> = {
        model: model || `openclaw:${agentId}`,
        input,
        stream: true,
      };

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "x-openclaw-agent-id": agentId,
      };
      if (sessionKey) headers["x-openclaw-session-key"] = sessionKey;
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 180_000);

      // Cancel upstream fetch if client disconnects
      if (request.signal) {
        request.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      let gwRes: Response;
      try {
        gwRes = await fetch(`${gwUrl}/v1/responses`, {
          method: "POST",
          headers,
          body: JSON.stringify(orBody),
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timeout);
        log.error({ agentId, phase: "gateway_fetch", err: err instanceof Error ? err.message : String(err) });
        return apiError(err instanceof Error ? err.message : String(err), 502);
      }

      if (!gwRes.ok) {
        clearTimeout(timeout);
        const text = await gwRes.text().catch(() => "");
        const errorCode = gwRes.status === 404 ? "endpoint_not_enabled" : "gateway_error";
        log.info({ status: gwRes.status, durationMs: Date.now() - start, agentId, error: errorCode });
        return apiError(
          text ||
            (gwRes.status === 404
              ? "The gateway's streaming endpoint isn't enabled."
              : "The gateway returned an error."),
          gwRes.status,
        );
      }

      if (!gwRes.body) {
        clearTimeout(timeout);
        return apiError("The gateway did not return a response body.", 502);
      }

      // Pipe the SSE stream through to the client
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      // Pipe in background — don't await
      (async () => {
        const reader = gwRes.body!.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
        } catch {
          // Stream interrupted (client disconnect, gateway error) — ok
        } finally {
          clearTimeout(timeout);
          reader.cancel().catch(() => {});
          await writer.close().catch(() => {});
        }
      })();

      log.info({ status: 200, durationMs: Date.now() - start, agentId, model: model || `openclaw:${agentId}` });
      return new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "x-openclaw-agent-id": agentId,
        },
      });
    } catch (err) {
      log.error({ err: err instanceof Error ? err.message : String(err) });
      return apiError(err instanceof Error ? err.message : String(err), 500);
    }
  },
);
