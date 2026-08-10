/**
 * Embedding provider metadata for the Settings tab.
 *
 * Scope note: OpenClaw documents eleven embedding providers
 * (docs/concepts/memory-search.md). This page only turns four of them into
 * one-click rows — the ones this page can genuinely verify and act on
 * (a real key, a reachable local server, or an installed plugin). The rest
 * (Bedrock, DeepInfra, Mistral, Voyage, GitHub Copilot, LM Studio,
 * OpenAI-compatible) are real and supported by OpenClaw, just not
 * self-service from here yet — they need `openclaw.json` edits this page
 * does not have a safe, verifiable path to make. Settings says so rather
 * than pretending the option isn't there.
 *
 * `memorySearch.provider` write values are the OpenClaw embedding-adapter ids
 * from docs/reference/memory-config.md — NOT the same namespace as
 * `models.providers.<id>` used for chat models (Gemini is "google" there,
 * "gemini" here). Getting this wrong means the config write silently fails
 * schema validation.
 */

export type ProviderRowId = "openai" | "gemini" | "ollama" | "local";

export const OPENAI_MODELS = [
  { model: "text-embedding-3-small", dims: 1536, label: "Standard", description: "Fast and inexpensive. The right default." },
  { model: "text-embedding-3-large", dims: 3072, label: "Higher quality", description: "Better recall, costs more per file." },
] as const;

/** Default local GGUF model — auto-downloads (~0.6 GB) once the plugin is installed. */
export const DEFAULT_LOCAL_MODEL_PATH =
  "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";

export const LOCAL_EMBEDDING_PLUGIN_INSTALL_COMMAND =
  "openclaw plugins install @openclaw/llama-cpp-provider";

export const PROVIDER_ROWS: Record<
  ProviderRowId,
  { label: string; blurb: string; keyLabel?: string }
> = {
  openai: {
    label: "OpenAI",
    blurb: "The most widely used option. Needs an OpenAI API key.",
    keyLabel: "OpenAI API key",
  },
  gemini: {
    label: "Google Gemini",
    blurb: "Google's embedding model. Free tier available. Needs a Gemini API key.",
    keyLabel: "Gemini API key",
  },
  ollama: {
    label: "Ollama",
    blurb: "Runs on this machine through a local Ollama server. No key, no cost, no data leaves the machine.",
  },
  local: {
    label: "Built-in local model",
    blurb: "Runs on this machine with no separate server. No key, no cost. Downloads a small model the first time.",
  },
};

/** Matches a `memorySearch` provider+model pair to one of the four rows this page manages. */
export function matchProviderRow(provider: string, model: string): ProviderRowId | null {
  if (provider === "openai") return "openai";
  if (provider === "gemini") return "gemini";
  if (provider === "ollama") return "ollama";
  if (provider === "local") return "local";
  void model;
  return null;
}
