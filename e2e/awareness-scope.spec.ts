import { expect, test } from "@playwright/test";
import { resolveInteractionScope } from "../src/lib/awareness/scope";

// B2: interaction tenant/user must come from the SERVER (env or trusted-proxy
// user header), never the request body — so create/read/answer/complete all
// agree and a caller can't write into (or make invisible) another tenant.
test.describe.serial("interaction scope resolution (B2)", () => {
  test.afterEach(() => {
    delete process.env.MISSION_CONTROL_TENANT_ID;
    delete process.env.MISSION_CONTROL_USER_ID;
  });

  test("defaults to local/owner with no env or proxy header", () => {
    expect(resolveInteractionScope()).toEqual({ tenantId: "local", userId: "owner" });
  });

  test("derives tenant/user from server env", () => {
    process.env.MISSION_CONTROL_TENANT_ID = "tenant-42";
    process.env.MISSION_CONTROL_USER_ID = "user-9";
    expect(resolveInteractionScope()).toEqual({ tenantId: "tenant-42", userId: "user-9" });
  });

  test("trusted-proxy user header overrides the env user, tenant stays server-set", () => {
    process.env.MISSION_CONTROL_TENANT_ID = "tenant-42";
    const request = {
      headers: { get: (name: string) => (name === "x-mission-control-user" ? "proxy-user" : null) },
    };
    const scope = resolveInteractionScope(request);
    expect(scope.tenantId).toBe("tenant-42");
    expect(scope.userId).toBe("proxy-user");
  });
});
