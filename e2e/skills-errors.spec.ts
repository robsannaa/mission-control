/**
 * A failed Skills load should read as something a person can act on.
 *
 * Issue #73: on an old OpenClaw the Skills page always showed "Degraded" with a
 * raw parser error ("empty output") as the only explanation. The route now maps
 * the known failure shapes to plain-language guidance.
 *
 * Pure unit tests: no gateway, no server.
 */

import { test, expect } from "@playwright/test";
import { describeSkillsFailure } from "../src/lib/skills-errors";

test.describe("describeSkillsFailure", () => {
  test("the empty-output (no-TTY CLI) case points at updating OpenClaw", () => {
    for (const e of [
      "Failed to parse JSON from openclaw skills list --json: empty output",
      "command returned nothing",
    ]) {
      const msg = describeSkillsFailure(new Error(e));
      expect(msg.toLowerCase()).toContain("out of date");
      expect(msg.toLowerCase()).toContain("update openclaw");
      expect(msg).not.toContain("empty output");
    }
  });

  test("an unreachable gateway says to make sure OpenClaw is running", () => {
    for (const e of ["connect ECONNREFUSED 127.0.0.1:18789", "fetch failed", "request timed out"]) {
      const msg = describeSkillsFailure(new Error(e));
      expect(msg.toLowerCase()).toContain("reach openclaw");
      expect(msg.toLowerCase()).toContain("running");
    }
  });

  test("an unknown error surfaces the real text, never a bare status word", () => {
    const msg = describeSkillsFailure(new Error("unknown agent id \"main\""));
    expect(msg).toContain("unknown agent id");
    expect(msg.toLowerCase()).toContain("couldn't load skills");
  });

  test("an empty error still yields a usable sentence", () => {
    expect(describeSkillsFailure(new Error(""))).toMatch(/reload/i);
  });
});
