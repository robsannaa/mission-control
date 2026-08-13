import { NextRequest, NextResponse } from "next/server";
import { constantTimeEquals, getAuthMode } from "@/lib/auth";
import { reEnableCronIfSettled, requestClarification } from "@/lib/awareness/engine";
import { resolveInteractionScope } from "@/lib/awareness/scope";
import { transitionInteraction } from "@/lib/awareness/store";
import { gatewayCall } from "@/lib/openclaw";

export const dynamic = "force-dynamic";

function loopbackHost(request: NextRequest): boolean {
  try {
    const host = new URL(`http://${request.headers.get("host") || ""}`).hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Machine-to-machine intake used by the OpenClaw awareness plugin. */
export async function POST(request: NextRequest) {
  const configured = String(process.env.MISSION_CONTROL_AWARENESS_TOKEN || "").trim();
  const presented = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

  if (configured) {
    if (!presented || !(await constantTimeEquals(presented, configured))) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
  } else if (getAuthMode() !== "off" || !loopbackHost(request)) {
    return NextResponse.json(
      { error: "MISSION_CONTROL_AWARENESS_TOKEN is required outside loopback local mode" },
      { status: 503 },
    );
  }

  // Tenant/user come from the SERVER, never the request body. (B2)
  const scope = resolveInteractionScope(request);

  try {
    const body = await request.json() as {
      action?: "create" | "complete" | "pause";
      id?: string;
      jobId?: string;
      success?: boolean;
      runId?: string;
      error?: string;
      interaction?: Parameters<typeof requestClarification>[0];
    };
    if (body.action === "pause") {
      if (!body.jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });
      await gatewayCall(
        "cron.update",
        { id: body.jobId, patch: { enabled: false } },
        10_000,
      );
      return NextResponse.json({ ok: true, jobId: body.jobId, schedulePaused: true });
    }
    if (body.action === "complete") {
      if (!body.id) return NextResponse.json({ error: "id is required" }, { status: 400 });
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
    if (!body.interaction) return NextResponse.json({ error: "interaction is required" }, { status: 400 });
    // Overwrite any caller-supplied tenant/user with the server-resolved scope.
    const interaction = await requestClarification({
      ...body.interaction,
      tenantId: scope.tenantId,
      userId: scope.userId,
    });
    return NextResponse.json({ ok: true, interaction }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: /required|characters/i.test(message) ? 400 : 500 });
  }
}
