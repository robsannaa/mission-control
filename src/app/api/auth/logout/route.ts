import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

export const POST = withRoute({ name: "/api/auth/logout" }, async () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
});
