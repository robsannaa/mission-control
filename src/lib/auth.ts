/**
 * Mission Control auth gate — shared helpers for middleware and /api/auth routes.
 *
 * Three deployment modes (mirrors OpenClaw's own gateway auth vocabulary —
 * see docs.openclaw.ai /gateway/configuration and /gateway/trusted-proxy-auth):
 *
 *   - "off" (default): local single-user on a loopback bind. No login, but
 *     Origin/Host validation is still enforced to kill DNS-rebinding attacks.
 *   - "token": MISSION_CONTROL_AUTH=token + MISSION_CONTROL_AUTH_TOKEN=<secret>.
 *     A login page exchanges the token for an httpOnly session cookie.
 *   - "trusted-proxy": MISSION_CONTROL_AUTH=trusted-proxy +
 *     MISSION_CONTROL_PROXY_SECRET=<secret>. An upstream identity-aware proxy
 *     authenticates the owner and forwards every request with
 *     x-mission-control-proxy-secret and x-mission-control-user headers.
 *
 * Everything here must stay Edge-runtime safe (middleware): Web Crypto only,
 * no node:* imports.
 */

export type AuthMode = "off" | "token" | "trusted-proxy";

export const SESSION_COOKIE = "mission_control_session";
export const PROXY_SECRET_HEADER = "x-mission-control-proxy-secret";
export const PROXY_USER_HEADER = "x-mission-control-user";

/** Hostnames always allowed regardless of port (loopback-only by design). */
const DEFAULT_ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

const SESSION_DERIVATION_PREFIX = "mission-control-session-v1:";

export function getAuthMode(): AuthMode {
  const raw = (process.env.MISSION_CONTROL_AUTH || "").trim().toLowerCase();
  if (raw === "token") return "token";
  if (raw === "trusted-proxy") return "trusted-proxy";
  return "off";
}

export function getAuthToken(): string {
  return (process.env.MISSION_CONTROL_AUTH_TOKEN || "").trim();
}

export function getProxySecret(): string {
  return (process.env.MISSION_CONTROL_PROXY_SECRET || "").trim();
}

/** Extra allowed hosts from MISSION_CONTROL_ALLOWED_HOSTS (comma-separated).
 *  Entries may be "host" (any port) or "host:port" (exact match). */
export function getAllowedHostEntries(): string[] {
  return (process.env.MISSION_CONTROL_ALLOWED_HOSTS || "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function parseHostHeader(value: string): { hostname: string; port: string } | null {
  try {
    // URL handles "[::1]:3100", "localhost:3100", bare "127.0.0.1", casing.
    const url = new URL(`http://${value}`);
    return { hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port };
  } catch {
    return null;
  }
}

/** Validate a Host (or forwarded host) header value against the allowlist. */
export function isAllowedHost(hostHeader: string | null | undefined): boolean {
  if (!hostHeader) return false;
  const parsed = parseHostHeader(hostHeader.trim().toLowerCase());
  if (!parsed) return false;
  if (DEFAULT_ALLOWED_HOSTNAMES.has(parsed.hostname)) return true;
  for (const entry of getAllowedHostEntries()) {
    const allowed = parseHostHeader(entry);
    if (!allowed) continue;
    if (allowed.hostname !== parsed.hostname) continue;
    // Entry with an explicit port must match exactly; without one, any port.
    if (allowed.port && allowed.port !== parsed.port) continue;
    return true;
  }
  return false;
}

/** Validate an Origin header. Absent Origin (curl, same-origin GET) passes;
 *  a present Origin must point at an allowlisted host. */
export function isAllowedOrigin(originHeader: string | null | undefined): boolean {
  if (originHeader == null || originHeader === "") return true;
  const raw = originHeader.trim();
  if (!raw || raw.toLowerCase() === "null") return false;
  try {
    const url = new URL(raw);
    return isAllowedHost(url.host);
  } catch {
    return false;
  }
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time string comparison. Compares SHA-256 digests so timing does not
 * depend on where the strings diverge or on their lengths.
 */
export async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) diff |= bytesA[i] ^ bytesB[i];
  return diff === 0;
}

/** Derived value stored in the session cookie — never the raw token. */
export async function sessionValueForToken(token: string): Promise<string> {
  return sha256Hex(`${SESSION_DERIVATION_PREFIX}${token}`);
}

/** True when the presented session cookie matches the configured token. */
export async function hasValidSession(cookieValue: string | null | undefined): Promise<boolean> {
  const token = getAuthToken();
  if (!token || !cookieValue) return false;
  const expected = await sessionValueForToken(token);
  return constantTimeEquals(cookieValue, expected);
}

/** True when the presented proxy secret matches the configured secret. */
export async function hasValidProxySecret(headerValue: string | null | undefined): Promise<boolean> {
  const secret = getProxySecret();
  if (!secret || !headerValue) return false;
  return constantTimeEquals(headerValue, secret);
}
