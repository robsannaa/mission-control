import { NextResponse } from "next/server";
import { runCli } from "@/lib/openclaw";
import { runOpenResponsesText } from "@/lib/openresponses";
import { getDefaultAgentId } from "@/lib/paths";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { skillsTestPostSchema } from "@/lib/schemas/automation";

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

export const POST = withRoute(
  { name: "/api/skills/test", bodySchema: skillsTestPostSchema },
  async (request, ctx) => {
  try {
    const body = ctx.body as SkillTestRequest;

    const skillName = safeToken(body.skillName || "");
    if (!skillName) {
      return badRequest("Valid skillName is required");
    }

    // "main" is a mainKey alias, not an agent id: the RPC rejects it and the CLI
    // resolves `--agent main` to a workspace inside the real one. Resolve the
    // real default instead, keeping "main" only for an unreachable gateway.
    const agentId = safeToken(
      body.agentId || (await getDefaultAgentId()) || "",
      "main",
    );
    if (!agentId) {
      return badRequest("Invalid agentId");
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
    // Malformed-JSON-body handling now lives in withRoute (readJsonBody +
    // the bodySchema gate), so it never reaches this catch anymore.
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err: message }, "Skill test failed");
    return serverError(message || "Skill test failed");
  }
  },
);
