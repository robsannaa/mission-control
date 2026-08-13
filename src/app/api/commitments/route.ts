import { NextRequest, NextResponse } from "next/server";
import {
  answerCommitment,
  dismissCommitments,
  listCommitments,
  sendNudge,
  type Commitment,
} from "@/lib/commitments";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status")?.trim() || "pending";
  try {
    const result = await listCommitments(status);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const action = String(body.action || "");
  try {
    if (action === "dismiss") {
      const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map(String) : [];
      if (ids.length === 0) return NextResponse.json({ error: "ids are required" }, { status: 400 });
      await dismissCommitments(ids);
    } else if (action === "answer") {
      const commitment = body.commitment as Commitment | undefined;
      const answer = String(body.answer || "");
      if (!commitment?.id) return NextResponse.json({ error: "commitment is required" }, { status: 400 });
      if (!answer.trim()) return NextResponse.json({ error: "answer is required" }, { status: 400 });
      await answerCommitment(commitment, answer);
      const result = await listCommitments("pending");
      return NextResponse.json({ ok: true, ...result });
    } else if (action === "send") {
      const commitment = body.commitment as Commitment | undefined;
      if (!commitment?.id) return NextResponse.json({ error: "commitment is required" }, { status: 400 });
      const result = await sendNudge(commitment, Boolean(body.dryRun));
      // After sending, drop the open loop so it doesn't linger.
      if (!body.dryRun) await dismissCommitments([commitment.id]).catch(() => {});
      return NextResponse.json({ ok: true, ...result });
    } else {
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    const result = await listCommitments("pending");
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|no channel|no recipient|no suggested|no session/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
