/**
 * Fragile-view render pins — agents, cron, config editor (@live @ui, LIVE_UI project).
 *
 * Plans 01/02/04 pin the pure helpers and the gateway API contracts feeding
 * these three views. That catches a changed formatter or a shifted API
 * field, but not a helper that stops being called, a prop that stops being
 * passed, or a list that silently renders empty. Only a real browser against
 * live data catches those — and before this file, `agents-view.tsx` and
 * `cron-view.tsx` had zero `@ui` coverage; only `config-editor.tsx` did
 * (config-editor-write.spec.ts).
 *
 * D-03 (01-CONTEXT.md, LOCKED): none of the three view files may be edited
 * by this plan, not even to add a `data-testid`. Every locator below uses
 * role, rendered text, or DOM attributes/classes the views already emit for
 * their own purposes (`data-config-path`, `id="cron-job-*"`,
 * `.monaco-editor`) — never something added for testing.
 *
 * @ui puts these in the LIVE_UI project: the only project that drives a
 * real browser, so the only one needing `npm run test:install`. See
 * playwright.config.ts.
 */

import { test, expect, type Page } from "@playwright/test";
import { scheduleDisplay, buildFailureGuide } from "../src/components/cron-view";

const LIVE_BASE = process.env.MC_BASE_URL || "http://127.0.0.1:3100";

async function dismissTour(page: Page): Promise<void> {
  // A fresh browser profile triggers the first-run dashboard tour, whose
  // full-screen scrim swallows every click. Mark it done before the app boots.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("mc-dashboard-tour-done-v1", "1");
    } catch {
      /* storage unavailable — the tour scrim is handled by explicit waits below */
    }
  });
}

/* ── 1. Agents view ──────────────────────────────────────────────── */

test.describe("@live @ui agents view renders the live agent list", () => {
  test("@live the Cards view reflects the live /api/agents response", async ({ page, request }) => {
    test.setTimeout(180_000);
    await dismissTour(page);

    const res = await request.get(`${LIVE_BASE}/api/agents`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const agents = body.agents as Array<Record<string, unknown>>;
    expect(agents.length).toBeGreaterThan(0);
    const first = agents[0];
    const firstId = String(first.id);
    const firstModel = String(first.model);
    const firstStatus = String(first.status);
    const firstTokens = Number(first.totalTokens);

    // shortModel(m) — agents-view.tsx: last "/"-separated segment of the model id.
    const expectedShortModel = firstModel.split("/").pop() as string;
    // STATUS_COLORS' three-way label mapping (agents-view.tsx AgentDetail).
    const expectedStatusLabel =
      firstStatus === "active" ? "Active" : firstStatus === "idle" ? "Idle" : "Unknown";
    // formatTokens(n) — agents-view.tsx: identical bucket formula, computed
    // here from the live response rather than a hardcoded literal.
    const expectedTokens =
      firstTokens < 1000
        ? String(firstTokens)
        : firstTokens < 1_000_000
          ? `${(firstTokens / 1000).toFixed(1)}K`
          : `${(firstTokens / 1_000_000).toFixed(2)}M`;

    await page.goto(`${LIVE_BASE}/agents`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: /Agents/ })).toBeVisible({
      timeout: 60_000,
    });

    // Hierarchy (Flow) is the default view — a pan/zoom canvas graph with no
    // stable role/text locators. Cards is the scrollable card+detail layout
    // this spec can query without adding a data-testid (D-03).
    await page.getByRole("button", { name: "Cards" }).click();

    // Grid view auto-selects an agent (the default, or agents[0]) as soon as
    // agents load, so the detail panel is already showing below the grid —
    // no click required to reach it.
    await expect(page.getByText(firstId, { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText(expectedShortModel, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(expectedStatusLabel, { exact: true }).first()).toBeVisible();
    await expect(page.getByText(expectedTokens, { exact: true }).first()).toBeVisible();

    // One card per agent — GridView's only <h3> is the per-agent name heading.
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(agents.length);
  });
});

/* ── 2. Cron view ────────────────────────────────────────────────── */

test.describe("@live @ui cron view renders the live job list", () => {
  test("@live the job list is chained gateway shape -> scheduleDisplay/buildFailureGuide -> pixel", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await dismissTour(page);

    const res = await request.get(`${LIVE_BASE}/api/cron`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const jobs = body.jobs as Array<Record<string, unknown>>;
    expect(jobs.length).toBeGreaterThan(0);
    const first = jobs[0];

    await page.goto(`${LIVE_BASE}/cron`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: /Cron Jobs/ })).toBeVisible({
      timeout: 60_000,
    });

    // One <div id="cron-job-{id}"> per job — existing in-page navigation
    // anchor markup (used by ?job= deep links), not added for this spec.
    const jobCards = page.locator('[id^="cron-job-"]');
    await expect(jobCards).toHaveCount(jobs.length);

    await expect(page.getByText(String(first.name), { exact: true }).first()).toBeVisible();

    // Chain gateway contract -> scheduleDisplay -> rendered text. This dev
    // instance's first job is `every`-kind; that branch's output ("Every
    // Nm"/"Every Nh") does not depend on the 12h/24h time-format preference,
    // so a fixed preference here cannot itself cause a false pass or fail —
    // unlike the `cron`-kind branch, which does.
    const expectedSchedule = scheduleDisplay(
      first.schedule as { kind: string; expr?: string; everyMs?: number; tz?: string },
      "24h",
    );
    const firstCard = page.locator(`#cron-job-${String(first.id)}`);
    await expect(firstCard.getByText(expectedSchedule, { exact: false })).toBeVisible();

    // enabled/paused reflects the API boolean via the DISABLED badge.
    if (first.enabled) {
      await expect(firstCard.getByText("DISABLED")).toHaveCount(0);
    } else {
      await expect(firstCard.getByText("DISABLED")).toBeVisible();
    }

    // Any job whose last run errored shows its FailureGuideCard inline (no
    // expand/click needed), headline computed by the real (now-exported)
    // buildFailureGuide — not copied — so a change to the gateway's error
    // shape or the helper's branch logic fails here.
    const erroredJob = jobs.find(
      (j) => (j.state as Record<string, unknown> | undefined)?.lastRunStatus === "error",
    );
    if (erroredJob) {
      const state = erroredJob.state as Record<string, unknown>;
      const guide = buildFailureGuide(
        String(state.lastError || ""),
        erroredJob.delivery as { mode: string; channel?: string; to?: string; bestEffort?: boolean },
      );
      const erroredCard = page.locator(`#cron-job-${String(erroredJob.id)}`);
      await expect(erroredCard.getByText(guide.headline, { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    }
  });
});

/* ── 3. Config editor secret masking ────────────────────────────── */

test.describe("@live @ui config editor masks sensitive values", () => {
  test("@live the raw view's masked toggle renders sensitive fields as bullet masks, never as plaintext", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await dismissTour(page);

    // Read-only against the instance: this spec issues no PATCH and no save
    // (shared write budget, per playwright.config.ts). Compute the expected
    // mask from the live response and the real redactConfigForDisplay
    // thresholds, before touching the page at all — so nothing here ever
    // needs to read the live secret value back out of the page.
    const res = await request.get(`${LIVE_BASE}/api/config`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const hints = body.meta.uiHints as Record<string, { sensitive?: boolean }>;
    expect(hints["gateway.auth.token"]?.sensitive).toBe(true);
    const tokenValue = body.config?.gateway?.auth?.token as string | undefined;
    expect(typeof tokenValue).toBe("string");
    // redactConfigForDisplay: strings over 8 chars get the 8-dot mask, else 4.
    const expectedMask = (tokenValue as string).length > 8 ? "••••••••" : "••••";

    await page.goto(`${LIVE_BASE}/config`, { waitUntil: "domcontentloaded" });
    await expect(page.getByLabel("Search settings")).toBeVisible({ timeout: 60_000 });

    // Coarsened anchor, documented per plan instructions (D-03 escape hatch):
    // the plan's own text asks to "find [the field] via the visible label
    // text" in the Form view first. That path was tried and is genuinely
    // unreachable on this instance — not because of anything this plan
    // touches, but a pre-existing bug in isModelPrimaryFallbacksShape
    // (config-editor.tsx:774), which is permissive enough to match *any*
    // small object without "primary"/"fallbacks" keys. gateway.auth here is
    // `{ token: "..." }`, so it matches and gateway.auth.token is routed
    // into the Primary-Model/Fallbacks editor instead of NestedSection ->
    // ConfigField -> StringField, and never renders as its own field at all
    // — confirmed via the field-search result landing on a Model/Fallbacks
    // widget, not a `[data-config-path="gateway.auth.token"]` input. D-03
    // forbids editing config-editor.tsx to fix this, so this spec pins the
    // masking behavior at the Raw-view level below, which does not depend
    // on that Form-view rendering path. See 01-05-SUMMARY.md.
    //
    // Pin current behavior, plainly stated: the Raw tab opens showing the
    // real (unmasked) document by design — RESEARCH.md Pitfall 1, and fixing
    // it is explicitly Phase 2/6 scope, not this plan's (01-CONTEXT.md).
    // Click straight from Raw to the masked toggle without asserting on
    // anything in between, so a mid-sequence failure can't retain a
    // screenshot/video of an unmasked secret (T-01-07) — LIVE_UI only keeps
    // artifacts on failure, and only locally, never in CI (D-02).
    await page.getByRole("button", { name: "Raw" }).click();
    await page.getByRole("button", { name: "Secrets visible" }).click();
    await expect(page.getByRole("button", { name: "Secrets masked" })).toBeVisible({
      timeout: 15_000,
    });

    const editorText = await page.locator(".monaco-editor").innerText();
    const tokenLineMatch = /"token":\s*"(•+)"/.exec(editorText);
    expect(tokenLineMatch).not.toBeNull();
    const maskedValue = tokenLineMatch ? tokenLineMatch[1] : "";
    expect(maskedValue).toMatch(/^•+$/);
    expect(maskedValue.length === 4 || maskedValue.length === 8).toBe(true);
    expect(maskedValue).toBe(expectedMask);

    // No credential-shaped run anywhere in the page's visible text. Failure
    // messages below name the pattern, never the match, so even a failing
    // assertion cannot echo a secret into the test report.
    const bodyText = await page.locator("body").innerText();
    expect(/[a-f0-9]{40,}/i.test(bodyText), "found a 40+ char hex-shaped run in page text").toBe(
      false,
    );
    expect(
      /sk-[A-Za-z0-9_-]{16,}/.test(bodyText),
      "found an sk-prefixed key-shaped run in page text",
    ).toBe(false);
  });
});
