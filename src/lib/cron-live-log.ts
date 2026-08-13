import { open, readdir, stat } from "fs/promises";
import { join } from "path";
import { redact } from "@/lib/doctor-redact";

const LOG_DIRS = [
  "/tmp/openclaw",
  "/private/tmp/openclaw",
  join(process.env.TMPDIR || "/tmp", "openclaw"),
];

function timeLabel(value: unknown): string {
  const date = new Date(String(value || ""));
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function quoted(message: string, key: string): string {
  const match = message.match(new RegExp(`${key}="([\\s\\S]*?)"(?:\\s+\\w+=|$)`));
  return match?.[1] ? redact(match[1]) : "";
}

export function formatCronDiagnosticLine(raw: string, jobId: string, sinceMs: number): string | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!JSON.stringify(row).includes(jobId)) return null;
  const at = new Date(String(row.time || "")).getTime();
  if (Number.isFinite(at) && at < sinceMs - 2_500) return null;

  const message = String(row.message || row["1"] || row["2"] || "").trim();
  if (!message) return null;
  const time = timeLabel(row.time);

  if (message.startsWith("long-running session:")) {
    const state = message.match(/\bstate=([^\s]+)/)?.[1] || "working";
    const progress =
      message
        .match(/\blastProgress=([^\s]+)/)?.[1]
        ?.replaceAll(":", " ")
        .replaceAll("_", " ") || "in progress";
    const assistant = quoted(message, "lastAssistant");
    const reason = message.match(/\breason=([^\s]+)/)?.[1]?.replaceAll("_", " ") || "";
    return `[${time}] ${state} · ${progress}${assistant ? `\n${assistant}` : reason ? ` · ${reason}` : ""}`;
  }
  if (message.includes("cleaned up timed-out agent run")) {
    return `[${time}] OpenClaw stopped the run after its timeout.`;
  }
  if (message.startsWith("lane task error:")) {
    const error = quoted(message, "error") || message.slice(message.indexOf("error=") + 6);
    return `[${time}] Error · ${redact(error)}`;
  }
  if (message.startsWith("message processed:")) {
    const outcome = message.match(/\boutcome=([^\s]+)/)?.[1] || "finished";
    const error = quoted(message, "error");
    return `[${time}] ${outcome === "error" ? "Failed" : "Finished"}${error ? ` · ${error}` : ""}`;
  }
  if (/cron:/.test(message)) {
    return `[${time}] ${redact(message)}`;
  }
  return null;
}

async function latestLogPath(): Promise<string | null> {
  for (const dir of LOG_DIRS) {
    try {
      const files = (await readdir(dir))
        .filter((file) => file.startsWith("openclaw-") && file.endsWith(".log"))
        .sort();
      if (files.length > 0) return join(dir, files[files.length - 1]);
    } catch {
      // Try the next OpenClaw temp directory.
    }
  }
  return null;
}

export async function readCronLiveLog(jobId: string, sinceMs: number): Promise<string> {
  const path = await latestLogPath();
  if (!path) return "";
  try {
    const fileStat = await stat(path);
    const maxBytes = 384 * 1024;
    const length = Math.min(maxBytes, fileStat.size);
    const start = Math.max(0, fileStat.size - length);
    const handle = await open(path, "r");
    let text = "";
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      text = buffer.toString("utf8");
    } finally {
      await handle.close();
    }
    if (start > 0) text = text.slice(Math.max(0, text.indexOf("\n") + 1));
    const seen = new Set<string>();
    return text
      .split("\n")
      .map((line) => formatCronDiagnosticLine(line, jobId, sinceMs))
      .filter((line): line is string => Boolean(line))
      .filter((line) => {
        if (seen.has(line)) return false;
        seen.add(line);
        return true;
      })
      .slice(-30)
      .join("\n\n");
  } catch {
    return "";
  }
}
