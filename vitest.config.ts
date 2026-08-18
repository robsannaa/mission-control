import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Vitest is the fast, no-gateway lane — the direct analogue of
 * `playwright.config.ts`'s multi-project split, but for pure-logic and
 * jsdom-rendered pinning tests that need no OpenClaw gateway, no shared app,
 * and no browser.
 *
 * Three projects split the suite by what the machine running it must
 * provide — the same split rationale `playwright.config.ts` documents for
 * its own CI / LIVE_GATEWAY / LIVE_UI projects, translated to Vitest:
 *   - `unit` — `environment: 'node'`. Pins `src/lib/**` pure functions and
 *     `src/app/api/**` route handlers via `next-test-api-route-handler`.
 *     The `node` environment is load-bearing here: NTARH patches Next.js
 *     internals and is documented to break under a DOM-like environment
 *     (jsdom) — do not widen this project to jsdom to "simplify" the split.
 *   - `component` — `environment: 'jsdom'`. Pins exported pure helpers from
 *     the fragile, monolithic client views (`agents-view.tsx` and friends)
 *     that need a DOM global to import cleanly (`@xyflow/react` imports CSS
 *     and browser APIs at module scope).
 *   - `live` — `environment: 'node'`, gateway-dependent by design. Runs
 *     `next-test-api-route-handler` route tests against the REAL dev
 *     OpenClaw gateway (`~/instances/dev`, :18789) through the app's own
 *     `src/lib/paths.ts` discovery chain — nothing is mocked or stood in.
 *     It is excluded from `test:unit` on purpose: `npm run test:integration`
 *     is the only script that runs it. Requires the dev instance running.
 *
 * `*.live.test.ts` is the ONLY thing that routes a test into the `live`
 * project — the same tag-in-the-name convention Playwright uses with
 * `@live`. It is excluded from both `unit` and `component` here so a
 * gateway-dependent test can never silently join the CI-safe lane. Get the
 * suffix wrong and the test either runs in the wrong project or not at all.
 *
 * `e2e/` belongs to Playwright, never to Vitest — the root-level `exclude`
 * below keeps `e2e/**` and `node_modules/**` out of every project's file
 * collection so a Playwright spec can never accidentally load under Vitest
 * (and vice versa).
 *
 *  npm run test:unit        → `unit` + `component` only, single-shot, no
 *                              watch mode, no gateway required — the
 *                              sub-second-feedback lane FOUND-01 asks for.
 *  npm run test:integration → `live` only. Needs the dev gateway running.
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    exclude: ["e2e/**", "node_modules/**"],
    projects: [
      {
        plugins: [react(), tsconfigPaths()],
        test: {
          name: "unit",
          environment: "node",
          include: ["src/lib/**/*.test.ts", "src/app/api/**/*.test.ts"],
          exclude: ["**/*.live.test.ts"],
        },
      },
      {
        plugins: [react(), tsconfigPaths()],
        test: {
          name: "component",
          environment: "jsdom",
          include: ["src/components/**/*.test.{ts,tsx}"],
          exclude: ["**/*.live.test.ts"],
        },
      },
      {
        plugins: [react(), tsconfigPaths()],
        test: {
          name: "live",
          environment: "node",
          include: ["src/**/*.live.test.ts"],
        },
      },
    ],
  },
});
