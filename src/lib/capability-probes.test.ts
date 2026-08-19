/**
 * Cache/TTL/invalidate and hosted-flag-freshness coverage for
 * `src/lib/capability-probes.ts` (CAP-04). No module mocking of any kind —
 * only `vi.stubEnv` for our own env var (stubbing OUR OWN env var is in
 * bounds; the no-mocks rule covers the gateway and G-Brain, not process env)
 * and real temp files for the probe-freshness case, per 03-01-PLAN.md Task 2.
 * `invalidateProbeCache()` runs in `beforeEach` so cache state never leaks
 * between tests.
 *
 * `getCachedIcalBuddyAvailable()` takes an explicit `candidates` override so
 * the cache/TTL contract can be pinned against a real temp executable
 * without depending on `process.platform` (this suite must stay green on
 * the Linux CI runner, not just this macOS dev machine — the darwin/hosted
 * skip that decides *whether* to probe at all lives in
 * `getCapabilitySnapshot`, one level up, and is exercised separately below).
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  probeBinary,
  invalidateProbeCache,
  getCachedIcalBuddyAvailable,
  getCapabilitySnapshot,
} from "./capability-probes";

beforeEach(() => {
  invalidateProbeCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
  invalidateProbeCache();
});

describe("probeBinary", () => {
  test("resolves false for a nonexistent candidate, never throws", async () => {
    await expect(probeBinary(["/definitely/not/here/xyz"])).resolves.toBe(false);
  });
});

describe("probe cache freshness (CAP-04)", () => {
  let dir: string;
  let binPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cap-probe-"));
    binPath = join(dir, "fake-icalbuddy");
    writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
    chmodSync(binPath, 0o755);
  });

  afterEach(() => {
    if (existsSync(binPath)) rmSync(binPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  test("probeBinary against a real executable resolves true", async () => {
    await expect(probeBinary([binPath])).resolves.toBe(true);
  });

  test("cached result survives the file's deletion until invalidateProbeCache() is called", async () => {
    await expect(getCachedIcalBuddyAvailable({ candidates: [binPath] })).resolves.toBe(true);
    rmSync(binPath, { force: true });
    // Stale cache still says true — no rebuild/restart needed to prove this,
    // and no invalidate/force has happened yet either.
    await expect(getCachedIcalBuddyAvailable({ candidates: [binPath] })).resolves.toBe(true);
    invalidateProbeCache();
    await expect(getCachedIcalBuddyAvailable({ candidates: [binPath] })).resolves.toBe(false);
  });

  test("force bypasses the cache without needing invalidateProbeCache()", async () => {
    await expect(getCachedIcalBuddyAvailable({ candidates: [binPath] })).resolves.toBe(true);
    rmSync(binPath, { force: true });
    await expect(
      getCachedIcalBuddyAvailable({ candidates: [binPath], force: true }),
    ).resolves.toBe(false);
  });
});

describe("getCapabilitySnapshot — hosted flag freshness", () => {
  test("the hosted flag is read fresh through process.env at request time, not inlined at build time", async () => {
    vi.stubEnv("AGENTBAY_HOSTED", "true");
    const snapshot = await getCapabilitySnapshot({ force: true });
    expect(snapshot.hosted).toBe(true);
    expect(Object.values(snapshot.capabilities).every((value) => value === false)).toBe(true);
  });
});
