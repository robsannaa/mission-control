import { getGatewayUrl, getGatewayToken } from "@/lib/paths";
import { guessMime } from "@/lib/openresponses";
import { logRequest, logError } from "@/lib/request-log";
import { triggerResponsesEndpointSetup, waitForResponsesEndpoint } from "@/lib/responses-endpoint";

/**
 * Streaming chat endpoint — proxies SSE from the Gateway's OpenResponses API.
 *
 * POST /api/chat/stream
 * Body: { agent, messages: [{ role, id, parts }], model?, sessionKey? }
 *
 * Streams back SSE events from the gateway's POST /v1/responses endpoint.
 * If the gateway doesn't support OpenResponses (404/502), returns a specific
 * status so the client can fall back to the non-streaming /api/chat endpoint.
 */
export async function POST(req: Request) {
  const start = Date.now();
  try {
    const body = await req.json();
    const messages: {
      role: string;
      parts?: { type: string; text?: string; url?: string; filename?: string; mimeType?: string }[];
      content?: string;
    }[] = body.messages || [];
    const agentId: string = body.agentId || body.agent || "main";
    const model: string | undefined = body.model?.trim() || undefined;
    const sessionKey: string | undefined = typeof body.sessionKey === "string" && body.sessionKey.trim()
      ? body.sessionKey.trim()
      : undefined;

    // Extract last user message — text + file attachments as OpenResponses input items
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const inputItems: unknown[] = [];

    if (lastUserMsg?.parts) {
      for (const p of lastUserMsg.parts) {
        if (p.type === "text" && p.text) {
          inputItems.push({
            type: "message",
            role: "user",
            content: p.text,
          });
        } else if (p.type === "file" && p.url) {
          const mime = p.mimeType || guessMime(p.url, p.filename);
          if (mime.startsWith("image/")) {
            inputItems.push({
              type: "input_image",
              source: { type: "url", url: p.url },
            });
          } else {
            // Extract base64 data from data URL
            const base64Match = p.url.match(/^data:[^;]+;base64,(.+)$/);
            if (base64Match) {
              inputItems.push({
                type: "input_file",
                source: {
                  type: "base64",
                  media_type: mime,
                  data: base64Match[1],
                  filename: p.filename || "file",
                },
              });
            }
          }
        }
      }
    } else if (lastUserMsg?.content) {
      inputItems.push({
        type: "message",
        role: "user",
        content: lastUserMsg.content,
      });
    }

    // Flatten: if there's only simple text, use a plain string input
    const input =
      inputItems.length === 1 &&
      (inputItems[0] as { type: string }).type === "message"
        ? (inputItems[0] as { content: string }).content
        : inputItems.length > 0
          ? inputItems
          : "";

    if (!input || (typeof input === "string" && !input.trim())) {
      return new Response("Please send a message or attach a file.", {
        status: 400,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
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
    if (req.signal) {
      req.signal.addEventListener("abort", () => controller.abort(), { once: true });
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
      logError("/api/chat/stream", err, { agentId, phase: "gateway_fetch" });
      return new Response(
        JSON.stringify({ error: "gateway_unreachable", message: String(err) }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!gwRes.ok) {
      clearTimeout(timeout);
      const text = await gwRes.text().catch(() => "");
      logRequest("/api/chat/stream", gwRes.status, Date.now() - start, { agentId, error: gwRes.status === 404 ? "endpoint_not_enabled" : "gateway_error" });
      return new Response(
        JSON.stringify({
          error: gwRes.status === 404 ? "endpoint_not_enabled" : "gateway_error",
          status: gwRes.status,
          message: text,
        }),
        { status: gwRes.status, headers: { "Content-Type": "application/json" } },
      );
    }

    if (!gwRes.body) {
      clearTimeout(timeout);
      return new Response(
        JSON.stringify({ error: "no_stream_body" }),
        { status: 502, headers: { "Content-Type": "application/json" } },
      );
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

    logRequest("/api/chat/stream", 200, Date.now() - start, { agentId, model: model || `openclaw:${agentId}` });
    return new Response(readable, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    logError("/api/chat/stream", err);
    return new Response(
      JSON.stringify({
        error: "internal",
        message: err instanceof Error ? err.message : String(err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
