import type { Tone } from "./primitives";

export function formatBytes(b: number): string {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return (b / 1024).toFixed(0) + " KB";
  return b + " B";
}

/** Plain-language match strength instead of a raw 0.xxxx cosine score. */
export function formatMatchPercent(score: number): string {
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
}

export function matchTone(score: number): Tone {
  if (score >= 0.7) return "positive";
  if (score >= 0.4) return "attention";
  return "neutral";
}

export function pluralize(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}
