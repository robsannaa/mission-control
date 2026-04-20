import { readFile } from "fs/promises";
import path from "path";
import os from "os";

type SessionRecord = {
  sessionFile?: string;
};

type MessageEvent = {
  type: string;
  message?: {
    role: string;
    content: unknown;
  };
};

type ContentPart = {
  type: string;
  text?: string;
};

/**
 * GET /api/chat/last-response?agentId=<id>&sessionKey=<key>
 *
 * Reads the gateway's JSONL session file for the given session key and
 * returns the last non-empty assistant message text. Used by the chat UI
 * to recover a completed response after the SSE stream was dropped (e.g.
 * when the browser backgrounded the tab mid-stream).
 *
 * Returns: { text: string }  or 404 if no complete response is found.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId") || "main";
  const sessionKey = url.searchParams.get("sessionKey");

  if (!sessionKey) {
    return new Response("missing sessionKey", { status: 400 });
  }

  try {
    const sessionsPath = path.join(
      os.homedir(),
      ".openclaw",
      "agents",
      agentId,
      "sessions",
      "sessions.json",
    );

    const sessionsRaw = await readFile(sessionsPath, "utf-8");
    const sessions = JSON.parse(sessionsRaw) as Record<string, SessionRecord>;
    const session = sessions[sessionKey];

    if (!session?.sessionFile) {
      return new Response("session not found", { status: 404 });
    }

    const jsonlRaw = await readFile(session.sessionFile, "utf-8");
    const lines = jsonlRaw.split("\n").filter(Boolean);

    // Walk backwards — the last assistant message with actual text wins.
    for (let i = lines.length - 1; i >= 0; i--) {
      let event: MessageEvent;
      try {
        event = JSON.parse(lines[i]) as MessageEvent;
      } catch {
        continue;
      }

      if (event.type !== "message" || event.message?.role !== "assistant") continue;

      const content = event.message.content;
      let text = "";

      if (Array.isArray(content)) {
        text = (content as ContentPart[])
          .filter((p) => p.type === "text" || p.type === "output_text")
          .map((p) => p.text ?? "")
          .join("");
      } else if (typeof content === "string") {
        text = content;
      }

      if (text.trim()) {
        return Response.json({ text: text.trim() });
      }
    }

    return new Response("no response found", { status: 404 });
  } catch {
    return new Response("error reading session", { status: 500 });
  }
}
