"use client";

import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { EntityPill, classifyInlineToken } from "@/components/chat/entity-pill";

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
 * Agent output names tools inline as plain prose — "Built-in tools apply_patch,
 * create_goal, exec, ...". Backtick identifier-shaped tokens so they render as
 * monospace chips instead of dissolving into the sentence. Existing code spans
 * and fenced blocks are left exactly as authored.
 */
const IDENTIFIER_RE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

function markUpIdentifiers(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((segment, i) => {
      // Odd indices are the captured code spans/blocks — never touch them.
      if (i % 2 === 1) return segment;
      return segment.replace(IDENTIFIER_RE, (match) => `\`${match}\``);
    })
    .join("");
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="text-sm text-foreground">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markUpIdentifiers(text)}
      </ReactMarkdown>
    </div>
  );
});
