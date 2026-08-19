/**
 * Unit coverage for the capability-aware nav filters — `sidebar.tsx`'s
 * `filterNavItemsForCapabilities()` and `search-modal.tsx`'s
 * `filterQuickActionsForCapabilities()`. Both are pure functions imported
 * directly: no rendering, no provider, no DOM interaction. A rendering test
 * would need `usePathname`/`useSearchParams` mocks that add nothing — the
 * filter itself is the unit under test (plan 03-02 Task 2).
 *
 * `ALL_NAV_ITEMS` is not exported from `search-modal.tsx` (its quick-action
 * list is a separate, hand-mirrored array — see that file's IA comment), so
 * the quick-action assertions below use a small fixture with the same shape
 * (`{ requiresCapability }`) rather than importing the real list, exercising
 * `filterQuickActionsForCapabilities` exactly as `sidebar.test.tsx` exercises
 * `filterNavItemsForCapabilities` against the real `ALL_NAV_ITEMS`.
 */
import { describe, test, expect } from "vitest";
import { ALL_NAV_ITEMS, filterNavItemsForCapabilities } from "./sidebar";
import { filterQuickActionsForCapabilities, type QuickAction } from "./search-modal";
import { NO_CAPABILITIES, type CapabilityMatrix } from "@/lib/capabilities";

const ALL_TRUE: CapabilityMatrix = {
  appleCalendar: true,
  calendarWorkspace: true,
  tailscaleNetworking: true,
  hostInfrastructure: true,
  localGatewayControl: true,
  localModelAuth: true,
};

const ONLY_CALENDAR_WORKSPACE: CapabilityMatrix = {
  ...NO_CAPABILITIES,
  calendarWorkspace: true,
};

const ONLY_HOST_INFRASTRUCTURE: CapabilityMatrix = {
  ...NO_CAPABILITIES,
  hostInfrastructure: true,
};

describe("filterNavItemsForCapabilities", () => {
  test("with NO_CAPABILITIES, drops every entry carrying requiresCapability and keeps every always-on entry, in original order", () => {
    const result = filterNavItemsForCapabilities(ALL_NAV_ITEMS, NO_CAPABILITIES);
    expect(result.some((item) => item.requiresCapability)).toBe(false);
    const alwaysOn = ALL_NAV_ITEMS.filter((item) => !item.requiresCapability);
    expect(result).toStrictEqual(alwaysOn);
  });

  test("with all six keys true, the result is ALL_NAV_ITEMS unchanged (same length, same order)", () => {
    const result = filterNavItemsForCapabilities(ALL_NAV_ITEMS, ALL_TRUE);
    expect(result).toHaveLength(ALL_NAV_ITEMS.length);
    expect(result).toStrictEqual(ALL_NAV_ITEMS);
  });

  test("with only calendarWorkspace true, Calendar is present and Logs and Backup are absent", () => {
    const result = filterNavItemsForCapabilities(ALL_NAV_ITEMS, ONLY_CALENDAR_WORKSPACE);
    expect(result.some((item) => item.section === "calendar")).toBe(true);
    expect(result.some((item) => item.section === "logs")).toBe(false);
    expect(result.some((item) => item.section === "backup")).toBe(false);
  });

  test("with only hostInfrastructure true, Logs and Backup are present and Calendar is absent — per-entry gating is independent", () => {
    const result = filterNavItemsForCapabilities(ALL_NAV_ITEMS, ONLY_HOST_INFRASTRUCTURE);
    expect(result.some((item) => item.section === "logs")).toBe(true);
    expect(result.some((item) => item.section === "backup")).toBe(true);
    expect(result.some((item) => item.section === "calendar")).toBe(false);
  });

  test("never mutates its input array", () => {
    const before = [...ALL_NAV_ITEMS];
    filterNavItemsForCapabilities(ALL_NAV_ITEMS, NO_CAPABILITIES);
    expect(ALL_NAV_ITEMS).toStrictEqual(before);
  });
});

const FIXTURE_ACTIONS: QuickAction[] = [
  { id: "chat", label: "Chat", group: "Overview", href: "/chat", icon: () => null, keywords: [] },
  { id: "calendar", label: "Calendar", group: "Overview", href: "/calendar", icon: () => null, keywords: [], requiresCapability: "calendarWorkspace" },
  { id: "logs", label: "Logs", group: "Settings", href: "/logs", icon: () => null, keywords: [], requiresCapability: "hostInfrastructure" },
];

describe("filterQuickActionsForCapabilities", () => {
  test("with NO_CAPABILITIES, drops every entry carrying requiresCapability and keeps every always-on entry, in original order", () => {
    const result = filterQuickActionsForCapabilities(FIXTURE_ACTIONS, NO_CAPABILITIES);
    expect(result.some((a) => a.requiresCapability)).toBe(false);
    expect(result.map((a) => a.id)).toStrictEqual(["chat"]);
  });

  test("with all six keys true, every action is kept, same order", () => {
    const result = filterQuickActionsForCapabilities(FIXTURE_ACTIONS, ALL_TRUE);
    expect(result).toStrictEqual(FIXTURE_ACTIONS);
  });

  test("with only calendarWorkspace true, Calendar is present and Logs is absent — per-entry gating is independent", () => {
    const result = filterQuickActionsForCapabilities(FIXTURE_ACTIONS, ONLY_CALENDAR_WORKSPACE);
    expect(result.map((a) => a.id)).toStrictEqual(["chat", "calendar"]);
  });

  test("never mutates its input array", () => {
    const before = [...FIXTURE_ACTIONS];
    filterQuickActionsForCapabilities(FIXTURE_ACTIONS, NO_CAPABILITIES);
    expect(FIXTURE_ACTIONS).toStrictEqual(before);
  });
});
