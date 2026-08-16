import { getOpenClawHome, getDefaultWorkspaceSync } from "@/lib/paths";
import { cpus, totalmem, freemem, loadavg, uptime, hostname, platform, arch } from "os";
import { statfs, readdir, stat, readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { gatewayCall } from "@/lib/openclaw";

export const dynamic = "force-dynamic";
const exec = promisify(execFile);
const STREAM_INTERVAL_MS = 5000;
const SNAPSHOT_TTL_MS = 4000;

/* ── TTL Cache ───────────────────────────────────── */

type CacheEntry<T> = { value: T; expiresAt: number };
const cache = new Map<string, CacheEntry<unknown>>();
let latestSnapshot: Awaited<ReturnType<typeof buildSnapshot>> | null = null;
let latestSnapshotAt = 0;
let snapshotInFlight: Promise<Awaited<ReturnType<typeof buildSnapshot>>> | null = null;

async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && Date.now() < existing.expiresAt) return existing.value;
  const value = await fn();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/* ── Helpers ─────────────────────────────────────── */

async function dirSizeBytes(dir: string, maxDepth = 3): Promise<number> {
  let total = 0;
  if (maxDepth <= 0) return 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        if (e.isFile()) {
          const s = await stat(p);
          total += s.size;
        } else if (e.isDirectory() && !e.name.startsWith(".")) {
          total += await dirSizeBytes(p, maxDepth - 1);
        }
      } catch {
        /* skip inaccessible */
      }
    }
  } catch {
    /* dir may not exist */
  }
  return total;
}

async function countFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries.filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** CPU usage measured over a ~200ms window. */
async function measureCpuUsage(): Promise<number> {
  const start = cpuSnapshot();
  await new Promise((r) => setTimeout(r, 200));
  const end = cpuSnapshot();

  const idleDiff = end.idle - start.idle;
  const totalDiff = end.total - start.total;
  if (totalDiff === 0) return 0;
  return Math.round(((totalDiff - idleDiff) / totalDiff) * 100);
}

function cpuSnapshot() {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

async function getLogFileSize(home: string): Promise<number> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const logFile = join("/tmp/openclaw", `openclaw-${today}.log`);
    const s = await stat(logFile);
    return s.size;
  } catch {
    try {
      const logDir = join(home, "logs");
      const files = await readdir(logDir);
      let biggest = 0;
      for (const f of files) {
        if (f.endsWith(".log")) {
          const s = await stat(join(logDir, f));
          if (s.size > biggest) biggest = s.size;
        }
      }
      return biggest;
    } catch {
      return 0;
    }
  }
}

async function getSessionCount(home: string): Promise<number> {
  // Gateway session list is the runtime source of truth.
  try {
    const data = await gatewayCall<{ count?: number; sessions?: unknown[] }>(
      "sessions.list",
      undefined,
      8000
    );
    if (typeof data.count === "number" && Number.isFinite(data.count) && data.count >= 0) {
      return Math.trunc(data.count);
    }
    if (Array.isArray(data.sessions)) return data.sessions.length;
  } catch {
    // Fall back to local metadata only if gateway is unavailable.
  }

  let count = 0;
  try {
    const agentsDir = join(home, "agents");
    const agents = await readdir(agentsDir, { withFileTypes: true });
    for (const a of agents) {
      if (!a.isDirectory()) continue;
      const sessionsPath = join(agentsDir, a.name, "sessions", "sessions.json");
      try {
        const raw = await readFile(sessionsPath, "utf-8");
        const data = JSON.parse(raw);
        count += Object.keys(data).length;
      } catch {
        /* skip */
      }
    }
  } catch {
    /* agents dir may not exist */
  }
  return count;
}

async function getProcessCount(): Promise<number> {
  const osPlatform = platform();
  try {
    const args = osPlatform === "darwin" ? ["-A", "-o", "pid="] : ["-e", "-o", "pid="];
    const { stdout } = await exec("ps", args, { timeout: 2000 });
    return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
  } catch {
    try {
      const { stdout } = await exec("ps", ["-ax"], { timeout: 2000 });
      return Math.max(0, stdout.trim().split("\n").length - 1); // minus header
    } catch {
      return 0;
    }
  }
}

type MemoryStats = {
  total: number;
  used: number;
  free: number;
  percent: number;
  app?: number;
  wired?: number;
  compressed?: number;
  cached?: number;
  swapUsed?: number;
  source: "os" | "vm_stat" | "proc_meminfo";
};

function parsePages(line: string): number | null {
  const m = line.match(/:\s+([0-9]+)/);
  if (!m?.[1]) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseSwapUsedBytes(raw: string): number {
  const m = raw.match(/used\s*=\s*([0-9.]+)([KMGTP])?/i);
  if (!m?.[1]) return 0;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (m[2] || "B").toUpperCase();
  const mult: Record<string, number> = {
    B: 1,
    K: 1024,
    M: 1024 * 1024,
    G: 1024 * 1024 * 1024,
    T: 1024 * 1024 * 1024 * 1024,
    P: 1024 * 1024 * 1024 * 1024 * 1024,
  };
  return Math.round(value * (mult[unit] || 1));
}

async function readMacMemoryStats(total: number): Promise<MemoryStats | null> {
  try {
    const [{ stdout: vmRaw }, { stdout: swapRaw }] = await Promise.all([
      exec("vm_stat", [], { timeout: 2000 }),
      exec("sysctl", ["vm.swapusage"], { timeout: 2000 }),
    ]);

    const lines = vmRaw.split(/\r?\n/);
    const pageSizeMatch = vmRaw.match(/page size of\s+(\d+)\s+bytes/i);
    const pageSize = Number(pageSizeMatch?.[1] || 0);
    if (!Number.isFinite(pageSize) || pageSize <= 0) return null;

    let freePages = 0;
    let speculativePages = 0;
    let wiredPages = 0;
    let anonymousPages = 0;
    let compressedPages = 0;
    let fileBackedPages = 0;

    for (const line of lines) {
      const [keyRaw] = line.split(":");
      const key = keyRaw?.trim().toLowerCase() || "";
      const pages = parsePages(line);
      if (pages == null) continue;
      if (key === "pages free") freePages = pages;
      else if (key === "pages speculative") speculativePages = pages;
      else if (key === "pages wired down") wiredPages = pages;
      else if (key === "anonymous pages") anonymousPages = pages;
      else if (key === "pages occupied by compressor") compressedPages = pages;
      else if (key === "file-backed pages") fileBackedPages = pages;
    }

    const app = anonymousPages * pageSize;
    const wired = wiredPages * pageSize;
    const compressed = compressedPages * pageSize;
    const used = Math.min(total, Math.max(0, app + wired + compressed));
    const cached = fileBackedPages * pageSize;
    const free = Math.max(0, (freePages + speculativePages) * pageSize);
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;
    const swapUsed = parseSwapUsedBytes(swapRaw);

    if (used === 0 && free === 0 && cached === 0) return null;

    return {
      total,
      used,
      free,
      percent,
      app,
      wired,
      compressed,
      cached,
      swapUsed,
      source: "vm_stat",
    };
  } catch {
    return null;
  }
}

async function readLinuxMemoryStats(): Promise<MemoryStats | null> {
  try {
    const raw = await readFile("/proc/meminfo", "utf-8");
    const kv = new Map<string, number>();

    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_()]+):\s+([0-9]+)\s+kB/i);
      if (!m?.[1] || !m[2]) continue;
      const n = Number(m[2]);
      if (Number.isFinite(n)) kv.set(m[1], n);
    }

    const memTotalKb = kv.get("MemTotal") || 0;
    if (memTotalKb <= 0) return null;

    const memFreeKb = kv.get("MemFree") || 0;
    const memAvailableKb = kv.get("MemAvailable") || 0;
    const buffersKb = kv.get("Buffers") || 0;
    const cachedKb = kv.get("Cached") || 0;
    const reclaimKb = kv.get("SReclaimable") || 0;
    const shmemKb = kv.get("Shmem") || 0;
    const swapTotalKb = kv.get("SwapTotal") || 0;
    const swapFreeKb = kv.get("SwapFree") || 0;

    const total = memTotalKb * 1024;
    const cacheBytes = Math.max(0, (cachedKb + reclaimKb - shmemKb) * 1024);
    const availableKb =
      memAvailableKb > 0
        ? memAvailableKb
        : Math.max(0, memFreeKb + buffersKb + cachedKb + reclaimKb);
    const free = Math.max(0, availableKb * 1024);
    const used = Math.min(total, Math.max(0, total - free));
    const percent = total > 0 ? Math.round((used / total) * 100) : 0;
    const swapUsed = Math.max(0, (swapTotalKb - swapFreeKb) * 1024);

    return {
      total,
      used,
      free,
      percent,
      cached: cacheBytes,
      swapUsed,
      source: "proc_meminfo",
    };
  } catch {
    return null;
  }
}

type DiskStats = {
  total: number;
  used: number;
  free: number;
};

function parseDfBytes(stdout: string): DiskStats | null {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return null;
  const row = lines[lines.length - 1] || "";
  const cols = row.trim().split(/\s+/);
  if (cols.length < 6) return null;

  const totalKb = Number(cols[cols.length - 5]);
  const usedKb = Number(cols[cols.length - 4]);
  const freeKb = Number(cols[cols.length - 3]);
  if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
  if (!Number.isFinite(usedKb) || !Number.isFinite(freeKb)) return null;

  return {
    total: Math.round(totalKb * 1024),
    used: Math.round(usedKb * 1024),
    free: Math.round(freeKb * 1024),
  };
}

async function readDiskStats(pathname: string, osPlatform: string): Promise<DiskStats> {
  const candidates = [...new Set([pathname, "/"])];

  // On macOS, `df -kP` aligns better with user-facing disk tools.
  // On Linux, try statfs first, then fall back to df.
  if (osPlatform === "darwin") {
    for (const p of candidates) {
      try {
        const { stdout } = await exec("df", ["-kP", p], { timeout: 2000 });
        const parsed = parseDfBytes(stdout);
        if (parsed) return parsed;
      } catch {
        /* try next candidate */
      }
    }
  }

  for (const p of candidates) {
    try {
      const fs = await statfs(p);
      const total = fs.bsize * fs.blocks;
      const free = fs.bsize * fs.bavail;
      const used = total - free;
      if (Number.isFinite(total) && total > 0) return { total, used, free };
    } catch {
      /* try next candidate */
    }
  }

  for (const p of candidates) {
    try {
      const { stdout } = await exec("df", ["-kP", p], { timeout: 2000 });
      const parsed = parseDfBytes(stdout);
      if (parsed) return parsed;
    } catch {
      /* try next candidate */
    }
  }

  return { total: 0, used: 0, free: 0 };
}

/* ── Snapshot builder ─────────────────────────────── */

async function buildSnapshot(home: string) {
  const cores = cpus();
  const osPlatform = platform();
  const workspacePath = getDefaultWorkspaceSync();
  const totalMem = totalmem();
  const freeMem = freemem();
  const usedMem = totalMem - freeMem;
  const load = loadavg();

  // Disk (workspace filesystem, OS-aware)
  const disk = await readDiskStats(workspacePath, osPlatform);

  // CPU usage (measured over 500ms)
  const cpuUsage = await measureCpuUsage();

  // OpenClaw specific stats (run in parallel, with TTL caching)
  const [
    workspaceSize,
    sessionsSize,
    memoryFileCount,
    logSize,
    sessionCount,
    processCount,
  ] = await Promise.all([
    cached("workspaceSize", 60_000, () => dirSizeBytes(getDefaultWorkspaceSync(), 3)),
    cached("sessionsSize", 60_000, () => dirSizeBytes(join(home, "agents"), 2)),
    cached("fileCount", 60_000, () => countFiles(getDefaultWorkspaceSync())),
    cached("logSize", 30_000, () => getLogFileSize(home)),
    cached("sessionCount", 30_000, () => getSessionCount(home)),
    cached("processCount", 15_000, () => getProcessCount()),
  ]);

  const fallbackMemory: MemoryStats = {
    total: totalMem,
    used: usedMem,
    free: freeMem,
    percent: Math.round((usedMem / totalMem) * 100),
    source: "os",
  };
  const memory = await (async () => {
    if (osPlatform === "darwin") {
      return cached("macMemoryStats", 2000, async () => {
        return (await readMacMemoryStats(totalMem)) || fallbackMemory;
      });
    }
    if (osPlatform === "linux") {
      return cached("linuxMemoryStats", 2000, async () => {
        return (await readLinuxMemoryStats()) || fallbackMemory;
      });
    }
    return fallbackMemory;
  })();

  return {
    ts: Date.now(),

    // CPU
    cpu: {
      model: cores[0]?.model || "unknown",
      cores: cores.length,
      usage: cpuUsage,
      speed: Math.round(cores[0]?.speed || 0),
      load1: Math.round(load[0] * 100) / 100,
      load5: Math.round(load[1] * 100) / 100,
      load15: Math.round(load[2] * 100) / 100,
    },

    // Memory
    memory,

    // Disk
    disk: {
      total: disk.total,
      used: disk.used,
      free: disk.free,
      percent: disk.total > 0 ? Math.round((disk.used / disk.total) * 100) : 0,
    },

    // System
    system: {
      hostname: hostname(),
      platform: osPlatform,
      arch: arch(),
      uptime: Math.round(uptime()),
      uptimeDisplay: formatUptime(Math.round(uptime())),
      processCount,
    },

    // OpenClaw
    openclaw: {
      homeDir: home,
      workspaceSizeBytes: workspaceSize,
      sessionsSizeBytes: sessionsSize,
      totalWorkspaceFiles: memoryFileCount,
      logSizeBytes: logSize,
      activeSessions: sessionCount,
    },
  };
}

async function getLatestSnapshot(home: string): Promise<Awaited<ReturnType<typeof buildSnapshot>>> {
  const now = Date.now();
  if (latestSnapshot && now - latestSnapshotAt < SNAPSHOT_TTL_MS) {
    return latestSnapshot;
  }
  if (snapshotInFlight) {
    return snapshotInFlight;
  }

  snapshotInFlight = (async () => {
    const snapshot = await buildSnapshot(home);
    latestSnapshot = snapshot;
    latestSnapshotAt = Date.now();
    return snapshot;
  })();

  try {
    return await snapshotInFlight;
  } finally {
    snapshotInFlight = null;
  }
}

/* ── SSE endpoint ─────────────────────────────────── */

export async function GET() {
  const home = getOpenClawHome();

  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      // Send initial snapshot immediately
      try {
        const snapshot = await getLatestSnapshot(home);
        send(snapshot);
      } catch (err) {
        send({ error: String(err) });
      }

      // Then send updates every 5 seconds
      interval = setInterval(async () => {
        if (closed) {
          clearInterval(interval);
          return;
        }
        try {
          const snapshot = await getLatestSnapshot(home);
          send(snapshot);
        } catch {
          // skip this tick
        }
      }, STREAM_INTERVAL_MS);

      // Cleanup when client disconnects
      // The controller.close() or an error will set closed = true
      // We also listen for the abort signal via the pull/cancel mechanism
    },
    cancel() {
      closed = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
