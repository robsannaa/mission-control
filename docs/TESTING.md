# Testing

Mission Control has two test runners, five lanes, and one contract gate that
runs ahead of both. This document is the single source of truth for which
lanes and gates exist, which of them block a merge, and how to run the ones
GitHub Actions cannot run.

For the API error envelope every route answers with, the wrapper contract
routes are migrated onto, and the migration recipe for `src/app/api/**`, see
[`docs/API-CONTRACT.md`](./API-CONTRACT.md).

## Two runners, five lanes, one contract gate

| Lane | Command | Requires | Typical runtime | Where it runs |
|------|---------|----------|------------------|----------------|
| API contract check | `npm run check:contract` | Nothing | <1s | GitHub Actions + local |
| Vitest unit + component | `npm run test:unit` | Nothing | ~1s (117 tests) | GitHub Actions + local |
| Vitest live | `npm run test:integration` | Dev instance | <1s (1 test) | Local only |
| Playwright CI | `npm test` | Nothing | ~16s (406 tests) | GitHub Actions + local |
| Playwright LIVE_GATEWAY | `npm run test:gateway` | Dev instance | ~55s | Local only |
| Playwright LIVE_UI | `npm run test:ui` | Dev instance + Chromium | ~2.5min | Local only |

"Dev instance" means the real local OpenClaw gateway (`~/instances/dev`, port 18789)
plus Mission Control running against it. "Chromium" means `npm run test:install` has
been run once.

The API contract check (`scripts/check-api-contract.mjs`) is not a Vitest or
Playwright lane — it's a dependency-free Node script that scans every file
under `src/app/api/**` for envelope, logging, and passthrough violations
against [`docs/API-CONTRACT.md`](./API-CONTRACT.md). It needs no gateway, no
dev instance, and no browser, so it runs everywhere the Vitest fast lane runs.

## What blocks what

GitHub Actions blocks a pull request on three checks: the API contract check
(`npm run check:contract`), the Vitest fast lane (`npm run test:unit`), and the
Playwright CI project (`npm test`). All three run in `.github/workflows/ci.yml`
on every push to `main` and every pull request — the contract check runs right
after the Vitest fast lane and before lint, so a route-shape regression is
reported by the tool that explains it, not by a generic lint failure. Lint,
type check, and build run after.

The scoped `no-console` ESLint rule (`eslint.config.mjs`, `src/app/api/**` and
`src/lib/**`, one exemption for `src/lib/logger.ts`) is enforced by the `Lint`
step in the same job — a bare `console.*` call in a server route or server
library fails the build the same way any other lint error does.

The three instance-dependent lanes — Vitest live, Playwright LIVE_GATEWAY,
Playwright LIVE_UI — do **not** run in GitHub Actions, because GitHub Actions has
no OpenClaw gateway, no Mission Control instance, and no G-Brain. They block a
merge through `npm run test:premerge`, run locally by a maintainer before merging.

Say this plainly: that half of the suite is enforced by convention and review, not
by the platform. `npm run test:premerge` chains `check:contract && test:unit &&
test:integration && test:live` — the first failing lane stops the run and returns
a non-zero exit code, so it is a gate, not a report. If this convention proves
unreliable, the deferred alternative — provisioning an ephemeral OpenClaw instance
inside GitHub Actions — is recorded in
`.planning/phases/01-test-foundation/01-CONTEXT.md` (Decision 2).

## When the contract check is red

A red `npm run check:contract` means a route in `src/app/api/**` left the
documented envelope, logging, or passthrough contract — not that the checker
is wrong. Read [`docs/API-CONTRACT.md`](./API-CONTRACT.md), find which builder
or wrapper the flagged file should be using, and fix the route. Do not loosen
`scripts/check-api-contract.mjs`'s detectors to make a violation disappear —
that erases the phase's whole hardening guarantee for every future
contributor, not just the one who introduced the regression.

## Running the local gate

From a stopped instance:

```bash
# 1. Start the dev OpenClaw instance
~/instances/dev/run.sh

# 2. Start Mission Control against it, on port 3100
OPENCLAW_HOME=~/instances/dev/home npm run dev -- -p 3100

# 3. Install Chromium once (skip if already installed)
npm run test:install

# 4. Run the full pre-merge gate
npm run test:premerge
```

A non-zero exit from `npm run test:premerge` blocks the merge. Fix the failing
lane, or confirm it's a known pre-existing issue tracked in
`.planning/phases/01-test-foundation/deferred-items.md`, before opening or
merging a pull request.

## Where tests live

The filename suffix and the spec title tag are the **only** routing mechanisms.
Getting one wrong makes a test silently not run in any lane.

- `src/lib/**/*.test.ts` and `src/app/api/**/*.test.ts` → Vitest `unit` project.
- `src/components/**/*.test.{ts,tsx}` → Vitest `component` project.
- Any file ending `.live.test.ts` → Vitest `live` project. Never the fast lane.
- Files in `e2e/` route by title tag:
  - No tag → Playwright `CI` project.
  - `@live` tag → Playwright `LIVE_GATEWAY` project.
  - `@live @ui` tags together → Playwright `LIVE_UI` project.

## Rules that are not negotiable

- No gateway doubles anywhere. Tests hit the real dev instance and real
  G-Brain — no `FakeGatewayClient`, no mocked gateway responses.
- Never print, snapshot, or commit a raw `/api/config` body or any
  credential-shaped string. The live config response contains unredacted
  secrets (gateway token, provider API keys).
- Any spec that writes config must pace itself against the shared
  three-writes-per-sixty-seconds budget on `config.patch` (see
  `playwright.config.ts`'s header comment and `pacedPatch()` in
  `e2e/config-editor-write.spec.ts`).
- The three fragile monolithic views (`agents-view.tsx`, `cron-view.tsx`,
  `config-editor.tsx`) take export-only edits — mechanical `export` keyword
  additions, zero logic changes — until the Phase 6 audit.

## Known gaps

`npm run test:premerge` does not currently exit 0 against the dev instance. Four
pre-existing failures, unrelated to any change in this phase, are tracked in
`.planning/phases/01-test-foundation/deferred-items.md`:

- `e2e/correctness.spec.ts:48` — no model in the live catalog currently reports a
  `contextWindow`.
- `e2e/memory.spec.ts:53` — `GET /api/memory/extraction` is not returning 2xx on
  this dev instance.
- `e2e/config-editor-write.spec.ts:688` — a config field's locator times out.
- `e2e/onboarding-live.spec.ts:266` — an onboarding wizard step times out.

None of these are caused by the test infrastructure this phase built. They are
real, pre-existing product/environment issues, deferred to a future audit per the
scope boundary of the plans that discovered them.
