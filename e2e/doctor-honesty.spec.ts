/**
 * The Doctor page's honesty guarantees, pinned as tests.
 *
 * These exist because the page's whole reason for being rebuilt was that it
 * reported "health score 100, healthy" from a liveness probe while the real
 * `openclaw doctor` was finding genuine problems. Two regressions of exactly
 * that shape were caught in review and are fixed here; without tests, nothing
 * stops them coming back:
 *
 *   1. `normalizeDoctorText` returned "All health checks passed" for output it
 *      had failed to parse — including `doctor --lint` prose that plainly
 *      contained `[error]` lines.
 *   2. Live fix output streamed raw subprocess text to the browser. One repair
 *      (`--generate-gateway-token`) prints a fresh gateway token on stdout.
 *
 * Pure unit tests: no gateway, no server, no CLI.
 */

import { test, expect } from "@playwright/test";
import { normalizeDoctorText } from "../src/lib/doctor-report";
import { redact } from "../src/lib/doctor-redact";

const worstStatus = (checks: { status: string }[]) =>
  checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";

test.describe("doctor never invents a clean bill of health", () => {
  test("output it cannot parse is reported as unreadable, not as healthy", () => {
    const { checks } = normalizeDoctorText("something entirely unexpected\nblah blah");

    expect(worstStatus(checks)).not.toBe("ok");
    expect(checks.some((c) => /could not be read/i.test(c.name))).toBe(true);
    expect(checks.some((c) => /all health checks passed/i.test(c.name))).toBe(false);
  });

  test("empty output is not success", () => {
    const { checks } = normalizeDoctorText("");
    expect(worstStatus(checks)).not.toBe("ok");
  });

  test("lint prose findings are parsed rather than swallowed", () => {
    // The exact shape `doctor --lint` prints when its JSON envelope is absent.
    const { checks } = normalizeDoctorText(
      [
        "  [warning] core/doctor/gateway-auth Gateway auth is set to insecure mode.",
        "  [error] core/doctor/legacy-state Legacy state detected and migration is blocked.",
      ].join("\n"),
    );

    expect(worstStatus(checks)).toBe("fail");
    expect(checks.some((c) => /insecure mode/i.test(c.message ?? ""))).toBe(true);
    expect(checks.some((c) => /migration is blocked/i.test(c.message ?? ""))).toBe(true);
  });

  test("a genuinely clean run is still allowed to say so", () => {
    const { checks } = normalizeDoctorText("Running checks...\nDoctor complete. No problems found.");
    expect(worstStatus(checks)).toBe("ok");
    expect(checks.some((c) => /all health checks passed/i.test(c.name))).toBe(true);
  });
});

test.describe("credentials never reach the client", () => {
  test("a gateway-token-shaped string is masked", () => {
    // 48 hex chars — the shape `openclaw doctor --generate-gateway-token` emits.
    const token = "a".repeat(12) + "b3c4d5e6f7" + "0".repeat(26);
    const out = redact(`Generated new gateway token: ${token}`);

    expect(out).not.toContain(token);
    expect(out).toContain("[redacted]");
  });

  test("common provider key shapes are masked", () => {
    for (const secret of [
      "sk-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
      "xoxb-1234567890-abcdefghijkl",
    ]) {
      expect(redact(`key=${secret}`)).not.toContain(secret);
    }
  });

  test("redaction is idempotent and leaves ordinary prose intact", () => {
    const prose = "Gateway is listening on port 18789 and 3 cron jobs are isolated.";
    expect(redact(prose)).toBe(prose);
    expect(redact(redact("token: " + "f".repeat(48)))).toBe(redact("token: " + "f".repeat(48)));
  });
});
