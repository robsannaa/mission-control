/**
 * Knowledge-graph extraction settings + LLM calls for the memory graph.
 *
 * The user decides where extraction prompts go (product decision):
 *   - "gateway": through the local gateway's OpenAI-compatible
 *     POST /v1/responses endpoint (same auth pattern as chat/stream) —
 *     memory content never leaves the machine unless the user's own
 *     gateway model routes it somewhere.
 *   - "openai": directly to api.openai.com, but ONLY with a key the user
 *     explicitly saved in Mission Control settings. Keys found in
 *     ~/.openclaw/.env are never auto-used — they are only surfaced as a
 *     suggestion the user must confirm (see findLegacyOpenAiKey).
 *   - "off": no LLM calls at all; the graph builds from wikilinks and
 *     deterministic markdown parsing only.
 *
 * Settings persist in $OPENCLAW_HOME/mission-control/settings.json — the
 * same Mission Control-owned state directory used by usage-db.ts and the
 * security audit cache. (The gateway config rejects unknown `settings.*`
 * keys, so the config.patch mechanism api/settings uses for timezone
 * cannot hold these.)
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { getGatewayToken, getGatewayUrl, getOpenClawHome } from "./paths";

// ── Settings ─────────────────────────────────────

export type ExtractionMode = "gateway" | "openai" | "off";

export type MemoryExtractionSettings = {
  mode: ExtractionMode;
  /** Gateway mode: backend model override (empty = agent default model).
   *  OpenAI mode: OpenAI model id (empty = gpt-4o-mini). */
  model: string;
  /** Only used when mode === "openai". Explicitly saved by the user. */
  openaiApiKey: string;
};

export const DEFAULT_EXTRACTION_SETTINGS: MemoryExtractionSettings = {
  mode: "gateway",
  model: "",
  openaiApiKey: "",
};

const SETTINGS_DIR = join(getOpenClawHome(), "mission-control");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

const VALID_MODES = new Set<ExtractionMode>(["gateway", "openai", "off"]);

function sanitizeSettings(raw: unknown): MemoryExtractionSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const mode = VALID_MODES.has(r.mode as ExtractionMode)
    ? (r.mode as ExtractionMode)
    : DEFAULT_EXTRACTION_SETTINGS.mode;
  return {
    mode,
    model: typeof r.model === "string" ? r.model.trim() : "",
    openaiApiKey: typeof r.openaiApiKey === "string" ? r.openaiApiKey.trim() : "",
  };
}

async function readSettingsFile(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_PATH, "utf-8"));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function readExtractionSettings(): Promise<MemoryExtractionSettings> {
  const file = await readSettingsFile();
  return sanitizeSettings(file.memoryExtraction);
}

export async function writeExtractionSettings(
  update: Partial<MemoryExtractionSettings>
): Promise<MemoryExtractionSettings> {
  const file = await readSettingsFile();
  const current = sanitizeSettings(file.memoryExtraction);
  const next = sanitizeSettings({ ...current, ...update });
  file.memoryExtraction = next;
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(file, null, 2) + "\n", "utf-8");
  return next;
}

/**
 * Detect (but never use) an OPENAI_API_KEY left in ~/.openclaw/.env by an
 * older Mission Control build. The settings UI offers it as an explicit
 * one-click import; extraction itself only ever reads the saved settings.
 */
export async function findLegacyOpenAiKey(): Promise<string | null> {
  try {
    const raw = await readFile(join(getOpenClawHome(), ".env"), "utf-8");
    const match = raw.match(/^OPENAI_API_KEY=(.+)$/m);
    const key = match?.[1]?.trim();
    return key || null;
  } catch {
    return null;
  }
}

// ── Extraction ───────────────────────────────────

export type ExtractedEntity = { name: string; type: string; summary: string };
export type ExtractedRelation = {
  subject: string;
  predicate: string;
  object: string;
  fact: string;
};
export type ExtractionResult = {
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
};

const VALID_ENTITY_TYPES = new Set(["person", "project", "tool", "concept", "preference"]);

export const EXTRACTION_SYSTEM_PROMPT = `Extract a rich knowledge graph from text. Return ONLY a JSON object with this exact schema:
{
  "entities": [{"name": "string", "type": "person|project|tool|concept|preference", "summary": "string"}],
  "relations": [{"subject": "string", "predicate": "string", "object": "string", "fact": "string"}]
}

Rules:
- Extract ALL meaningful named entities — be thorough, not just the most obvious ones
- subject and object must be entity names from your entities list
- Skip bare markdown formatting artifacts and meaningless placeholders
- person: named humans, roles, contacts (use "User" for the person writing these notes)
- project: software projects, apps, products, stores, businesses, brands, repositories
- tool: libraries, frameworks, CLIs, APIs, databases, services, platforms, skills, integrations
- concept: ideas, patterns, methodologies, markets, locations, business domains, strategies
- preference: explicit rules, constraints, or strong preferences ("always use X", "never do Y")
- predicates should be short action verbs: uses, prefers, owns, maintains, built_with, integrates, targets, sells_to, located_in, depends_on, manages
- Respond with the JSON object only — no prose, no code fences

Example input: "User prefers TypeScript. The second-brain project uses Next.js and SQLite."
Example output: {"entities":[{"name":"User","type":"person","summary":"The developer"},{"name":"second-brain","type":"project","summary":"Next.js knowledge management app"},{"name":"TypeScript","type":"tool","summary":"Programming language"},{"name":"Next.js","type":"tool","summary":"React framework"},{"name":"SQLite","type":"tool","summary":"Embedded database"}],"relations":[{"subject":"User","predicate":"prefers","object":"TypeScript","fact":"User prefers TypeScript"},{"subject":"second-brain","predicate":"uses","object":"Next.js","fact":"second-brain uses Next.js"},{"subject":"second-brain","predicate":"uses","object":"SQLite","fact":"second-brain uses SQLite"}]}`;

export function validateExtractionResult(data: unknown): ExtractionResult {
  if (!data || typeof data !== "object") return { entities: [], relations: [] };
  const d = data as Record<string, unknown>;

  const entities: ExtractedEntity[] = Array.isArray(d.entities)
    ? (d.entities as unknown[])
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .filter((e) => typeof e.name === "string" && e.name.length > 0)
        .map((e) => ({
          name: String(e.name).trim(),
          type: VALID_ENTITY_TYPES.has(String(e.type)) ? String(e.type) : "concept",
          summary: typeof e.summary === "string" ? e.summary.trim().slice(0, 200) : "",
        }))
    : [];

  const relations: ExtractedRelation[] = Array.isArray(d.relations)
    ? (d.relations as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .filter(
          (r) =>
            typeof r.subject === "string" && r.subject.length > 0 &&
            typeof r.predicate === "string" && r.predicate.length > 0 &&
            typeof r.object === "string" && r.object.length > 0
        )
        .map((r) => ({
          subject: String(r.subject).trim(),
          predicate: String(r.predicate).trim(),
          object: String(r.object).trim(),
          fact:
            typeof r.fact === "string" && r.fact.trim()
              ? r.fact.trim().slice(0, 300)
              : `${r.subject} ${r.predicate} ${r.object}`,
        }))
    : [];

  return { entities, relations };
}

/** Pull the first JSON object out of a model reply that may add prose/fences. */
function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("model reply contained no JSON object");
  }
  return JSON.parse(trimmed.slice(start, end + 1));
}

type OpenResponsesReply = {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  error?: { message?: string } | string;
};

/**
 * Gateway requests run as an agent turn (there is no raw-completion RPC), so
 * the whole task lives in the user message: framing it as an explicit
 * read-only extraction job is what keeps the agent from treating the memory
 * content as a chat message and acting on it (verified against a live
 * gateway — `instructions`-only framing made the agent try to edit files).
 */
function buildGatewayPrompt(content: string): string {
  return [
    "TASK: read-only knowledge extraction. You are being called programmatically by Mission Control to parse text into a knowledge graph.",
    "Do NOT use any tools. Do NOT edit or save any files. Do NOT store memories. Only analyze the text below and reply.",
    "",
    EXTRACTION_SYSTEM_PROMPT,
    "",
    "TEXT TO ANALYZE:",
    "<<<",
    content,
    ">>>",
  ].join("\n");
}

async function extractViaGateway(
  content: string,
  model: string
): Promise<ExtractionResult> {
  const gwUrl = await getGatewayUrl();
  const token = getGatewayToken();

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Backend model override — only when the user picked a specific model;
  // otherwise the gateway uses the default agent's configured model.
  if (model) headers["x-openclaw-model"] = model;

  let response: Response;
  try {
    response = await fetch(`${gwUrl}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "openclaw",
        input: buildGatewayPrompt(content),
        stream: false,
        max_output_tokens: 4000,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw new Error(`gateway unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (response.status === 404) {
      throw new Error(
        "gateway OpenResponses endpoint is disabled (gateway.http.endpoints.responses.enabled)"
      );
    }
    throw new Error(`gateway returned ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = (await response.json()) as OpenResponsesReply;
  const text = (data.output || [])
    .filter((item) => item?.type === "message")
    .flatMap((item) => item.content || [])
    .filter((chunk) => chunk?.type === "output_text" && typeof chunk.text === "string")
    .map((chunk) => String(chunk.text))
    .join("\n")
    .trim();

  if (!text) throw new Error("gateway model returned an empty reply");
  return validateExtractionResult(parseJsonObject(text));
}

async function extractViaOpenAi(
  content: string,
  model: string,
  apiKey: string
): Promise<ExtractionResult> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || "gpt-4o-mini",
      messages: [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 4000,
    }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI returned ${response.status}: ${text.slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("OpenAI returned an empty reply");
  return validateExtractionResult(parseJsonObject(raw));
}

/**
 * Run knowledge extraction on one chunk of text with the user's settings.
 * Throws (with a human-readable message) instead of silently returning an
 * empty result — callers surface the message as a { warning } / { error }.
 */
export async function extractKnowledge(
  content: string,
  settings: MemoryExtractionSettings
): Promise<ExtractionResult> {
  const truncated = content.slice(0, 8000);
  if (settings.mode === "off") {
    throw new Error("extraction is off");
  }
  if (settings.mode === "openai") {
    if (!settings.openaiApiKey) {
      throw new Error("no OpenAI API key configured in Mission Control settings");
    }
    return extractViaOpenAi(truncated, settings.model, settings.openaiApiKey);
  }
  return extractViaGateway(truncated, settings.model);
}
