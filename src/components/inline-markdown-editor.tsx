"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { SaveShortcut } from "@/components/ui/save-shortcut";

/* ── types ────────────────────────────────────────── */

type Props = {
  /** The markdown source string */
  content: string;
  /** Called with the new markdown string when content changes (debounced) */
  onContentChange: (markdown: string) => void;
  /** Called once on blur after final save */
  onBlur?: () => void;
  /** Called on Cmd+S — receives current markdown; return value ignored */
  onSave?: (markdown: string) => void;
  /** Extra classes for the container */
  className?: string;
  /** Placeholder when content is empty */
  placeholder?: string;
  /** Initial panel mode */
  defaultMode?: "preview" | "edit";
  /** Line number to scroll to (finds nearest heading at/before this line) */
  scrollToLine?: number | null;
};

/* ── Heading ID helper ──────────────────────────────── */

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return extractText((children as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

/* ── Preview styling (matches MarkdownContent / docs) ── */

const previewComponents = {
  h1: ({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1 id={slugify(extractText(children))} className="mb-3 mt-6 text-base font-semibold text-foreground first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2 id={slugify(extractText(children))} className="mb-2 mt-5 text-sm font-semibold text-muted-foreground dark:text-fg-secondary first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3 id={slugify(extractText(children))} className="mb-2 mt-4 text-sm font-semibold text-foreground first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: React.ComponentPropsWithoutRef<"h4">) => (
    <h4 id={slugify(extractText(children))} className="mb-1.5 mt-3 text-sm font-medium text-fg-secondary first:mt-0" {...props}>
      {children}
    </h4>
  ),
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<"p">) => (
    <p className="mb-2 text-sm leading-relaxed text-muted-foreground" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
    <ul className="my-2 list-inside list-disc space-y-1 pl-4 text-muted-foreground" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
    <ol className="my-2 list-inside list-decimal space-y-1 pl-4 text-muted-foreground" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<"li">) => (
    <li className="text-sm text-muted-foreground" {...props}>
      {children}
    </li>
  ),
  code: ({ children, ...props }: React.ComponentPropsWithoutRef<"code">) => (
    <code
      className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-xs text-foreground"
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre
      className="my-3 overflow-x-auto rounded-lg bg-foreground/[0.04] p-3 text-xs text-foreground"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="my-2 border-l-2 border-border-strong pl-4 italic text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children, ...props }: React.ComponentPropsWithoutRef<"a">) => (
    <a
      href={href}
      className="text-muted-foreground dark:text-fg-secondary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }: React.ComponentPropsWithoutRef<"table">) => (
    <div className="my-3 overflow-x-auto">
      <table className="min-w-full border-collapse border border-foreground/10 text-sm" {...props}>
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.ComponentPropsWithoutRef<"th">) => (
    <th className="border border-foreground/10 bg-foreground/[0.04] px-3 py-2 text-left text-sm font-medium" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.ComponentPropsWithoutRef<"td">) => (
    <td className="border border-foreground/10 px-3 py-2 text-sm text-muted-foreground" {...props}>
      {children}
    </td>
  ),
  hr: (props: React.ComponentPropsWithoutRef<"hr">) => <hr className="my-4 border-foreground/10" {...props} />,
  strong: ({ children, ...props }: React.ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: React.ComponentPropsWithoutRef<"em">) => (
    <em className="italic text-foreground" {...props}>
      {children}
    </em>
  ),
};

/* ── component ───────────────────────────────────── */

export function InlineMarkdownEditor({
  content,
  onContentChange,
  onBlur,
  onSave,
  className,
  placeholder = "Write your markdown here…",
  defaultMode = "preview",
  scrollToLine,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [localValue, setLocalValue] = useState(content);
  const [isEditing, setIsEditing] = useState(defaultMode === "edit");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmittedRef = useRef(content);

  // Sync local value when content prop changes (e.g. load new doc)
  useEffect(() => {
    if (content !== lastEmittedRef.current) {
      lastEmittedRef.current = content;
      queueMicrotask(() => setLocalValue(content));
    }
  }, [content]);

  useEffect(() => {
    setIsEditing(defaultMode === "edit");
  }, [defaultMode]);

  // Scroll to the nearest heading at/before scrollToLine
  useEffect(() => {
    if (!scrollToLine || isEditing) return;
    const timer = setTimeout(() => {
      const container = previewRef.current;
      if (!container) return;

      const lines = localValue.split("\n");
      let bestSlug = "";
      for (let i = 0; i < Math.min(scrollToLine, lines.length); i++) {
        const match = lines[i].match(/^#{1,4}\s+(.+)/);
        if (match) bestSlug = slugify(match[1].trim());
      }

      if (bestSlug) {
        const el = container.querySelector(`#${CSS.escape(bestSlug)}`);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
          el.classList.add("bg-muted-foreground/20", "rounded", "transition-colors");
          setTimeout(() => el.classList.remove("bg-muted-foreground/20", "rounded", "transition-colors"), 2000);
          return;
        }
      }

      const scrollable = container;
      const ratio = scrollToLine / Math.max(lines.length, 1);
      scrollable.scrollTop = ratio * scrollable.scrollHeight;
    }, 150);
    return () => clearTimeout(timer);
  }, [scrollToLine, isEditing, localValue]);

  useEffect(() => {
    if (isEditing) textareaRef.current?.focus();
  }, [isEditing]);

  const emitChange = useCallback(
    (md: string) => {
      if (md === lastEmittedRef.current) return;
      lastEmittedRef.current = md;
      onContentChange(md);
    },
    [onContentChange]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setLocalValue(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => emitChange(value), 400);
    },
    [emitChange]
  );

  const handleBlur = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (lastEmittedRef.current !== localValue) {
      lastEmittedRef.current = localValue;
      onContentChange(localValue);
    }
    onBlur?.();
  }, [localValue, onContentChange, onBlur]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Escape") {
        textareaRef.current?.blur();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (lastEmittedRef.current !== localValue) {
          lastEmittedRef.current = localValue;
          onContentChange(localValue);
        }
        onSave?.(localValue);
      }
    },
    [localValue, onContentChange, onSave]
  );

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col rounded-lg border border-foreground/[0.08] bg-foreground/[0.02] overflow-hidden",
        className
      )}
    >
      <div className="border-b border-foreground/[0.06] bg-card/30 px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {isEditing ? "Editor" : "Preview"}
          </p>
          <button
            type="button"
            onClick={() => {
              if (isEditing) textareaRef.current?.blur();
              setIsEditing((prev) => !prev);
            }}
            className="rounded-md border border-foreground/10 px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-pressed={isEditing}
            aria-label={isEditing ? "Switch to preview mode" : "Switch to edit mode"}
          >
            {isEditing ? "Preview" : "Edit"}
          </button>
        </div>
      </div>

      {isEditing ? (
        <textarea
          ref={textareaRef}
          value={localValue}
          onChange={handleChange}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          spellCheck={true}
          className={cn(
            "h-full min-h-0 w-full flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 text-sm text-foreground placeholder:text-fg-subtle",
            "focus:outline-none focus:ring-0",
            "font-mono leading-relaxed text-muted-foreground"
          )}
          aria-label="Markdown editor"
        />
      ) : (
        <div ref={previewRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <div className="h-full text-left">
            {localValue.trim() ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={previewComponents}>
                {localValue}
              </ReactMarkdown>
            ) : (
              <p className="text-sm italic text-fg-subtle">Nothing to preview yet.</p>
            )}
          </div>
        </div>
      )}

      {isEditing && (
        <div className="border-t border-foreground/[0.06] bg-card/20 px-4 py-2 text-[11px] text-muted-foreground">
          Press <SaveShortcut keyClassName="text-[10px]" /> to save.
        </div>
      )}
    </div>
  );
}
