/**
 * Vitest pin for `groupFindings` (src/lib/doctor-lint.ts) — the "unit"
 * project's proof that the Vitest lane resolves the `@/*` alias and pins
 * real `src/lib` logic. No gateway, no server, no DOM.
 *
 * Pins the documented behavior from doctor-lint.ts's own header:
 *   1. Several findings sharing one `checkId` collapse into one group.
 *   2. Distinct `checkId`s stay in separate groups.
 *   3. Groups are ordered by highest-severity-first (error, then warning,
 *      then info) — `groupFindings`'s own `.sort()` call.
 *   4. A group's `severity` is the highest severity among its rows
 *      (SEVERITY_RANK: error=0 outranks warning=1 outranks info=2).
 *   5. `paths`/`targets` dedupe distinct values across rows; `fixHint` takes
 *      the first non-empty value seen.
 */

import { describe, test, expect } from "vitest";
import { groupFindings, type HealthFinding } from "@/lib/doctor-lint";

function finding(overrides: Partial<HealthFinding> & Pick<HealthFinding, "checkId" | "severity" | "message">): HealthFinding {
  return { ...overrides };
}

describe("doctor-lint: groupFindings", () => {
  test("several rows sharing one checkId collapse into one group", () => {
    const findings: HealthFinding[] = [
      finding({ checkId: "core/doctor/security", severity: "warning", message: "row 1" }),
      finding({ checkId: "core/doctor/security", severity: "warning", message: "row 2" }),
      finding({ checkId: "core/doctor/security", severity: "warning", message: "row 3" }),
    ];

    const groups = groupFindings(findings);

    expect(groups).toHaveLength(1);
    expect(groups[0].checkId).toBe("core/doctor/security");
    expect(groups[0].rows).toHaveLength(3);
  });

  test("distinct checkIds stay in separate groups", () => {
    const findings: HealthFinding[] = [
      finding({ checkId: "check-a", severity: "info", message: "a" }),
      finding({ checkId: "check-b", severity: "info", message: "b" }),
    ];

    const groups = groupFindings(findings);

    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.checkId).sort()).toEqual(["check-a", "check-b"]);
  });

  test("groups are ordered highest-severity-first: error, warning, info", () => {
    const findings: HealthFinding[] = [
      finding({ checkId: "info-check", severity: "info", message: "i" }),
      finding({ checkId: "error-check", severity: "error", message: "e" }),
      finding({ checkId: "warning-check", severity: "warning", message: "w" }),
    ];

    const groups = groupFindings(findings);

    expect(groups.map((g) => g.checkId)).toEqual(["error-check", "warning-check", "info-check"]);
  });

  test("a group's severity is the highest severity among its rows (highest-severity-wins rollup)", () => {
    const findings: HealthFinding[] = [
      finding({ checkId: "mixed", severity: "info", message: "info row" }),
      finding({ checkId: "mixed", severity: "error", message: "error row" }),
      finding({ checkId: "mixed", severity: "warning", message: "warning row" }),
    ];

    const groups = groupFindings(findings);

    expect(groups).toHaveLength(1);
    expect(groups[0].severity).toBe("error");
  });

  test("paths and targets dedupe distinct values across rows", () => {
    const findings: HealthFinding[] = [
      finding({ checkId: "dupe", severity: "warning", message: "1", path: "a.json", target: "t1" }),
      finding({ checkId: "dupe", severity: "warning", message: "2", path: "a.json", target: "t2" }),
      finding({ checkId: "dupe", severity: "warning", message: "3", path: "b.json", target: "t1" }),
    ];

    const groups = groupFindings(findings);

    expect(groups[0].paths).toEqual(["a.json", "b.json"]);
    expect(groups[0].targets).toEqual(["t1", "t2"]);
  });

  test("fixHint takes the first non-empty value seen, later rows do not override it", () => {
    const findings: HealthFinding[] = [
      finding({ checkId: "hinted", severity: "warning", message: "1" }),
      finding({ checkId: "hinted", severity: "warning", message: "2", fixHint: "run doctor --fix" }),
      finding({ checkId: "hinted", severity: "warning", message: "3", fixHint: "a different hint" }),
    ];

    const groups = groupFindings(findings);

    expect(groups[0].fixHint).toBe("run doctor --fix");
  });

  test("empty input produces no groups", () => {
    expect(groupFindings([])).toEqual([]);
  });
});
