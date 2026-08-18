/**
 * CI-safe route-handler tests pinning the automation route group's
 * schema-boundary rejection branches (02-09 Task 3).
 *
 * This file drives two route modules:
 *
 *   - `@/app/api/cron/route` — the scheduled-jobs (cron) POST action switch
 *     and its schedule-expression format check.
 *   - `@/app/api/mcp/route` — the MCP tool-server's `create`/`update` POST
 *     action, where `server.url` (the probe's eventual outbound target) is
 *     constrained to a parsed absolute URL with an allowed scheme set
 *     (T-02-39). `GET /api/mcp/probe` itself takes no URL — it only
 *     resolves a `name` against a server config already written (and
 *     already validated) through this route, so the schema boundary that
 *     stops an unsafe target from ever reaching a probe lives here, at
 *     write time, not in the probe route.
 *
 * Every case below is rejected by `withRoute`'s schema-validation step
 * (`src/lib/api-route.ts#resolveInputs`) BEFORE the handler runs, so none of
 * these requests ever reach `gatewayCall`/`runCli`/`saveServer` — this file
 * stays green with no OpenClaw instance running and registers nothing.
 * Anything that needs the real gateway belongs in a `*.live.test.ts` file
 * (the `live` project), never here.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import { describe, test, expect, vi } from "vitest";

vi.mock("@/lib/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/mcp")>();
  return {
    ...actual,
    saveServer: vi.fn(actual.saveServer),
  };
});

import * as cronRoute from "@/app/api/cron/route";
import * as mcpRoute from "@/app/api/mcp/route";
import { saveServer } from "@/lib/mcp";

describe("POST /api/cron — pre-registration validation (no instance required)", () => {
  test("unrecognized action → 400 with ok:false and a details tree naming the action field", async () => {
    await testApiHandler({
      appHandler: cronRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "reticulate-splines" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        // The discriminated union rejects the unrecognized action at the
        // `action` field — the details tree names it.
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("action");
      },
    });
  });

  test("malformed schedule expression on create → 400 with ok:false, no job registered", async () => {
    await testApiHandler({
      appHandler: cronRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "create",
            name: "test-job",
            scheduleKind: "cron",
            cronExpr: "not a cron expression at all",
            payloadKind: "systemEvent",
            message: "hello",
          }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("cronExpr");
      },
    });
  });
});

describe("POST /api/mcp — tool-server target validation (no instance required)", () => {
  test("target that is not an absolute URL → 400 with ok:false, no outbound write attempted", async () => {
    await testApiHandler({
      appHandler: mcpRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "create",
            server: { name: "test-server", transport: "streamable-http", url: "not-a-url" },
          }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("url");
      },
    });
    // The rejection happened at the schema boundary — saveServer (which
    // would shell out to `openclaw mcp set`) was never reached.
    expect(saveServer).not.toHaveBeenCalled();
  });

  test("target with a scheme outside the allowed set → 400 with ok:false", async () => {
    await testApiHandler({
      appHandler: mcpRoute,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "create",
            server: { name: "test-server", transport: "streamable-http", url: "ftp://example.com/mcp" },
          }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("url");
      },
    });
    expect(saveServer).not.toHaveBeenCalled();
  });
});
