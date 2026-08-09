import { defineConfig } from "@playwright/test";

/**
 * Two projects split the suite by environment needs:
 *
 *  - CI: every spec NOT tagged @live — unit-style tests plus specs that spawn
 *    their own throwaway `next dev` servers (ports 3190-3199). Safe on a
 *    machine with no OpenClaw gateway and no shared dev server, so this is
 *    what GitHub Actions runs (`--project=CI`, equivalent to
 *    `--grep-invert @live`).
 *  - LIVE_GATEWAY: specs tagged @live in their title — they hit the shared
 *    dev server (http://127.0.0.1:3100 by default) and the real OpenClaw
 *    gateway on 127.0.0.1:18789.
 *
 *  `npm test`          → CI project only
 *  `npm run test:live` → both projects (the full suite)
 *
 * All specs are request-style (no `page` fixture), so no browsers need to be
 * installed. There is intentionally no `webServer`: every spec targets an
 * absolute URL, and port 3000 may be held by an unrelated app.
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
    },
  ],
});
