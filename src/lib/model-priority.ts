/**
 * Pure helpers for the ordered OpenClaw model chain.
 * Index 0 is the configured primary; subsequent entries are fallbacks.
 */

export function normalizeModelPriority(models: unknown[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of models) {
    const ref = String(value ?? "").trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    normalized.push(ref);
  }
  return normalized;
}

export function moveModelPriority(
  models: string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= models.length ||
    toIndex >= models.length ||
    fromIndex === toIndex
  ) {
    return [...models];
  }
  const next = [...models];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
