import { NextRequest, NextResponse } from "next/server";
import {
  getAuthMode,
  getAuthToken,
  getProxySecret,
  hasValidProxySecret,
  hasValidSession,
  isAllowedHost,
  isAllowedOrigin,
  PROXY_SECRET_HEADER,
  PROXY_USER_HEADER,
  SESSION_COOKIE,
} from "@/lib/auth";

/**
 * Mission Control auth gate.
 *
 * Every page and API route passes through here except Next static assets and
 * /api/usage/internal (which enforces its own webhook token). The gate only
 * inspects headers and cookies — it never touches request/response bodies, so
 * SSE streams (/api/chat/stream, /api/terminal) and the browser relay proxy
 * pass through untouched once authenticated.
 *
 * See docs/DEPLOYMENT.md for the three deployment modes.
 */

/** Paths that skip the auth check (host/origin validation still applies). */
function isAuthExempt(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/api/auth/");
}

/** Paths that skip the gate entirely — they carry their own auth. */
function isFullyExempt(pathname: string): boolean {
  return pathname.startsWith("/api/usage/internal");
}

/** Public static assets (never under /api/ — a dynamic API segment could end
 *  in ".svg" and must not slip past the gate). */
const STATIC_ASSET = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|map|txt|woff2?)$/i;

function isStaticAsset(pathname: string): boolean {
  return !pathname.startsWith("/api/") && STATIC_ASSET.test(pathname);
}

function forbidden(reason: string, detail: string) {
  return NextResponse.json({ ok: false, error: reason, detail }, { status: 403 });
}

function unauthorized(detail: string) {
  return NextResponse.json({ ok: false, error: "unauthorized", detail }, { status: 401 });
}

function misconfigured(detail: string) {
  return NextResponse.json({ ok: false, error: "auth_misconfigured", detail }, { status: 500 });
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isFullyExempt(pathname) || isStaticAsset(pathname)) return NextResponse.next();

  const mode = getAuthMode();

  // ── Trusted-proxy mode ──────────────────────────────────────────────────
  // The upstream identity-aware proxy is the trust boundary (it authenticates
  // the owner and fronts the only network path here), so the shared secret it
  // injects replaces the Origin/Host allowlist — mirroring how OpenClaw's own
  // trusted-proxy mode replaces origin checks with gateway.trustedProxies.
  if (mode === "trusted-proxy") {
    if (!getProxySecret()) {
      return misconfigured(
        "MISSION_CONTROL_AUTH=trusted-proxy requires MISSION_CONTROL_PROXY_SECRET to be set."
      );
    }
    if (!(await hasValidProxySecret(request.headers.get(PROXY_SECRET_HEADER)))) {
      return unauthorized(`Missing or invalid ${PROXY_SECRET_HEADER} header.`);
    }
    if (!(request.headers.get(PROXY_USER_HEADER) || "").trim()) {
      return unauthorized(`Missing ${PROXY_USER_HEADER} header identifying the owner.`);
    }
    // No login page in this mode — the platform already authenticated the owner.
    if (pathname === "/login") {
      return NextResponse.redirect(new URL("/", request.url));
    }
    return NextResponse.next();
  }

  // ── Origin/Host allowlist (off + token modes) ───────────────────────────
  // Kills DNS rebinding: a page on attacker.example that resolves to
  // 127.0.0.1 still sends "Host: attacker.example" and is rejected here.
  if (!isAllowedHost(request.headers.get("host"))) {
    return forbidden(
      "forbidden_host",
      "Host is not allowlisted. Add it to MISSION_CONTROL_ALLOWED_HOSTS (comma-separated) to allow it."
    );
  }
  if (!isAllowedOrigin(request.headers.get("origin"))) {
    return forbidden(
      "forbidden_origin",
      "Origin is not allowlisted. Add it to MISSION_CONTROL_ALLOWED_HOSTS (comma-separated) to allow it."
    );
  }

  // ── Off mode: host/origin validation only ───────────────────────────────
  if (mode === "off") return NextResponse.next();

  // ── Token mode ──────────────────────────────────────────────────────────
  if (isAuthExempt(pathname)) return NextResponse.next();

  if (!getAuthToken()) {
    return misconfigured(
      "MISSION_CONTROL_AUTH=token requires MISSION_CONTROL_AUTH_TOKEN to be set."
    );
  }

  if (await hasValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return unauthorized("Sign in at /login to obtain a session cookie.");
  }

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next internals and well-known public assets. API routes
  // are matched; SSE/streaming routes flow through untouched (headers-only
  // checks). Extension-based assets are exempted in code (isStaticAsset) so
  // "/api/thing.svg" cannot slip past the gate.
  matcher: ["/((?!_next/|favicon\\.ico|manifest\\.json|sw\\.js|icons/).*)"],
};
