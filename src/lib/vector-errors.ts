/**
 * Plain-language classification of vector/memory reindex failures.
 *
 * Issue #80: a reindex that timed out or hit a missing/unreachable embedding
 * provider surfaced only as "reindex failed (500)". This turns the raw error
 * into one sentence a person can act on. Lives in lib (not the route file)
 * because Next.js route modules may only export HTTP handlers.
 */
export function describeReindexFailure(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)) || "";
  const lower = raw.toLowerCase();

  if (/timed out|timeout|aborted|aborterror|etimedout/.test(lower)) {
    return "Indexing is taking longer than a few minutes — this happens with a large memory or a slow embedding model. Progress is saved as it goes, so press Update again and it will pick up where it left off.";
  }
  // Unreachable is checked before "not configured" so phrasing like "provider
  // not responding" is treated as a down provider, not a missing one.
  if (/econnrefused|connection refused|fetch failed|not responding|unreachable|11434|1234/.test(lower)) {
    return "The embedding provider isn't responding. If you're running a local model (Ollama or LM Studio), make sure it's started, then try again.";
  }
  if (/no embedding|embedding.*not configured|no provider|provider not set|not configured/.test(lower)) {
    return "No embedding provider is set up yet. Open Settings and choose one — local Ollama needs no key, or you can add a cloud key.";
  }
  if (/unauthor|401|403|api key|invalid.*key/.test(lower)) {
    return "The embedding provider rejected the request — its API key looks missing or invalid. Check it in Settings.";
  }
  const cleaned = raw.replace(/\s+/g, " ").trim().slice(0, 300);
  return cleaned ? `Reindex could not finish: ${cleaned}` : "Reindex could not finish. Please try again.";
}
