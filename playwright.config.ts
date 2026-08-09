import { defineConfig } from "@playwright/test";

/**
 * Three projects split the suite by what the machine running it must provide.
 * A spec opts into a project purely through tags in its title, so the split is
 * visible in the spec itself rather than in a file list here.
 *
 *  - CI — every spec NOT tagged @live. Pure unit-style tests plus specs that
 *    spawn their own throwaway `next dev` servers (ports 3190-3199). Needs no
 *    OpenClaw gateway, no shared dev server and no browser download, so this
 *    is what GitHub Actions runs (`--project=CI`, equivalent to
 *    `--grep-invert @live`).
 *  - LIVE_GATEWAY — specs tagged @live but not @ui. Request-style (no `page`
 *    fixture): they hit Mission Control on http://127.0.0.1:3100 and the real
 *    OpenClaw gateway on 127.0.0.1:18789. Still no browser required.
 *  - LIVE_UI — specs tagged @ui (which are also @live). These are the only
 *    tests that drive a real browser, so they are the only ones that need
 *    `npx playwright install chromium`. Isolating them keeps a missing browser
 *    binary from failing the request-style live tests, and lets them carry
 *    UI-debugging artifacts (screenshot/video/trace) that would be noise
 *    elsewhere.
 *
 *  npm test             → CI project only (no gateway, no app, no browser)
 *  npm run test:live    → CI + LIVE_GATEWAY + LIVE_UI (the full suite)
 *  npm run test:gateway → LIVE_GATEWAY only
 *  npm run test:ui      → LIVE_UI only (needs `npm run test:install` once)
 *
 * SHARED BUDGET — read before adding a live spec that writes config. The real
 * gateway caps `config.patch` at 3 writes per 60s per client, and that budget
 * is shared by every spec in a run, not per file. A spec that PATCHes
 * /api/config MUST treat HTTP 429 as "wait and retry" using the server's
 * `retryAfterMs`, the way config-write.spec.ts and config-editor-write.spec.ts
 * both do in their `pacedPatch()` helpers. A spec that asserts `toBe(200)` on
 * an unpaced write passes alone and fails in the suite, purely on ordering.
 *
 * There is intentionally no `webServer`: every spec targets an absolute URL,
 * and port 3000 may be held by an unrelated app.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:3100";

export default defineConfig({
  testDir: "./e2e",
  timeout: 90_000,
  expect: {
    timeout: 15_000,
  },
  // Specs mutate shared live state (config round-trips schedule gateway
  // restarts) and several spawn their own next servers — run strictly
  // serially.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "CI",
      grepInvert: /@live/,
    },
    {
      name: "LIVE_GATEWAY",
      grep: /@live/,
      grepInvert: /@ui/,
    },
    {
      name: "LIVE_UI",
      grep: /@ui/,
      use: {
        // Deliberately NOT devices["Desktop Chrome"] — that descriptor spoofs
        // a Windows user agent, and the config editor is a real app that may
        // key off the platform. Bundled Chromium with an explicit viewport is
        // the honest environment.
        browserName: "chromium",
        viewport: { width: 1440, height: 900 },
        // A browser failure is expensive to reproduce by hand against a live
        // gateway, so keep the evidence from the first run.
        screenshot: "only-on-failure",
        video: "retain-on-failure",
        trace: "retain-on-failure",
      },
    },
  ],
});
