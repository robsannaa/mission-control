/**
 * Small, predictable fuzzy matcher for the composer menus.
 *
 * Ranking is intentionally boring: exact prefix beats substring beats
 * subsequence. A user typing "/mod" must see /model first, every time — a
 * cleverer scorer that occasionally reorders the top hit is worse than a dumb
 * one that never does.
 */

export type Ranked<T> = { item: T; score: number };

export function scoreText(haystack: string, needle: string): number {
  if (!needle) return 1;
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();

  if (text === query) return 1000;
  if (text.startsWith(query)) return 900 - text.length * 0.05;
  const index = text.indexOf(query);
  if (index > 0) return 700 - index;

  // Subsequence: "mdl" matches "model".
  let cursor = 0;
  let gaps = 0;
  for (const char of query) {
    const found = text.indexOf(char, cursor);
    if (found < 0) return -1;
    gaps += found - cursor;
    cursor = found + 1;
  }
  return 400 - gaps;
}

export function rank<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => string[],
  limit = 50,
): T[] {
  if (!query) return items.slice(0, limit);
  const ranked: Ranked<T>[] = [];
  for (const item of items) {
    let best = -1;
    for (const field of fields(item)) {
      const score = scoreText(field, query);
      if (score > best) best = score;
    }
    if (best >= 0) ranked.push({ item, score: best });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit).map((entry) => entry.item);
}
