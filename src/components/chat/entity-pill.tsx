"use client";

import {
  Brain,
  FileText,
  FileCode,
  FileJson,
  Folder,
  Wrench,
  Bot,
  Terminal,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Inline entity pills.
 *
 * Chat text is full of references — a file the agent read, a memory page, a
 * tool it called. Rendered as plain text they disappear into the sentence;
 * rendered as code they all look identical. A pill gives each reference a
 * recognisable shape and a glanceable icon, so "which file did it touch?" is
 * answerable without reading.
 *
 * Style follows the product's reference language: fully rounded, tinted
 * background, no hard border, small leading icon, label in the accent colour.
 */

export type EntityKind = "file" | "memory" | "tool" | "agent" | "command";

/**
 * Returns the icon element directly rather than a component reference, so the
 * component identity is stable across renders.
 */
function EntityIcon({ kind, path }: { kind: EntityKind; path: string }) {
  const cls = "h-3 w-3 shrink-0 opacity-80";
  if (kind === "memory") return <Brain className={cls} />;
  if (kind === "tool") return <Wrench className={cls} />;
  if (kind === "agent") return <Bot className={cls} />;
  if (kind === "command") return <Terminal className={cls} />;

  // Files get a type-specific icon so a long path is readable at a glance.
  if (path.endsWith("/")) return <Folder className={cls} />;
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (["ts", "tsx", "js", "jsx", "py", "sh", "rs", "go"].includes(ext)) {
    return <FileCode className={cls} />;
  }
  if (["json", "yaml", "yml", "toml"].includes(ext)) {
    return <FileJson className={cls} />;
  }
  return <FileText className={cls} />;
}

/** Long paths read better as ".../parent/file.md" than truncated at the end. */
function shortenPath(path: string, maxSegments = 2): string {
  const clean = path.replace(/^\.\//, "");
  const parts = clean.split("/").filter(Boolean);
  if (parts.length <= maxSegments) return clean;
  return `…/${parts.slice(-maxSegments).join("/")}`;
}

const TONE: Record<EntityKind, string> = {
  // Files get their tone from the format instead (see fileTone).
  file: "bg-muted text-fg-secondary",
  memory: "bg-brand-subtle text-brand-text",
  // Machine references stay neutral: they are what the agent did, not what
  // the user brought.
  tool: "bg-muted text-fg-secondary",
  command: "bg-muted text-fg-secondary",
  agent: "bg-muted text-fg-secondary",
};

/**
 * Format families, coloured the way desktop apps colour their icons —
 * spreadsheets green, documents blue, data amber. Tints are kept low so a
 * paragraph of references still reads as text, not as confetti.
 */
const FILE_TONES: Array<{ exts: string[]; tone: string }> = [
  { exts: ["xlsx", "xls", "csv", "tsv", "numbers"], tone: "bg-success-bg text-success-fg" },
  { exts: ["doc", "docx", "rtf", "pages", "odt"], tone: "bg-info-bg text-info-fg" },
  { exts: ["pdf"], tone: "bg-danger-bg text-danger-fg" },
  { exts: ["md", "markdown", "txt"], tone: "bg-brand-subtle text-brand-text" },
  { exts: ["json", "yaml", "yml", "toml", "xml"], tone: "bg-warning-bg text-warning-fg" },
  { exts: ["png", "jpg", "jpeg", "gif", "svg", "webp", "heic"], tone: "bg-info-bg text-info-fg" },
];

function fileTone(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  for (const entry of FILE_TONES) {
    if (entry.exts.includes(ext)) return entry.tone;
  }
  // Code and everything unrecognised stay neutral.
  return "bg-muted text-fg-secondary";
}

type Props = {
  kind: EntityKind;
  label: string;
  title?: string;
  className?: string;
};

/**
 * Clicking a command in a reply loads it into the composer, ready to send.
 * A DOM event keeps the pill decoupled from the composer — the markdown
 * renderer has no reference to it, and the composer owns its own state.
 */
export const INSERT_COMMAND_EVENT = "mc:insert-command";

export function emitInsertCommand(command: string) {
  window.dispatchEvent(
    new CustomEvent(INSERT_COMMAND_EVENT, { detail: command }),
  );
}

export function EntityPill({ kind, label, title, className }: Props) {
  const display =
    kind === "file" && label.includes("/") ? shortenPath(label) : label;

  const classes = cn(
    "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5",
    "align-baseline text-[12.5px] font-medium leading-5",
    kind === "file" ? fileTone(label) : TONE[kind],
    className,
  );

  if (kind === "command") {
    return (
      <button
        type="button"
        title={`Use ${label}`}
        onClick={() => emitInsertCommand(label)}
        className={cn(
          classes,
          "cursor-pointer transition-colors hover:bg-secondary hover:text-foreground",
        )}
      >
        <EntityIcon kind={kind} path={label} />
        <span className="truncate">{display}</span>
      </button>
    );
  }

  return (
    <span
      title={title ?? label}
      className={cn(
        "mx-0.5 inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5",
        "align-baseline text-[12.5px] font-medium leading-5",
        kind === "file" ? fileTone(label) : TONE[kind],
        className,
      )}
    >
      <EntityIcon kind={kind} path={label} />
      <span className="truncate">{display}</span>
    </span>
  );
}

/* ── detection ─────────────────────────────────────── */

const MEMORY_RE = /^(~?\/?)(memory|brain)\//i;
const FILE_RE =
  /^(~\/|\.\/|\/)?[\w.-]+(\/[\w.@-]+)*\.(md|markdown|ts|tsx|js|jsx|json|ya?ml|toml|txt|csv|log|sh|py|rs|go|sql|css|html)$/i;
const PATH_LIKE_RE = /^(~\/|\.\/|\/)[\w./@-]+$/;
const TOOL_RE = /^[a-z][a-z0-9_]*(_[a-z0-9]+)+$/; // snake_case, e.g. memory_search
const COMMAND_RE = /^\/[a-z][a-z0-9-]*$/i;

/**
 * Classify an inline code token. Returns null when it is ordinary code and
 * should keep its monospace treatment — pills are for references, not for
 * every backticked word.
 */
export function classifyInlineToken(raw: string): EntityKind | null {
  const t = raw.trim();
  if (!t || t.length > 120 || /\s/.test(t)) return null;
  if (COMMAND_RE.test(t)) return "command";
  if (MEMORY_RE.test(t)) return "memory";
  if (FILE_RE.test(t) || PATH_LIKE_RE.test(t)) return "file";
  if (TOOL_RE.test(t)) return "tool";
  return null;
}
