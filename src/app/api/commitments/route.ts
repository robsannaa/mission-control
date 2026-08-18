import { NextRequest, NextResponse } from "next/server";
import {
  answerCommitment,
  dismissCommitments,
  listCommitments,
  sendNudge,
  type Commitment,
} from "@/lib/commitments";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest, serverError } from "@/lib/api-errors";
import {
  commitmentsGetQuerySchema,
  commitmentsPostSchema,
  type CommitmentsGetQuery,
  type CommitmentsPostInput,
} from "@/lib/schemas/workspace";

export const dynamic = "force-dynamic";

export const GET = withRoute<unknown, CommitmentsGetQuery>(
  { name: "/api/commitments", querySchema: commitmentsGetQuerySchema },
  async (_request: NextRequest, ctx) => {
  const status = ctx.query.status?.trim() || "pending";
  try {
    const result = await listCommitments(status);
    return NextResponse.json(result);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : String(error));
  }
  },
);

export const POST = withRoute<CommitmentsPostInput>(
  { name: "/api/commitments", bodySchema: commitmentsPostSchema },
  async (_request: NextRequest, ctx) => {
  const body = ctx.body as Record<string, unknown>;
  const action = String(body.action || "");
  try {
    if (action === "dismiss") {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : [];
      if (ids.length === 0) return badRequest("ids are required");
      await dismissCommitments(ids);
    } else if (action === "answer") {
      const commitment = body.commitment as Commitment | undefined;
      const answer = String(body.answer || "");
      if (!commitment?.id) return badRequest("commitment is required");
      if (!answer.trim()) return badRequest("answer is required");
      await answerCommitment(commitment, answer);
      const result = await listCommitments("pending");
      return NextResponse.json({ ok: true, ...result });
    } else if (action === "send") {
      const commitment = body.commitment as Commitment | undefined;
      if (!commitment?.id) return badRequest("commitment is required");
      const result = await sendNudge(commitment, Boolean(body.dryRun));
      // After sending, drop the open loop so it doesn't linger.
      if (!body.dryRun) await dismissCommitments([commitment.id]).catch(() => {});
      return NextResponse.json({ ok: true, ...result });
    } else {
      return badRequest(`Unknown action: ${action}`);
    }
    const result = await listCommitments("pending");
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|no channel|no recipient|no suggested|no session/i.test(message) ? 400 : 500;
    return apiError(message, status);
  }
  },
);
