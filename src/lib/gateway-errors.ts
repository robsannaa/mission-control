/**
 * Gateway pairing / scope error detection.
 *
 * When the gateway refuses this device because it needs (re-)approval, the
 * failure reaches us in one of these shapes (probed against OpenClaw
 * v2026.7.1, see packages/gateway-protocol connect-error-details):
 *
 *   1. Connect `res` error — GatewayRpcError with code "NOT_PAIRED",
 *      message "pairing required: <requirement>" and
 *      details { code: "PAIRING_REQUIRED", reason, requestId,
 *      requestedScopes, approvedScopes, … }.
 *   2. Socket close 1008 — GatewayRpcError("Gateway RPC socket closed
 *      (1008): pairing required: …") with no code.
 *   3. CLI fallback — a plain Error whose message embeds the same
 *      "pairing required" text from `openclaw gateway call` stderr.
 *   4. GatewayScopeError (code "MISSING_SCOPES") — the handshake succeeded
 *      but granted zero operator scopes, i.e. this device is not approved.
 *
 * All of them mean the same product moment: the owner must approve a pending
 * pairing request. Routes should answer HTTP 428 so the UI can show the
 * approval flow instead of an empty page.
 */

import { GatewayRpcError } from "./gateway-rpc";

export type PairingReason =
  | "not-paired"
  | "role-upgrade"
  | "scope-upgrade"
  | "metadata-upgrade";

export type PairingRequiredDetail = {
  /** Original gateway error message, e.g. "pairing required: device is asking for more scopes than currently approved". */
  message: string;
  /** Normalized pairing reason when the gateway provided (or implied) one. */
  reason?: PairingReason;
  /** Pending pairing request id, when the gateway echoed one. */
  requestId?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedScopes?: string[];
};

/**
 * Typed error thrown by `gatewayCall` when the gateway demands pairing
 * approval. Extends GatewayRpcError so existing `instanceof` checks and
 * `.code` readers keep working.
 */
export class PairingRequiredError extends GatewayRpcError {
  readonly detail: PairingRequiredDetail;

  constructor(detail: PairingRequiredDetail) {
    super(detail.message, "PAIRING_REQUIRED", detail);
    this.name = "PairingRequiredError";
    this.detail = detail;
  }
}

/** Same pattern OpenClaw itself uses to spot pairing refusals in error text. */
const PAIRING_MESSAGE_PATTERN = /\bpairing required\b/i;

/** Requirement phrases from the gateway's connect-error metadata → reason. */
const REASON_BY_REQUIREMENT: Array<[RegExp, PairingReason]> = [
  [/more scopes/i, "scope-upgrade"],
  [/higher role/i, "role-upgrade"],
  [/not approved yet/i, "not-paired"],
  [/identity changed|re-approved/i, "metadata-upgrade"],
];

const PAIRING_REASONS = new Set<string>([
  "not-paired",
  "role-upgrade",
  "scope-upgrade",
  "metadata-upgrade",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return strings.length > 0 ? strings : undefined;
}

function reasonFromMessage(message: string): PairingReason | undefined {
  for (const [pattern, reason] of REASON_BY_REQUIREMENT) {
    if (pattern.test(message)) return reason;
  }
  return undefined;
}

/**
 * Classify an arbitrary gateway RPC failure. Returns a structured pairing
 * detail when the error is a pairing/scope refusal, null otherwise.
 */
export function classifyPairingError(err: unknown): PairingRequiredDetail | null {
  if (err instanceof PairingRequiredError) return err.detail;

  const message = err instanceof Error ? err.message : String(err ?? "");
  const code = err instanceof GatewayRpcError ? err.code : undefined;
  const details =
    err instanceof GatewayRpcError && isRecord(err.details) ? err.details : undefined;
  const detailCode = typeof details?.code === "string" ? details.code : undefined;

  const isPairing =
    PAIRING_MESSAGE_PATTERN.test(message) ||
    code === "NOT_PAIRED" ||
    detailCode === "PAIRING_REQUIRED" ||
    // GatewayScopeError: handshake granted zero scopes — device not approved.
    code === "MISSING_SCOPES";
  if (!isPairing) return null;

  const rawReason = typeof details?.reason === "string" ? details.reason : undefined;
  const reason =
    rawReason && PAIRING_REASONS.has(rawReason)
      ? (rawReason as PairingReason)
      : reasonFromMessage(message) ??
        (code === "MISSING_SCOPES" ? "not-paired" : undefined);

  return {
    message: message || "pairing required",
    ...(reason ? { reason } : {}),
    ...(typeof details?.requestId === "string" && details.requestId
      ? { requestId: details.requestId }
      : {}),
    ...(typeof details?.requestedRole === "string" && details.requestedRole
      ? { requestedRole: details.requestedRole }
      : {}),
    ...(toStringArray(details?.requestedScopes)
      ? { requestedScopes: toStringArray(details?.requestedScopes) }
      : {}),
    ...(toStringArray(details?.approvedScopes)
      ? { approvedScopes: toStringArray(details?.approvedScopes) }
      : {}),
  };
}

/**
 * Upgrade a raw gateway failure to a PairingRequiredError, or null when it is
 * not a pairing refusal. Used by `gatewayCall` so every caller sees the typed
 * error without touching individual call sites.
 */
export function toPairingRequiredError(err: unknown): PairingRequiredError | null {
  if (err instanceof PairingRequiredError) return err;
  const detail = classifyPairingError(err);
  return detail ? new PairingRequiredError(detail) : null;
}

export function isPairingRequiredError(err: unknown): err is PairingRequiredError {
  return err instanceof PairingRequiredError;
}

/**
 * Route helper: when `err` is a pairing refusal, build the HTTP 428
 * "Precondition Required" response routes should return instead of a 500.
 * Returns null for every other error so callers can fall through to their
 * existing handling. (A plain Response is a valid Next.js route return value;
 * using it keeps this module importable outside the Next runtime, e.g. tests.)
 */
export function pairingRequiredResponse(err: unknown): Response | null {
  const pairing = toPairingRequiredError(err);
  if (!pairing) return null;
  return Response.json(
    { error: "pairing_required", detail: pairing.detail },
    { status: 428, headers: { "X-Pairing-Required": "1" } },
  );
}
