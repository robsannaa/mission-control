/**
 * Unit coverage for `src/lib/logger.ts` — redaction and the safe-emit
 * contract. Uses `createLogger(destination)` with an in-memory destination
 * to capture NDJSON output directly rather than intercepting process
 * stdout (the injectable-destination seam exists exactly for this).
 */
import { describe, test, expect } from "vitest";
import { createLogger, safeLog } from "./logger";

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

describe("logger redaction", () => {
  test("censors a root-level token-named key and drops the raw value", () => {
    const { destination, lines } = makeCapture();
    const logger = createLogger(destination);

    logger.info({ token: "raw-secret-value" }, "root token");

    const [entry] = lines();
    expect(entry.token).toBe("[Redacted]");
    expect(JSON.stringify(entry)).not.toContain("raw-secret-value");
  });

  test("censors a nested gateway.auth.token path and drops the raw value", () => {
    const { destination, lines } = makeCapture();
    const logger = createLogger(destination);

    logger.info({ gateway: { auth: { token: "nested-secret-value" } } }, "nested token");

    const [entry] = lines();
    const gateway = entry.gateway as { auth: { token: string } };
    expect(gateway.auth.token).toBe("[Redacted]");
    expect(JSON.stringify(entry)).not.toContain("nested-secret-value");
  });

  test("censors wildcard-matched secret/password/apiKey keys one level deep", () => {
    const { destination, lines } = makeCapture();
    const logger = createLogger(destination);

    logger.info(
      {
        req: { secret: "sec-value" },
        config: { password: "pw-value", apiKey: "key-value" },
      },
      "wildcard fields",
    );

    const [entry] = lines();
    const req = entry.req as { secret: string };
    const config = entry.config as { password: string; apiKey: string };
    expect(req.secret).toBe("[Redacted]");
    expect(config.password).toBe("[Redacted]");
    expect(config.apiKey).toBe("[Redacted]");
    expect(JSON.stringify(entry)).not.toContain("sec-value");
    expect(JSON.stringify(entry)).not.toContain("pw-value");
    expect(JSON.stringify(entry)).not.toContain("key-value");
  });

  test("leaves non-credential fields untouched", () => {
    const { destination, lines } = makeCapture();
    const logger = createLogger(destination);

    logger.info({ route: "/api/agents", status: 200 }, "ordinary line");

    const [entry] = lines();
    expect(entry.route).toBe("/api/agents");
    expect(entry.status).toBe(200);
  });
});

describe("safeLog", () => {
  test("returns normally when the wrapped call throws", () => {
    expect(() =>
      safeLog(() => {
        throw new Error("log sink exploded");
      }),
    ).not.toThrow();
  });

  test("still runs the wrapped call when it does not throw", () => {
    let ran = false;
    safeLog(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});
