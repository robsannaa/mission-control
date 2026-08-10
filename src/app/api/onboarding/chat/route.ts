import { NextRequest } from "next/server";
import { getGatewayUrl, getGatewayToken } from "@/lib/paths";
import { triggerResponsesEndpointSetup, waitForResponsesEndpoint } from "@/lib/responses-endpoint";
import { buildOnboardErrorFrame, friendlyOnboardChatError } from "@/components/onboarding/error-frame";

export const dynamic = "force-dynamic";

/**
 * Wizard-only chat send for the "first chat" step.
 *
 * Deliberately separate from the app's main /api/chat route, which many other
 * surfaces depend on and is out of scope for onboarding changes. This
 * endpoint has one job: prove "the agent can think" honestly. The stream is
 * plain assistant text, with exactly one exception — any failure, before the
 * first byte or mid-stream, ends the response with a typed marker (see
 * error-frame.ts) instead of raw error text, so the wizard can tell a real
 * reply from a gateway/agent failure and react with plain-language guidance
 * instead of celebrating.
 */

const REQUEST_TIMEOUT_MS = 60_000;

function errorStream(message: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(encoder.encode(buildOnboardErrorFrame(message)));
      ctrl.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(req: NextRequest) {
  let prompt = "";
  try {
    const body = await req.json();
    prompt = String(body?.prompt || "").trim();
  } catch {
    return errorStream("Please send a message.");
  }
  if (!prompt) {
    return errorStream("Please send a message.");
  }

  let gwUrl: string;
  let token: string;
  try {
    gwUrl = await getGatewayUrl();
    token = getGatewayToken();
  } catch {
    return errorStream(friendlyOnboardChatError("gateway unreachable"));
  }

  // Best-effort: make sure streaming is enabled before we rely on it.
  triggerResponsesEndpointSetup();
  await waitForResponsesEndpoint();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-openclaw-agent-id": "main",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let gwRes: Response;
  try {
    gwRes = await fetch(`${gwUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "openclaw:main", input: prompt, stream: true }),
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeout);
    return errorStream(friendlyOnboardChatError("gateway unreachable"));
  }

  if (!gwRes.ok || !gwRes.body) {
    clearTimeout(timeout);
    const status = gwRes.status;
    const text = await gwRes.text().catch(() => "");
    return errorStream(friendlyOnboardChatError(text, status));
  }

  const reader = gwRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(ctrl) {
      let buffer = "";
      let sawContent = false;
      let failMessage: string | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              if (event.type === "response.output_text.delta" && event.delta) {
                sawContent = true;
                ctrl.enqueue(encoder.encode(event.delta));
              } else if (event.type === "response.failed") {
                failMessage = event.response?.error?.message || "";
              }
            } catch {
              // non-JSON SSE line — skip
            }
          }
          if (failMessage !== null) break;
        }
      } catch {
        // stream interrupted — fall through to the empty/failure check below
      } finally {
        clearTimeout(timeout);
        if (failMessage !== null) {
          ctrl.enqueue(encoder.encode(buildOnboardErrorFrame(friendlyOnboardChatError(failMessage))));
        } else if (!sawContent) {
          ctrl.enqueue(
            encoder.encode(
              buildOnboardErrorFrame("The agent sent an empty reply. Try again in a moment."),
            ),
          );
        }
        ctrl.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
