import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { devicesPostSchema } from "@/lib/schemas/system";

type TokenInfo = {
  role: string;
  scopes: string[];
  createdAtMs: number;
  rotatedAtMs?: number;
  lastUsedAtMs: number;
};

type PairedDevice = {
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform: string;
  clientId: string;
  clientMode: string;
  role: string;
  roles: string[];
  scopes: string[];
  tokens: TokenInfo[];
  createdAtMs: number;
  approvedAtMs: number;
};

type PendingRequest = {
  requestId: string;
  deviceId: string;
  publicKey: string;
  displayName?: string;
  platform: string;
  clientId: string;
  clientMode: string;
  requestedRole: string;
  requestedScopes: string[];
  createdAtMs: number;
  expiresAtMs: number;
};

type DeviceListResult = {
  pending: PendingRequest[];
  paired: PairedDevice[];
};

/**
 * GET /api/devices - List all pending requests and paired devices.
 *
 * Deliberately never returns an error status: on a gateway failure it
 * serves an empty, explicitly-degraded list (`degraded: true`) instead.
 * Kept as an internal try/catch (not thrown) so `withRoute`'s own catch
 * never sees this failure and never converts it into a 500 (T-02-46).
 */
export const GET = withRoute({ name: "/api/devices" }, async (_request, { log }) => {
  try {
    const data = await gatewayCall<DeviceListResult>("device.pair.list", {}, 15000);

    // Sanitize: strip actual token values, keep metadata
    const paired = (data.paired || []).map((d) => ({
      ...d,
      tokens: (d.tokens || []).map((t) => ({
        role: t.role,
        scopes: t.scopes || [],
        createdAtMs: t.createdAtMs,
        rotatedAtMs: t.rotatedAtMs,
        lastUsedAtMs: t.lastUsedAtMs,
      })),
    }));

    return NextResponse.json({
      pending: data.pending || [],
      paired,
    });
  } catch (err) {
    log.warn({ err: String(err) }, "Devices API GET error — returning degraded payload");
    return NextResponse.json({
      pending: [],
      paired: [],
      warning: String(err),
      degraded: true,
    });
  }
});

/**
 * POST /api/devices - Device management actions.
 *
 * Body:
 *   { action: "approve", requestId: "..." }
 *   { action: "reject", requestId: "..." }
 *   { action: "revoke", deviceId: "...", role: "..." }
 *
 * `devicesPostSchema` rejects an unrecognized `action` before this handler
 * runs, so a device record can never be altered by falling through to a
 * default branch (T-02-48). `requestId`/`deviceId`+`role` stay manual
 * required-field checks so their exact pre-migration messages survive
 * (no `details` tree, matching `src/lib/schemas/agents.ts`'s split).
 */
export const POST = withRoute(
  { name: "/api/devices", bodySchema: devicesPostSchema },
  async (_request, { body, log }) => {
    try {
      switch (body.action) {
        case "approve": {
          const requestId = body.requestId;
          if (!requestId) {
            return badRequest("requestId is required");
          }
          const result = await gatewayCall<Record<string, unknown>>(
            "device.pair.approve",
            { requestId },
            15000,
          );
          return NextResponse.json({ ok: true, action: body.action, requestId, result });
        }

        case "reject": {
          const requestId = body.requestId;
          if (!requestId) {
            return badRequest("requestId is required");
          }
          const result = await gatewayCall<Record<string, unknown>>(
            "device.pair.reject",
            { requestId },
            15000,
          );
          return NextResponse.json({ ok: true, action: body.action, requestId, result });
        }

        case "revoke": {
          const deviceId = body.deviceId;
          const role = body.role;
          if (!deviceId || !role) {
            return badRequest("deviceId and role are required");
          }
          const result = await gatewayCall<Record<string, unknown>>(
            "device.token.revoke",
            { deviceId, role },
            15000,
          );
          return NextResponse.json({ ok: true, action: body.action, deviceId, role, result });
        }
      }
    } catch (err) {
      // Preserves the pre-migration message text exactly (`String(err)`,
      // not `err.message`) rather than delegating to `withRoute`'s own
      // catch, whose message normalization drops the "Error: " prefix.
      log.error({ err: String(err) }, "Devices API POST error");
      return serverError(String(err));
    }
  },
);
