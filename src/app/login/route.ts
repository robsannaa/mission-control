import { NextRequest, NextResponse } from "next/server";
import { getAuthMode, hasValidSession, SESSION_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";

/**
 * /login — token-mode sign-in screen.
 *
 * Served as a route handler (not a page.tsx) on purpose: the root app layout
 * wraps every React page in the dashboard chrome and <SetupGate>, whose
 * /api/onboard probe is (correctly) rejected with 401 before sign-in, which
 * would block a page-based login screen from ever rendering. A standalone
 * HTML response keeps the login flow dependency-free: no gateway, no session,
 * no layout — it works even when everything else is locked down.
 *
 * The "next" redirect target is read client-side and validated to a
 * same-origin absolute path; no request input is interpolated into the HTML.
 */

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Sign in — Mission Control</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fafaf9;
    --halo-a: rgba(16, 185, 129, 0.14);
    --halo-b: rgba(16, 185, 129, 0.05);
    --card-bg: #ffffff;
    --card-border: #e7e5e4;
    --text: #1c1917;
    --muted: #78716c;
    --input-bg: #ffffff;
    --input-border: #d6d3d1;
    --input-text: #1c1917;
    --accent: #059669;
    --accent-hover: #047857;
    --accent-ring: rgba(5, 150, 105, 0.25);
    --error: #dc2626;
    --shadow: 0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #101214;
      --halo-a: rgba(52, 211, 153, 0.09);
      --halo-b: rgba(52, 211, 153, 0.03);
      --card-bg: #171a1d;
      --card-border: #2c343d;
      --text: #f5f7fa;
      --muted: #8e98a3;
      --input-bg: #101214;
      --input-border: #2c343d;
      --input-text: #f5f7fa;
      --accent: #10b981;
      --accent-hover: #34d399;
      --accent-ring: rgba(16, 185, 129, 0.3);
      --error: #f87171;
      --shadow: 0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.5);
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    background: var(--bg);
    background-image: radial-gradient(48rem 32rem at 50% -8rem, var(--halo-a), transparent 70%),
                      radial-gradient(36rem 24rem at 85% 110%, var(--halo-b), transparent 70%);
    color: var(--text);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%;
    max-width: 22rem;
    background: var(--card-bg);
    border: 1px solid var(--card-border);
    border-radius: 1rem;
    box-shadow: var(--shadow);
    padding: 2rem;
    animation: rise 0.35s cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes rise {
    from { opacity: 0; transform: translateY(0.5rem); }
    to { opacity: 1; transform: none; }
  }
  .mark {
    width: 2.5rem;
    height: 2.5rem;
    border-radius: 0.75rem;
    background: linear-gradient(135deg, #10b981, #047857);
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1.25rem;
    box-shadow: 0 4px 12px var(--accent-ring);
  }
  .mark svg { width: 1.25rem; height: 1.25rem; stroke: #fff; }
  h1 { font-size: 1.05rem; font-weight: 600; letter-spacing: -0.01em; }
  .sub { margin-top: 0.35rem; font-size: 0.8rem; line-height: 1.45; color: var(--muted); }
  form { margin-top: 1.5rem; display: grid; gap: 0.75rem; }
  label {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  input[type="password"] {
    width: 100%;
    height: 2.5rem;
    padding: 0 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--input-border);
    background: var(--input-bg);
    color: var(--input-text);
    font-size: 0.875rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input[type="password"]:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-ring);
  }
  button {
    height: 2.5rem;
    border: 0;
    border-radius: 0.5rem;
    background: var(--accent);
    color: #fff;
    font-size: 0.875rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s, opacity 0.15s;
  }
  button:hover { background: var(--accent-hover); }
  button:disabled { opacity: 0.6; cursor: default; }
  .error {
    display: none;
    font-size: 0.78rem;
    line-height: 1.4;
    color: var(--error);
  }
  .error.visible { display: block; animation: rise 0.2s ease-out; }
  .hint { margin-top: 1.25rem; font-size: 0.72rem; line-height: 1.5; color: var(--muted); }
  .hint code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem;
    background: color-mix(in srgb, var(--muted) 12%, transparent);
    border-radius: 0.25rem;
    padding: 0.1rem 0.3rem;
  }
</style>
</head>
<body>
  <main class="card">
    <div class="mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z" />
      </svg>
    </div>
    <h1>Mission Control</h1>
    <p class="sub">This dashboard is protected. Enter the access token to continue.</p>
    <form id="login-form" autocomplete="off">
      <label for="token">Access token</label>
      <input id="token" name="token" type="password" autocomplete="current-password" autofocus required placeholder="••••••••••••••••" />
      <p id="error" class="error" role="alert"></p>
      <button id="submit" type="submit">Unlock dashboard</button>
    </form>
    <p class="hint">The token is set by the operator via <code>MISSION_CONTROL_AUTH_TOKEN</code> on the Mission Control host.</p>
  </main>
  <script>
    (function () {
      var form = document.getElementById("login-form");
      var input = document.getElementById("token");
      var button = document.getElementById("submit");
      var error = document.getElementById("error");

      function safeNext() {
        var next = new URLSearchParams(location.search).get("next") || "/";
        // Same-origin absolute paths only ("/foo", never "//host" or URLs).
        return /^\\/(?!\\/)/.test(next) ? next : "/";
      }

      function showError(message) {
        error.textContent = message;
        error.classList.add("visible");
      }

      form.addEventListener("submit", async function (event) {
        event.preventDefault();
        var token = input.value.trim();
        if (!token) return;
        button.disabled = true;
        button.textContent = "Checking\\u2026";
        error.classList.remove("visible");
        try {
          var res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: token }),
          });
          if (res.ok) {
            button.textContent = "Welcome back";
            location.replace(safeNext());
            return;
          }
          var data = await res.json().catch(function () { return {}; });
          showError(
            data && data.error === "invalid_token"
              ? "That token is not correct. Check it and try again."
              : (data && data.detail) || "Sign-in failed. Try again."
          );
        } catch {
          showError("Could not reach the server. Try again.");
        }
        button.disabled = false;
        button.textContent = "Unlock dashboard";
        input.select();
      });
    })();
  </script>
</body>
</html>`;

export async function GET(request: NextRequest) {
  const mode = getAuthMode();
  // The login page only exists in token mode; elsewhere go straight home.
  if (mode !== "token") {
    return NextResponse.redirect(new URL("/", request.url));
  }
  // Already signed in — no need to show the form again.
  if (await hasValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  return new NextResponse(LOGIN_PAGE, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
