import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATEWAY_CLIENT_ID,
  GATEWAY_CLIENT_MODE,
  GATEWAY_CONNECT_CHALLENGE_TIMEOUT_MS,
  GATEWAY_MIN_CLIENT_PROTOCOL_VERSION,
  GATEWAY_OPERATOR_SCOPES,
  GATEWAY_PROTOCOL_VERSION,
  getMissionControlVersion,
} from "./gateway-protocol";
import {
  getGatewayPassword,
  getGatewayToken,
  getGatewayUrl,
  getOpenClawHome,
} from "./paths";

type GatewayConnectHello = {
  protocol?: number;
  features?: {
    methods?: string[];
  };
  auth?: {
    role?: string;
    scopes?: string[];
  };
};

type GatewayErrorPayload = {
  code?: string;
  message?: string;
  details?: unknown;
};

type GatewayEventMessage = {
  type: "event";
  event?: string;
  payload?: Record<string, unknown>;
};

type GatewayResponseMessage = {
  type: "res";
  id?: string;
  ok?: boolean;
  payload?: unknown;
  error?: GatewayErrorPayload;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type DeviceAuthTokens = {
  operator?: {
    token: string;
    scopes: string[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toWsUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

// ── Device auth helpers (mirrors openclaw CLI logic) ──────────

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function derivePublicKeyRaw(publicKeyPem: string): Buffer {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  if (
    spki.length === ED25519_SPKI_PREFIX.length + 32 &&
    spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return spki.subarray(ED25519_SPKI_PREFIX.length);
  }
  return spki;
}

function buildDeviceAuthPayloadV3(params: {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token: string | null;
  nonce: string;
  platform: string;
  deviceFamily?: string;
}): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = (params.platform || "").toLowerCase().trim();
  const deviceFamily = (params.deviceFamily || "").toLowerCase().trim();
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

function signDevicePayload(privateKeyPem: string, payload: string): string {
  const key = crypto.createPrivateKey(privateKeyPem);
  return base64UrlEncode(crypto.sign(null, Buffer.from(payload, "utf8"), key) as unknown as Buffer);
}

// ── Device identity loading ──────────

let _deviceIdentityLoaded = false;
let _deviceIdentity: DeviceIdentity | null = null;
let _deviceAuthTokensLoaded = false;
let _deviceAuthTokens: DeviceAuthTokens | null = null;

function loadDeviceIdentity(): DeviceIdentity | null {
  if (_deviceIdentityLoaded) return _deviceIdentity;
  _deviceIdentityLoaded = true;
  try {
    const path = join(getOpenClawHome(), "identity", "device.json");
    const data = JSON.parse(readFileSync(path, "utf-8"));
    if (data.deviceId && data.publicKeyPem && data.privateKeyPem) {
      _deviceIdentity = {
        deviceId: data.deviceId,
        publicKeyPem: data.publicKeyPem,
        privateKeyPem: data.privateKeyPem,
      };
      return _deviceIdentity;
    }
  } catch {
    // No device identity available
  }
  _deviceIdentity = null;
  return null;
}

function loadDeviceAuthTokens(): DeviceAuthTokens | null {
  if (_deviceAuthTokensLoaded) return _deviceAuthTokens;
  _deviceAuthTokensLoaded = true;
  try {
    const path = join(getOpenClawHome(), "identity", "device-auth.json");
    const data = JSON.parse(readFileSync(path, "utf-8"));
    _deviceAuthTokens = data.tokens || null;
    return _deviceAuthTokens;
  } catch {
    // No device auth tokens available
  }
  _deviceAuthTokens = null;
  return null;
}

// ──────────────────────────────────────────────────

export class GatewayRpcError extends Error {
  code?: string;
  details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Raised when the handshake succeeds but the gateway grants no operator
 * scopes. Every RPC would fail with `missing scope: ...`, so surface the
 * actionable cause instead of letting each call fail separately.
 */
export class GatewayScopeError extends GatewayRpcError {
  constructor(granted: string[]) {
    super(
      "Gateway granted no operator scopes to Mission Control. " +
        "Configure gateway auth (gateway.auth.token / OPENCLAW_GATEWAY_TOKEN, or " +
        "gateway.auth.password) so this host authenticates as a local operator, " +
        "or approve its device identity with `openclaw devices approve`. " +
        `Granted scopes: [${granted.join(", ")}]`,
      "MISSING_SCOPES",
      { granted },
    );
    this.name = "GatewayScopeError";
  }
}

export class GatewayRpcClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connectRequestId: string | null = null;
  private connectRequestSent = false;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private connectKickTimer: ReturnType<typeof setTimeout> | null = null;
  private connectNonce: string | null = null;
  /**
   * Methods advertised in `hello-ok.features.methods`. Advisory only: OpenClaw
   * builds this list conservatively and intentionally omits real, callable
   * methods (`sessions.usage`, `plugins.list`, `audit.activity.list`, …), so it
   * must never be used to reject a request.
   */
  private advertisedMethods = new Set<string>();
  private grantedScopes: string[] = [];
  private pending = new Map<string, PendingRequest>();
  private seq = 0;
  private readonly token: string;
  private readonly password: string;
  private readonly gatewayUrl?: string;
  private listeners: {
    open?: () => void;
    message?: (event: MessageEvent) => void;
    close?: (event: CloseEvent) => void;
    error?: () => void;
  } = {};

  constructor(gatewayUrl?: string, token?: string, password?: string) {
    this.gatewayUrl = gatewayUrl;
    this.token = token ?? getGatewayToken();
    this.password = password ?? getGatewayPassword();
  }

  /** Operator scopes the gateway granted on the current connection. */
  getGrantedScopes(): string[] {
    return [...this.grantedScopes];
  }

  /** Whether the gateway advertised this method in `hello-ok` (advisory). */
  advertisesMethod(method: string): boolean {
    return this.advertisedMethods.has(method);
  }

  async request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeout = 15000,
  ): Promise<T> {
    await this.connect(timeout);

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new GatewayRpcError("Gateway RPC socket is not connected");
    }

    const id = this.nextId();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayRpcError(`Gateway RPC timed out for ${method}`));
      }, timeout);

      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });

      try {
        ws.send(
          JSON.stringify({
            type: "req",
            id,
            method,
            params,
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(this.normalizeError(err));
      }
    });
  }

  private async connect(timeout: number): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN && this.connectRequestId === null) {
      return;
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = new Promise<void>(async (resolve, reject) => {
      const onResolve = () => {
        this.clearConnectState();
        this.connectPromise = null;
        resolve();
      };
      const onReject = (error: Error) => {
        this.clearConnectState();
        this.connectPromise = null;
        this.closeSocket();
        reject(error);
      };

      this.connectResolve = onResolve;
      this.connectReject = onReject;
      this.connectRequestId = this.nextId();
      this.connectRequestSent = false;
      this.connectNonce = null;

      const timer = setTimeout(() => {
        onReject(new GatewayRpcError("Gateway RPC connect timed out"));
      }, timeout);
      this.connectTimeoutTimer = timer;

      try {
        const wsUrl = toWsUrl(this.gatewayUrl ?? (await getGatewayUrl()));
        const ws = new WebSocket(wsUrl);
        this.ws = ws;

        this.listeners.open = () => {
          // Wait for connect.challenge before sending connect request.
          // Fall back to sending after 750ms if no challenge arrives (older gateways).
          this.scheduleConnectRequest();
        };
        this.listeners.message = (event: MessageEvent) => {
          this.handleMessage(String(event.data ?? ""));
        };
        this.listeners.close = (event: CloseEvent) => {
          const reason = String(event.reason || "socket closed");
          this.handleSocketClosed(
            new GatewayRpcError(`Gateway RPC socket closed (${event.code}): ${reason}`),
          );
        };
        this.listeners.error = () => {
          if (this.ws?.readyState !== WebSocket.OPEN && this.connectReject) {
            this.connectReject(new GatewayRpcError("Gateway RPC socket error"));
          }
        };

        ws.addEventListener("open", this.listeners.open);
        ws.addEventListener("message", this.listeners.message);
        ws.addEventListener("close", this.listeners.close);
        ws.addEventListener("error", this.listeners.error);
      } catch (err) {
        clearTimeout(timer);
        onReject(this.normalizeError(err));
      }
    });

    return this.connectPromise;
  }

  private handleMessage(raw: string): void {
    let message: GatewayEventMessage | GatewayResponseMessage;
    try {
      message = JSON.parse(raw) as GatewayEventMessage | GatewayResponseMessage;
    } catch {
      return;
    }

    if (message.type === "event") {
      if (message.event === "connect.challenge") {
        const payload = (message as GatewayEventMessage).payload;
        const nonce =
          payload && typeof payload.nonce === "string" ? payload.nonce.trim() : null;
        if (nonce) {
          this.connectNonce = nonce;
        }
        this.sendConnectRequest();
      }
      return;
    }

    if (message.type !== "res") {
      return;
    }

    if (message.id && message.id === this.connectRequestId) {
      if (message.ok) {
        const hello = (message.payload || {}) as GatewayConnectHello;
        this.advertisedMethods = new Set(hello.features?.methods || []);
        this.grantedScopes = Array.isArray(hello.auth?.scopes) ? hello.auth!.scopes! : [];
        // A handshake can succeed with zero scopes (unpaired device, or a
        // client identity the gateway does not treat as a local operator).
        // Every later RPC would fail; fail the connect instead.
        if (this.grantedScopes.length === 0) {
          this.connectReject?.(new GatewayScopeError(this.grantedScopes));
          return;
        }
        this.connectResolve?.();
      } else {
        this.connectReject?.(this.normalizeGatewayError(message.error));
      }
      return;
    }

    const pending = message.id ? this.pending.get(message.id) : undefined;
    if (!pending || !message.id) {
      return;
    }

    clearTimeout(pending.timer);
    this.pending.delete(message.id);

    if (message.ok) {
      pending.resolve(message.payload);
      return;
    }

    pending.reject(this.normalizeGatewayError(message.error));
  }

  /**
   * The gateway emits `connect.challenge` right after the socket opens and its
   * nonce is required to sign a device identity. Wait for it rather than racing
   * ahead, but still send an unsigned connect if it never arrives so shared-
   * secret auth keeps working.
   */
  private scheduleConnectRequest(): void {
    if (this.connectRequestSent || this.connectKickTimer) {
      return;
    }
    const timer = setTimeout(() => {
      this.connectKickTimer = null;
      this.sendConnectRequest();
    }, GATEWAY_CONNECT_CHALLENGE_TIMEOUT_MS);
    this.connectKickTimer = timer;
  }

  private sendConnectRequest(): void {
    if (this.connectRequestSent || !this.connectRequestId) {
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    this.connectRequestSent = true;
    if (this.connectKickTimer) {
      clearTimeout(this.connectKickTimer);
      this.connectKickTimer = null;
    }

    const scopes = [...GATEWAY_OPERATOR_SCOPES];
    const nonce = this.connectNonce || "";

    // Resolve device identity and auth tokens for signed connect.
    const identity = loadDeviceIdentity();
    const authTokens = loadDeviceAuthTokens();
    const deviceToken = authTokens?.operator?.token;

    // Build auth. Shared-secret auth (token or password, depending on
    // gateway.auth.mode) is what makes a loopback backend client a trusted
    // local operator; a paired device token also works.
    const authToken = this.token || undefined;
    const authPassword = this.password || undefined;
    const auth: Record<string, unknown> = {};
    if (authToken) auth.token = authToken;
    if (authPassword) auth.password = authPassword;
    if (deviceToken) auth.deviceToken = deviceToken;

    // Build device signature if identity is available and we have a nonce.
    let device: Record<string, unknown> | undefined;
    if (identity && nonce) {
      const signedAtMs = Date.now();
      // The gateway recomputes this payload from the connect frame, so every
      // signed field must match exactly what we send below — including the
      // client id and mode.
      const signatureToken = authToken || deviceToken || null;
      const payload = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: GATEWAY_CLIENT_ID,
        clientMode: GATEWAY_CLIENT_MODE,
        role: "operator",
        scopes,
        signedAtMs,
        token: signatureToken,
        nonce,
        platform: process.platform,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      device = {
        id: identity.deviceId,
        publicKey: base64UrlEncode(derivePublicKeyRaw(identity.publicKeyPem)),
        signature,
        signedAt: signedAtMs,
        nonce,
      };
    }

    ws.send(
      JSON.stringify({
        type: "req",
        id: this.connectRequestId,
        method: "connect",
        params: {
          minProtocol: GATEWAY_MIN_CLIENT_PROTOCOL_VERSION,
          maxProtocol: GATEWAY_PROTOCOL_VERSION,
          client: {
            id: GATEWAY_CLIENT_ID,
            displayName: "Mission Control",
            version: getMissionControlVersion(),
            platform: process.platform,
            mode: GATEWAY_CLIENT_MODE,
            instanceId: `pid-${process.pid}`,
          },
          role: "operator",
          scopes,
          caps: [],
          ...(Object.keys(auth).length > 0 ? { auth } : {}),
          ...(device ? { device } : {}),
          locale: "en-US",
          userAgent: `@openclaw/dashboard/${getMissionControlVersion()}`,
        },
      }),
    );
  }

  private handleSocketClosed(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error);
    }
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.advertisedMethods.clear();
    this.grantedScopes = [];
    this.closeSocket();
  }

  private clearConnectState(): void {
    if (this.connectTimeoutTimer) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
    if (this.connectKickTimer) {
      clearTimeout(this.connectKickTimer);
      this.connectKickTimer = null;
    }
    this.connectResolve = null;
    this.connectReject = null;
    this.connectRequestId = null;
    this.connectRequestSent = false;
    this.connectNonce = null;
  }

  private closeSocket(): void {
    if (this.ws) {
      if (this.listeners.open) this.ws.removeEventListener("open", this.listeners.open);
      if (this.listeners.message) this.ws.removeEventListener("message", this.listeners.message as EventListener);
      if (this.listeners.close) this.ws.removeEventListener("close", this.listeners.close as EventListener);
      if (this.listeners.error) this.ws.removeEventListener("error", this.listeners.error);
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }
    this.ws = null;
    this.listeners = {};
  }

  private nextId(): string {
    this.seq += 1;
    return `mc-${this.seq}`;
  }

  private normalizeGatewayError(error: GatewayErrorPayload | undefined): GatewayRpcError {
    if (isRecord(error)) {
      return new GatewayRpcError(
        String(error.message || error.code || "Gateway request failed"),
        typeof error.code === "string" ? error.code : undefined,
        error.details,
      );
    }
    return new GatewayRpcError("Gateway request failed");
  }

  private normalizeError(error: unknown): GatewayRpcError {
    if (error instanceof GatewayRpcError) {
      return error;
    }
    return new GatewayRpcError(error instanceof Error ? error.message : String(error));
  }
}
