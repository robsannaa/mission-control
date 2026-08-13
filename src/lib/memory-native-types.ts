/**
 * Native OpenClaw memory — CLIENT-SAFE types + parsers (no server imports).
 *
 * Everything here is grounded in OpenClaw's REAL memory model — nothing is
 * fabricated:
 *   - MEMORY.md   long-term memories the agent keeps (## heading + body)
 *   - DREAMS.md   REM reflections the agent wrote while "dreaming"
 *   - promote     short-term recalls ranked for promotion, with scores
 *   - status      the semantic index (files / chunks / embedding model)
 *
 * The server module `@/lib/memory-native` re-exports these.
 */

export interface MemoryEntry {
  id: string;
  heading: string;
  body: string;
  /** Character offsets of this entry's block within the raw file, for edits. */
  start: number;
  end: number;
}

export interface Reflection {
  id: string;
  timestamp: string; // as written in DREAMS.md, e.g. "August 10, 2026 at 3:00 AM GMT+2"
  text: string;
}

export interface PromotionCandidate {
  key: string;
  score: number | null;
  snippet: string;
  reason?: string;
}

export interface MemoryStatus {
  backend?: string;
  files: number;
  chunks: number;
  dirty: boolean;
  provider?: string;
  model?: string;
}

export interface MemorySnapshot {
  entries: MemoryEntry[];
  reflections: Reflection[];
  candidates: PromotionCandidate[];
  status: MemoryStatus | null;
  /** The MEMORY.md preamble (title + intro before the first ## entry). */
  preamble: string;
}

function slug(heading: string, index: number): string {
  const base = heading
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `${base}-${index}` : `entry-${index}`;
}

/**
 * Parse MEMORY.md into discrete memories. Each `## heading` starts a memory;
 * its body runs until the next `## ` (or EOF). The `# Title` and any intro
 * before the first `##` is returned separately as the preamble.
 */
export function parseMemoryEntries(raw: string): { entries: MemoryEntry[]; preamble: string } {
  const text = String(raw || "").replace(/\r/g, "");
  const headingRe = /^##[ \t]+(.+)$/gm;
  const matches: Array<{ heading: string; index: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ heading: m[1]!.trim(), index: m.index });
  }
  const preamble = (matches[0] ? text.slice(0, matches[0].index) : text).trim();
  const entries: MemoryEntry[] = matches.map((h, i) => {
    const start = h.index;
    const end = i + 1 < matches.length ? matches[i + 1]!.index : text.length;
    const block = text.slice(start, end);
    const body = block.replace(/^##[ \t]+.+\n?/, "").trim();
    return { id: slug(h.heading, i), heading: h.heading, body, start, end };
  });
  return { entries, preamble };
}

const DIARY_START = "<!-- openclaw:dreaming:diary:start -->";

/**
 * Parse DREAMS.md into reflections. Entries are `---`-separated blocks that open
 * with an italic `*timestamp*` line, followed by the reflection text.
 */
export function parseReflections(raw: string): Reflection[] {
  const text = String(raw || "").replace(/\r/g, "");
  const startAt = text.indexOf(DIARY_START);
  const body = startAt >= 0 ? text.slice(startAt + DIARY_START.length) : text;
  const blocks = body.split(/^---[ \t]*$/m);
  const out: Reflection[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const tsMatch = trimmed.match(/^\*(.+?)\*\s*/);
    const timestamp = tsMatch ? tsMatch[1]!.trim() : "";
    const content = (tsMatch ? trimmed.slice(tsMatch[0].length) : trimmed).trim();
    if (!content && !timestamp) continue;
    out.push({ id: `reflection-${out.length}`, timestamp, text: content });
  }
  // Newest first (DREAMS.md appends chronologically).
  return out.reverse();
}

/** True when a reflection carries no real content (a barren REM run). */
export function isBarrenReflection(r: Reflection): boolean {
  return /details were unavailable|no memory trace|nothing surfaced/i.test(r.text) || r.text.length < 12;
}

/** A short one-line lead for a memory body (first sentence / line). */
export function memoryLead(body: string, max = 160): string {
  const firstLine = body.split("\n").find((l) => l.trim()) ?? "";
  const clean = firstLine.replace(/^[-*]\s+/, "").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function scoreTone(score: number | null): "success" | "warning" | "secondary" {
  if (score == null) return "secondary";
  if (score >= 0.66) return "success";
  if (score >= 0.33) return "warning";
  return "secondary";
}
