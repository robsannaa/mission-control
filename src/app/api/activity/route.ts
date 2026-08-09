import { NextRequest, NextResponse } from "next/server";
import { readdir, stat, open, readFile } from "fs/promises";
import { join } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { fetchGatewaySessions } from "@/lib/gateway-sessions";
import { gatewayCall } from "@/lib/openclaw";
import { isPairingRequiredError, pairingRequiredResponse } from "@/lib/gateway-errors";

// OpenClaw v2026.3.23+ writes tslog JSON to /tmp/openclaw/openclaw-YYYY-MM-DD.log.
const TMP_LOG_CANDIDATES = [
  "/tmp/openclaw",
  "/private/tmp/openclaw",
  join(process.env.TMPDIR || "/tmp", "openclaw"),
];

export const dynamic = "force-dynamic";

// ── Types ────────────────────────────────────────────────────────────────────

type ActivityEventType = "cron" | "session" | "log" | "system";
type ActivityEventStatus = "ok" | "error" | "info" | "warning";

type ActivityEvent = {
  id: string;
  type: ActivityEventType;
  timestamp: number;
  title: string;
  detail?: string;
  status?: ActivityEventStatus;
  source?: string;
};

type CronRunEntry = {
  ts: number;
  jobId: string;
  action: string;
  status: string;
  summary?: string;
  durationMs?: number;
  error?: string;
};

// ── File helpers ─────────────────────────────────────────────────────────────

async function tailLines(path: string, n: number): Promise<string[]> {
  try {
    const maxBytes = 256 * 1024;
    const s = await stat(path);
    if (s.size <= 0) return [];

    let content: string;
    if (s.size > maxBytes) {
      const fh = await open(path, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        await fh.read(buf, 0, maxBytes, s.size - maxBytes);
        content = buf.toString("utf-8");
      } finally {
        await fh.close();
      }
      // Drop the partial first line that results from reading a tail chunk.
      const firstNewline = content.indexOf("\n");
      if (firstNewline !== -1) content = content.slice(firstNewline + 1);
    } else {
      content = await readFile(path, "utf-8");
    }

    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-n);
  } catch {
    return [];
  }
}

// ── Aggregation helpers ──────────────────────────────────────────────────────

/**
 * Job id → human name. A run row only carries the job's uuid, and a feed of
 * uuids is unreadable: "versami-mail-sweep — finished" is the whole point.
 */
async function fetchCronJobNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const data = await gatewayCall<{
      jobs?: Array<{ id?: string; name?: string; displayName?: string }>;
    }>("cron.list", {}, 8000);
    for (const job of data.jobs ?? []) {
      const label = job.displayName?.trim() || job.name?.trim();
      if (job.id && label) names.set(job.id, label);
    }
  } catch {
    // Names are a nicety — fall back to ids rather than failing the feed.
  }
  return names;
}

function cronEntryToEvent(
  entry: CronRunEntry,
  jobNames?: Map<string, string>,
): ActivityEvent | null {
  // Require a valid numeric timestamp and a jobId to proceed.
  if (!entry.ts || typeof entry.ts !== "number" || !entry.jobId) {
    return null;
  }

  const isError =
    entry.status === "error" ||
    entry.status === "failed" ||
    Boolean(entry.error);

  return {
    id: `cron-${entry.jobId}-${entry.ts}`,
    type: "cron",
    timestamp: entry.ts,
    title: `${jobNames?.get(entry.jobId) ?? entry.jobId} — ${entry.action}`,
    detail: entry.error || entry.summary || undefined,
    status: isError ? "error" : "ok",
    source: entry.jobId,
  };
}

async function aggregateCronEvents(): Promise<{
  events: ActivityEvent[];
  pairingRequired: boolean;
}> {
  let pairingRequired = false;

  // Primary: the gateway's cron.runs RPC (cron history moved into the gateway's
  // SQLite store in OpenClaw 6.x — the ~/.openclaw/cron/runs/*.jsonl files are
  // no longer written).
  try {
    const data = await gatewayCall<{ entries?: CronRunEntry[] }>(
      "cron.runs",
      { limit: 50 },
      10000,
    );
    const entries = Array.isArray(data.entries) ? data.entries : [];
    const jobNames = await fetchCronJobNames();
    return {
      events: entries
        .map((e) => cronEntryToEvent(e, jobNames))
        .filter((e): e is ActivityEvent => e !== null),
      pairingRequired: false,
    };
  } catch (err) {
    // A pairing refusal must not silently blank the feed — surface it to the
    // route so the response can carry the X-Pairing-Required signal.
    if (isPairingRequiredError(err)) pairingRequired = true;
    // Otherwise gateway unreachable — fall through to the legacy file layout
    // below so pre-6.x installs still get their history.
  }

  const home = getOpenClawHome();
  const runsDir = join(home, "cron", "runs");
  const events: ActivityEvent[] = [];

  try {
    const files = await readdir(runsDir);
    const runFiles = files.filter((f) => f.endsWith(".jsonl"));

    const tails = await Promise.all(
      runFiles.map((f) => tailLines(join(runsDir, f), 20))
    );

    for (const lines of tails) {
      for (const line of lines) {
        try {
          const event = cronEntryToEvent(JSON.parse(line) as CronRunEntry);
          if (event) events.push(event);
        } catch {
          // Skip malformed JSONL lines.
        }
      }
    }
  } catch {
    // The runs directory may not exist yet — return an empty list.
  }

  return { events, pairingRequired };
}

type TslogLine = {
  message?: string;
  hostname?: string;
  time?: string;
  _meta?: {
    logLevelName?: string;
    date?: string;
    name?: string;
    parentNames?: string[];
  };
};

async function findTslogFiles(): Promise<string[]> {
  for (const tmpDir of TMP_LOG_CANDIDATES) {
    try {
      const entries = await readdir(tmpDir);
      const logFiles = entries
        .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
        .sort()
        .slice(-2) // Last 2 days
        .map((f) => join(tmpDir, f));
      if (logFiles.length > 0) return logFiles;
    } catch {
      // This candidate dir doesn't exist — try the next one
    }
  }
  return [];
}

async function aggregateLogEvents(): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];

  // Primary: tslog JSON files (OpenClaw v2026.3.23+). One JSON object per line.
  const tslogFiles = await findTslogFiles();
  for (const path of tslogFiles) {
    const lines = await tailLines(path, 200);
    for (const line of lines) {
      let parsed: TslogLine;
      try {
        parsed = JSON.parse(line) as TslogLine;
      } catch {
        // Not JSON — a wrapped continuation or corrupt tail chunk. Dropping it
        // is correct: inventing a timestamp would sort noise to the top of the
        // feed as if it just happened.
        continue;
      }

      const level = parsed._meta?.logLevelName?.toUpperCase();
      if (level !== "WARN" && level !== "ERROR" && level !== "FATAL") continue;

      const rawTimestamp = parsed.time || parsed._meta?.date;
      const ts = rawTimestamp ? new Date(rawTimestamp).getTime() : NaN;
      if (!Number.isFinite(ts) || ts <= 0) continue;

      const source =
        parsed._meta?.parentNames?.join(".") || parsed._meta?.name || "gateway";
      const message = (parsed.message || "").trim();
      if (!message) continue;

      events.push({
        id: `log-${source}-${ts}-${events.length}`,
        type: "log",
        timestamp: ts,
        title: `${source}: ${message}`,
        status: level === "WARN" ? "warning" : "error",
        source,
      });
    }
  }
  if (events.length > 0 || tslogFiles.length > 0) return events;

  // Legacy fallback: pre-4.25 plain-text gateway.log (TIMESTAMP [SOURCE] MSG).
  const home = getOpenClawHome();
  const logPath = join(home, "logs", "gateway.log");
  const lines = await tailLines(logPath, 50);
  const errorPattern = /\[warn\]|\[error\]|error/i;

  for (const line of lines) {
    if (!errorPattern.test(line)) continue;

    const match = line.match(/^(\S+)\s+\[([^\]]+)\]\s+(.*)/);
    // Lines that don't match the known format are dropped — no synthetic
    // timestamps.
    if (!match) continue;

    const ts = new Date(match[1]).getTime();
    if (!Number.isFinite(ts) || ts <= 0) continue;

    const isWarning = /\[warn\]/i.test(line);

    events.push({
      id: `log-${match[2]}-${ts}-${events.length}`,
      type: "log",
      timestamp: ts,
      title: `${match[2]}: ${match[3]}`,
      status: isWarning ? "warning" : "error",
      source: match[2],
    });
  }

  return events;
}

async function aggregateSessionEvents(): Promise<{
  events: ActivityEvent[];
  pairingRequired: boolean;
}> {
  const events: ActivityEvent[] = [];
  let pairingRequired = false;

  try {
    const sessions = await fetchGatewaySessions(5000);

    for (const session of sessions) {
      const key = session.key || session.sessionId || "unknown";
      const totalTokens = session.totalTokens ?? 0;
      const model = session.model || "unknown";
      const timestamp = session.updatedAt || Date.now();

      events.push({
        id: `session-${session.sessionId || key}-${timestamp}`,
        type: "session",
        timestamp,
        title: `Session active: ${key}`,
        detail: `${totalTokens} tokens · ${model}`,
        status: "info",
        source: key,
      });
    }
  } catch (err) {
    // Gateway may be offline — return an empty list rather than failing the
    // entire activity response. A pairing refusal is still surfaced so the
    // route can set the X-Pairing-Required signal.
    if (isPairingRequiredError(err)) pairingRequired = true;
  }

  return { events, pairingRequired };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const typeFilter = searchParams.get("type") as ActivityEventType | null;

    // Gather all sources in parallel.
    const [cronResult, logEvents, sessionResult] = await Promise.all([
      aggregateCronEvents(),
      aggregateLogEvents(),
      aggregateSessionEvents(),
    ]);

    const pairingRequired =
      cronResult.pairingRequired || sessionResult.pairingRequired;

    let events: ActivityEvent[] = [
      ...cronResult.events,
      ...logEvents,
      ...sessionResult.events,
    ];

    // Apply optional type filter.
    if (typeFilter) {
      events = events.filter((e) => e.type === typeFilter);
    }

    // Sort newest-first and cap at 50.
    events.sort((a, b) => b.timestamp - a.timestamp);
    events = events.slice(0, 50);

    // Backward compat: the body stays a plain array. A pairing refusal in an
    // aggregator is signalled out-of-band via the X-Pairing-Required header so
    // existing consumers keep working while the UI can offer the approve flow.
    return NextResponse.json(
      events,
      pairingRequired ? { headers: { "X-Pairing-Required": "1" } } : undefined,
    );
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    console.error("Activity API error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
