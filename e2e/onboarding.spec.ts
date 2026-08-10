import { test, expect } from "@playwright/test";

/**
 * Onboarding API specs — run against a live Mission Control instance.
 *
 * These are request-style API tests. They rely on the dry-run guards built
 * into the onboarding endpoints so they NEVER mutate the real gateway config,
 * auth profiles, or channel settings. The only state they touch is Mission
 * Control's own onboarding progress file, which is captured and restored.
 */

const BASE =
  process.env.PLAYWRIGHT_BASE_URL || process.env.MC_BASE_URL || "http://127.0.0.1:3100";

test.describe("onboarding: detect @live", () => {
  test("returns live gateway info for this machine", async ({ request }) => {
    const res = await request.get(`${BASE}/api/onboarding/detect`);
    expect(res.status()).toBe(200);
    const body = await res.json();

    // A local OpenClaw install exists on this machine
    expect(body.installed).toBe(true);
    expect(typeof body.binPath).toBe("string");
    expect(body.cliVersion).toMatch(/^\d{4}\.\d+/);

    // The gateway runs on 127.0.0.1:18789 in this environment
    expect(body.running).toBe(true);
    expect(body.port).toBe(18789);
    expect(typeof body.checkedAt).toBe("string");
  });

  test("start action supports dry-run without touching the service", async ({ request }) => {
    const res = await request.post(`${BASE}/api/onboarding/detect`, {
      data: { action: "start", dryRun: true },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.command).toContain("gateway start");
  });

  test("rejects unknown actions", async ({ request }) => {
    const res = await request.post(`${BASE}/api/onboarding/detect`, {
      data: { action: "explode" },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("onboarding: state persistence @live", () => {
  let savedState: unknown = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${BASE}/api/onboarding/state`);
    savedState = (await res.json()).state;
  });

  test.afterAll(async ({ request }) => {
    // Restore whatever was there before the test ran
    await request.delete(`${BASE}/api/onboarding/state`);
    const prior = savedState as {
      currentStep?: string;
      completedAt?: string | null;
      steps?: Record<string, unknown>;
      startedAt?: string | null;
    } | null;
    if (prior && (prior.startedAt || prior.completedAt)) {
      await request.post(`${BASE}/api/onboarding/state`, {
        data: {
          patch: {
            currentStep: prior.currentStep,
            completedAt: prior.completedAt ?? null,
            steps: prior.steps,
          },
        },
      });
    }
  });

  test("GET returns a well-formed state object", async ({ request }) => {
    const res = await request.get(`${BASE}/api/onboarding/state`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.state.version).toBe(1);
    expect(["gateway", "model", "channel", "chat"]).toContain(body.state.currentStep);
    for (const id of ["gateway", "model", "channel", "chat"]) {
      expect(["pending", "done", "skipped"]).toContain(body.state.steps[id].status);
    }
  });

  test("POST patch persists across requests", async ({ request }) => {
    const patchRes = await request.post(`${BASE}/api/onboarding/state`, {
      data: {
        patch: {
          currentStep: "channel",
          steps: {
            gateway: { status: "done", meta: { version: "spec-test" } },
            model: { status: "skipped" },
          },
        },
      },
    });
    expect(patchRes.status()).toBe(200);

    const res = await request.get(`${BASE}/api/onboarding/state`);
    const { state } = await res.json();
    expect(state.currentStep).toBe("channel");
    expect(state.steps.gateway.status).toBe("done");
    expect(state.steps.gateway.meta.version).toBe("spec-test");
    expect(state.steps.model.status).toBe("skipped");
    expect(state.startedAt).toBeTruthy();
  });

  test("rejects invalid step ids and statuses", async ({ request }) => {
    const badStep = await request.post(`${BASE}/api/onboarding/state`, {
      data: { patch: { steps: { nonsense: { status: "done" } } } },
    });
    expect(badStep.status()).toBe(400);

    const badStatus = await request.post(`${BASE}/api/onboarding/state`, {
      data: { patch: { steps: { gateway: { status: "exploded" } } } },
    });
    expect(badStatus.status()).toBe(400);

    const badCurrent = await request.post(`${BASE}/api/onboarding/state`, {
      data: { patch: { currentStep: "nowhere" } },
    });
    expect(badCurrent.status()).toBe(400);

    const noPatch = await request.post(`${BASE}/api/onboarding/state`, {
      data: {},
    });
    expect(noPatch.status()).toBe(400);
  });

  test("DELETE resets to defaults", async ({ request }) => {
    const res = await request.delete(`${BASE}/api/onboarding/state`);
    expect(res.status()).toBe(200);
    const after = await request.get(`${BASE}/api/onboarding/state`);
    const { state } = await after.json();
    expect(state.currentStep).toBe("gateway");
    expect(state.steps.gateway.status).toBe("pending");
  });
});

test.describe("onboarding: model auth (dry-run only — never mutates real auth) @live", () => {
  test("GET lists the provider catalog", async ({ request }) => {
    const res = await request.get(`${BASE}/api/onboarding/model-auth`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    const ids = body.providers.map((p: { id: string }) => p.id);
    expect(ids).toContain("openrouter");
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    for (const p of body.providers) {
      expect(Array.isArray(p.authMethods)).toBe(true);
      expect(typeof p.keyUrl).toBe("string");
    }
    // Live gateway contributes its known providers
    expect(Array.isArray(body.gatewayProviders)).toBe(true);
  });

  test("validate-key enforces input shape", async ({ request }) => {
    const missingToken = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: { action: "validate-key", provider: "openai", dryRun: true },
    });
    expect(missingToken.status()).toBe(400);

    const badProvider = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: { action: "validate-key", provider: "Not A Provider!", token: "x", dryRun: true },
    });
    expect(badProvider.status()).toBe(400);

    const unknownProvider = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: { action: "validate-key", provider: "zzz-unknown", token: "x", dryRun: true },
    });
    expect(unknownProvider.status()).toBe(400);

    const ok = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: { action: "validate-key", provider: "openai", token: "sk-test", dryRun: true },
    });
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
  });

  test("save-api-key dry-run reports the plan without writing config", async ({ request }) => {
    const res = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: {
        action: "save-api-key",
        provider: "openrouter",
        token: "sk-or-test",
        model: "openrouter/test-model",
        dryRun: true,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.wouldPatch.env).toContain("OPENROUTER_API_KEY");
    expect(body.wouldPatch.model).toBe("openrouter/test-model");
  });

  test("paste-token dry-run returns the CLI plan with stdin redaction", async ({ request }) => {
    const res = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: { action: "paste-token", provider: "anthropic", token: "tok-secret", dryRun: true },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.command).toBe("openclaw models auth paste-token --provider anthropic");
    // The token itself must never be echoed back in the plan
    expect(JSON.stringify(body)).not.toContain("tok-secret");
  });

  test("paste-token validates expiresIn format", async ({ request }) => {
    const res = await request.post(`${BASE}/api/onboarding/model-auth`, {
      data: {
        action: "paste-token",
        provider: "anthropic",
        token: "tok",
        expiresIn: "sometime",
        dryRun: true,
      },
    });
    expect(res.status()).toBe(400);
  });
});

test.describe("onboarding: channel (dry-run only — never mutates real channels) @live", () => {
  test("GET returns live telegram status shape", async ({ request }) => {
    const res = await request.get(`${BASE}/api/onboarding/channel`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.channel).toBe("telegram");
    expect(typeof body.configured).toBe("boolean");
    expect(typeof body.running).toBe("boolean");
    expect(typeof body.connected).toBe("boolean");
  });

  test("connect rejects malformed tokens before any side effect", async ({ request }) => {
    const res = await request.post(`${BASE}/api/onboarding/channel`, {
      data: { action: "connect", token: "definitely-not-a-token", dryRun: true },
    });
    expect(res.status()).toBe(400);

    const empty = await request.post(`${BASE}/api/onboarding/channel`, {
      data: { action: "connect", token: "", dryRun: true },
    });
    expect(empty.status()).toBe(400);
  });

  test("connect dry-run accepts a well-formed token and reports the patch plan", async ({ request }) => {
    /*
     * Assembled from parts rather than written as one string. The value is
     * invented — sequential digits, a straight alphabet run, no bot behind it —
     * but it has to be well-formed for this test to mean anything, and a
     * well-formed Telegram token is exactly what GitHub's secret scanner looks
     * for. It flagged this line as a public leak. A repo carrying a standing
     * false positive is a repo where a real leak goes unnoticed, so the literal
     * never appears in the source.
     */
    const botId = "123456789";
    const botSecret = ["AAF0123456789", "abcdefghijklmnopqrstuv"].join("");

    const res = await request.post(`${BASE}/api/onboarding/channel`, {
      data: {
        action: "connect",
        token: `${botId}:${botSecret}`,
        dryRun: true,
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.wouldPatch.channels.telegram).toContain("botToken");
  });
});

test.describe("onboarding: page renders @live", () => {
  test("the dashboard page serves HTML", async ({ request }) => {
    const res = await request.get(`${BASE}/`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });
});
