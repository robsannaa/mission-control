import { NextRequest, NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";

export const dynamic = "force-dynamic";

type Session = {
  key: string;
  kind: string;
  updatedAt?: number | string | null;
  ageMs?: number | string | null;
  sessionId: string;
  inputTokens?: number | string | null;
  outputTokens?: number | string | null;
  totalTokens?: number | string | null;
  model?: string | null;
  contextTokens?: number | string | null;
  [key: string]: unknown;
};

function toEpochMs(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return null;
  if (num <= 0) return null;
  // Accept seconds-based timestamps and normalize to milliseconds.
  return num < 1_000_000_000_000 ? Math.trunc(num * 1000) : Math.trunc(num);
}

function toNonNegativeNumber(value: unknown, fallback = 0): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) return fallback;
  return num;
}

export async function GET() {
  try {
    const data = await gatewayCall<{
      count: number;
      sessions: Session[];
      defaults: Record<string, unknown>;
    }>("sessions.list");
    const now = Date.now();
    const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
    const sessions = rawSessions
      .map((session) => {
        const updatedAt = toEpochMs(session.updatedAt);
        const rawAgeMs = toNonNegativeNumber(session.ageMs, -1);
        const computedAgeMs =
          updatedAt !== null ? Math.max(0, now - updatedAt) : 0;
        const ageMs = rawAgeMs >= 0 ? rawAgeMs : computedAgeMs;

        return {
          ...session,
          updatedAt: updatedAt ?? 0,
          ageMs,
          inputTokens: toNonNegativeNumber(session.inputTokens),
          outputTokens: toNonNegativeNumber(session.outputTokens),
          totalTokens: toNonNegativeNumber(session.totalTokens),
          contextTokens: toNonNegativeNumber(session.contextTokens),
          model: String(session.model || "unknown"),
        };
      })
      .sort((a, b) => (b.updatedAt as number) - (a.updatedAt as number));

    return NextResponse.json({
      ...data,
      count: sessions.length,
      sessions,
    });
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    console.error("Sessions GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const key = searchParams.get("key");
    if (!key) {
      return NextResponse.json({ error: "session key required" }, { status: 400 });
    }

    const result = await gatewayCall<{
      ok: boolean;
      key: string;
      deleted: boolean;
      archived: string[];
    }>("sessions.delete", { key });

    return NextResponse.json(result);
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    console.error("Sessions DELETE error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
