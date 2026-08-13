/**
 * Native OpenClaw memory — SERVER-ONLY. The single source of truth for the
 * Memory page. Reads/writes the real MEMORY.md and DREAMS.md, and drives the
 * promotion pipeline via `openclaw memory {status,promote,promote-explain,index}`.
 * Nothing is fabricated: an empty brain shows an empty brain.
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { runCli, runCliJson, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import {
  parseMemoryEntries,
  parseReflections,
  type MemoryEntry,
  type MemorySnapshot,
  type MemoryStatus,
  type PromotionCandidate,
} from "./memory-native-types";

export * from "./memory-native-types";

interface StatusRow {
  agentId?: string;
  status?: {
    backend?: string;
    files?: number;
    chunks?: number;
    dirty?: boolean;
    provider?: string;
    model?: string;
    workspaceDir?: string;
  };
}

async function readStatusRows(): Promise<StatusRow[]> {
  try {
    const rows = await runCliJson<StatusRow[]>(["memory", "status"], 15_000);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

async function resolveWorkspace(rows: StatusRow[]): Promise<string> {
  const fromStatus = rows[0]?.status?.workspaceDir;
  if (fromStatus) return fromStatus;
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return join(home, ".openclaw", "workspace");
}

async function readMemoryFile(ws: string): Promise<{ raw: string; path: string }> {
  const upper = join(ws, "MEMORY.md");
  try {
    return { raw: await readFile(upper, "utf-8"), path: upper };
  } catch {
    const lower = join(ws, "memory.md");
    try {
      return { raw: await readFile(lower, "utf-8"), path: lower };
    } catch {
      return { raw: "# Memory\n", path: upper };
    }
  }
}

interface RawCandidate {
  key?: string;
  id?: string;
  score?: number;
  finalScore?: number;
  snippet?: string;
  text?: string;
  content?: string;
  reason?: string;
}

async function readCandidates(): Promise<PromotionCandidate[]> {
  try {
    const raw = await runCliJson<{ candidates?: RawCandidate[] }>(["memory", "promote"], 20_000);
    const list = Array.isArray(raw?.candidates) ? raw.candidates : [];
    return list.map((c, i) => ({
      key: String(c.key || c.id || `candidate-${i}`),
      score: typeof c.finalScore === "number" ? c.finalScore : typeof c.score === "number" ? c.score : null,
      snippet: String(c.snippet || c.text || c.content || "").trim(),
      reason: c.reason ? String(c.reason) : undefined,
    }));
  } catch {
    return [];
  }
}

export async function getMemorySnapshot(): Promise<MemorySnapshot> {
  const rows = await readStatusRows();
  const ws = await resolveWorkspace(rows);
  const [{ raw: memMd }, dreamMd, candidates] = await Promise.all([
    readMemoryFile(ws),
    readFile(join(ws, "DREAMS.md"), "utf-8").catch(() => ""),
    readCandidates(),
  ]);
  const { entries, preamble } = parseMemoryEntries(memMd);
  const reflections = parseReflections(dreamMd);
  const st = rows[0]?.status;
  const status: MemoryStatus | null = st
    ? {
        backend: st.backend,
        files: st.files ?? 0,
        chunks: st.chunks ?? 0,
        dirty: Boolean(st.dirty),
        provider: st.provider,
        model: st.model,
      }
    : null;
  return { entries, reflections, candidates, status, preamble };
}

// ── writes (MEMORY.md is the durable store) ─────────────────────────────────

function entryBlock(heading: string, body: string): string {
  return `## ${heading.trim()}\n\n${body.trim()}\n`;
}

async function loadForWrite(): Promise<{ ws: string; path: string; raw: string; entries: MemoryEntry[] }> {
  const rows = await readStatusRows();
  const ws = await resolveWorkspace(rows);
  const { raw, path } = await readMemoryFile(ws);
  const { entries } = parseMemoryEntries(raw);
  return { ws, path, raw, entries };
}

async function persist(path: string, next: string): Promise<void> {
  await writeFile(path, next.replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n", "utf-8");
  // Re-embed in the background so the save returns instantly. The file is the
  // durable truth; the incremental index catches up within a moment.
  void runCli(["memory", "index"], CONFIG_WRITE_TIMEOUT_MS).catch(() => {});
}

export async function addMemory(heading: string, body: string): Promise<void> {
  if (!heading.trim()) throw new Error("A title is required");
  if (!body.trim()) throw new Error("A memory can't be empty");
  const { path, raw } = await loadForWrite();
  const base = raw.replace(/\s+$/, "");
  await persist(path, `${base}\n\n${entryBlock(heading, body)}`);
}

export async function updateMemory(id: string, heading: string, body: string): Promise<void> {
  if (!heading.trim() || !body.trim()) throw new Error("Title and memory are both required");
  const { path, raw, entries } = await loadForWrite();
  const target = entries.find((e) => e.id === id);
  if (!target) throw new Error("That memory no longer exists");
  const next = raw.slice(0, target.start) + entryBlock(heading, body) + raw.slice(target.end);
  await persist(path, next);
}

export async function deleteMemory(id: string): Promise<void> {
  const { path, raw, entries } = await loadForWrite();
  const target = entries.find((e) => e.id === id);
  if (!target) throw new Error("That memory no longer exists");
  const next = raw.slice(0, target.start) + raw.slice(target.end);
  await persist(path, next);
}

// ── promotion pipeline ──────────────────────────────────────────────────────

/** Promote ranked short-term recalls into MEMORY.md, then re-index. */
export async function promoteCandidates(): Promise<void> {
  await runCli(["memory", "promote", "--apply"], CONFIG_WRITE_TIMEOUT_MS);
  await runCli(["memory", "index"], CONFIG_WRITE_TIMEOUT_MS).catch(() => {});
}

export async function explainCandidate(selector: string): Promise<string> {
  const sel = String(selector || "").trim();
  if (!sel) throw new Error("A candidate selector is required");
  return runCli(["memory", "promote-explain", sel], 20_000);
}

/** Rebuild the semantic index over the memory files. */
export async function reindexMemory(force = false): Promise<void> {
  const args = ["memory", "index"];
  if (force) args.push("--force");
  await runCli(args, Math.max(CONFIG_WRITE_TIMEOUT_MS, 120_000));
}
