"use client";
/* eslint-disable @next/next/no-img-element */

import { memo, useState } from "react";
import type { FileUIPart, UIMessage } from "ai";
import { Check, ChevronRight, Loader2, Paperclip, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  CopyButton,
  Markdown,
  findJsonSpans,
  formatJsonSpan,
} from "@/components/chat/markdown";
import { EntityPill } from "@/components/chat/entity-pill";
import { FileHoverCard } from "@/components/chat/file-hover-card";

/**
 * The transcript.
 *
 * Deliberately not a messenger: assistant turns are plain type on the page
 * background at a ~70ch measure, and a user turn is at most a quiet rounded
 * container. No avatars, no bubbles on both sides, no timestamps welded inside
 * the text. Metadata (time, copy) appears on hover so a still transcript is
 * only words.
 */

/* ── Tool activity markers ────────────────────────────────────────────────── */

type ToolSegment = {
  type: "tool";
  callId: string;
  toolName: string;
  displayName: string;
  args?: string;
  done: boolean;
  isAgent: boolean;
};
type TextSegment = { type: "text"; text: string };
type Segment = TextSegment | ToolSegment;

const TOOL_START_RE = /\u200B\[\[TOOL_START:([^:]*):([^:]*):([^\]]*)\]\]\u200B/g;
const TOOL_ARGS_RE = /\u200B\[\[TOOL_ARGS:([^:]*):([^\]]*)\]\]\u200B/g;
const TOOL_END_RE = /\u200B\[\[TOOL_END:([^\]]*)\]\]\u200B/g;
const AGENT_START_RE = /\u200B\[\[AGENT_START:([^:]*):([^\]]*)\]\]\u200B/g;
const ALL_MARKERS_RE =
  /\u200B\[\[(?:TOOL_START|TOOL_ARGS|TOOL_END|AGENT_START):[^\]]*\]\]\u200B/g;

/** Strip the inline tool markers the stream route injects, for copy/plain use. */
export function stripMarkers(text: string): string {
  return text.replace(ALL_MARKERS_RE, "").trim();
}

export function parseSegments(text: string): Segment[] {
  if (!text.includes("\u200B[[")) {
    return text.trim() ? [{ type: "text", text }] : [];
  }

  const calls = new Map<string, ToolSegment>();
  let match: RegExpExecArray | null;

  TOOL_START_RE.lastIndex = 0;
  while ((match = TOOL_START_RE.exec(text)) !== null) {
    calls.set(match[1], {
      type: "tool",
      callId: match[1],
      toolName: match[2],
      displayName: match[3],
      done: false,
      isAgent: false,
    });
  }
  AGENT_START_RE.lastIndex = 0;
  while ((match = AGENT_START_RE.exec(text)) !== null) {
    calls.set(match[1], {
      type: "tool",
      callId: match[1],
      toolName: match[2],
      displayName: match[2],
      done: false,
      isAgent: true,
    });
  }
  TOOL_ARGS_RE.lastIndex = 0;
  while ((match = TOOL_ARGS_RE.exec(text)) !== null) {
    const call = calls.get(match[1]);
    if (call) call.args = match[2];
  }
  TOOL_END_RE.lastIndex = 0;
  while ((match = TOOL_END_RE.exec(text)) !== null) {
    const call = calls.get(match[1]);
    if (call) call.done = true;
  }

  const markers: string[] = [];
  ALL_MARKERS_RE.lastIndex = 0;
  while ((match = ALL_MARKERS_RE.exec(text)) !== null) markers.push(match[0]);

  const chunks = text.split(ALL_MARKERS_RE);
  const segments: Segment[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i += 1) {
    if (chunks[i].trim()) segments.push({ type: "text", text: chunks[i] });
    const marker = markers[i];
    if (!marker) continue;
    const inner = marker.replace(/\u200B/g, "").replace(/^\[\[|\]\]$/g, "");
    const callId = inner.slice(inner.indexOf(":") + 1).split(":")[0];
    const call = calls.get(callId);
    if (call && !seen.has(callId)) {
      seen.add(callId);
      segments.push(call);
    }
  }
  return segments;
}

function formatJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function ToolCall({ segment }: { segment: ToolSegment }) {
  const [open, setOpen] = useState(false);
  const label = segment.isAgent
    ? `Delegating to ${segment.displayName}`
    : segment.displayName;

  return (
    <div className="my-2.5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-muted/60 py-1 pl-2.5 pr-3 text-[12px] text-muted-foreground transition-colors",
          "hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <ChevronRight
          className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
        <Terminal className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{label}</span>
        {segment.done ? (
          <Check className="h-3 w-3 shrink-0 text-success-fg" aria-hidden />
        ) : (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        )}
      </button>
      {open && segment.args && (
        <pre className="mt-2 max-h-56 overflow-auto rounded-xl border border-border bg-muted px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
          {formatJson(segment.args)}
        </pre>
      )}
    </div>
  );
}

const MessageBody = memo(function MessageBody({ text }: { text: string }) {
  const segments = parseSegments(text);
  if (segments.length === 0) return null;
  return (
    <>
      {segments.map((segment, index) =>
        segment.type === "text" ? (
          <Markdown key={`t${index}`} text={segment.text.trim()} />
        ) : (
          <ToolCall key={segment.callId} segment={segment} />
        ),
      )}
    </>
  );
});

/* ── Rows ─────────────────────────────────────────────────────────────────── */

export type ChatMessageMeta = { timestamp?: number; source?: "command" };

function textOf(message: UIMessage): string {
  return (message.parts ?? [])
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function filesOf(message: UIMessage): FileUIPart[] {
  return (message.parts ?? []).filter(
    (part): part is FileUIPart => part.type === "file",
  );
}

function formatTime(value: number | undefined): string {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function MessageRow({
  message,
  isStreaming,
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";
  const text = textOf(message);
  const files = filesOf(message);
  const images = files.filter((file) => /^image\//i.test(file.mediaType ?? ""));
  const others = files.filter((file) => !/^image\//i.test(file.mediaType ?? ""));
  const meta = (message.metadata ?? {}) as ChatMessageMeta;
  const time = formatTime(meta.timestamp);

  const { body: userBody, paths: referencedPaths } = isUser
    ? splitReferenceFooter(text)
    : { body: text, paths: [] as string[] };
  // A reference the author never typed inline still deserves to be visible.
  const unmentionedPaths = referencedPaths.filter(
    (path) => !mentionTokensFor(path).some((token) => userBody.includes(token)),
  );

  if (isUser) {
    return (
      <div className="group/msg mb-7 flex flex-col items-end">
        <div className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-sm leading-7 text-foreground">
          {userBody ? (
            <span className="whitespace-pre-wrap">
              {renderUserBody(userBody, referencedPaths)}
            </span>
          ) : null}
          {unmentionedPaths.length > 0 && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              {unmentionedPaths.map((referenced) => (
                <FileHoverCard key={referenced} path={referenced}>
                  <EntityPill kind="file" label={referenced} />
                </FileHoverCard>
              ))}
            </span>
          )}
          {images.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {images.map((file, index) => (
                <img
                  key={index}
                  src={file.url}
                  alt={file.filename ?? "Attached image"}
                  className="max-h-52 max-w-full rounded-xl"
                />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {others.map((file, index) => (
                <span
                  key={index}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-0.5 text-[11.5px] text-muted-foreground"
                >
                  <Paperclip className="h-3 w-3" aria-hidden />
                  {file.filename ?? "file"}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="mt-1 flex h-5 items-center gap-1 pr-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
          {time && (
            <span className="text-[11px] text-muted-foreground">{time}</span>
          )}
          {text && <CopyButton value={text} label="Copy" />}
        </div>
      </div>
    );
  }

  const isCommandReply = meta.source === "command";

  return (
    <div className="group/msg mb-8 rounded-2xl bg-card/60 px-4 py-3 ring-1 ring-border/60">
      {isCommandReply && (
        <div className="mb-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
          Gateway
        </div>
      )}
      <div className="text-sm leading-7 text-foreground">
        <MessageBody text={text} />
        {isStreaming && (
          <span
            className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] animate-pulse bg-foreground align-baseline"
            aria-hidden
          />
        )}
      </div>
      <div className="mt-1 flex h-5 items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
        {time && (
          <span className="text-[11px] text-muted-foreground">{time}</span>
        )}
        {text && <CopyButton value={stripMarkers(text)} label="Copy" />}
      </div>
    </div>
  );
}

export function ThinkingIndicator({ label = "Thinking" }: { label?: string }) {
  return (
    <div className="mb-8 flex items-center gap-2 text-sm text-muted-foreground">
      <span className="inline-flex items-center gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:140ms]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:280ms]" />
      </span>
      <span className="animate-pulse">{label}</span>
    </div>
  );
}


/**
 * The composer appends a "Referenced files (relative to the agent workspace…)"
 * block so the agent can locate what was mentioned. It is plumbing, not prose:
 * strip it from the displayed message and surface the paths as pills instead.
 */
function splitReferenceFooter(text: string): { body: string; paths: string[] } {
  const marker = text.indexOf("Referenced files (relative to the agent workspace");
  if (marker < 0) return { body: text, paths: [] };

  const body = text.slice(0, marker).trim();
  const footer = text.slice(marker);
  const paths: string[] = [];
  for (const line of footer.split("\n")) {
    const match = /^\s*-\s+(\S+?)(?:\s+—\s+.*)?$/.exec(line);
    if (match) paths.push(match[1]);
  }
  return { body, paths };
}


/** The composer writes a mention as `@path`, or `@"path with spaces"`. */
function mentionTokensFor(path: string): string[] {
  return [`@"${path}"`, `@${path}`];
}

/**
 * Renders the typed message with its "@path" mentions swapped for file pills.
 * The reference then appears exactly once — in the sentence where it was
 * written — instead of once as text and again as a chip below.
 */
/**
 * User messages are deliberately NOT rendered as markdown — someone typing
 * `# note` should see `# note`. But a message can still arrive carrying a JSON
 * schema or payload, because programmatic callers send prompts through this
 * same surface, and as plain text those reflow into the paragraph and become
 * unreadable. So JSON is pulled out and shown as code; everything else is left
 * exactly as typed.
 */
function renderUserBody(body: string, paths: string[]): React.ReactNode {
  const spans = findJsonSpans(body);
  if (spans.length === 0) return renderWithPills(body, paths);

  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  spans.forEach((span, index) => {
    if (span.start > cursor) {
      nodes.push(
        <span key={`prose-${index}`}>{renderWithPills(body.slice(cursor, span.start), paths)}</span>,
      );
    }
    nodes.push(
      <pre
        key={`json-${index}`}
        className="my-2 max-w-full overflow-x-auto rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre"
      >
        <code>{formatJsonSpan(span)}</code>
      </pre>,
    );
    cursor = span.end;
  });

  if (cursor < body.length) {
    nodes.push(<span key="prose-tail">{renderWithPills(body.slice(cursor), paths)}</span>);
  }
  return nodes;
}

function renderWithPills(body: string, paths: string[]): React.ReactNode {
  if (paths.length === 0) return body;

  const tokens = paths
    .flatMap((path) => mentionTokensFor(path).map((token) => ({ token, path })))
    .sort((a, b) => b.token.length - a.token.length); // longest first

  const nodes: React.ReactNode[] = [];
  let rest = body;
  let guard = 0;

  while (rest.length > 0 && guard++ < 200) {
    let bestIndex = -1;
    let best: { token: string; path: string } | null = null;
    for (const entry of tokens) {
      const at = rest.indexOf(entry.token);
      if (at >= 0 && (bestIndex < 0 || at < bestIndex)) {
        bestIndex = at;
        best = entry;
      }
    }
    if (!best || bestIndex < 0) break;

    if (bestIndex > 0) nodes.push(rest.slice(0, bestIndex));
    nodes.push(
      <FileHoverCard key={`${best.path}-${nodes.length}`} path={best.path}>
        <EntityPill kind="file" label={best.path} />
      </FileHoverCard>,
    );
    rest = rest.slice(bestIndex + best.token.length);
  }

  if (rest.length > 0) nodes.push(rest);
  return nodes;
}

export function MessageList({
  messages,
  streamingId,
}: {
  messages: UIMessage[];
  streamingId: string | null;
}) {
  return (
    <>
      {messages.map((message) => (
        <MessageRow
          key={message.id}
          message={message}
          isStreaming={message.id === streamingId}
        />
      ))}
    </>
  );
}
