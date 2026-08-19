/**
 * Pure fixture-table coverage for `computeCapabilities()` — the function is
 * pure, so nothing is stubbed or mocked. Style matches
 * `src/lib/api-errors.test.ts`.
 */
import { describe, test, expect } from "vitest";
import {
  CAPABILITY_KEYS,
  NO_CAPABILITIES,
  computeCapabilities,
  type CapabilityMatrix,
} from "./capabilities";

/** Build the expected matrix: every key `true` except the ones listed. */
function allTrueExcept(offKeys: (keyof CapabilityMatrix)[]): CapabilityMatrix {
  const result = {} as CapabilityMatrix;
  for (const key of CAPABILITY_KEYS) {
    result[key] = !offKeys.includes(key);
  }
  return result;
}

describe("computeCapabilities", () => {
  test("darwin + not hosted + icalBuddy present -> appleCalendar true, all keys true", () => {
    const result = computeCapabilities({ platform: "darwin", hosted: false, icalBuddyAvailable: true });
    expect(result).toStrictEqual(allTrueExcept([]));
  });

  test("darwin + not hosted + icalBuddy absent -> appleCalendar false, the other five still true", () => {
    const result = computeCapabilities({ platform: "darwin", hosted: false, icalBuddyAvailable: false });
    expect(result).toStrictEqual(allTrueExcept(["appleCalendar"]));
  });

  test("linux + not hosted + icalBuddy present -> appleCalendar false (platform gate independent of the probe)", () => {
    const result = computeCapabilities({ platform: "linux", hosted: false, icalBuddyAvailable: true });
    expect(result).toStrictEqual(allTrueExcept(["appleCalendar"]));
  });

  test("linux + hosted + icalBuddy absent -> every key false", () => {
    const result = computeCapabilities({ platform: "linux", hosted: true, icalBuddyAvailable: false });
    expect(result).toStrictEqual(NO_CAPABILITIES);
  });

  test("darwin + hosted + icalBuddy present -> every key false (hosted wins over a present binary)", () => {
    const result = computeCapabilities({ platform: "darwin", hosted: true, icalBuddyAvailable: true });
    expect(result).toStrictEqual(NO_CAPABILITIES);
  });

  test("the returned object's key set is exactly CAPABILITY_KEYS — no extra key, no missing key", () => {
    const result = computeCapabilities({ platform: "darwin", hosted: false, icalBuddyAvailable: true });
    expect(Object.keys(result).sort()).toStrictEqual([...CAPABILITY_KEYS].sort());
  });
});

describe("NO_CAPABILITIES", () => {
  test("every key is false", () => {
    for (const key of CAPABILITY_KEYS) {
      expect(NO_CAPABILITIES[key]).toBe(false);
    }
  });

  test("is not mutated by a computeCapabilities call", () => {
    const before = { ...NO_CAPABILITIES };
    computeCapabilities({ platform: "darwin", hosted: false, icalBuddyAvailable: true });
    expect(NO_CAPABILITIES).toStrictEqual(before);
  });
});
