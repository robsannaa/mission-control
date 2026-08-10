/**
 * Plain-language formatting for the Doctor page.
 *
 * Every string here is written to be read by someone who has never opened a
 * terminal: "checked 4 minutes ago", not "age 241203ms". Nothing in this file
 * rounds a number into a claim the data does not support — an unknown age
 * returns the words for unknown, never a zero.
 */

/** "just now" · "4 minutes ago" · "3 hours ago" · "yesterday" · "6 days ago" */
export function describeAge(ageMs: number | null): string {
  if (ageMs === null || !Number.isFinite(ageMs)) return "at an unknown time";
  const ms = Math.max(0, ageMs);
  if (ms < 45_000) return "just now";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(ms / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(ms / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return `${months} month${months === 1 ? "" : "s"} ago`;
}

/** Short duration for timings the user is watching tick by. */
export function describeDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Absolute wall-clock stamp for history rows. */
export function formatStamp(ts: number, hour12: boolean | undefined): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    ...(hour12 === undefined ? {} : { hour12 }),
  });
  if (sameDay) return `Today, ${time}`;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time}`;
}

/** "one thing" / "two things" / "13 things" — numbers under ten read as words. */
const WORDS = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

export function countWord(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
}

export function pluralise(n: number, one: string, many: string): string {
  return `${countWord(n)} ${n === 1 ? one : many}`;
}

/** Sentence-cased version of `pluralise`, for the start of a line. */
export function pluraliseSentence(n: number, one: string, many: string): string {
  const s = pluralise(n, one, many);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The label a run mode carries in history and in the run panel. */
export const RUN_MODE_LABEL: Record<string, string> = {
  quick: "Quick check",
  full: "Full check",
  deep: "Deep check",
};

export function runModeLabel(mode: string): string {
  return RUN_MODE_LABEL[mode] ?? mode;
}

/** Human names for the five collection sources. */
export const SOURCE_LABEL: Record<string, string> = {
  lint: "OpenClaw health checks",
  legacy: "OpenClaw's full doctor pass",
  securityAudit: "Security audit",
  secretsAudit: "Stored credentials audit",
  runtime: "Live system readings",
};

/** What a source contributes, so "did not run" reads as a real gap. */
export const SOURCE_BLURB: Record<string, string> = {
  lint: "51 registered checks, read-only, machine-readable results.",
  legacy: "OpenClaw's own end-to-end pass, including things lint does not cover.",
  securityAudit: "How exposed this installation is, and to whom.",
  secretsAudit: "Where passwords and keys are stored in readable form.",
  runtime: "Disk, memory, responsiveness, sign-ins and pending restarts.",
};

/** Human names for the confidence classes. */
export function confidenceLabel(confidence: string): string {
  if (confidence === "structured") return "Reported directly by OpenClaw";
  if (confidence === "parsed") return "Read from OpenClaw's written output";
  return "Worked out by Mission Control";
}

export function confidenceCaveat(confidence: string): string | null {
  if (confidence === "parsed") {
    return "OpenClaw does not publish this one in a machine-readable form, so Mission Control read it from the text the command printed. The finding is real; the exact wording could change with an OpenClaw update.";
  }
  if (confidence === "derived") {
    return "Mission Control worked this out from real measurements rather than being told about it directly.";
  }
  return null;
}
