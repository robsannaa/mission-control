/**
 * Gateway-dependent route test for GET /api/status — runs in the `live`
 * Vitest project (`environment: 'node'`), never in `unit` or `component`.
 *
 * This file is gateway-dependent BY DESIGN: it exercises the handler
 * in-process against the REAL dev OpenClaw gateway through the app's own
 * `src/lib/paths.ts` discovery chain (`OPENCLAW_HOME` → `openclaw.json` →
 * default port). Nothing here is mocked, intercepted, or stood in for the
 * real call — that is the whole point of the `live` project (D-01,
 * 01-CONTEXT.md).
 *
 * It must NEVER be renamed to `*.test.ts` — that suffix change would pull it
 * into the CI-safe `unit` project, where it would fail on any machine
 * without an OpenClaw instance (including GitHub Actions).
 *
 * To run: start the dev instance first (`~/instances/dev/run.sh`), then
 * `npm run test:integration`.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as appHandler from "@/app/api/status/route";
import { describe, test, expect, beforeAll, afterAll } from "vitest";

const DEV_OPENCLAW_HOME = "/Users/clawbert/instances/dev/home";
let previousOpenClawHome: string | undefined;

beforeAll(() => {
  previousOpenClawHome = process.env.OPENCLAW_HOME;
  // Point the handler's paths.ts discovery chain at the real dev instance so
  // getGatewayUrl()/getGatewayToken() resolve through the real discovery
  // chain — no interception, no fixture, no stand-in (D-01).
  process.env.OPENCLAW_HOME = DEV_OPENCLAW_HOME;
});

afterAll(() => {
  if (previousOpenClawHome === undefined) {
    delete process.env.OPENCLAW_HOME;
  } else {
    process.env.OPENCLAW_HOME = previousOpenClawHome;
  }
});

const KNOWN_TRANSPORTS = ["cli", "http", "auto"];

describe("GET /api/status — real dev gateway contract @live", () => {
  test("returns 200 with the full StatusPayload contract, gateway online", async () => {
    await testApiHandler({
      appHandler,
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(200);
        const body = await res.json();

        for (const key of [
          "ok",
          "gateway",
          "transport",
          "transportConfigured",
          "transportReason",
          "port",
          "timestamp",
          "latencyMs",
          "stale",
        ]) {
          expect(body).toHaveProperty(key);
        }

        // A running dev gateway is this test's precondition — anything else
        // is a real failure, not a flake.
        expect(body.gateway).toBe("online");
        expect(body.port).toBe(18789);
        expect(KNOWN_TRANSPORTS).toContain(body.transport);
        expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
        expect(Number.isFinite(body.latencyMs)).toBe(true);
      },
    });
  });
});
