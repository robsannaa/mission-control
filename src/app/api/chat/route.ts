import { runOpenResponsesText, guessMime } from "@/lib/openresponses";
import { getGatewayUrl, getGatewayToken, getOpenClawHome } from "@/lib/paths";
import { waitForResponsesEndpoint, triggerResponsesEndpointSetup } from "@/app/api/gateway/route";
import fs from "fs";
import path from "path";

/**
 * Chat endpoint that sends a message to an OpenClaw agent and returns the response.
 * Works with Vercel AI SDK v5's TextStreamChatTransport.
 *
 * Tries the Gateway's OpenResponses API first (streaming, token-by-token),
 * then a non-streaming gateway request. This route is gateway-only.
 *
 * Request body: { messages, agentId, sessionKey?, model?, ... }
 * Each UIMessage has { id, role, parts: [{ type: 'text', text }, { type: 'file', url, filename }] }
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


function buildUserTurnItems(msg: Message): { textParts: string[]; fileParts: string[]; orContent: unknown[] } {
  const textParts: string[] = [];
  const fileParts: string[] = [];
  const orContent: unknown[] = [];

  if (msg.parts) {
    for (const p of msg.parts) {
      if (p.type === "text" && p.text) {
        textParts.push(p.text);
        orContent.push({ type: "text", text: p.text });
      } else if (p.type === "file" && p.url) {
        const name = (p.filename || "file").replace(/\s+/g, " ");
        fileParts.push(dataUrlToSafeMessagePart(p.url, name));
        const mime = p.mimeType || guessMime(p.url, p.filename);
        if (mime.startsWith("image/")) {
          // OpenAI Responses API: image_url is a plain string (data URL or https URL)
          orContent.push({ type: "input_image", image_url: p.url });
        } else {
          const base64Match = p.url.match(/^data:[^;]+;base64,(.+)$/);
          if (base64Match) {
            orContent.push({ type: "text", text: `[Attached file: ${name}]` });
          }
        }
      }
    }
  } else if (msg.content) {
    textParts.push(msg.content);
    orContent.push({ type: "text", text: msg.content });
  }

  return { textParts, fileParts, orContent };
}

function extractContent(messages: Message[]): {
  plainText: string;
  openResponsesInput: unknown;
} {
  const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");

  // plainText is always derived from the last user message (for empty-check)
  const lastTurn = lastUserMsg ? buildUserTurnItems(lastUserMsg) : { textParts: [], fileParts: [], orContent: [] };
  const textBlock = lastTurn.textParts.join("").trim();
  const fileBlock = lastTurn.fileParts.length ? "\n\n" + lastTurn.fileParts.join("\n\n---\n\n") : "";
  const plainText = (textBlock + fileBlock).trim();

  // For multi-turn conversations, build the full history so the model has context
  // even when the gateway session is cold (e.g. first load or after clearChat).
  const conversationTurns = messages.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );

  const orItems: unknown[] = [];
  for (const msg of conversationTurns) {
    if (msg.role === "assistant") {
      const text =
        msg.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text ?? "")
          .join("") || msg.content || "";
      if (text.trim()) {
        orItems.push({ type: "message", role: "assistant", content: text.trim() });
      }
      continue;
    }
    // user turn
    const { orContent } = buildUserTurnItems(msg);
    if (orContent.length === 0) continue;
    const content =
      orContent.length === 1 && (orContent[0] as { type: string }).type === "text"
        ? (orContent[0] as { type: string; text: string }).text
        : orContent;
    orItems.push({ type: "message", role: "user", content });
  }

  // Single text-only turn → plain string (gateway accepts both forms)
  const openResponsesInput =
    orItems.length === 1 &&
    (orItems[0] as { type: string; role: string; content: unknown }).role === "user" &&
    typeof (orItems[0] as { content: unknown }).content === "string"
      ? (orItems[0] as { content: string }).content
      : orItems.length > 0
        ? orItems
        : plainText;

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
  opts?: { onSpawn?: (agentId: string) => void },
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  // Track in-flight tool calls so we can emit start/end markers
  const activeCalls = new Map<string, string>(); // callId → toolName
  // Track stream state for commentary-fallback detection
  let accumulatedDeltaText = "";
  let finalDoneText: string | null = null;
  let completedStatus: string | null = null;

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
      if (data === "[DONE]") {
        // Before returning: if the response failed but we streamed real text,
        // the commentary content is already in the client's buffer. Add a
        // subtle note so the user knows the primary model was unavailable.
        if (
          completedStatus === "failed" &&
          accumulatedDeltaText.trim() &&
          (finalDoneText === "No response from OpenClaw." || !finalDoneText)
        ) {
          yield "\n\n*[⚡ via fallback model — primary unavailable]*";
        }
        return;
      }

      try {
        const event = JSON.parse(data);

        // ── Text deltas ──
        if (event.type === "response.output_text.delta" && event.delta) {
          accumulatedDeltaText += event.delta;
          yield event.delta;
          continue;
        }

        // ── Track final done text (to detect "No response from OpenClaw." override) ──
        if (event.type === "response.output_text.done") {
          finalDoneText = typeof event.text === "string" ? event.text : null;
          continue;
        }

        // ── Track overall completion status ──
        if (event.type === "response.completed") {
          completedStatus = event.response?.status ?? null;
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
            const callName = activeCalls.get(callId);
            try {
              const args = typeof event.arguments === "string"
                ? event.arguments
                : JSON.stringify(event.arguments);
              // Emit args as a detail line inside the tool block
              if (args && args !== "{}") {
                yield `\n\u{200B}[[TOOL_ARGS:${callId}:${args}]]\u{200B}\n`;
              }
              // Capture sessions_spawn agentId for auto-relay
              if (callName === "sessions_spawn" && opts?.onSpawn) {
                try {
                  const parsed = JSON.parse(args) as { agentId?: string };
                  if (parsed.agentId) opts.onSpawn(parsed.agentId);
                } catch { /* ignore malformed args */ }
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

// ── Sub-agent auto-relay helpers ─────────────────────

type SubagentSessionRecord = {
  startedAt?: number;
  endedAt?: number;
  sessionFile?: string;
};

/**
 * Scan all sub-agent directories for a session started during this request.
 * sessions_spawn is handled internally by the gateway and never appears in
 * the SSE stream, so we must scan after the orchestrator stream ends.
 *
 * Strategy:
 *  - Check immediately: by the time Em's stream ends, the sub-agent is
 *    typically already created (the spawn happens mid-run).
 *  - If found but still running, poll up to 90s for completion.
 *  - If not found on first pass, wait 3s and try once more, then bail.
 *    (Avoids a long scan on requests with no delegation.)
 */
async function findAnySubagentResult(
  orchAgentId: string,
  requestStartTime: number,
): Promise<{ agentId: string; text: string } | null> {
  const agentsDir = path.join(getOpenClawHome(), "agents");
  let agentIds: string[];
  try {
    agentIds = fs
      .readdirSync(agentsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== orchAgentId)
      .map((e) => e.name);
  } catch {
    return null;
  }
  if (agentIds.length === 0) return null;

  const scanForSession = (): { id: string; sessionFile: string; done: boolean } | null => {
    for (const id of agentIds) {
      const p = path.join(agentsDir, id, "sessions", "sessions.json");
      try {
        const raw = fs.readFileSync(p, "utf-8");
        const sessions = JSON.parse(raw) as Record<string, SubagentSessionRecord>;
        const candidates = Object.values(sessions)
          .filter((s) => s.startedAt && s.startedAt > requestStartTime - 5_000 && s.sessionFile)
          .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
        if (candidates[0]) {
          return { id, sessionFile: candidates[0].sessionFile!, done: !!candidates[0].endedAt };
        }
      } catch { /* not readable */ }
    }
    return null;
  };

  // First immediate scan — sub-agent is usually already created by now.
  let found = scanForSession();

  // If not found, give it one more short window (3s) then bail.
  if (!found) {
    await delay(3000);
    found = scanForSession();
    if (!found) return null;
  }

  // Sub-agent was found. If already done, return immediately.
  if (found.done) {
    const text = readSubagentSessionText(found.sessionFile);
    if (text) return { agentId: found.id, text };
  }

  // Otherwise poll up to 90s for completion.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await delay(2000);
    const p = path.join(agentsDir, found.id, "sessions", "sessions.json");
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const sessions = JSON.parse(raw) as Record<string, SubagentSessionRecord>;
      const candidates = Object.values(sessions)
        .filter((s) => s.startedAt && s.startedAt > requestStartTime - 5_000 && s.sessionFile && s.endedAt)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      if (candidates[0]?.sessionFile) {
        const text = readSubagentSessionText(candidates[0].sessionFile);
        if (text) return { agentId: found.id, text };
      }
    } catch { /* not readable */ }
  }
  return null;
}


/**
 * Poll ~/.openclaw/agents/{agentId}/sessions/sessions.json until a session
 * started after `requestStartTime` finishes, then return its final assistant
 * message text.  Returns null on timeout.
 */
async function pollForSubagentResult(
  spawnedAgentId: string,
  requestStartTime: number,
  timeoutMs = 90_000,
): Promise<string | null> {
  const sessionsJsonPath = path.join(
    getOpenClawHome(),
    "agents",
    spawnedAgentId,
    "sessions",
    "sessions.json",
  );
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await delay(2000);
    try {
      const raw = fs.readFileSync(sessionsJsonPath, "utf-8");
      const sessions = JSON.parse(raw) as Record<string, SubagentSessionRecord>;
      const candidates = Object.values(sessions)
        .filter((s) => s.startedAt && s.startedAt > requestStartTime - 5_000 && s.sessionFile && s.endedAt)
        .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
      for (const session of candidates) {
        if (!session.sessionFile) continue;
        const text = readSubagentSessionText(session.sessionFile);
        if (text) return text;
      }
    } catch { /* sessions.json not readable */ }
  }

  return null;
}

function readSubagentSessionText(sessionFile: string): string | null {
  try {
    const lines = fs.readFileSync(sessionFile, "utf-8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]) as { type: string; message?: { role: string; content: unknown } };
        if (event.type !== "message" || event.message?.role !== "assistant") continue;
        const content = event.message.content;
        let text = "";
        if (Array.isArray(content)) {
          text = (content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text" || c.type === "output_text")
            .map((c) => c.text ?? "")
            .join("");
        } else if (typeof content === "string") {
          text = content;
        }
        if (text.trim()) return text.trim();
      } catch { /* skip malformed line */ }
    }
  } catch { /* session file not readable */ }
  return null;
}


/**
 * After Em's first stream completes, poll for a sub-agent result then fire a
 * second Em turn and pipe its response into the already-open stream controller.
 *
 * sessions_spawn is handled internally by the gateway (not exposed in SSE),
 * so we always scan sub-agent directories after the orchestrator stream ends.
 * The scan is fast: sub-agent sessions are typically already created by then.
 */
async function autoRelaySubagentResult(
  ctrl: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  opts: {
    spawnedAgentId: string | null; // from SSE stream if available (otherwise null)
    requestStartTime: number;
    orchAgentId: string;
    sessionKey: string | undefined;
    gwUrl: string;
    token: string;
    gwHeaders: Record<string, string>;
  },
): Promise<void> {
  const { spawnedAgentId, requestStartTime, orchAgentId, sessionKey, gwUrl, token, gwHeaders } = opts;

  let result: string | null = null;
  let resolvedAgentId = spawnedAgentId ?? "sub-agent";

  if (spawnedAgentId) {
    result = await pollForSubagentResult(spawnedAgentId, requestStartTime);
  } else {
    // sessions_spawn doesn't appear in the SSE stream — scan all sub-agent dirs.
    const found = await findAnySubagentResult(orchAgentId, requestStartTime);
    if (found) { result = found.text; resolvedAgentId = found.agentId; }
  }

  if (!result) return;

  // Fire a second orchestrator turn with the sub-agent result
  const continuationInput = `[Subagent ${resolvedAgentId} completed its task. Result: "${result}" — please relay this to the user now.]`;

  const headers: Record<string, string> = { ...gwHeaders, "Content-Type": "application/json" };
  if (sessionKey) headers["x-openclaw-session-key"] = sessionKey;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const secondController = new AbortController();
  const secondTimeout = setTimeout(() => secondController.abort(), 120_000);
  try {
    const secondRes = await fetch(`${gwUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: `openclaw:${orchAgentId}`,
        input: continuationInput,
        stream: true,
      }),
      signal: secondController.signal,
    });
    if (secondRes.ok && secondRes.body) {
      const secondReader = secondRes.body.getReader();
      for await (const delta of parseOpenResponsesStream(secondReader)) {
        ctrl.enqueue(encoder.encode(delta));
      }
    }
  } catch { /* continuation failed — stream what we have */ }
  finally {
    clearTimeout(secondTimeout);
  }
}

async function tryStreamingResponse(
  input: unknown,
  agentId: string,
  sessionKey?: string,
): Promise<Response | null> {
  let gwUrl: string;
  let token: string;
  try {
    gwUrl = await getGatewayUrl();
    token = getGatewayToken();
  } catch (e) {
    console.warn("[chat] Gateway URL/token not available:", e);
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
    console.warn(`[chat] Gateway unreachable at ${endpoint}:`, e);
    return null;
  }

  if (!gwRes.ok || !gwRes.body) {
    clearTimeout(timeout);
    const status = gwRes.status;
    const text = await gwRes.text().catch(() => "");
    console.warn(`[chat] Gateway returned ${status} from ${endpoint}.`, text.slice(0, 200));
    // Surface auth/config errors (4xx) directly instead of falling through
    if (text && status >= 400 && status < 500 && status !== 404) {
      return new Response(`Error: ${text.slice(0, 500)}`, {
        status,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return null;
  }

  console.log(
    `[chat] Streaming via gateway OpenResponses API (agent=${agentId}, session=${sessionKey || "ephemeral"})`,
  );

  // Stream text deltas as plain text for TextStreamChatTransport
  const reader = gwRes.body.getReader();
  const encoder = new TextEncoder();
  const requestStartTime = Date.now();
  const spawnedAgentIds: string[] = [];
  // Headers for sub-agent relay (without session-key — added per-request in autoRelaySubagentResult)
  const baseHeaders: Record<string, string> = { "x-openclaw-agent-id": agentId };

  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        for await (const delta of parseOpenResponsesStream(reader, {
          onSpawn: (spawned) => spawnedAgentIds.push(spawned),
        })) {
          ctrl.enqueue(encoder.encode(delta));
        }
        // Auto-relay the sub-agent result when sessions_spawn was detected.
        await autoRelaySubagentResult(ctrl, encoder, {
          spawnedAgentId: spawnedAgentIds.length > 0 ? spawnedAgentIds[0] : null,
          requestStartTime,
          orchAgentId: agentId,
          sessionKey,
          gwUrl,
          token,
          gwHeaders: baseHeaders,
        });
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

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const messages: Message[] = body.messages || [];
    const agentId: string = body.agentId || body.agent || "main";
    const sessionKey = normalizeRequestedSessionKey(body.sessionKey);

    const { plainText, openResponsesInput } = extractContent(messages);

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
    console.error("Chat API error:", err);
    const errMsg =
      err instanceof Error ? err.message : "Failed to get agent response";
    return new Response(`Error: ${errMsg}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
