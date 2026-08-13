import { NextRequest, NextResponse } from "next/server";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import { gatewayCall } from "@/lib/openclaw";
import { redact } from "@/lib/doctor-redact";
import {
  classifySessionKind,
  sessionAgentIdOf,
  sessionKindOf,
  sessionTitleOf,
} from "@/lib/session-kinds";

export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 160;
const MAX_LIMIT = 300;
const MAX_ITEM_CHARS = 12_000;
const SESSION_KEY_RE = /^[A-Za-z0-9_.:-]{1,256}$/;
const SENSITIVE_KEY_RE =
  /(api[\s_-]?key|token|secret|password|credential|authorization|cookie|private[\s_-]?key)/i;

type RawBlock = {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  id?: unknown;
  arguments?: unknown;
  input?: unknown;
};

type RawMessage = {
  role?: string;
  content?: unknown;
  timestamp?: number | string;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  channel?: unknown;
  source?: unknown;
  origin?: unknown;
  provenance?: unknown;
  metadata?: unknown;
  usage?: {
    input?: number | string;
    inputTokens?: number | string;
    output?: number | string;
    outputTokens?: number | string;
    cacheRead?: number | string;
    cacheReadTokens?: number | string;
    cacheWrite?: number | string;
    cacheWriteTokens?: number | string;
    totalTokens?: number | string;
    cost?: { total?: number | string };
  };
  __openclaw?: { id?: string; seq?: number };
};

type SessionSummary = {
  key?: string;
  kind?: string;
  label?: string;
  displayName?: string;
  sessionId?: string;
  status?: string;
  hasActiveRun?: boolean;
  abortedLastRun?: boolean;
  startedAt?: number | string;
  endedAt?: number | string;
  runtimeMs?: number | string;
  inputTokens?: number | string;
  outputTokens?: number | string;
  totalTokens?: number | string;
  estimatedCostUsd?: number | string | null;
  model?: string;
  modelProvider?: string;
  origin?: { label?: string };
};

type SessionDescription = SessionSummary & {
  lastActivityAt?: number | string;
};

type TimelineItem = {
  id: string;
  type: "prompt" | "output" | "reasoning" | "tool-call" | "tool-result";
  timestamp: number | null;
  text?: string;
  name?: string;
  arguments?: string;
  isError?: boolean;
  stopReason?: string;
  provenance?: string[];
  truncated?: boolean;
};

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function epochMs(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return null;
  return number < 1_000_000_000_000 ? Math.trunc(number * 1000) : Math.trunc(number);
}

function nonNegative(value: unknown): number {
  const number = finiteNumber(value);
  return number !== null && number >= 0 ? number : 0;
}

function bounded(text: string): { text: string; truncated: boolean } {
  const safe = redact(text.trim());
  if (safe.length <= MAX_ITEM_CHARS) return { text: safe, truncated: false };
  return { text: `${safe.slice(0, MAX_ITEM_CHARS)}…`, truncated: true };
}

function scrubValue(value: unknown, key = "", depth = 0): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return "[redacted]";
  if (depth > 8) return "[truncated]";
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => scrubValue(item, "", depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 100)
        .map(([childKey, childValue]) => [childKey, scrubValue(childValue, childKey, depth + 1)]),
    );
  }
  return value;
}

function serialized(value: unknown): { text: string; truncated: boolean } {
  try {
    return bounded(JSON.stringify(scrubValue(value), null, 2));
  } catch {
    return bounded(String(value ?? ""));
  }
}

function blocksOf(content: unknown): RawBlock[] {
  return Array.isArray(content)
    ? content.filter((block): block is RawBlock => Boolean(block && typeof block === "object"))
    : [];
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  const text = blocksOf(content)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("\n")
    .trim();
  if (text) return text;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    return serialized(content).text;
  }
  return "";
}

function provenanceOf(message: RawMessage): string[] {
  const out = new Set<string>();
  const add = (label: string, value: unknown) => {
    if (typeof value !== "string" || !value.trim()) return;
    const clean = redact(value.trim()).slice(0, 160);
    out.add(`${label}: ${clean}`);
  };
  add("Channel", message.channel);
  add("Source", message.source);
  add("Origin", message.origin);

  for (const candidate of [message.provenance, message.metadata]) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    add("Channel", record.channel);
    add("Source", record.source ?? record.surface);
    add("Origin", record.origin ?? record.kind);
    add("Sent via", record.tool ?? record.transport);
  }
  return [...out].slice(0, 4);
}

function normalizeTimeline(messages: RawMessage[]): TimelineItem[] {
  const timeline: TimelineItem[] = [];

  messages.forEach((message, messageIndex) => {
    const at = epochMs(message.timestamp);
    const baseId = message.__openclaw?.id || `${message.__openclaw?.seq ?? messageIndex}`;
    const role = message.role || "";

    if (role === "user") {
      const value = bounded(textOfContent(message.content));
      if (value.text) {
        timeline.push({
          id: `${baseId}-prompt`,
          type: "prompt",
          timestamp: at,
          text: value.text,
          provenance: provenanceOf(message),
          truncated: value.truncated,
        });
      }
      return;
    }

    if (role === "assistant") {
      if (typeof message.content === "string") {
        const value = bounded(message.content);
        if (value.text) {
          timeline.push({
            id: `${baseId}-output`,
            type: "output",
            timestamp: at,
            text: value.text,
            stopReason: message.stopReason,
            truncated: value.truncated,
          });
        }
        return;
      }

      blocksOf(message.content).forEach((block, blockIndex) => {
        if (block.type === "text" && typeof block.text === "string") {
          const value = bounded(block.text);
          if (value.text) {
            timeline.push({
              id: `${baseId}-output-${blockIndex}`,
              type: "output",
              timestamp: at,
              text: value.text,
              stopReason: message.stopReason,
              truncated: value.truncated,
            });
          }
          return;
        }

        if (block.type === "thinking") {
          // The event is useful operationally, but private chain-of-thought is
          // intentionally never sent to the browser.
          timeline.push({
            id: `${baseId}-reasoning-${blockIndex}`,
            type: "reasoning",
            timestamp: at,
          });
          return;
        }

        if (block.type === "toolCall") {
          const args = serialized(block.arguments ?? block.input ?? {});
          timeline.push({
            id: `${baseId}-tool-${String(block.id ?? blockIndex)}`,
            type: "tool-call",
            timestamp: at,
            name: typeof block.name === "string" ? block.name : "Tool",
            arguments: args.text,
            truncated: args.truncated,
          });
        }
      });
      return;
    }

    if (role === "toolResult" || role === "tool") {
      const value = bounded(textOfContent(message.content));
      timeline.push({
        id: `${baseId}-result-${message.toolCallId ?? messageIndex}`,
        type: "tool-result",
        timestamp: at,
        name: message.toolName || "Tool result",
        text: value.text,
        isError: Boolean(message.isError),
        truncated: value.truncated,
      });
    }
  });

  return timeline;
}

function aggregateUsage(messages: RawMessage[]) {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let processedTokens = 0;
  let estimatedCostUsd = 0;
  let modelCalls = 0;
  let hasCost = false;

  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;
    modelCalls += 1;
    const input = nonNegative(message.usage.input ?? message.usage.inputTokens);
    const output = nonNegative(message.usage.output ?? message.usage.outputTokens);
    const cacheRead = nonNegative(message.usage.cacheRead ?? message.usage.cacheReadTokens);
    const cacheWrite = nonNegative(message.usage.cacheWrite ?? message.usage.cacheWriteTokens);
    const reportedTotal = nonNegative(message.usage.totalTokens);
    inputTokens += input;
    outputTokens += output;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    processedTokens += reportedTotal || input + output + cacheRead + cacheWrite;

    const cost = finiteNumber(message.usage.cost?.total);
    if (cost !== null && cost >= 0) {
      hasCost = true;
      estimatedCostUsd += cost;
    }
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    processedTokens,
    modelCalls,
    estimatedCostUsd: hasCost ? estimatedCostUsd : null,
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sessionKey = searchParams.get("sessionKey")?.trim();
  if (!sessionKey) {
    return NextResponse.json({ error: "sessionKey is required" }, { status: 400 });
  }
  if (!SESSION_KEY_RE.test(sessionKey)) {
    return NextResponse.json({ error: "invalid sessionKey" }, { status: 400 });
  }

  const requestedLimit = Number(searchParams.get("limit") ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    const listing = await gatewayCall<{ sessions?: SessionSummary[] }>(
      "sessions.list",
      { limit: 500 },
      10_000,
    );
    const sessions = Array.isArray(listing.sessions) ? listing.sessions : [];
    const match = sessions.find((session) => session.key === sessionKey);
    if (!match) {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }

    const kind = sessionKindOf(match);
    const classification = classifySessionKind(kind);
    if (!classification.isInspectable) {
      return NextResponse.json(
        { error: "This session is private and cannot be inspected from Activity." },
        { status: 403 },
      );
    }

    const agentId = sessionAgentIdOf(match);
    const [history, descriptionResult] = await Promise.all([
      gatewayCall<{
        sessionId?: string;
        messages?: RawMessage[];
        sessionInfo?: SessionDescription;
      }>(
        "chat.history",
        { sessionKey, ...(agentId ? { agentId } : {}), limit },
        15_000,
      ),
      gatewayCall<{ session?: SessionDescription }>(
        "sessions.describe",
        { key: sessionKey },
        10_000,
      ).catch(() => null),
    ]);

    const messages = Array.isArray(history.messages) ? history.messages : [];
    const usage = aggregateUsage(messages);
    const info = descriptionResult?.session ?? history.sessionInfo ?? match;
    const status = String(info.status || match.status || "done");
    const hasActiveRun = Boolean(info.hasActiveRun ?? match.hasActiveRun) || status === "running";

    return NextResponse.json({
      session: {
        key: sessionKey,
        sessionId: history.sessionId ?? match.sessionId ?? null,
        title: sessionTitleOf(match),
        kind,
        kindLabel: classification.label,
        agentId,
        status,
        hasActiveRun,
        abortedLastRun: Boolean(info.abortedLastRun ?? match.abortedLastRun),
        startedAt: epochMs(info.startedAt ?? match.startedAt),
        endedAt: epochMs(info.endedAt ?? match.endedAt),
        runtimeMs: nonNegative(info.runtimeMs ?? match.runtimeMs),
        inputTokens: usage.modelCalls > 0
          ? usage.inputTokens
          : nonNegative(info.inputTokens ?? match.inputTokens),
        outputTokens: usage.modelCalls > 0
          ? usage.outputTokens
          : nonNegative(info.outputTokens ?? match.outputTokens),
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        processedTokens: usage.modelCalls > 0
          ? usage.processedTokens
          : nonNegative(info.inputTokens ?? match.inputTokens) +
            nonNegative(info.outputTokens ?? match.outputTokens),
        modelCalls: usage.modelCalls,
        // sessions.list calls this totalTokens, but for current OpenClaw
        // providers it is the latest context/input size, not cumulative usage.
        contextUsedTokens: nonNegative(info.totalTokens ?? match.totalTokens),
        totalTokens: nonNegative(info.totalTokens ?? match.totalTokens),
        estimatedCostUsd:
          usage.estimatedCostUsd ??
          finiteNumber(info.estimatedCostUsd ?? match.estimatedCostUsd) ??
          null,
        model: String(info.model || match.model || "unknown"),
        modelProvider: info.modelProvider || match.modelProvider || null,
        originLabel: match.origin?.label ? redact(match.origin.label) : null,
      },
      timeline: normalizeTimeline(messages),
      limit,
      truncated: messages.length >= limit,
      reasoningContentHidden: true,
      refreshedAt: Date.now(),
    });
  } catch (error) {
    const pairing = pairingRequiredResponse(error);
    if (pairing) return pairing;
    console.error("activity/session failed:", error);
    return NextResponse.json(
      { error: "Could not load this session from the gateway." },
      { status: 502 },
    );
  }
}
