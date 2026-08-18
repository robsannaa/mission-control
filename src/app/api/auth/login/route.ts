import { NextRequest, NextResponse } from "next/server";
import {
  constantTimeEquals,
  getAuthMode,
  getAuthToken,
  SESSION_COOKIE,
  sessionValueForToken,
} from "@/lib/auth";
import { withRoute } from "@/lib/api-route";
import { loginPostSchema } from "@/lib/schemas/auth";

export const dynamic = "force-dynamic";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const FAILED_LOGIN_DELAY_MS = 400; // slow down brute-force attempts

function isSecureRequest(request: NextRequest): boolean {
  return (
    request.nextUrl.protocol === "https:" ||
    (request.headers.get("x-forwarded-proto") || "").split(",")[0]?.trim() === "https"
  );
}

/**
 * Every error body below carries an extra top-level `detail` string that
 * `src/app/login/route.ts`'s client script reads directly (`data.detail`) —
 * the same extra-field precedent as `/api/config`'s 409 conflict body
 * (`.planning/phases/02-server-contract-hardening/02-04-SUMMARY.md`): these
 * responses are built by hand (still `ok: false`) rather than through an
 * `src/lib/api-errors.ts` builder, which has no slot for `detail`.
 *
 * `loginPostSchema` (src/lib/schemas/auth.ts) requires a non-empty `token`
 * before this handler ever runs — a malformed/missing token is rejected with
 * a `details` issue tree BEFORE `constantTimeEquals` is called (T-02-21,
 * this plan's must_haves). A present-but-wrong token still reaches the
 * `constantTimeEquals` branch below and gets the original 401 `invalid_token`
 * body, unchanged (pinned by `e2e/auth.spec.ts`).
 */
export const POST = withRoute(
  { name: "/api/auth/login", bodySchema: loginPostSchema },
  async (request, ctx) => {
    const mode = getAuthMode();
    if (mode !== "token") {
      return NextResponse.json(
        { ok: false, error: "login_disabled", detail: `Login is not available in "${mode}" mode.` },
        { status: 400 },
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
        { status: 500 },
      );
    }

    const candidate = ctx.body.token;

    if (!(await constantTimeEquals(candidate, expected))) {
      await new Promise((resolve) => setTimeout(resolve, FAILED_LOGIN_DELAY_MS));
      return NextResponse.json(
        { ok: false, error: "invalid_token", detail: "The access token is incorrect." },
        { status: 401 },
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
  },
);
