/**
 * CI-safe route-handler tests for the integrations/accounts/channels batch
 * (02-06) — runs in the `unit` project under `environment: 'node'`
 * (next-test-api-route-handler patches Next.js internals; jsdom breaks that
 * patching, so this file must never be collected by the `component`
 * project).
 *
 * Every case here rejects before any external provider call (Gmail,
 * Calendar, Drive, gog) or Google-account-store lookup is reached — the
 * `integrationsPostSchema` discriminated union and the shared
 * `googleAccountRouteParamsSchema` route-param schema both run inside
 * `withRoute`'s pre-handler validation step, before the route handler
 * itself is ever invoked. That is what makes these tests gateway- and
 * filesystem-independent: `getGoogleAccountHealth` (which calls
 * `listAgents()`, a gateway RPC) is provably never reached in the
 * malformed-identifier case below — proven by the response message being
 * the schema's "Invalid Google account id" rather than the lookup's
 * "Google account not found: <id>" (see `src/lib/google-integrations-api.ts`).
 * Anything that needs the real gateway belongs in a `*.live.test.ts` file
 * (the `live` project), never here.
 */
import { testApiHandler } from "next-test-api-route-handler"; // ◄ must be first import
import * as integrationsHandler from "@/app/api/integrations/route";
import * as googleAccountHealthHandler from "@/app/api/integrations/google/accounts/[id]/health/route";
import { describe, test, expect } from "vitest";

describe("POST /api/integrations — pre-gateway validation (no instance required)", () => {
  test("unrecognized action → 400 with the project error envelope and a details tree naming the action field", async () => {
    await testApiHandler({
      appHandler: integrationsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "not-a-real-action" }),
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
        // `details` is a Zod treeifyError() tree — the discriminated union's
        // invalid-discriminator issue is reported against the `action`
        // field path.
        expect(body.details).toBeDefined();
        expect(JSON.stringify(body.details)).toContain("action");
      },
    });
  });

  test("malformed JSON body → 400 with the project error envelope", async () => {
    await testApiHandler({
      appHandler: integrationsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "not json",
        });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(typeof body.error).toBe("string");
        expect(body.error.length).toBeGreaterThan(0);
      },
    });
  });

  test("no field in the rejection body looks like a stored provider token", async () => {
    await testApiHandler({
      appHandler: integrationsHandler,
      test: async ({ fetch }) => {
        const res = await fetch({
          method: "POST",
          headers: { "content-type": "application/json" },
          // A caller submitting a credential-shaped field in a malformed
          // (unrecognized-action) request must never see it echoed back —
          // details is always a Zod issue tree, never the raw body
          // (docs/API-CONTRACT.md §1).
          body: JSON.stringify({ action: "not-a-real-action", accessToken: "super-secret-value" }),
        });
        expect(res.status).toBe(400);
        const raw = await res.text();
        expect(raw).not.toContain("super-secret-value");
        const body = JSON.parse(raw);
        expect(body).not.toHaveProperty("token");
        expect(body).not.toHaveProperty("accessToken");
        expect(body).not.toHaveProperty("refreshToken");
      },
    });
  });
});

describe("GET /api/integrations/google/accounts/[id]/health — route-param validation (no instance required)", () => {
  test("out-of-format account id → 400 with the project error envelope, no account lookup attempted", async () => {
    await testApiHandler({
      appHandler: googleAccountHealthHandler,
      params: { id: "not a valid id ; drop table accounts" },
      test: async ({ fetch }) => {
        const res = await fetch({ method: "GET" });
        expect(res.status).toBe(400);
        expect(res.headers.get("content-type")).toContain("application/json");
        const body = await res.json();
        expect(body.ok).toBe(false);
        // The schema's own message — NOT
        // `getGoogleAccountHealth`'s "Google account not found: <id>" —
        // proves the request was rejected before any store lookup ran.
        expect(body.error).toBe("Invalid Google account id");
        expect(body.details).toBeDefined();
      },
    });
  });
});
