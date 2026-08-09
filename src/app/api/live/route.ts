import { NextResponse } from "next/server";
import { readFile, readdir, stat, open } from "fs/promises";
import { join } from "path";
import { getOpenClawHome, getGatewayUrl, getGatewayPort, readConfigFile } from "@/lib/paths";
import { fetchGatewaySessions, summarizeSessionsByAgent } from "@/lib/gateway-sessions";
import { gatewayCall } from "@/lib/openclaw";

const OPENCLAW_HOME = getOpenClawHome();

// OpenClaw v2026.3.23+ writes tslog JSON to /tmp/openclaw/openclaw-YYYY-MM-DD.log.
const TMP_LOG_CANDIDATES = [
  "/tmp/openclaw",
  "/private/tmp/openclaw",
  join(process.env.TMPDIR || "/tmp", "openclaw"),
];

async function findLatestTslogFile(): Promise<string | null> {
  for (const tmpDir of TMP_LOG_CANDIDATES) {
    try {
      const entries = await readdir(tmpDir);
      const logFiles = entries
        .filter((f) => f.startsWith("openclaw-") && f.endsWith(".log"))
        .sort();
      if (logFiles.length > 0) {
        return join(tmpDir, logFiles[logFiles.length - 1]);
      }
    } catch {
      // This candidate dir doesn't exist — try the next one
    }
  }
  return null;
}

async function readJsonSafe<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

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
      // Drop partial first line when reading a tail chunk.
      const firstNewline = content.indexOf("\n");
      if (firstNewline !== -1) {
        content = content.slice(firstNewline + 1);
      }
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

async function checkGatewayHealth(): Promise<{
  status: string;
  latencyMs: number;
}> {
  const start = Date.now();
  try {
    const gwUrl = await getGatewayUrl();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${gwUrl}/`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { status: res.ok ? "online" : "degraded", latencyMs: Date.now() - start };
  } catch {
    return { status: "offline", latencyMs: Date.now() - start };
  }
}

type CronJobLive = {
  id: string;
  name: string;
  enabled: boolean;
  lastStatus: string;
  lastRunAtMs: number | null;
  nextRunAtMs: number | null;
  lastDurationMs: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  scheduleDisplay: string;
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

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [gateway, cronData, tslogPath, cronRuns, agents] = await Promise.all([
      checkGatewayHealth(),
      readCronJobs(),
      findLatestTslogFile(),
      readRecentCronRuns(),
      readAgentSessions(),
    ]);

    // Parse gateway logs into structured entries. Primary source is the tslog
    // JSON file; the pre-4.25 plain-text gateway.log is the fallback.
    // Unparseable lines are dropped in both paths — never given fake fields.
    let logEntries: { time: string; source: string; message: string }[] = [];
    if (tslogPath) {
      const lines = await tailLines(tslogPath, 60);
      logEntries = lines
        .map((line) => {
          try {
            const parsed = JSON.parse(line) as {
              message?: string;
              time?: string;
              _meta?: { date?: string; name?: string; parentNames?: string[] };
            };
            const message = (parsed.message || "").trim();
            const time = parsed.time || parsed._meta?.date || "";
            if (!message || !time) return null;
            return {
              time,
              source:
                parsed._meta?.parentNames?.join(".") ||
                parsed._meta?.name ||
                "gateway",
              message,
            };
          } catch {
            return null;
          }
        })
        .filter((e): e is { time: string; source: string; message: string } => e !== null)
        .reverse(); // newest first
    } else {
      const logs = await tailLines(join(OPENCLAW_HOME, "logs", "gateway.log"), 40);
      logEntries = logs
        .map((line) => {
          const match = line.match(
            /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+\[([^\]]+)\]\s+(.*)/
          );
          return match
            ? { time: match[1], source: match[2], message: match[3] }
            : null;
        })
        .filter((e): e is { time: string; source: string; message: string } => e !== null)
        .reverse(); // newest first
    }

    // Read config metadata (merged nested + outer)
    const config = await readConfigFile();
    const meta = (config.meta || {}) as Record<string, unknown>;

    const gwPort = await getGatewayPort();

    return NextResponse.json({
      timestamp: Date.now(),
      gateway: {
        ...gateway,
        port: gwPort,
        version: (meta.lastTouchedVersion as string) || "unknown",
      },
      cron: cronData,
      cronRuns,
      agents,
      logEntries: logEntries.slice(0, 30),
    });
  } catch (err) {
    console.error("Live API error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

async function readCronJobs(): Promise<{
  jobs: CronJobLive[];
  stats: { total: number; ok: number; error: number };
}> {
  // Primary: the gateway's cron.list RPC — the ~/.openclaw/cron/jobs.json file
  // stopped being written when cron state moved into the gateway's SQLite
  // store (OpenClaw 6.x). The legacy file remains as a fallback for old
  // installs and offline gateways.
  let data: { jobs?: Record<string, unknown>[] };
  try {
    data = await gatewayCall<{ jobs?: Record<string, unknown>[] }>(
      "cron.list",
      {},
      10000,
    );
  } catch {
    data = await readJsonSafe<{ jobs?: Record<string, unknown>[] }>(
      join(OPENCLAW_HOME, "cron", "jobs.json"),
      { jobs: [] }
    );
  }
  const jobs: CronJobLive[] = (data.jobs || []).map((j: Record<string, unknown>) => {
    const schedule = (j.schedule || {}) as Record<string, unknown>;
    const state = (j.state || {}) as Record<string, unknown>;
    let scheduleDisplay = "";
    if (schedule.kind === "cron" && schedule.expr) {
      scheduleDisplay = `${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ""}`;
    } else if (schedule.kind === "every" && schedule.everyMs) {
      const mins = Math.round((schedule.everyMs as number) / 60000);
      scheduleDisplay = mins < 60 ? `Every ${mins}m` : `Every ${Math.round(mins / 60)}h`;
    }
    return {
      id: j.id as string,
      name: j.name as string,
      enabled: j.enabled as boolean,
      lastStatus: (state.lastStatus as string) || "unknown",
      lastRunAtMs: (state.lastRunAtMs as number) || null,
      nextRunAtMs: (state.nextRunAtMs as number) || null,
      lastDurationMs: (state.lastDurationMs as number) || null,
      consecutiveErrors: (state.consecutiveErrors as number) || 0,
      lastError: (state.lastError as string) || null,
      scheduleDisplay,
    };
  });
  return {
    jobs,
    stats: {
      total: jobs.length,
      ok: jobs.filter((j) => j.lastStatus === "ok").length,
      error: jobs.filter((j) => j.lastStatus === "error").length,
    },
  };
}

async function readRecentCronRuns(): Promise<CronRunEntry[]> {
  // Primary: cron.runs RPC (run history lives in the gateway since 6.x).
  try {
    const data = await gatewayCall<{ entries?: CronRunEntry[] }>(
      "cron.runs",
      { limit: 15 },
      10000,
    );
    const entries = Array.isArray(data.entries) ? data.entries : [];
    if (entries.length > 0) {
      return entries
        .filter((e) => typeof e.ts === "number" && e.jobId)
        .sort((a, b) => b.ts - a.ts)
        .slice(0, 15);
    }
  } catch {
    // Gateway unreachable — fall through to the legacy file layout.
  }

  const runsDir = join(OPENCLAW_HOME, "cron", "runs");
  const all: CronRunEntry[] = [];
  try {
    const files = await readdir(runsDir);
    const runFiles = files.filter((file) => file.endsWith(".jsonl"));
    const tails = await Promise.all(
      runFiles.map((file) => tailLines(join(runsDir, file), 5))
    );
    for (const lines of tails) {
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as CronRunEntry;
          all.push(entry);
        } catch { /* skip malformed */ }
      }
    }
  } catch { /* runs dir may not exist */ }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, 15);
}

type AgentSessionRow = {
  id: string;
  name: string;
  emoji: string;
  sessionCount: number;
  totalTokens: number;
  lastActivity: number;
};

async function readAgentSessions(): Promise<AgentSessionRow[]> {
  const configuredAgentIds = new Set<string>();
  const identityByAgentId = new Map<string, { name: string; emoji: string }>();
  try {
    const config = await readConfigFile();
    const agents = (config.agents || {}) as Record<string, unknown>;
    const list = Array.isArray(agents.list) ? (agents.list as Record<string, unknown>[]) : [];
    for (const row of list) {
      const id = String(row.id || "").trim();
      if (id) {
        configuredAgentIds.add(id);
        const identity =
          row.identity && typeof row.identity === "object"
            ? (row.identity as Record<string, unknown>)
            : {};
        const rawName =
          (row.name as string) || (identity.name as string) || id;
        const name =
          rawName.replace(/\s*_\(.*?\)_?\s*/g, "").trim() || rawName || id;
        const rawEmoji =
          (identity.emoji as string) || "🤖";
        const emoji = String(rawEmoji).replace(/\s*_\(.*?\)_?\s*/g, "").trim() || "🤖";
        identityByAgentId.set(id, { name, emoji });
      }
    }
  } catch {
    // ignore; we'll still fall back to runtime sessions and main agent.
  }

  function row(
    id: string,
    sessionCount: number,
    totalTokens: number,
    lastActivity: number
  ): AgentSessionRow {
    const identity = identityByAgentId.get(id) || {
      name: id,
      emoji: id === "main" ? "🦞" : "🤖",
    };
    return { id, name: identity.name, emoji: identity.emoji, sessionCount, totalTokens, lastActivity };
  }

  try {
    const sessions = await fetchGatewaySessions(10000);
    const summary = summarizeSessionsByAgent(sessions);
    const rows = [...summary.entries()]
      .map(([id, s]) =>
        row(id, s.sessionCount, s.totalTokens, s.lastActive)
      )
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of configuredAgentIds) {
      if (!byId.has(id)) {
        byId.set(id, row(id, 0, 0, 0));
      }
    }
    if (!byId.has("main")) {
      byId.set("main", row("main", 0, 0, 0));
    }
    return [...byId.values()].sort((a, b) => b.lastActivity - a.lastActivity);
  } catch {
    const fallbackIds = configuredAgentIds.size > 0 ? [...configuredAgentIds] : ["main"];
    if (!fallbackIds.includes("main")) fallbackIds.unshift("main");
    return fallbackIds.map((id) => row(id, 0, 0, 0));
  }
}
