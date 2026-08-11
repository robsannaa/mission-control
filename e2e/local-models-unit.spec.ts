/**
 * CI-safe unit tests for issue #70 ("let people run fully local models with
 * no paid API key, and never clobber their existing local model") — pure
 * functions only, no gateway, no server, no browser.
 *
 * Covers:
 *   1. The local-provider config-patch shape (ollama / lmstudio / custom) —
 *      the non-secret marker key, the `api` field only where it belongs, and
 *      `timeoutSeconds` passthrough for slow local cold-starts.
 *   2. The private/loopback host detection that decides when a marker key is
 *      offered instead of demanding a real credential.
 *   3. The Part A footgun fix itself: `mergeModelPrimary` (never discards
 *      `fallbacks`) and `shouldSetPrimary` (never flips the primary as a
 *      silent side effect of connecting a provider).
 */

import { test, expect } from "@playwright/test";
import {
  buildLocalProviderConfig,
  isPrivateHost,
  isPrivateBaseUrl,
  protocolForLocalKind,
  LOCAL_PROVIDER_MARKERS,
  LOCAL_PROVIDER_DEFAULTS,
  type LocalProviderKind,
} from "../src/lib/provider-auth";
import {
  mergeModelPrimary,
  shouldSetPrimary,
  extractPrimaryModel,
} from "../src/lib/gateway-config";

/* ── 1. Local-provider config-patch shape ───────────────────────────────── */

test.describe("provider-auth: buildLocalProviderConfig", () => {
  test("ollama: native protocol, no `api` field, marker key", () => {
    const patch = buildLocalProviderConfig("ollama", "ollama", "http://127.0.0.1:11434");
    const providers = (patch.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers.ollama as Record<string, unknown>;
    expect(entry.baseUrl).toBe("http://127.0.0.1:11434");
    expect(entry.apiKey).toBe("ollama-local");
    expect(entry.apiKey).toBe(LOCAL_PROVIDER_MARKERS.ollama);
    // Ollama speaks its own native API — no `api` override belongs here.
    expect(entry.api).toBeUndefined();
  });

  test("lmstudio: openai-compatible, defaults to openai-completions, marker key", () => {
    const patch = buildLocalProviderConfig("lmstudio", "lmstudio", "http://127.0.0.1:1234/v1");
    const entry = (
      (patch.models as Record<string, unknown>).providers as Record<string, unknown>
    ).lmstudio as Record<string, unknown>;
    expect(entry.baseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(entry.apiKey).toBe("lmstudio");
    expect(entry.api).toBe("openai-completions");
  });

  test("lmstudio: honors an explicit openai-responses api style (the recommended LM Studio setup)", () => {
    const patch = buildLocalProviderConfig("lmstudio", "lmstudio", "http://127.0.0.1:1234/v1", {
      apiStyle: "openai-responses",
    });
    const entry = (
      (patch.models as Record<string, unknown>).providers as Record<string, unknown>
    ).lmstudio as Record<string, unknown>;
    expect(entry.api).toBe("openai-responses");
  });

  test("custom: user-chosen provider id, sk-local marker, timeoutSeconds for cold starts", () => {
    const patch = buildLocalProviderConfig("custom", "local", "http://127.0.0.1:8000/v1", {
      timeoutSeconds: 300,
    });
    const providers = (patch.models as Record<string, unknown>).providers as Record<string, unknown>;
    const entry = providers.local as Record<string, unknown>;
    expect(entry.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(entry.apiKey).toBe("sk-local");
    expect(entry.api).toBe("openai-completions");
    expect(entry.timeoutSeconds).toBe(300);
  });

  test("never writes a real credential anywhere — apiKey is always the non-secret marker", () => {
    for (const kind of ["ollama", "lmstudio", "custom"] as LocalProviderKind[]) {
      const patch = buildLocalProviderConfig(kind, "x", "http://127.0.0.1:9/v1");
      const entry = ((patch.models as Record<string, unknown>).providers as Record<string, unknown>)
        .x as Record<string, unknown>;
      expect(entry.apiKey).toBe(LOCAL_PROVIDER_MARKERS[kind]);
      expect(JSON.stringify(patch)).not.toMatch(/sk-(ant|or)-|OPENAI_API_KEY|OPENROUTER_API_KEY/);
    }
  });

  test("trailing slashes on baseUrl are stripped", () => {
    const patch = buildLocalProviderConfig("ollama", "ollama", "http://127.0.0.1:11434///");
    const entry = ((patch.models as Record<string, unknown>).providers as Record<string, unknown>)
      .ollama as Record<string, unknown>;
    expect(entry.baseUrl).toBe("http://127.0.0.1:11434");
  });

  test("empty baseUrl or providerId builds nothing to patch", () => {
    expect(buildLocalProviderConfig("ollama", "ollama", "")).toEqual({});
    expect(buildLocalProviderConfig("ollama", "", "http://127.0.0.1:11434")).toEqual({});
  });

  test("protocolForLocalKind: ollama is native, everything else is OpenAI-compatible", () => {
    expect(protocolForLocalKind("ollama")).toBe("ollama");
    expect(protocolForLocalKind("lmstudio")).toBe("openai-compatible");
    expect(protocolForLocalKind("custom")).toBe("openai-compatible");
  });

  test("default base URLs match OpenClaw's documented local ports", () => {
    expect(LOCAL_PROVIDER_DEFAULTS.ollama.baseUrl).toBe("http://127.0.0.1:11434");
    expect(LOCAL_PROVIDER_DEFAULTS.lmstudio.baseUrl).toBe("http://127.0.0.1:1234/v1");
  });
});

/* ── 2. Private/loopback host detection ─────────────────────────────────── */

test.describe("provider-auth: isPrivateHost / isPrivateBaseUrl", () => {
  test("loopback addresses are private", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("127.5.5.5")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
  });

  test("private LAN ranges (RFC 1918) are private", () => {
    expect(isPrivateHost("10.0.0.5")).toBe(true);
    expect(isPrivateHost("172.16.0.1")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.1.50")).toBe(true);
  });

  test("172.x outside the 16-31 second octet is NOT private (common off-by-range bug)", () => {
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });

  test(".local and bare hostnames are private (mDNS / LAN box names)", () => {
    expect(isPrivateHost("my-gpu-box.local")).toBe(true);
    expect(isPrivateHost("dgx-spark")).toBe(true);
  });

  test("public hostnames and IPs are NOT private", () => {
    expect(isPrivateHost("api.openai.com")).toBe(false);
    expect(isPrivateHost("openrouter.ai")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("ollama.com")).toBe(false);
  });

  test("isPrivateBaseUrl extracts the hostname from a full URL", () => {
    expect(isPrivateBaseUrl("http://127.0.0.1:11434")).toBe(true);
    expect(isPrivateBaseUrl("http://192.168.1.20:1234/v1")).toBe(true);
    expect(isPrivateBaseUrl("https://openrouter.ai/api/v1")).toBe(false);
    expect(isPrivateBaseUrl("not a url")).toBe(false);
  });
});

/* ── 3. Part A footgun fix: merge-not-replace + never-clobber-primary ──── */

test.describe("gateway-config: mergeModelPrimary (the merge-not-replace fix)", () => {
  test("preserves fallbacks when changing primary — the exact bug from issue #70", () => {
    const existing = { primary: "ollama/qwen3:8b", fallbacks: ["ollama/llama3.2:latest"] };
    const merged = mergeModelPrimary(existing, "openrouter/anthropic/claude-sonnet-4-6");
    expect(merged.primary).toBe("openrouter/anthropic/claude-sonnet-4-6");
    expect(merged.fallbacks).toEqual(["ollama/llama3.2:latest"]);
  });

  test("preserves arbitrary other keys on the model object, not just fallbacks", () => {
    const existing = { primary: "a/b", fallbacks: ["c/d"], someFutureKey: 42 };
    const merged = mergeModelPrimary(existing, "e/f");
    expect(merged).toEqual({ primary: "e/f", fallbacks: ["c/d"], someFutureKey: 42 });
  });

  test("a bare string primary (legacy shorthand) has nothing to preserve, and that's fine", () => {
    const merged = mergeModelPrimary("ollama/qwen3:8b", "lmstudio/my-model");
    expect(merged).toEqual({ primary: "lmstudio/my-model" });
  });

  test("no existing model (fresh machine) just sets primary", () => {
    expect(mergeModelPrimary(undefined, "ollama/qwen3:8b")).toEqual({ primary: "ollama/qwen3:8b" });
    expect(mergeModelPrimary(null, "ollama/qwen3:8b")).toEqual({ primary: "ollama/qwen3:8b" });
  });

  test("never mutates the input object", () => {
    const existing = { primary: "a/b", fallbacks: ["c/d"] };
    const snapshot = JSON.stringify(existing);
    mergeModelPrimary(existing, "e/f");
    expect(JSON.stringify(existing)).toBe(snapshot);
  });
});

test.describe("gateway-config: shouldSetPrimary (never clobber a configured primary)", () => {
  test("nothing configured yet — safe to set automatically (fresh onboarding)", () => {
    expect(shouldSetPrimary(null, false)).toBe(true);
  });

  test("something already configured — refuses to overwrite without explicit opt-in", () => {
    // This is the exact issue #70 scenario: a local primary is set, then a
    // cloud key gets connected. Without makePrimary, the local model must
    // survive untouched.
    expect(shouldSetPrimary("ollama/qwen3:8b", false)).toBe(false);
  });

  test("something already configured, but the user explicitly asked to switch", () => {
    expect(shouldSetPrimary("ollama/qwen3:8b", true)).toBe(true);
  });

  test("makePrimary alone never matters on a fresh machine — same result either way", () => {
    expect(shouldSetPrimary(null, true)).toBe(true);
    expect(shouldSetPrimary(null, false)).toBe(true);
  });
});

test.describe("gateway-config: extractPrimaryModel", () => {
  test("reads the object-shorthand primary", () => {
    const config = { agents: { defaults: { model: { primary: "ollama/qwen3:8b", fallbacks: [] } } } };
    expect(extractPrimaryModel(config)).toBe("ollama/qwen3:8b");
  });

  test("reads a bare-string model as primary", () => {
    const config = { agents: { defaults: { model: "ollama/qwen3:8b" } } };
    expect(extractPrimaryModel(config)).toBe("ollama/qwen3:8b");
  });

  test("null/missing/malformed config all read as no primary, never throw", () => {
    expect(extractPrimaryModel(null)).toBeNull();
    expect(extractPrimaryModel(undefined)).toBeNull();
    expect(extractPrimaryModel({})).toBeNull();
    expect(extractPrimaryModel({ agents: null } as unknown as Record<string, unknown>)).toBeNull();
    expect(extractPrimaryModel({ agents: { defaults: { model: {} } } })).toBeNull();
  });
});
