import { NextRequest, NextResponse } from "next/server";
import { runCli } from "@/lib/openclaw";
import { runOpenResponsesText } from "@/lib/openresponses";
import { getDefaultAgentId } from "@/lib/paths";

export const dynamic = "force-dynamic";

const SAFE_TOKEN_RE = /^[A-Za-z0-9._-]+$/;

type SkillTestRequest = {
  skillName?: string;
  agentId?: string;
  input?: string;
};

function safeToken(raw: string, fallback = ""): string {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  if (!SAFE_TOKEN_RE.test(value)) return "";
  return value;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SkillTestRequest;

    const skillName = safeToken(body.skillName || "");
    if (!skillName) {
      return NextResponse.json(
        { ok: false, error: "Valid skillName is required" },
        { status: 400 }
      );
    }

    // "main" is a mainKey alias, not an agent id: the RPC rejects it and the CLI
    // resolves `--agent main` to a workspace inside the real one. Resolve the
    // real default instead, keeping "main" only for an unreachable gateway.
    const agentId = safeToken(
      body.agentId || (await getDefaultAgentId()) || "",
      "main",
    );
    if (!agentId) {
      return NextResponse.json(
        { ok: false, error: "Invalid agentId" },
        { status: 400 }
      );
    }

    const input = String(body.input || "").trim();
    const message = input ? `/skill ${skillName} ${input}` : `/skill ${skillName}`;
    const startedAt = Date.now();

    let output = "";
    let method: "openresponses" | "cli" = "openresponses";
    try {
      const result = await runOpenResponsesText({
        input: message,
        agentId,
        timeoutMs: 180_000,
      });
      if (!result.ok) {
        throw new Error(result.text || `Gateway returned ${result.status}`);
      }
      output = result.text;
    } catch {
      method = "cli";
      output = await runCli(
        ["agent", "--agent", agentId, "--message", message],
        180_000
      );
    }

    return NextResponse.json({
      ok: true,
      skillName,
      agentId,
      message,
      method,
      cliCommand:
        method === "cli"
          ? `openclaw agent --agent ${agentId} --message ${JSON.stringify(message)}`
          : null,
      output: output.trim(),
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    // Bug fix 2026-08-16: malformed JSON body throws SyntaxError from `request.json()`.
    if (err instanceof SyntaxError) {
      return NextResponse.json(
        { ok: false, error: `Invalid JSON body: ${err.message}` },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: message || "Skill test failed" },
      { status: 500 }
    );
  }
}
