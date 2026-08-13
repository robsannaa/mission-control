/**
 * Stable, URL-safe identity for a raw log record.
 *
 * Line numbers are not stable because the logs API tails multiple rotating
 * files. Hashing the original record lets notifications deep-link to the same
 * row after sorting, filtering, and refreshes without exposing the log message
 * in the URL.
 */
export function createLogAnchor(raw: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `log-${(hash >>> 0).toString(36)}`;
}
