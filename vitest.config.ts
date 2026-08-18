import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Vitest is the fast, no-gateway lane — the direct analogue of
 * `playwright.config.ts`'s multi-project split, but for pure-logic and
 * jsdom-rendered pinning tests that need no OpenClaw gateway, no shared app,
 * and no browser.
 *
 * Two projects split the suite by DOM requirement:
 *   - `unit` — `environment: 'node'`. Pins `src/lib/**` pure functions and
 *     (from Plan 03 onward) `src/app/api/**` route handlers via
 *     `next-test-api-route-handler`. The `node` environment is load-bearing
 *     here: NTARH patches Next.js internals and is documented to break under
 *     a DOM-like environment (jsdom) — do not widen this project to jsdom to
 *     "simplify" the split.
 *   - `component` — `environment: 'jsdom'`. Pins exported pure helpers from
 *     the fragile, monolithic client views (`agents-view.tsx` and friends)
 *     that need a DOM global to import cleanly (`@xyflow/react` imports CSS
 *     and browser APIs at module scope).
 *
 * `*.live.test.ts` is excluded from both projects here — that suffix is
 * reserved for the gateway-dependent Vitest project Plan 03 introduces
 * (tests that hit the real dev OpenClaw gateway, mirroring Playwright's
 * `@live` tag convention). This file's `unit`/`component` projects are the
 * pure, no-gateway lane only.
 *
 * `e2e/` belongs to Playwright, never to Vitest — the root-level `exclude`
 * below keeps `e2e/**` and `node_modules/**` out of every project's file
 * collection so a Playwright spec can never accidentally load under Vitest
 * (and vice versa).
 *
 *  npm run test:unit → both projects (`unit` + `component`), single-shot,
 *  no watch mode — this is the sub-second-feedback lane FOUND-01 asks for.
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
    ],
  },
});
