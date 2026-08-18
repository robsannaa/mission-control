import { NextResponse } from "next/server";
import {
  getAuthMode,
  getAuthToken,
  getProxySecret,
  hasValidProxySecret,
  hasValidSession,
  PROXY_SECRET_HEADER,
  PROXY_USER_HEADER,
  SESSION_COOKIE,
} from "@/lib/auth";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

export const GET = withRoute({ name: "/api/auth/status" }, async (request) => {
  const mode = getAuthMode();

  if (mode === "token") {
    const authenticated = await hasValidSession(request.cookies.get(SESSION_COOKIE)?.value);
    return NextResponse.json({
      ok: true,
      mode,
      configured: Boolean(getAuthToken()),
      authenticated,
      user: null,
    });
  }

  if (mode === "trusted-proxy") {
    const authenticated =
      (await hasValidProxySecret(request.headers.get(PROXY_SECRET_HEADER))) &&
      Boolean((request.headers.get(PROXY_USER_HEADER) || "").trim());
    return NextResponse.json({
      ok: true,
      mode,
      configured: Boolean(getProxySecret()),
      authenticated,
      user: authenticated ? (request.headers.get(PROXY_USER_HEADER) || "").trim() : null,
    });
  }

  return NextResponse.json({ ok: true, mode, configured: true, authenticated: true, user: null });
});
