"use client";

import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityPill, classifyInlineToken } from "@/components/chat/entity-pill";
import { FileHoverCard } from "@/components/chat/file-hover-card";

/**
 * Message markdown.
 *
 * Body copy is 14px with a 1.7 line box and the column is capped near 72
 * characters upstream — the two things that decide whether a transcript is
 * comfortable to read. Code blocks own their own copy affordance rather than
 * relying on a hover toolbar, which is unreachable on touch.
 */

function useCopy(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = useCallback((text: string) => {
    const done = () => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {});
      return;
    }
    done();
  }, []);

  return [copied, copy];
}

export function CopyButton({
  value,
  label = "Copy",
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      onClick={() => copy(value)}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-success-fg" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span>{copied ? "Copied" : label}</span>
    </button>
  );
}

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (typeof node === "object" && "props" in (node as never)) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return nodeText(props?.children);
  }
  return "";
}

function CodeBlock({ children }: { children: ReactNode }) {
  const raw = nodeText(children).replace(/\n$/, "");
  const language =
    (Array.isArray(children) ? children[0] : children) &&
    typeof children === "object" &&
    "props" in (children as never)
      ? String(
          (children as { props?: { className?: string } }).props?.className ?? "",
        ).replace("language-", "")
      : "";

  return (
    <div className="group/code relative my-3 overflow-hidden rounded-lg border border-border bg-muted">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-muted-foreground">
          {language || "code"}
        </span>
        <CopyButton value={raw} className="-mr-1" />
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 text-[13px] leading-relaxed">
        {children}
      </pre>
    </div>
  );
}

const components: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  p: ({ children, ...props }) => (
    <p className="mb-3 leading-7 last:mb-0" {...props}>
      {children}
    </p>
  ),
  h1: ({ children, ...props }) => (
    <h1 className="mb-2 mt-5 text-[15px] font-semibold first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }) => (
    <h2 className="mb-2 mt-5 text-[15px] font-semibold first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mb-1.5 mt-4 text-sm font-semibold first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }) => (
    <h4 className="mb-1.5 mt-4 text-sm font-medium first:mt-0" {...props}>
      {children}
    </h4>
  ),
  ul: ({ children, ...props }) => (
    <ul className="my-3 list-disc space-y-1.5 pl-5 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="my-3 list-decimal space-y-1.5 pl-5 last:mb-0" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-7 [&>p]:mb-1" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  code: ({ className, children, ...props }) => {
    if (className?.includes("language-")) {
      return (
        <code className={cn("block font-mono", className)} {...props}>
          {children}
        </code>
      );
    }
    // A backticked token that names a file, memory page, tool or command is a
    // reference, not code — give it a recognisable pill rather than blending
    // every backticked word into one grey monospace mass.
    const raw =
      typeof children === "string"
        ? children
        : Array.isArray(children) &&
            children.length === 1 &&
            typeof children[0] === "string"
          ? children[0]
          : null;
    const kind = raw ? classifyInlineToken(raw) : null;
    if (raw && (kind === "file" || kind === "memory")) {
      // Files and memory pages are real things on disk: hovering previews them,
      // clicking opens them in Documents.
      return (
        <FileHoverCard path={raw.trim()}>
          <EntityPill kind={kind} label={raw.trim()} />
        </FileHoverCard>
      );
    }
    if (raw && kind === "command") {
      return <EntityPill kind={kind} label={raw.trim()} />;
    }
    return (
      <code
        className="rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[12.5px] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="my-3 border-l-2 border-border-strong pl-4 text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children, ...props }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline decoration-border-strong underline-offset-2 transition-colors hover:decoration-foreground"
      {...props}
    >
      {children}
    </a>
  ),
  hr: (props) => <hr className="my-5 border-border" {...props} />,
  table: ({ children, ...props }) => (
    <div className="my-4 w-full overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-[13px]" {...props}>
        {children}
      </table>
    </div>
  ),
  tr: ({ children, ...props }) => (
    <tr className="border-b border-border last:border-0" {...props}>
      {children}
    </tr>
  ),
  th: ({ children, ...props }) => (
    <th
      className="bg-muted px-3 py-2 text-left font-medium text-foreground"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="px-3 py-2 align-top" {...props}>
      {children}
    </td>
  ),
};


/**
 * The gateway writes chat output as loosely-formatted prose: tool names appear
 * bare ("Built-in tools apply_patch, create_goal, ..."), slash commands appear
 * bare ("/session - Manage session-level settings"), and lines are separated by
 * single newlines. Markdown collapses single newlines into spaces, which turned
 * a readable command list into one run-on paragraph.
 *
 * This pass restores intent without touching anything the author marked up:
 *   - identifier tokens  -> code spans  (monospace chips)
 *   - bare /commands     -> code spans  (rendered as pills downstream)
 *   - single newlines    -> hard breaks (two trailing spaces)
 * Fenced blocks and existing inline code are passed through untouched.
 */
const IDENTIFIER_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

// A slash command: not preceded by a word character or slash (so URLs and
// paths are skipped) and not followed by one (so "/tmp/openclaw" is skipped).
const SLASH_COMMAND_RE = /(^|[^\w/])(\/[a-z][a-z0-9-]*)(?![\w/-])/g;

// Bare filenames and paths in prose ("view/edit MEMORY.md") are references
// too — mark them up so they render as pills instead of vanishing into the
// sentence. The trailing lookahead keeps URLs and sentence punctuation intact.
const FILE_TOKEN_RE =
  /(^|[\s(\[])((?:[\w.-]+\/)*[\w.-]+\.(?:md|markdown|txt|json|ya?ml|toml|csv|log|tsx?|jsx?|py|sh|rs|go|sql|css|html|pdf|xlsx?|docx?|png|jpe?g|gif|svg))(?=$|[\s),.:;\]])/g;

function markUpProse(segment: string): string {
  return segment
    .replace(FILE_TOKEN_RE, (_m, before, file) => `${before}\`${file}\``)
    .replace(IDENTIFIER_RE, (match) => `\`${match}\``)
    .replace(SLASH_COMMAND_RE, (_m, before, cmd) => `${before}\`${cmd}\``);
}

/** Single newlines become hard breaks; blank-line paragraph breaks are kept. */
function preserveLineBreaks(segment: string): string {
  return segment.replace(/([^\n])\n(?!\n)/g, "$1  \n");
}

function prepareMarkdown(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((segment, i) => {
      // Odd indices are captured code spans/blocks — never touch them.
      if (i % 2 === 1) return segment;
      return preserveLineBreaks(markUpProse(segment));
    })
    .join("");
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {prepareMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
});
