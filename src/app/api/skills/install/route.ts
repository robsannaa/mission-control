import { NextRequest } from "next/server";
import { gatewayCall } from "@/lib/openclaw";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Installs can be slow (compiling formulae, etc).

/**
 * POST /api/skills/install
 *
 * Installs a skill's missing requirement through the gateway and streams the
 * result back as Server-Sent Events: `{ type: "stdout" | "stderr" | "exit" |
 * "error", ... }`.
 *
 * Body: { name: string, installId: string }
 *   name      — skill name, as reported by /api/skills
 *   installId — id of the entry in that skill's `install` array
 *
 * This delegates to the gateway's `skills.install` rather than running a
 * package manager here, for three reasons:
 *
 *   1. The package name is not ours to guess. A skill's install spec carries a
 *      `formula`/`package` distinct from the binaries it provides — 1password's
 *      brew spec is `formula: "1password-cli"` providing `bins: ["op"]`. The
 *      inventory API deliberately omits those fields, so a client that builds
 *      its own command installs the wrong thing.
 *   2. OpenClaw picks the installer per host — Homebrew, `uv`, the configured
 *      node manager, `go`, then a direct download — honouring
 *      `skills.install.preferBrew` and `skills.install.nodeManager`. Hardcoding
 *      brew/npm/pip fails outright on a Linux or Docker deployment.
 *   3. The binary has to land on the gateway's host, which is where the agent
 *      will look for it. That is not necessarily this host.
 *
 * The trade-off is that `skills.install` answers once when it finishes instead
 * of streaming, so output arrives in one batch. The SSE envelope is kept so the
 * client renders it the same way either path is taken.
 */

type SkillsInstallResult = {
  ok?: boolean;
  message?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  warnings?: string[];
};

const INSTALL_TIMEOUT_MS = 285_000;

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const installId = typeof body?.installId === "string" ? body.installId.trim() : "";

  if (!name || !installId) {
    return new Response(
      JSON.stringify({ error: "name and installId are required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const agentId =
    typeof body?.agentId === "string" && body.agentId.trim()
      ? body.agentId.trim()
      : undefined;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: unknown) => {
        try {
          controller.enqueue(encoder.encode(sse(payload)));
        } catch {
          // Client disconnected.
        }
      };

      send({
        type: "stdout",
        text: `\x1b[1;36m$ openclaw skills install ${name} (${installId})\x1b[0m\n`,
      });

      try {
        const result = await gatewayCall<SkillsInstallResult>(
          "skills.install",
          {
            name,
            installId,
            timeoutMs: INSTALL_TIMEOUT_MS,
            ...(agentId ? { agentId } : {}),
          },
          INSTALL_TIMEOUT_MS,
        );

        for (const warning of result.warnings ?? []) {
          send({ type: "stderr", text: `${warning}\n` });
        }
        if (result.stdout) send({ type: "stdout", text: result.stdout });
        if (result.stderr) send({ type: "stderr", text: result.stderr });
        if (result.message) {
          send({
            type: result.ok ? "stdout" : "stderr",
            text: `${result.message}\n`,
          });
        }
        send({ type: "exit", code: result.ok ? 0 : (result.code ?? 1) });
      } catch (err) {
        send({ type: "error", text: String(err) });
      }

      try {
        controller.close();
      } catch {
        // Already closed.
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
