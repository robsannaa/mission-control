/**
 * Typed client for the config write contract.
 *
 * Every shape here is the route's as-built response (src/app/api/config/route.ts
 * and src/app/api/config/doctor/route.ts). Keeping them in one place means the
 * editor never has to guess whether a 400 is a failure or a confirmation
 * prompt — `saveConfig` classifies the answer and the UI just renders it.
 */

import type { JsonObject } from "@/lib/config-diff";
import type { ConfigSaveBody } from "./config-changes";

/* ── GET /api/config ────────────────────────────────────────────────── */

export type ConfigPayload = {
  /** The gateway's `parsed` document: `${VAR}` stays literal, secrets real. */
  config: JsonObject;
  baseHash: string;
  schema: Record<string, unknown>;
  uiHints: Record<string, unknown>;
  configSource: "parsed" | "resolved" | "disk";
  envSubstituted: string[];
  warning?: string;
  degraded?: boolean;
};

export async function fetchConfigPayload(): Promise<ConfigPayload> {
  const res = await fetch("/api/config", { cache: "no-store" });
  const data = await res.json();
  if (!res.ok && !data?.config) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  const meta = (data?.meta ?? {}) as Record<string, unknown>;
  const schema = (meta.schema ?? {}) as Record<string, unknown>;
  return {
    config: (data?.config ?? {}) as JsonObject,
    baseHash: typeof meta.baseHash === "string" ? meta.baseHash : "",
    schema: (schema.properties ?? {}) as Record<string, unknown>,
    uiHints: (meta.uiHints ?? {}) as Record<string, unknown>,
    configSource:
      meta.configSource === "resolved" || meta.configSource === "disk"
        ? meta.configSource
        : "parsed",
    envSubstituted: Array.isArray(meta.envSubstituted)
      ? (meta.envSubstituted as unknown[]).filter((p): p is string => typeof p === "string")
      : [],
    ...(typeof meta.warning === "string" ? { warning: meta.warning } : {}),
    ...(meta.degraded === true ? { degraded: true as const } : {}),
  };
}

/* ── PATCH /api/config ──────────────────────────────────────────────── */

export type SaveSuccess = {
  status: "ok";
  hash: string;
  restartRequired: boolean;
  restartPaths: string[];
  deletedPaths: string[];
  warnings: string[];
  repairedConfig: boolean;
  fallbackUsed: boolean;
  fallbackMessage?: string;
};

/** HTTP 409 — someone else wrote since this editor loaded its snapshot. */
export type SaveConflict = {
  status: "conflict";
  currentHash: string;
  remoteConfig: JsonObject;
  message: string;
};

/**
 * HTTP 400 carrying `replacePathsRequired` — not a failure. The gateway
 * refused to shrink an array without an explicit confirmation, and this is the
 * exact path list to resend.
 */
export type SaveNeedsReplaceConfirm = {
  status: "needs-replace-confirm";
  paths: string[];
  message: string;
};

/** HTTP 429 — control-plane writes are capped at 3 per 60s per client. */
export type SaveRateLimited = {
  status: "rate-limited";
  message: string;
  details?: string;
  retryAfterMs: number;
};

export type SaveFailure = {
  status: "error";
  message: string;
  details?: string;
  doctorOutput?: string;
  fallback?: string;
  httpStatus: number;
};

export type SaveResult =
  | SaveSuccess
  | SaveConflict
  | SaveNeedsReplaceConfirm
  | SaveRateLimited
  | SaveFailure;

export type SaveRequest = ConfigSaveBody | { raw: string; baseHash: string; mode: "apply" };

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Send a write and classify the answer.
 *
 * Deliberately does not throw for 4xx: a conflict and a replace-confirmation
 * are normal parts of the flow, and the editor renders a different UI for each.
 */
export async function saveConfig(body: SaveRequest): Promise<SaveResult> {
  let res: Response;
  try {
    res = await fetch("/api/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      status: "error",
      message: "Could not reach Mission Control to save the configuration.",
      details: err instanceof Error ? err.message : String(err),
      httpStatus: 0,
    };
  }

  let data: Record<string, unknown>;
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    return {
      status: "error",
      message: `The server returned an unreadable response (HTTP ${res.status}).`,
      httpStatus: res.status,
    };
  }

  if (res.status === 409) {
    return {
      status: "conflict",
      currentHash: typeof data.currentHash === "string" ? data.currentHash : "",
      remoteConfig: (data.remoteConfig ?? {}) as JsonObject,
      message:
        typeof data.message === "string"
          ? data.message
          : "This configuration changed in another session since you loaded it.",
    };
  }

  if (res.status === 429) {
    return {
      status: "rate-limited",
      message: typeof data.error === "string" ? data.error : "Too many configuration writes.",
      details: typeof data.details === "string" ? data.details : undefined,
      retryAfterMs: typeof data.retryAfterMs === "number" ? data.retryAfterMs : 60_000,
    };
  }

  const replaceRequired = stringList(data.replacePathsRequired);
  if (!res.ok && replaceRequired.length > 0) {
    return {
      status: "needs-replace-confirm",
      paths: replaceRequired,
      message: typeof data.error === "string" ? data.error : "This write removes list entries.",
    };
  }

  if (!res.ok || data.ok !== true) {
    return {
      status: "error",
      message: typeof data.error === "string" ? data.error : `Save failed (HTTP ${res.status}).`,
      details: typeof data.details === "string" ? data.details : undefined,
      doctorOutput: typeof data.doctorOutput === "string" ? data.doctorOutput : undefined,
      fallback: typeof data.fallback === "string" ? data.fallback : undefined,
      httpStatus: res.status,
    };
  }

  return {
    status: "ok",
    hash: typeof data.hash === "string" ? data.hash : "",
    restartRequired: data.restartRequired === true,
    restartPaths: stringList(data.restartPaths),
    deletedPaths: stringList(data.deletedPaths),
    warnings: stringList(data.warnings),
    repairedConfig: data.repairedConfig === true,
    fallbackUsed: data.fallbackUsed === true,
    ...(typeof data.fallbackMessage === "string"
      ? { fallbackMessage: data.fallbackMessage }
      : {}),
  };
}

/* ── POST /api/config/doctor ────────────────────────────────────────── */

export type DoctorCheck = {
  id?: string;
  name: string;
  status: "ok" | "warn" | "fail";
  message?: string;
};

export type DoctorReport = {
  ok: boolean;
  ranAt: number;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
  partial: boolean;
  timedOut: boolean;
  cached: boolean;
  fast: boolean;
  retryAfterMs: number;
  filtered: Array<{ id: string; reason: string }>;
};

/** The route's own header check — the panel renders its own, so drop it. */
export const DOCTOR_COMPLETED_CHECK_ID = "mission-control/doctor/completed";

export async function runDoctor(fast = true): Promise<DoctorReport> {
  const res = await fetch("/api/config/doctor", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fast }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  const summary = (data.summary ?? {}) as Record<string, unknown>;
  return {
    ok: data.ok === true,
    ranAt: typeof data.ranAt === "number" ? data.ranAt : Date.now(),
    checks: Array.isArray(data.checks) ? (data.checks as DoctorCheck[]) : [],
    summary: {
      ok: Number(summary.ok ?? 0),
      warn: Number(summary.warn ?? 0),
      fail: Number(summary.fail ?? 0),
    },
    partial: data.partial === true,
    timedOut: data.timedOut === true,
    cached: data.cached === true,
    fast: data.fast !== false,
    retryAfterMs: typeof data.retryAfterMs === "number" ? data.retryAfterMs : 0,
    filtered: Array.isArray(data.filtered)
      ? (data.filtered as Array<{ id: string; reason: string }>)
      : [],
  };
}
