/**
 * Gateway protocol constants for the OpenClaw WebSocket control plane.
 *
 * Mirrors `packages/gateway-protocol/src/version.ts` and
 * `packages/gateway-protocol/src/client-info.ts` in OpenClaw. Keep these in
 * sync when bumping the supported OpenClaw range — the gateway hard-rejects a
 * handshake whose [minProtocol, maxProtocol] window excludes its own version.
 */

/** Protocol version spoken by current OpenClaw clients and servers. */
export const GATEWAY_PROTOCOL_VERSION = 4;

/**
 * Lowest protocol an operator client may advertise. OpenClaw's
 * `MIN_CLIENT_PROTOCOL_VERSION` is 4: the N-1 compatibility window only covers
 * `role: "node"` clients and lightweight restart probes, so an operator client
 * must advertise 4 exactly.
 */
export const GATEWAY_MIN_CLIENT_PROTOCOL_VERSION = 4;

/**
 * Client identity Mission Control presents at handshake.
 *
 * This pair is load-bearing, not cosmetic. The gateway only preserves the
 * scopes requested by a client that has no paired device identity when it
 * matches one of two exact combinations (`shouldSkipLocalBackendSelfPairing`
 * and `shouldPreserveLocalCliSharedAuthScopes` in OpenClaw's gateway message
 * handler):
 *
 *   - `gateway-client` + `backend` — a local backend service (this app)
 *   - `cli` + `cli`               — the interactive CLI
 *
 * Any other pair connects successfully but is granted zero scopes, so every
 * subsequent RPC fails with `missing scope: operator.read`.
 */
export const GATEWAY_CLIENT_ID = "gateway-client";
export const GATEWAY_CLIENT_MODE = "backend";

/** Operator scopes Mission Control needs to drive the whole dashboard. */
export const GATEWAY_OPERATOR_SCOPES = [
  "operator.read",
  "operator.write",
  "operator.admin",
  "operator.approvals",
  "operator.pairing",
] as const;

/**
 * Connect-challenge budget. The gateway sends `connect.challenge` immediately
 * after the socket opens; OpenClaw's reference client waits up to 15s for it.
 */
export const GATEWAY_CONNECT_CHALLENGE_TIMEOUT_MS = 15_000;

/** Default per-request RPC timeout used by OpenClaw's reference client. */
export const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Version Mission Control reports at handshake. The gateway logs it against
 * connection diagnostics, so report the real package version when readable.
 */
let _version: string | null = null;

export function getMissionControlVersion(): string {
  if (_version) return _version;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { join } = require("node:path") as typeof import("node:path");
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));
    _version = String(pkg.version || "").trim() || "0.0.0";
  } catch {
    _version = "0.0.0";
  }
  return _version;
}
