import { NextRequest, NextResponse } from "next/server";
import {
  constantTimeEquals,
  getAuthMode,
  getAuthToken,
  SESSION_COOKIE,
  sessionValueForToken,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const FAILED_LOGIN_DELAY_MS = 400; // slow down brute-force attempts

function isSecureRequest(request: NextRequest): boolean {
  return (
    request.nextUrl.protocol === "https:" ||
    (request.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim() === "https"
  );
}

export async function POST(request: NextRequest) {
  const mode = getAuthMode();
  if (mode !== "token") {
    return NextResponse.json(
      { ok: false, error: "login_disabled", detail: `Login is not available in "${mode}" mode.` },
      { status: 400 }
    );
  }
  const expected = getAuthToken();
  if (!expected) {
    return NextResponse.json(
      {
        ok: false,
        error: "auth_misconfigured",
        detail: "MISSION_CONTROL_AUTH=token requires MISSION_CONTROL_AUTH_TOKEN to be set.",
      },
      { status: 500 }
    );
  }

  let candidate = "";
  try {
    const body = await request.json();
    candidate = String(body?.token ?? "").trim();
  } catch {
    // fall through with empty candidate
  }

  if (!candidate || !(await constantTimeEquals(candidate, expected))) {
    await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
    return NextResponse.json(
      { ok: false, error: "invalid_token", detail: "The access token is incorrect." },
      { status: 401 }
    );
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: await sessionValueForToken(expected),
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
