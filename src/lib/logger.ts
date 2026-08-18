/**
 * Structured request/error logger — replaces the former hand-rolled
 * request logger module (retired in 02-04, see docs/API-CONTRACT.md).
 *
 * pino is the underlying engine; `safeLog` carries forward the exact
 * never-crash-a-request-over-logging contract the retired module already
 * implemented (a log-sink failure must never fail the request it describes).
 *
 * `createLogger(destination?)` exists so tests can capture NDJSON output
 * through an in-memory destination instead of intercepting process stdout.
 * The default `logger` export is what every route and lib module imports.
 */
import pino from "pino";

/**
 * Redaction paths. Covers the gateway auth token, the mission-control proxy
 * secret, common header locations for credentials, and credential-shaped key
 * names (`token`, `secret`, `password`, `apiKey`, `api_key`) so a payload
 * logged from any call site is censored regardless of where it lives in the
 * shape.
 *
 * Both the bare key (`token`) and the one-level-nested wildcard (`*.token`)
 * are listed: pino/fast-redact's `*` wildcard matches exactly one level, so
 * `*.token` alone redacts `someObj.token` but NOT a `token` key sitting at
 * the payload's own root (`logger.info({ token: "..." })` is a very common
 * call shape — the bare path is required to cover it too).
 */
const REDACT_PATHS = [
  "gateway.auth.token",
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "token",
  "secret",
  "password",
  "apiKey",
  "api_key",
  "*.token",
  "*.secret",
  "*.password",
  "*.apiKey",
  "*.api_key",
  "MISSION_CONTROL_PROXY_SECRET",
  "OPENCLAW_GATEWAY_TOKEN",
];

const REDACT_CENSOR = "[Redacted]";

function shouldUsePrettyTransport(): boolean {
  return process.env.NODE_ENV === "development" && process.env.NEXT_RUNTIME === "nodejs";
}

/**
 * Build a pino instance. Pass `destination` in tests to capture output
 * in-memory; omit it in production code to use pino's default (stdout, or
 * the pino-pretty transport in local development).
 */
export function createLogger(destination?: pino.DestinationStream): pino.Logger {
  const options: pino.LoggerOptions = {
    level: process.env.LOG_LEVEL || "info",
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
  };

  if (destination) {
    return pino(options, destination);
  }

  if (shouldUsePrettyTransport()) {
    return pino({
      ...options,
      transport: { target: "pino-pretty" },
    });
  }

  return pino(options);
}

export const logger: pino.Logger = createLogger();

/** Scoped logger carrying fixed bindings (e.g. route name) on every line. */
export function childLogger(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}

/**
 * Invoke `fn` for its logging side effect, swallowing any throw. A broken
 * log sink (disk full, pipe closed) must never fail the request it is
 * describing — the same contract the retired module's `emit()` implemented.
 */
export function safeLog(fn: () => void): void {
  try {
    fn();
  } catch {
    // swallow — never crash a request over logging
  }
}
