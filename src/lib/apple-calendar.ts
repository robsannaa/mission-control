/**
 * Apple Calendar reader (local, macOS only).
 *
 * Reads the machine's own Apple Calendar via `icalBuddy` and never leaves the
 * host — this is the same loopback-local posture as the rest of Mission Control.
 * Requires macOS to have granted Calendar access to the process that runs
 * icalBuddy (System Settings → Privacy & Security → Calendars).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Prefer the Homebrew path but fall back to PATH resolution.
const ICALBUDDY_CANDIDATES = ["/opt/homebrew/bin/icalBuddy", "/usr/local/bin/icalBuddy", "icalBuddy"];

export interface AppleCalendarEvent {
  id: string;
  title: string;
  date: string;        // YYYY-MM-DD (start day)
  endDate?: string;    // YYYY-MM-DD when the event spans days
  startTime?: string;  // HH:MM, absent for all-day events
  endTime?: string;    // HH:MM
  allDay: boolean;
  location?: string;
}

export interface AppleCalendarResult {
  available: boolean;         // false when icalBuddy is missing or Calendar access is denied
  reason?: string;            // human explanation when unavailable
  events: AppleCalendarEvent[];
}

function parseDateLine(line: string): Pick<AppleCalendarEvent, "date" | "endDate" | "startTime" | "endTime" | "allDay"> | null {
  const dates = line.match(/\d{4}-\d{2}-\d{2}/g) || [];
  const date = dates[0];
  if (!date) return null;
  const times = line.match(/\b\d{2}:\d{2}\b/g) || [];
  return {
    date,
    endDate: dates[1] && dates[1] !== date ? dates[1] : undefined,
    startTime: times[0],
    endTime: times[1],
    allDay: times.length === 0,
  };
}

export function parseIcalBuddyOutput(out: string): AppleCalendarEvent[] {
  const events: AppleCalendarEvent[] = [];
  const blocks = out.split("@@EVT@@").map((b) => b.replace(/\s+$/, "")).filter((b) => b.trim());
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    const title = lines[0].trim();
    if (!title) continue;
    const rest = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    const dateIdx = rest.findIndex((l) => /^\d{4}-\d{2}-\d{2}/.test(l));
    const when = dateIdx >= 0 ? parseDateLine(rest[dateIdx]) : null;
    if (!when) continue;
    const location = rest.slice(0, dateIdx >= 0 ? dateIdx : 0).join(", ") || undefined;
    events.push({
      id: createHash("sha1").update(`${title}|${rest[dateIdx]}`).digest("hex").slice(0, 12),
      title,
      location,
      ...when,
    });
  }
  return events;
}

async function runIcalBuddy(range: string): Promise<string> {
  let lastErr: unknown;
  for (const bin of ICALBUDDY_CANDIDATES) {
    try {
      const { stdout } = await exec(
        bin,
        [
          "-nc",            // no calendar names header
          "-nrd",           // absolute dates, not "tomorrow"
          "-npn",           // no property names
          "-b", "@@EVT@@",  // event delimiter
          "-iep", "title,datetime,location",
          "-eep", "notes,attendees,url",
          "-df", "%Y-%m-%d",
          "-tf", "%H:%M",
          range,
        ],
        { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout;
    } catch (err) {
      lastErr = err;
      // ENOENT → try the next candidate path; other errors are real failures.
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") continue;
      throw err;
    }
  }
  throw lastErr ?? new Error("icalBuddy not found");
}

/** Read upcoming Apple Calendar events for the next `days` days. */
export async function readAppleCalendarEvents(days = 30): Promise<AppleCalendarResult> {
  const window = Math.max(1, Math.min(365, Math.floor(days) || 30));
  try {
    const out = await runIcalBuddy(`eventsToday+${window}`);
    return { available: true, events: parseIcalBuddyOutput(out) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT|not found/i.test(message)) {
      return { available: false, reason: "icalBuddy is not installed (brew install ical-buddy).", events: [] };
    }
    if (/access|permission|denied|not authori/i.test(message)) {
      return {
        available: false,
        reason: "Mission Control does not have macOS Calendar access. Grant it in System Settings → Privacy & Security → Calendars.",
        events: [],
      };
    }
    return { available: false, reason: message, events: [] };
  }
}
