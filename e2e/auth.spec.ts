import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Auth gate e2e — request-style API specs for the Mission Control middleware
 * (src/middleware.ts) across its three deployment modes:
 *
 *   off           → no login, but Origin/Host allowlist still enforced
 *   token         → login page + httpOnly session cookie, 401 without it
 *   trusted-proxy → x-mission-control-proxy-secret + x-mission-control-user
 *
 * Each mode spawns its own `next dev` server on port 3190. The server runs
 * from a sandbox directory (src copied, node_modules/config symlinked) so the
 * spec also works while another `next dev` holds the repo's .next/dev/lock.
 */

const PORT = 3190;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = "auth-spec-test-token";
const PROXY_SECRET = "auth-spec-proxy-secret";
const PROXY_SECRET_HEADER = "x-mission-control-proxy-secret";
const PROXY_USER_HEADER = "x-mission-control-user";
const REPO_ROOT = path.resolve(__dirname, "..");
const STARTUP_TIMEOUT_MS = 180_000;

let sandboxDir = "";
let server: ChildProcess | null = null;

function prepareSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-auth-spec-"));
  const symlinked = [
    "node_modules",
    "public",
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "postcss.config.mjs",
    "components.json",
    "next-env.d.ts",
    "instrumentation.ts",
  ];
  for (const entry of symlinked) {
    const target = path.join(REPO_ROOT, entry);
    if (fs.existsSync(target)) fs.symlinkSync(target, path.join(dir, entry));
  }
  // src must be a real copy — Next's route discovery skips symlinked app dirs.
  fs.cpSync(path.join(REPO_ROOT, "src"), path.join(dir, "src"), { recursive: true });
  return dir;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function statusBody(extraHeaders: Record<string, string> = {}): Promise<{
  mode?: string;
  authenticated?: boolean;
  user?: string | null;
} | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`${BASE}/api/auth/status`, {
      headers: extraHeaders,
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as { mode?: string; authenticated?: boolean; user?: string | null };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function startServer(env: Record<string, string>, expectedMode: string) {
  sandboxDir = prepareSandbox();
  const nextBin = path.join(REPO_ROOT, "node_modules", ".bin", "next");
  server = spawn(nextBin, ["dev", "-H", "127.0.0.1", "-p", String(PORT), "--webpack"], {
    cwd: sandboxDir,
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(
    async () => (await statusBody(env.MISSION_CONTROL_AUTH === "trusted-proxy"
      ? { [PROXY_SECRET_HEADER]: PROXY_SECRET, [PROXY_USER_HEADER]: "spec@example.com" }
      : {}))?.mode === expectedMode,
    STARTUP_TIMEOUT_MS,
    `next dev on :${PORT} in "${expectedMode}" mode`
  );
}

async function stopServer() {
  const proc = server;
  server = null;
  if (proc?.pid) {
    const exited = new Promise<void>((resolve) => {
      proc.once("exit", () => resolve());
      setTimeout(resolve, 10_000);
    });
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await exited;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  await waitFor(async () => !(await portOpen()), 15_000, "port to free").catch(() => {});
  if (sandboxDir) {
    // Retry: the killed server may still be flushing .next writes.
    fs.rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    sandboxDir = "";
  }
}

async function portOpen(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${BASE}/api/auth/status`, { signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

test.describe.configure({ mode: "serial" });

/* ── off mode (default): passthrough + Origin/Host validation ─────────── */

test.describe("auth gate — off mode", () => {
  test.beforeAll(async () => {
    test.setTimeout(STARTUP_TIMEOUT_MS + 60_000);
    await startServer(
      { MISSION_CONTROL_ALLOWED_HOSTS: "mc.example.com, lab.local:8443" },
      "off"
    );
  });
  test.afterAll(async () => {
    await stopServer();
  });

  test("requests pass through without any credential", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/status`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "off", authenticated: true });
    // A nonexistent API path reaches the router (404), not an auth wall.
    const probe = await request.get(`${BASE}/api/__mc-auth-probe`);
    expect(probe.status()).toBe(404);
  });

  test("rejects a non-allowlisted Host header with 403 JSON (DNS rebinding)", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/status`, {
      headers: { Host: "evil.example.com" },
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "forbidden_host" });
  });

  test("rejects a non-allowlisted Origin header with 403 JSON", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/status`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status()).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: "forbidden_origin" });
  });

  test("rejects a null Origin", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/status`, { headers: { Origin: "null" } });
    expect(res.status()).toBe(403);
  });

  test("allows localhost origins on any port", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/status`, {
      headers: { Origin: `http://localhost:${PORT}` },
    });
    expect(res.status()).toBe(200);
  });

  test("MISSION_CONTROL_ALLOWED_HOSTS extends the allowlist", async ({ request }) => {
    const anyPort = await request.get(`${BASE}/api/auth/status`, {
      headers: { Host: "mc.example.com" },
    });
    expect(anyPort.status()).toBe(200);
    const rightPort = await request.get(`${BASE}/api/auth/status`, {
      headers: { Host: "lab.local:8443" },
    });
    expect(rightPort.status()).toBe(200);
    const wrongPort = await request.get(`${BASE}/api/auth/status`, {
      headers: { Host: "lab.local:9999" },
    });
    expect(wrongPort.status()).toBe(403);
  });

  test("login page redirects home when auth is off", async ({ request }) => {
    const res = await request.get(`${BASE}/login`, { maxRedirects: 0 });
    expect([302, 307, 308]).toContain(res.status());
    expect(res.headers()["location"]).toContain("/");
  });
});

/* ── token mode: login flow, session cookie, 401 without it ───────────── */

test.describe("auth gate — token mode", () => {
  test.beforeAll(async () => {
    test.setTimeout(STARTUP_TIMEOUT_MS + 60_000);
    await startServer(
      { MISSION_CONTROL_AUTH: "token", MISSION_CONTROL_AUTH_TOKEN: TOKEN },
      "token"
    );
  });
  test.afterAll(async () => {
    await stopServer();
  });

  test("API requests without a session cookie get 401 JSON", async ({ request }) => {
    const res = await request.get(`${BASE}/api/__mc-auth-probe`);
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "unauthorized" });
  });

  test("page requests without a session redirect to /login", async ({ request }) => {
    const res = await request.get(`${BASE}/sessions`, { maxRedirects: 0 });
    expect([302, 307]).toContain(res.status());
    expect(res.headers()["location"]).toContain("/login");
    expect(res.headers()["location"]).toContain("next=%2Fsessions");
  });

  test("login page is served without a session", async ({ request }) => {
    const res = await request.get(`${BASE}/login`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    expect(await res.text()).toContain("Mission Control");
  });

  test("login with a wrong token is rejected", async ({ request }) => {
    const res = await request.post(`${BASE}/api/auth/login`, { data: { token: "wrong-token" } });
    expect(res.status()).toBe(401);
    expect(await res.json()).toMatchObject({ ok: false, error: "invalid_token" });
  });

  test("login with the right token sets an httpOnly cookie that unlocks the API", async ({
    playwright,
  }) => {
    const context = await playwright.request.newContext({ baseURL: BASE });
    const login = await context.post("/api/auth/login", { data: { token: TOKEN } });
    expect(login.status()).toBe(200);
    const setCookie = login.headers()["set-cookie"] || "";
    expect(setCookie).toContain("mission_control_session=");
    expect(setCookie.toLowerCase()).toContain("httponly");
    expect(setCookie).not.toContain(TOKEN); // cookie is derived, never the raw token

    // Cookie jar carries the session: API + status now authenticated.
    const probe = await context.get("/api/__mc-auth-probe");
    expect(probe.status()).toBe(404); // through the gate, into the router
    const status = await context.get("/api/auth/status");
    expect(await status.json()).toMatchObject({ mode: "token", authenticated: true });

    // Logout clears the session.
    const logout = await context.post("/api/auth/logout");
    expect(logout.status()).toBe(200);
    const after = await context.get("/api/__mc-auth-probe");
    expect(after.status()).toBe(401);
    await context.dispose();
  });

  test("asset-extension API paths do not bypass auth, but public assets load", async ({
    request,
  }) => {
    const sneaky = await request.get(`${BASE}/api/usage/providers/sneaky.svg`);
    expect(sneaky.status()).toBe(401);
    const asset = await request.get(`${BASE}/next.svg`);
    expect(asset.status()).toBe(200);
  });

  test("origin allowlist still enforced in token mode", async ({ request }) => {
    const res = await request.get(`${BASE}/api/auth/status`, {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status()).toBe(403);
  });
});

/* ── trusted-proxy mode: platform headers, no login page ──────────────── */

test.describe("auth gate — trusted-proxy mode", () => {
  test.beforeAll(async () => {
    test.setTimeout(STARTUP_TIMEOUT_MS + 60_000);
    await startServer(
      { MISSION_CONTROL_AUTH: "trusted-proxy", MISSION_CONTROL_PROXY_SECRET: PROXY_SECRET },
      "trusted-proxy"
    );
  });
  test.afterAll(async () => {
    await stopServer();
  });

  const validHeaders = {
    [PROXY_SECRET_HEADER]: PROXY_SECRET,
    [PROXY_USER_HEADER]: "owner@example.com",
  };

  test("requests without proxy headers get 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/__mc-auth-probe`);
    expect(res.status()).toBe(401);
    const page = await request.get(`${BASE}/`, { maxRedirects: 0 });
    expect(page.status()).toBe(401);
  });

  test("a wrong proxy secret gets 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/__mc-auth-probe`, {
      headers: { ...validHeaders, [PROXY_SECRET_HEADER]: "wrong-secret" },
    });
    expect(res.status()).toBe(401);
  });

  test("a valid secret without a user header gets 401", async ({ request }) => {
    const res = await request.get(`${BASE}/api/__mc-auth-probe`, {
      headers: { [PROXY_SECRET_HEADER]: PROXY_SECRET },
    });
    expect(res.status()).toBe(401);
    expect((await res.json()).detail).toContain(PROXY_USER_HEADER);
  });

  test("valid proxy headers unlock API and pages under the platform host", async ({ request }) => {
    const probe = await request.get(`${BASE}/api/__mc-auth-probe`, { headers: validHeaders });
    expect(probe.status()).toBe(404); // through the gate, into the router
    const status = await request.get(`${BASE}/api/auth/status`, {
      headers: { ...validHeaders, Host: "agentbay.example.com" },
    });
    expect(status.status()).toBe(200);
    expect(await status.json()).toMatchObject({
      mode: "trusted-proxy",
      authenticated: true,
      user: "owner@example.com",
    });
  });

  test("no login page in trusted-proxy mode", async ({ request }) => {
    const res = await request.get(`${BASE}/login`, {
      headers: validHeaders,
      maxRedirects: 0,
    });
    expect([302, 307, 308]).toContain(res.status());
  });
});
