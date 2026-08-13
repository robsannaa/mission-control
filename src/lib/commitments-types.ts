/**
 * Commitments (inferred agent follow-ups) — CLIENT-SAFE types + formatting.
 *
 * OpenClaw watches conversations and records "open loops" — things the agent
 * offered or promised but never closed ("Still want me to run X?"). This module
 * is pure (no server imports) so the view can render it directly; the server
 * module `@/lib/commitments` re-exports these types.
 */

export type CommitmentStatus = "pending" | "dismissed" | "sent" | "expired";

export interface CommitmentDueWindow {
  earliestMs?: number;
  latestMs?: number;
  timezone?: string;
}

export interface Commitment {
  id: string;
  agentId: string;
  sessionKey?: string;
  channel?: string;
  accountId?: string;
  to?: string;
  senderId?: string;
  kind?: string; // e.g. "open_loop"
  sensitivity?: string; // e.g. "routine"
  source?: string; // e.g. "agent_promise"
  status: CommitmentStatus | string;
  reason?: string;
  suggestedText?: string;
  dedupeKey?: string;
  confidence?: number; // 0..1
  dueWindow?: CommitmentDueWindow;
  sourceMessageId?: string;
  createdAt?: number;
}

export interface CommitmentsResult {
  count: number;
  status: string;
  commitments: Commitment[];
}

/** Human label for a confidence score. */
export function confidenceLabel(c?: number): { label: string; tone: "success" | "warning" | "secondary" } {
  if (typeof c !== "number") return { label: "—", tone: "secondary" };
  if (c >= 0.8) return { label: "High", tone: "success" };
  if (c >= 0.5) return { label: "Medium", tone: "warning" };
  return { label: "Low", tone: "secondary" };
}

/** Relative "due" grouping for a commitment. */
export type DueBucket = "overdue" | "today" | "soon" | "later" | "someday";

export function dueBucket(dw: CommitmentDueWindow | undefined, now: number): DueBucket {
  const due = dw?.latestMs ?? dw?.earliestMs;
  if (!due) return "someday";
  const dayMs = 24 * 60 * 60 * 1000;
  const delta = due - now;
  if (delta < 0) return "overdue";
  if (delta < dayMs) return "today";
  if (delta < 3 * dayMs) return "soon";
  if (delta < 14 * dayMs) return "later";
  return "someday";
}

export const DUE_BUCKET_LABEL: Record<DueBucket, string> = {
  overdue: "Overdue",
  today: "Due today",
  soon: "Next few days",
  later: "This fortnight",
  someday: "Someday",
};

const BUCKET_ORDER: DueBucket[] = ["overdue", "today", "soon", "later", "someday"];

/** Group commitments into ordered due buckets. */
export function groupByDue(
  commitments: Commitment[],
  now: number,
): Array<{ bucket: DueBucket; label: string; items: Commitment[] }> {
  const map = new Map<DueBucket, Commitment[]>();
  for (const c of commitments) {
    const b = dueBucket(c.dueWindow, now);
    const arr = map.get(b) ?? [];
    arr.push(c);
    map.set(b, arr);
  }
  return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({
    bucket: b,
    label: DUE_BUCKET_LABEL[b],
    items: (map.get(b) ?? []).sort((a, z) => (a.dueWindow?.latestMs ?? 0) - (z.dueWindow?.latestMs ?? 0)),
  }));
}

/** Short "due Fri" style hint. */
export function formatDue(dw: CommitmentDueWindow | undefined): string | null {
  const due = dw?.latestMs ?? dw?.earliestMs;
  if (!due) return null;
  try {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      timeZone: dw?.timezone,
    }).format(new Date(due));
  } catch {
    return new Date(due).toDateString();
  }
}

/** Title-case a channel id for display. */
export function channelLabel(channel?: string): string {
  if (!channel) return "Direct";
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}
