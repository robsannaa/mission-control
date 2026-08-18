import { NextRequest, NextResponse } from "next/server";
import { constantTimeEquals, getAuthMode } from "@/lib/auth";
import { reEnableCronIfSettled, requestClarification } from "@/lib/awareness/engine";
import { resolveInteractionScope } from "@/lib/awareness/scope";
import { transitionInteraction } from "@/lib/awareness/store";
import { gatewayCall } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest, unauthorized } from "@/lib/api-errors";
import { interactionsIntakePostSchema, type InteractionsIntakePostInput } from "@/lib/schemas/workspace";

export const dynamic = "force-dynamic";

function loopbackHost(request: NextRequest): boolean {
  try {
    const host = new URL(`http://${request.headers.get("host") || ""}`).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/**
 * Machine-to-machine intake used by the OpenClaw awareness plugin.
 *
 * `interactionsIntakePostSchema` (src/lib/schemas/workspace.ts) stays a
 * loose optional `action` string — not in this plan's threat register for
 * enumeration, and the Bearer-token check below (not the body shape) is
 * this route's actual authorization boundary. Schema validation still runs
 * before that check (the same `withRoute` ordering already accepted for
 * `POST /api/auth/login` in plan 02-05), but the schema is loose enough
 * that only a genuinely malformed JSON body is affected.
 */
export const POST = withRoute<InteractionsIntakePostInput>(
  { name: "/api/interactions/intake", bodySchema: interactionsIntakePostSchema },
  async (request: NextRequest, ctx) => {
  const configured = String(process.env.MISSION_CONTROL_AWARENESS_TOKEN || "").trim();
  const presented = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

  if (configured) {
    if (!presented || !(await constantTimeEquals(presented, configured))) {
      return unauthorized("unauthorized");
    }
  } else if (getAuthMode() !== "off" || !loopbackHost(request)) {
    return apiError("MISSION_CONTROL_AWARENESS_TOKEN is required outside loopback local mode", 503);
  }

  // Tenant/user come from the SERVER, never the request body. (B2)
  const scope = resolveInteractionScope(request);

  try {
    const body = ctx.body as {
      action?: "create" | "complete" | "pause";
      id?: string;
      jobId?: string;
      success?: boolean;
      runId?: string;
      error?: string;
      interaction?: Parameters<typeof requestClarification>[0];
    };
    if (body.action === "pause") {
      if (!body.jobId) return badRequest("jobId is required");
      await gatewayCall(
        "cron.update",
        { id: body.jobId, patch: { enabled: false } },
        10_000,
      );
      return NextResponse.json({ ok: true, jobId: body.jobId, schedulePaused: true });
    }
    if (body.action === "complete") {
      if (!body.id) return badRequest("id is required");
      const interaction = await transitionInteraction({
        id: body.id,
        tenantId: scope.tenantId,
        status: body.success === false ? "failed" : "completed",
        detail: {
          resumedRunId: body.runId || undefined,
          error: body.error || undefined,
        },
      });
      // The resumed run has truly ended — re-enable the cron schedule unless the
      // run raised a fresh question (then it stays paused for that one). H1/H2.
      await reEnableCronIfSettled(interaction);
      return NextResponse.json({ ok: true, interaction });
    }
    if (!body.interaction) return badRequest("interaction is required");
    // Bug fix 2026-08-16: validate `source` before delegating. Without it, the
    // awareness engine throws "Cannot read properties of undefined (reading
    // 'runId')" and surfaces as a generic 500. Surface a precise 400 instead.
    if (!body.interaction.source || typeof body.interaction.source !== "object") {
      return badRequest("interaction.source is required (kind, id, label, and optional sessionKey/agentId)");
    }
    // Overwrite any caller-supplied tenant/user with the server-resolved scope.
    const interaction = await requestClarification({
      ...body.interaction,
      tenantId: scope.tenantId,
      userId: scope.userId,
      runId: body.runId,
    });
    return NextResponse.json({ ok: true, interaction }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Bug fix 2026-08-16: extend the client-error heuristic so the new
    // `validateQuestion` messages (type checks, NUL-byte checks) surface as
    // 400 instead of 500. Matches: "required", "characters", "must be a string",
    // "must not contain", "must start with", "must contain only".
    const isClientError =
      /required|characters|must be a string|must not contain|must start with|must contain only/i.test(message);
    return apiError(message, isClientError ? 400 : 500);
  }
  },
);
