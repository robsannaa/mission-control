"use client";

import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const baseComponents = {
  h1: ({ children, ...props }: React.ComponentPropsWithoutRef<"h1">) => (
    <h1
      className="mb-3 mt-6 text-xs font-semibold text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: React.ComponentPropsWithoutRef<"h2">) => (
    <h2
      className="mb-2 mt-5 text-xs font-semibold text-fg-secondary first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: React.ComponentPropsWithoutRef<"h3">) => (
    <h3
      className="mb-2 mt-4 text-sm font-semibold text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: React.ComponentPropsWithoutRef<"h4">) => (
    <h4
      className="mb-1.5 mt-3 text-sm font-medium text-fg-secondary first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),
  p: ({ children, ...props }: React.ComponentPropsWithoutRef<"p">) => (
    <p className="mb-2 text-sm leading-7 text-muted-foreground" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }: React.ComponentPropsWithoutRef<"ul">) => (
    <ul
      className="my-2 list-inside list-disc space-y-1 text-muted-foreground"
      {...props}
    >
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: React.ComponentPropsWithoutRef<"ol">) => (
    <ol
      className="my-2 list-inside list-decimal space-y-1 text-muted-foreground"
      {...props}
    >
      {children}
    </ol>
  ),
  li: ({ children, ...props }: React.ComponentPropsWithoutRef<"li">) => (
    <li className="text-sm text-muted-foreground" {...props}>
      {children}
    </li>
  ),
  hr: (props: React.ComponentPropsWithoutRef<"hr">) => (
    <hr className="my-4 border-foreground/10" {...props} />
  ),
  strong: ({ children, ...props }: React.ComponentPropsWithoutRef<"strong">) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }: React.ComponentPropsWithoutRef<"em">) => (
    <em className="italic text-fg-secondary" {...props}>
      {children}
    </em>
  ),
  code: ({ children, ...props }: React.ComponentPropsWithoutRef<"code">) => (
    <code
      className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm text-fg-secondary"
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({ children, ...props }: React.ComponentPropsWithoutRef<"pre">) => (
    <pre
      className="my-3 overflow-x-auto rounded-lg bg-muted/80 p-4 text-sm text-fg-secondary"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"blockquote">) => (
    <blockquote
      className="my-2 border-l-2 border-border-strong pl-4 italic text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  a: ({
    href,
    children,
    ...props
  }: React.ComponentPropsWithoutRef<"a">) => (
    <a
      href={href}
      className="text-fg-secondary hover:underline"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  table: ({ children, ...props }: React.ComponentPropsWithoutRef<"table">) => (
    <div className="my-4 overflow-x-auto">
      <table
        className="min-w-full border-collapse border border-foreground/10 text-sm text-muted-foreground"
        {...props}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, ...props }: React.ComponentPropsWithoutRef<"th">) => (
    <th
      className="border border-foreground/10 bg-muted/60 px-3 py-2 text-left text-sm font-medium text-foreground"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: React.ComponentPropsWithoutRef<"td">) => (
    <td className="border border-foreground/10 px-3 py-2 text-sm" {...props}>
      {children}
    </td>
  ),
  tr: ({ children, ...props }: React.ComponentPropsWithoutRef<"tr">) => (
    <tr className="border-b border-foreground/10" {...props}>
      {children}
    </tr>
  ),
};

export function MarkdownContent({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const source = typeof content === "string" ? content : "";
  if (!source.trim()) {
    return (
      <p className={cn("text-sm italic text-fg-subtle", className)}>
        No content
      </p>
    );
  }
  return (
    <div className={cn("space-y-1", className)}>
      <ReactMarkdown
        key={source.length}
        remarkPlugins={[remarkGfm]}
        components={baseComponents}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
