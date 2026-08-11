/**
 * Vector reindex failures should read as something a person can act on.
 *
 * Issue #80: a reindex that timed out or hit a missing/unreachable embedding
 * provider surfaced only as "reindex failed (500)". The route now catches the
 * failure and returns a classified, plain-language message with HTTP 200 +
 * ok:false, so the UI shows guidance instead of an opaque status code.
 *
 * Pure unit tests: no gateway, no server.
 */

import { test, expect } from "@playwright/test";
import { describeReindexFailure } from "../src/lib/vector-errors";

test.describe("describeReindexFailure", () => {
  test("a timeout tells the user it is slow and resumable, not failed", () => {
    for (const e of ["This operation was aborted", "AbortError", "request timed out", "ETIMEDOUT"]) {
      const msg = describeReindexFailure(new Error(e));
      expect(msg.toLowerCase()).toContain("taking longer");
      expect(msg).not.toContain("500");
      expect(msg).toContain("pick up where it left off");
    }
  });

  test("a missing embedding provider points at Settings", () => {
    const msg = describeReindexFailure(new Error("no embedding provider configured"));
    expect(msg.toLowerCase()).toContain("no embedding provider");
    expect(msg).toContain("Settings");
  });

  test("an unreachable local model says to start it", () => {
    for (const e of ["connect ECONNREFUSED 127.0.0.1:11434", "fetch failed", "provider not responding"]) {
      const msg = describeReindexFailure(new Error(e));
      expect(msg.toLowerCase()).toMatch(/isn't responding|not responding/);
      expect(msg.toLowerCase()).toMatch(/ollama|lm studio|local/);
    }
  });

  test("a rejected key is called out as a key problem", () => {
    const msg = describeReindexFailure(new Error("401 Unauthorized: invalid api key"));
    expect(msg.toLowerCase()).toContain("key");
    expect(msg).toContain("Settings");
  });

  test("an unknown error surfaces the real text, never a bare status code", () => {
    const msg = describeReindexFailure(new Error("sqlite disk image is malformed"));
    expect(msg).toContain("sqlite disk image is malformed");
    expect(msg).not.toMatch(/^\d+$/);
  });

  test("an empty error still yields a usable sentence", () => {
    expect(describeReindexFailure(new Error(""))).toMatch(/try again/i);
  });
});
