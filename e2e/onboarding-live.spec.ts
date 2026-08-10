/**
 * Onboarding wizard — full UI walkthrough against a real, sandboxed gateway.
 *
 * Uses the sandbox pattern from auth.spec.ts / config-doctor.spec.ts: a
 * throwaway `next dev` (src copied, node_modules/config symlinked) so the
 * spec works alongside the shared :3100 dev server, PLUS a real OpenClaw
 * gateway run in the foreground against a temp OPENCLAW_HOME:
 *
 *   OPENCLAW_HOME=<mktemp>  openclaw gateway run --port 18850
 *     --allow-unconfigured --token <test-token>
 *
 * `gateway run` (not `gateway start`/`--install-daemon`) is deliberate: it
 * never touches launchd/systemd or any state outside the temp home, so it is
 * safe to run on a machine that also hosts the owner's real gateway. The
 * spawned Mission Control instance runs with AGENTBAY_HOSTED=true for the
 * same reason — it makes the fresh-machine bootstrap this spec exercises
 * take the no-daemon branch (see src/app/api/onboarding/_lib/bootstrap.ts),
 * which was the branch safe to verify by automation. The daemon-install
 * branch (`--install-daemon`, non-hosted) was verified once by hand in a
 * sandbox instead — see the audit report for that run's output.
 *
 * Neither process ever sets OPENCLAW_STATE_DIR and neither is pointed at the
 * real $HOME: the suite asserts the real ~/.openclaw/openclaw.json checksum
 * is unchanged before and after the run.
 */

import { test, expect, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PORT = 3196;
const BASE = `http://127.0.0.1:${PORT}`;
const GATEWAY_PORT = 18850;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;
const GATEWAY_TOKEN = "onboarding-live-spec-token";
const REPO_ROOT = path.resolve(__dirname, "..");
const STARTUP_TIMEOUT_MS = 180_000;
const REAL_HOME = os.homedir();
const REAL_CONFIG_PATH = path.join(REAL_HOME, ".openclaw", "openclaw.json");

function sha256OfFile(p: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
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

/* ── Sandbox gateway: temp OPENCLAW_HOME, foreground, never installed ──── */

let gatewayHome = "";
let gatewayProc: ChildProcess | null = null;

async function startSandboxGateway() {
  gatewayHome = fs.mkdtempSync(path.join(os.tmpdir(), "mc-onboarding-live-gw-"));
  const openclawBin = process.env.OPENCLAW_BIN || "openclaw";
  gatewayProc = spawn(
    openclawBin,
    ["gateway", "run", "--port", String(GATEWAY_PORT), "--allow-unconfigured", "--token", GATEWAY_TOKEN],
    {
      cwd: gatewayHome,
      // OPENCLAW_HOME only — never OPENCLAW_STATE_DIR. Setting STATE_DIR
      // makes the CLI's legacy-state migration read from the REAL $HOME as
      // its migration source (verified live); OPENCLAW_HOME does not.
      env: { ...process.env, OPENCLAW_HOME: gatewayHome, OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN },
      stdio: "ignore",
      detached: true,
    },
  );
  await waitFor(
    async () => {
      const res = await fetch(`${GATEWAY_URL}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    },
    STARTUP_TIMEOUT_MS,
    `sandboxed openclaw gateway on :${GATEWAY_PORT}`,
  );
}

async function stopSandboxGateway() {
  const proc = gatewayProc;
  gatewayProc = null;
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
  if (gatewayHome) {
    fs.rmSync(gatewayHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    gatewayHome = "";
  }
}

/* ── Sandbox Mission Control: throwaway next dev, src copied ───────────── */

let sandboxDir = "";
let server: ChildProcess | null = null;

function prepareSandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-onboarding-live-app-"));
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

async function startApp() {
  sandboxDir = prepareSandbox();
  const nextBin = path.join(REPO_ROOT, "node_modules", ".bin", "next");
  server = spawn(nextBin, ["dev", "-H", "127.0.0.1", "-p", String(PORT), "--webpack"], {
    cwd: sandboxDir,
    env: {
      ...process.env,
      OPENCLAW_HOME: gatewayHome,
      OPENCLAW_GATEWAY_URL: GATEWAY_URL,
      OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
      // See the file header for why: this keeps the bootstrap this spec
      // triggers on the no-daemon branch.
      AGENTBAY_HOSTED: "true",
      NEXT_PUBLIC_AGENTBAY_HOSTED: "true",
    },
    stdio: "ignore",
    detached: true,
  });
  await waitFor(
    async () => {
      const res = await fetch(`${BASE}/api/onboard`, { signal: AbortSignal.timeout(3000) });
      return res.ok;
    },
    STARTUP_TIMEOUT_MS,
    `next dev on :${PORT}`,
  );
}

async function stopApp() {
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
  if (sandboxDir) {
    fs.rmSync(sandboxDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    sandboxDir = "";
  }
}

/* ── UI helpers ──────────────────────────────────────────────────────── */

async function resetOnboardingState(page: Page) {
  await page.request.delete(`${BASE}/api/onboarding/state`);
}

test.describe.configure({ mode: "serial" });

test.describe("onboarding wizard — fresh sandboxed gateway @live @ui", () => {
  let realConfigChecksumBefore: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(STARTUP_TIMEOUT_MS + 60_000);
    realConfigChecksumBefore = sha256OfFile(REAL_CONFIG_PATH);
    await startSandboxGateway();
    await startApp();
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await stopApp();
    await stopSandboxGateway();
    // The whole point of the sandbox pattern: the owner's real gateway config
    // must be byte-for-byte unchanged after this spec runs.
    const after = sha256OfFile(REAL_CONFIG_PATH);
    expect(after).toBe(realConfigChecksumBefore);
  });

  test("a config-less machine reports installed but unconfigured", async ({ request }) => {
    const res = await request.get(`${BASE}/api/onboard`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.installed).toBe(true);
    expect(body.gatewayRunning).toBe(true);
    expect(body.hasModel).toBe(false);
    expect(body.hasApiKey).toBe(false);
  });

  test("fresh-machine bootstrap: starting the gateway from nothing creates a working config", async ({
    request,
  }) => {
    // Before: no openclaw.json exists anywhere under the sandbox home yet.
    const configPath = path.join(gatewayHome, ".openclaw", "openclaw.json");
    expect(fs.existsSync(configPath)).toBe(false);

    const res = await request.post(`${BASE}/api/onboarding/detect`, { data: { action: "start" } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.running).toBe(true);

    // After: bootstrap created a real config, and the gateway (which was
    // already running via --allow-unconfigured) picked it up without ever
    // needing `gateway start`/a daemon.
    expect(fs.existsSync(configPath)).toBe(true);
    const detect = await request.get(`${BASE}/api/onboarding/detect`);
    expect((await detect.json()).running).toBe(true);
  });

  // One continuous flow, one page — Playwright gives every top-level test()
  // its own fresh page, but each of these steps depends on wizard state the
  // previous step left behind, so they run as test.step()s inside a single
  // test instead of pretending to be independent.
  test("wizard walkthrough: honest validation end to end, then the skip-loop stays fixed", async ({
    page,
  }) => {
    await test.step("renders and the gateway step is healthy immediately (hosted: auto-passed)", async () => {
      await resetOnboardingState(page);
      await page.goto(BASE, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Get started" }).click();
      await expect(page.getByText("Connect an AI model")).toBeVisible({ timeout: 15_000 });
      const stepLabels = await page.locator("span.uppercase").allTextContents();
      expect(stepLabels).not.toContain("GATEWAY");
    });

    await test.step("OpenRouter validation is honest: a garbage key is rejected, never 'Verified'", async () => {
      const keyInput = page.locator('input[placeholder="sk-or-..."]');
      await keyInput.fill("sk-or-totally-fake-garbage-key-12345");
      await keyInput.press("Enter");

      await expect(page.locator("p.text-danger-fg")).toBeVisible({ timeout: 15_000 });
      const errorText = await page.locator("p.text-danger-fg").first().textContent();
      expect(errorText).toMatch(/invalid|401/i);
      // The false-positive this replaces: the old probe hit a public catalog
      // endpoint that 200s for any key, so this used to say "Verified".
      await expect(page.getByText("Verified", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
    });

    await test.step("chat step fails honestly with no model configured — no celebration, no raw CLI/path text", async () => {
      // Skip model and channel, land on chat, without ever getting a working
      // credential saved (this sandbox has no real provider key available).
      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect(page.getByText("Put your agent in your pocket")).toBeVisible({ timeout: 10_000 });
      await page.getByRole("button", { name: "Skip for now" }).click();
      await expect(page.getByText("Say hello to your agent")).toBeVisible({ timeout: 10_000 });

      const input = page.locator('input[placeholder="Ask your agent anything…"]');
      await input.fill("Hello, are you there?");
      await input.press("Enter");

      const errorLocator = page.locator("p.text-danger-fg");
      await expect(errorLocator).toBeVisible({ timeout: 20_000 });
      const errorText = (await errorLocator.first().textContent()) || "";

      // Honest, plain-language remediation — the P0 fix. Depending on gateway
      // timing this resolves as either "no model configured" or "gateway
      // unreachable"; both are genuine, actionable failures the fix must
      // translate, so accept either rather than assuming one.
      expect(errorText.toLowerCase()).toMatch(/model|gateway/);
      expect(errorText).toMatch(/step/i);
      // Never raw CLI jargon or filesystem paths from the underlying gateway
      // error (verified live: the real failure text contains both).
      expect(errorText).not.toContain("openclaw-agent.sqlite");
      expect(errorText).not.toMatch(/openclaw (agents|models)\s/);
      expect(errorText).not.toContain("/agents/main/agent");

      // No false celebration, and "Finish setup" stays honestly disabled.
      await expect(page.getByText(/live and thinking/i)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Finish setup" })).toBeDisabled();
    });

    await test.step("skip-loop fix: finishing (via skip) settles onboarding — the wizard does not reappear", async () => {
      await page.getByRole("button", { name: "Skip for now" }).click();
      // The wizard closes; the dashboard renders instead of looping back to it.
      await expect(page.getByText("Connect an AI model")).toHaveCount(0, { timeout: 10_000 });
      await expect(page.getByText("Say hello to your agent")).toHaveCount(0);

      const state = await (await page.request.get(`${BASE}/api/onboarding/state`)).json();
      expect(state.state.completedAt).toBeTruthy();

      // Reloading must not resurrect the wizard, even though credentials are
      // still genuinely missing — this is the exact skip-loop bug.
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1000);
      await expect(page.getByText("Connect an AI model")).toHaveCount(0);
      await expect(page.getByText("Meet Mission Control")).toHaveCount(0);
    });
  });
});
