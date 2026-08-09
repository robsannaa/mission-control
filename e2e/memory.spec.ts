/**
 * API specs for the memory knowledge graph + extraction settings.
 *
 * Runs request-style against a live Mission Control server. Defaults to the
 * local dev server; override with MEMORY_SPEC_BASE_URL (e.g. a throwaway
 * server on a 319x port).
 *
 * The gateway-mode test performs a real (tiny) extraction through the local
 * OpenClaw gateway's /v1/responses endpoint, so it needs the gateway running —
 * which is the deployment contract for Mission Control anyway.
 *
 * The suite snapshots the user's extraction settings and restores them when
 * done, and never POSTs a graph save — the saved knowledge-graph.json is left
 * untouched.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE = process.env.MEMORY_SPEC_BASE_URL || "http://127.0.0.1:3100";

type ExtractionSettings = {
  mode: "gateway" | "openai" | "off";
  model: string;
  openaiApiKey: string;
};

async function saveSettings(
  request: APIRequestContext,
  settings: Partial<ExtractionSettings>
): Promise<void> {
  const res = await request.post(`${BASE}/api/memory/extraction`, {
    data: { action: "save", settings },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe.serial("memory extraction settings @live", () => {
  let originalSettings: ExtractionSettings | null = null;

  test.beforeAll(async ({ request }) => {
    const res = await request.get(`${BASE}/api/memory/extraction`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    originalSettings = body.settings as ExtractionSettings;
  });

  test.afterAll(async ({ request }) => {
    if (originalSettings) {
      await saveSettings(request, originalSettings);
    }
  });

  test("settings persist and default to gateway mode", async ({ request }) => {
    const res = await request.get(`${BASE}/api/memory/extraction`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.settings).toBeDefined();
    expect(["gateway", "openai", "off"]).toContain(body.settings.mode);
    expect(body.defaults.mode).toBe("gateway");

    await saveSettings(request, { mode: "off" });
    const after = await (await request.get(`${BASE}/api/memory/extraction`)).json();
    expect(after.settings.mode).toBe("off");
  });

  test("rejects an invalid mode", async ({ request }) => {
    const res = await request.post(`${BASE}/api/memory/extraction`, {
      data: { action: "save", settings: { mode: "cloud-magic" } },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(String(body.error)).toContain("Invalid mode");
  });

  test("mode=off builds a deterministic link-based graph with provenance", async ({
    request,
  }) => {
    await saveSettings(request, { mode: "off" });

    const res = await request.get(`${BASE}/api/memory/graph?mode=bootstrap`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // The response declares which extraction route produced it.
    expect(body.extraction).toBeDefined();
    expect(body.extraction.mode).toBe("off");

    // Deterministic graph is never empty and never warns about extraction.
    expect(Array.isArray(body.graph?.nodes)).toBeTruthy();
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    expect(body.warning ?? "").not.toContain("extraction failed");

    // Provenance: every confidence value carries its source, and nothing in
    // off mode is an unlabeled guess — deterministic structure is explicit
    // (files/headings/wikilinks/agents), placeholders are labeled.
    for (const node of body.graph.nodes) {
      if (typeof node.confidence === "number") {
        expect(["explicit", "heuristic", "user"]).toContain(node.confidenceSource);
      } else {
        expect(node.confidence).toBeUndefined();
      }
    }
    const root = body.graph.nodes.find(
      (n: { id: string }) => n.id === "memory-core"
    );
    expect(root).toBeDefined();
    expect(root.confidence).toBe(1);
    expect(root.confidenceSource).toBe("explicit");

    // Deterministic edges carry weight 1; none carry fabricated fractions.
    for (const edge of body.graph.edges) {
      if (typeof edge.weight === "number") {
        expect(edge.weight).toBeGreaterThan(0);
        expect(edge.weight).toBeLessThanOrEqual(1);
      }
    }
  });

  test("openai mode without a key surfaces a structured warning, not an empty graph", async ({
    request,
  }) => {
    await saveSettings(request, { mode: "openai", openaiApiKey: "" });

    const res = await request.get(`${BASE}/api/memory/graph?mode=bootstrap`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();

    // Structured warning field — the UI renders this as a banner.
    expect(body.warning).toBe("no model configured — showing link-based graph");
    expect(body.extraction.mode).toBe("openai");
    expect(body.extraction.configured).toBe(false);

    // Crucially: the graph still contains the link-based nodes. A failure is
    // never presented as "no memories".
    expect(body.graph.nodes.length).toBeGreaterThan(0);
  });

  test("test action while off returns a structured error", async ({ request }) => {
    await saveSettings(request, { mode: "off" });
    const res = await request.post(`${BASE}/api/memory/extraction`, {
      data: { action: "test" },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(body.error.length).toBeGreaterThan(0);
  });

  test("gateway mode runs a tiny extraction through the local gateway", async ({
    request,
  }) => {
    // A real LLM round-trip through /v1/responses on the live gateway with
    // the default agent model — allow for a slow model.
    test.setTimeout(240_000);

    await saveSettings(request, { mode: "gateway", model: "" });

    const res = await request.post(`${BASE}/api/memory/extraction`, {
      data: {
        action: "test",
        content:
          "User prefers TypeScript. The mission-control project uses Next.js and talks to the OpenClaw gateway.",
      },
      timeout: 180_000,
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.mode).toBe("gateway");
    expect(Array.isArray(body.entities)).toBeTruthy();
    expect(body.entities.length).toBeGreaterThan(0);
    expect(Array.isArray(body.relations)).toBeTruthy();

    // Extraction results are unscored by design — the relations schema has no
    // confidence field for the model to hallucinate into.
    for (const rel of body.relations) {
      expect(rel.confidence).toBeUndefined();
      expect(typeof rel.subject).toBe("string");
      expect(typeof rel.predicate).toBe("string");
      expect(typeof rel.object).toBe("string");
    }
  });
});
