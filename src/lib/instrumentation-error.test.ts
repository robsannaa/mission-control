/**
 * Unit coverage for `src/lib/instrumentation-error.ts` — the reporter behind
 * `instrumentation.ts`'s `onRequestError` export (02-03-PLAN.md Task 1).
 * Driven directly (not through the Next.js instrumentation lifecycle, which
 * the route-handler test harness cannot reach) with a logger built over an
 * in-memory destination, matching the pattern in `src/lib/logger.test.ts`.
 */
import { describe, test, expect } from "vitest";
import { createLogger } from "@/lib/logger";
import { reportRequestError } from "./instrumentation-error";

type CaptureDestination = {
  write: (chunk: string) => boolean;
};

function makeCapture(): { destination: CaptureDestination; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  return {
    destination: {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("reportRequestError", () => {
  test("emits one error-level log line carrying message, path, method and route type", () => {
    const { destination, lines } = makeCapture();
    const log = createLogger(destination);

    reportRequestError(
      new Error("boom"),
      { path: "/api/agents", method: "POST" },
      { routeType: "route" },
      log,
    );

    const entries = lines();
    expect(entries).toHaveLength(1);
    const [entry] = entries;
    expect(entry.level).toBe(50); // pino error level
    expect(entry.error).toBe("boom");
    expect(entry.route).toBe("/api/agents");
    expect(entry.method).toBe("POST");
    expect(entry.routeType).toBe("route");
  });

  test("emits a line and does not throw for a thrown non-Error value", () => {
    const { destination, lines } = makeCapture();
    const log = createLogger(destination);

    expect(() =>
      reportRequestError("just a string throw", { path: "/api/tasks", method: "GET" }, { routeType: "render" }, log),
    ).not.toThrow();

    const [entry] = lines();
    expect(entry.error).toBe("just a string throw");
    expect(entry.route).toBe("/api/tasks");
  });

  test("emits a line and does not throw for a thrown plain object", () => {
    const { destination, lines } = makeCapture();
    const log = createLogger(destination);

    expect(() =>
      reportRequestError({ oops: true }, { path: "/api/config", method: "GET" }, { routeType: "action" }, log),
    ).not.toThrow();

    const [entry] = lines();
    expect(typeof entry.error).toBe("string");
    expect(entry.route).toBe("/api/config");
  });

  test("surfaces a digest property carried on the error object", () => {
    const { destination, lines } = makeCapture();
    const log = createLogger(destination);

    const err = Object.assign(new Error("digested failure"), { digest: "NEXT_DIGEST_ABC123" });
    reportRequestError(err, { path: "/api/gateway", method: "POST" }, { routeType: "route" }, log);

    const [entry] = lines();
    expect(entry.digest).toBe("NEXT_DIGEST_ABC123");
  });

  test("returns normally when the injected logger's write throws", () => {
    const throwingLog = createLogger({
      write() {
        throw new Error("log sink exploded");
      },
    });

    expect(() =>
      reportRequestError(new Error("original failure"), { path: "/api/status", method: "GET" }, { routeType: "route" }, throwingLog),
    ).not.toThrow();
  });

  test("censors a credential-named field carried in the error context", () => {
    const { destination, lines } = makeCapture();
    const log = createLogger(destination);

    reportRequestError(
      new Error("auth failure"),
      { path: "/api/gateway", method: "POST" },
      { routeType: "route", token: "raw-secret-value" },
      log,
    );

    const [entry] = lines();
    expect(JSON.stringify(entry)).not.toContain("raw-secret-value");
    const context = entry.context as { token?: string };
    expect(context.token).toBe("[Redacted]");
  });
});
