/**
 * The environment boundary for the capability matrix (D-07): the ONLY file
 * in `src/` allowed to read the legacy hosted env flags. Every other
 * consumer must go through `getCapabilitySnapshot()` / `requireCapability()`
 * exported here — never re-derive the env-flag OR expression at another
 * call site (that sprawl is exactly what CAP-01 closes).
 *
 * Server-only: uses `node:child_process` and `next/server`. Not importable
 * from a client bundle — `src/lib/capabilities.ts` stays the pure,
 * client-safe half of this module pair.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { notFound } from "@/lib/api-errors";
import {
  computeCapabilities,
  UNAVAILABLE_MESSAGE,
  type CapabilityKey,
  type CapabilitySnapshot,
} from "@/lib/capabilities";

const exec = promisify(execFile);

// Prefer the Homebrew path but fall back to PATH resolution — the same
// candidate list and ENOENT-catch idiom as src/lib/apple-calendar.ts (D-04).
// This probe is existence-only (`-h`); it must never call
// readAppleCalendarEvents(), which performs a real Calendar read.
const ICALBUDDY_CANDIDATES = ["/opt/homebrew/bin/icalBuddy", "/usr/local/bin/icalBuddy", "icalBuddy"];
const PROBE_TIMEOUT_MS = 2_000;

/**
 * Read the hosted deployment flag fresh through `process.env` on every
 * call — never cached, never inlined at build time — so restarting the
 * process with a different value changes the answer without a rebuild
 * (RESEARCH Pitfall 1, CAP-04). The server-only flag takes precedence over
 * the public one when both are set.
 */
export function readHostedFlag(): boolean {
  return (
    process.env.AGENTBAY_HOSTED === "true" ||
    process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true"
  );
}

/**
 * Existence-only probe: does any candidate binary run without ENOENT? Never
 * throws — every rejection, timeout or unexpected error resolves `false`
 * (fail-closed, T-03-03), whether that's because the candidate is missing
 * (ENOENT, tried next) or because it exists but failed for any other reason
 * (returned false immediately rather than treated as "found").
 */
export async function probeBinary(candidates: string[]): Promise<boolean> {
  for (const bin of candidates) {
    try {
      await exec(bin, ["-h"], { timeout: PROBE_TIMEOUT_MS });
      return true;
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") continue;
      return false;
    }
  }
  return false;
}

interface ProbeCacheEntry {
  icalBuddyAvailable: boolean;
  ts: number;
}

/** Newest icalBuddy probe result held in this process. Survives navigation, not restarts. */
let probeCache: ProbeCacheEntry | null = null;

/** Default freshness for the icalBuddy binary probe (CAP-04). */
export const PROBE_TTL_MS = 5 * 60_000;

/** Invalidate the cache — the next read re-probes. Called by `?refresh=1`. */
export function invalidateProbeCache(): void {
  probeCache = null;
}

/**
 * TTL-cached wrapper around `probeBinary()` for the icalBuddy candidates —
 * the CAP-04 freshness contract, modeled on `doctor-snapshot.ts`'s
 * `getSnapshot({ maxAgeMs, force })`. Exported directly (not only reachable
 * through `getCapabilitySnapshot`) so cache/TTL/invalidate behavior can be
 * pinned in tests against a real temp-file candidate without depending on
 * `process.platform` — the darwin/hosted skip that decides *whether* to
 * probe at all lives one level up, in `getCapabilitySnapshot`.
 */
export async function getCachedIcalBuddyAvailable(
  options: { force?: boolean; maxAgeMs?: number; candidates?: string[] } = {},
): Promise<boolean> {
  const maxAgeMs = options.maxAgeMs ?? PROBE_TTL_MS;
  if (!options.force && probeCache && Date.now() - probeCache.ts <= maxAgeMs) {
    return probeCache.icalBuddyAvailable;
  }
  const candidates = options.candidates ?? ICALBUDDY_CANDIDATES;
  const icalBuddyAvailable = await probeBinary(candidates).catch(() => false);
  probeCache = { icalBuddyAvailable, ts: Date.now() };
  return icalBuddyAvailable;
}

/**
 * Resolve the full capability snapshot. Platform and the hosted flag are
 * read fresh every call (cheap, and they cannot change without a restart);
 * only the binary probe is cached. The probe is skipped entirely — resolved
 * `false` — when `platform !== "darwin" || hosted`, so a hosted or
 * non-macOS process never spawns a subprocess to answer a capability that
 * `computeCapabilities()` would gate to `false` anyway. Any rejection along
 * this path resolves to `false` and the snapshot still returns — never
 * throws.
 */
export async function getCapabilitySnapshot(
  options: { force?: boolean; maxAgeMs?: number } = {},
): Promise<CapabilitySnapshot> {
  const hosted = readHostedFlag();
  const platform = process.platform;

  const icalBuddyAvailable =
    !hosted && platform === "darwin"
      ? await getCachedIcalBuddyAvailable(options).catch(() => false)
      : false;

  return {
    capabilities: computeCapabilities({ platform, hosted, icalBuddyAvailable }),
    hosted,
  };
}

/**
 * Server-side enforcement guard (CAP-03). Resolves the snapshot and, when
 * `key` is absent, returns the fixed 404 refusal built through `notFound()`
 * — never a hand-built `{ ok: false }` literal (T-03-02). A thrown error
 * anywhere in this path is caught and also produces the refusal: fail
 * closed, never leak a capability that couldn't be confirmed.
 */
export async function requireCapability(key: CapabilityKey): Promise<Response | null> {
  try {
    const snapshot = await getCapabilitySnapshot();
    if (snapshot.capabilities[key] === true) return null;
    return notFound(UNAVAILABLE_MESSAGE);
  } catch {
    return notFound(UNAVAILABLE_MESSAGE);
  }
}
