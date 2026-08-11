import { useSyncExternalStore } from "react";

export type GatewayHealth = Record<string, unknown> | null;
export type GatewayStatus = "online" | "degraded" | "offline" | "loading";
/** Effective runtime transport reported by /api/status (for auto: "http" or "cli"). */
export type TransportMode = "cli" | "auto" | string | null;
export type TransportConfigured = "auto" | "cli" | "http" | null;
export type TransportReason = "forced_cli" | "forced_http" | "auto_http" | "auto_fallback_cli" | null;

type Snapshot = {
  status: GatewayStatus;
  health: GatewayHealth;
  restarting: boolean;
  latencyMs: number | null;
  /** True once at least one full poll cycle has completed (success or failure). */
  initialCheckDone: boolean;
  /** Effective transport from /api/status — "cli" means CLI fallback is active. */
  transport: TransportMode;
  /** Static transport configured by env (OPENCLAW_TRANSPORT). */
  transportConfigured: TransportConfigured;
  /** Why this transport mode is active. */
  transportReason: TransportReason;
};

const RESTART_EVENT = "gateway-restarting";

let snapshot: Snapshot = {
  status: "loading",
  health: null,
  restarting: false,
  latencyMs: null,
  initialCheckDone: false,
  transport: null,
  transportConfigured: null,
  transportReason: null,
};

const SERVER_SNAPSHOT: Snapshot = {
  status: "loading",
  health: null,
  restarting: false,
  latencyMs: null,
  initialCheckDone: false,
  transport: null,
  transportConfigured: null,
  transportReason: null,
};

const VALID_STATUSES = new Set<GatewayStatus>(["online", "degraded", "offline", "loading"]);

function toGatewayStatus(value: unknown): GatewayStatus {
  if (typeof value === "string" && VALID_STATUSES.has(value as GatewayStatus)) {
    return value as GatewayStatus;
  }
  return "offline";
}

const listeners = new Set<() => void>();
let subscribers = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let fastPollCount = 0;
let liteInFlight = false;
let fullInFlight = false;
let offlineConsecutiveFailures = 0;
let tabHidden = false;
let pollMode: "normal" | "offline" | "fast" = "normal";

function emit() {
  listeners.forEach((listener) => listener());
}

function setSnapshot(next: Partial<Snapshot>) {
  snapshot = { ...snapshot, ...next };
  emit();
}

/** Lightweight poll via /api/status — 3s max, used for normal ticks. */
async function pollLite(initial = false) {
  if (liteInFlight || typeof window === "undefined" || tabHidden) return;
  liteInFlight = true;
  try {
    const res = await fetch("/api/status", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      if (!initial) setSnapshot({ status: "offline", health: null, latencyMs: null });
      if (fastPollCount === 0) switchToOfflinePolling();
      return;
    }
    const data = await res.json();
    const nextStatus = toGatewayStatus(data.gateway);
    setSnapshot({
      status: nextStatus,
      latencyMs: typeof data.latencyMs === "number" ? data.latencyMs : null,
      transport: typeof data.transport === "string" ? data.transport : null,
      transportConfigured:
        data.transportConfigured === "auto" ||
        data.transportConfigured === "cli" ||
        data.transportConfigured === "http"
          ? data.transportConfigured
          : null,
      transportReason:
        data.transportReason === "forced_cli" ||
        data.transportReason === "forced_http" ||
        data.transportReason === "auto_http" ||
        data.transportReason === "auto_fallback_cli"
          ? data.transportReason
          : null,
    });
    if (fastPollCount > 0) {
      // During restart recovery, keep fast polling until we confirm gateway is back.
    } else if (nextStatus === "offline" || nextStatus === "degraded") {
      switchToOfflinePolling();
    } else {
      offlineConsecutiveFailures = 0;
    }
  } catch {
    if (!initial) setSnapshot({ status: "offline", health: null, latencyMs: null });
    if (fastPollCount === 0) switchToOfflinePolling();
  } finally {
    liteInFlight = false;
  }
}

/** Full poll via /api/gateway — used for fast/recovery ticks and initial load. */
async function poll(initial = false) {
  if (fullInFlight || typeof window === "undefined" || tabHidden) return;
  fullInFlight = true;
  try {
    const res = await fetch("/api/gateway", {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      if (!initial) setSnapshot({ status: "offline", health: null, latencyMs: null });
      switchToOfflinePolling();
      return;
    }
    const data = await res.json();
    const nextStatus = toGatewayStatus(data.status);
    setSnapshot({
      status: nextStatus,
      health: (data.health as GatewayHealth) || null,
      latencyMs: null,
    });

    if (fastPollCount > 0 && nextStatus === "online") {
      // Restart recovery complete
      fastPollCount = 0;
      offlineConsecutiveFailures = 0;
      switchToNormalPolling();
      setSnapshot({ restarting: false });
    } else if (fastPollCount > 0) {
      // During restart: stay in fast-poll mode even if degraded/offline.
      // Don't downgrade to offline polling — the gateway is still coming up.
    } else if (nextStatus === "offline" || nextStatus === "degraded") {
      switchToOfflinePolling();
    } else {
      offlineConsecutiveFailures = 0;
      switchToNormalPolling();
    }
  } catch {
    if (!initial) setSnapshot({ status: "offline", health: null, latencyMs: null });
    if (fastPollCount === 0) switchToOfflinePolling();
  } finally {
    fullInFlight = false;
  }
}

function clearPollTimer() {
  if (!pollTimer) return;
  clearTimeout(pollTimer);
  pollTimer = null;
}

function switchToNormalPolling() {
  pollMode = "normal";
  clearPollTimer();
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void tickNormal();
  }, 12000);
}

/** Poll when offline with exponential backoff: 5s, 10s, 20s, capped at 30s. */
function switchToOfflinePolling() {
  // Don't downgrade from fast polling (restart recovery).
  if (fastPollCount > 0) return;
  pollMode = "offline";
  clearPollTimer();
  offlineConsecutiveFailures += 1;
  const delay = Math.min(5000 * Math.pow(2, Math.min(offlineConsecutiveFailures - 1, 3)), 30000);
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void tickOffline();
  }, delay);
}

function switchToFastPolling() {
  pollMode = "fast";
  clearPollTimer();
  fastPollCount = 1;
  pollTimer = setTimeout(() => {
    pollTimer = null;
    void tickFast();
  }, 2000);
}

async function tickNormal() {
  if (pollMode !== "normal" || subscribers <= 0) return;
  await pollLite();
  if (pollMode === "normal" && subscribers > 0 && !tabHidden && !pollTimer) {
    switchToNormalPolling();
  }
}

async function tickOffline() {
  if (pollMode !== "offline" || subscribers <= 0) return;
  await pollLite();
  if (pollMode === "offline" && subscribers > 0 && !tabHidden && !pollTimer) {
    switchToOfflinePolling();
  }
}

async function tickFast() {
  if (pollMode !== "fast" || subscribers <= 0) return;
  fastPollCount += 1;
  if (fastPollCount > 30) {
    fastPollCount = 0;
    switchToNormalPolling();
    setSnapshot({ restarting: false });
    return;
  }
  await pollLite();
  if (pollMode !== "fast") return;

  // During restart recovery, run full health checks less frequently.
  // If /api/status already reports online, probe full health immediately.
  if (snapshot.status === "online" || fastPollCount % 8 === 0) {
    await poll();
    if (pollMode !== "fast") return;
  }

  if (!tabHidden && !pollTimer) {
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void tickFast();
    }, 2000);
  }
}

function handleRestartingSignal() {
  setSnapshot({ status: "loading", health: null, restarting: true });
  switchToFastPolling();
  setTimeout(() => {
    void poll();
  }, 1500);
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    setSnapshot({ restarting: false });
  }, 5000);
}

function handleVisibilityChange() {
  const hidden = document.visibilityState === "hidden";
  if (tabHidden === hidden) return;
  tabHidden = hidden;
  if (hidden) {
    clearPollTimer();
    return;
  }
  if (!hidden && subscribers > 0) {
    // Tab became visible — immediately refresh and resume polling.
    void pollLite();
    if (!pollTimer) {
      if (pollMode === "fast") switchToFastPolling();
      else if (pollMode === "offline") switchToOfflinePolling();
      else switchToNormalPolling();
    }
  }
}

async function start() {
  if (typeof window === "undefined") return;
  tabHidden = document.visibilityState === "hidden";
  window.addEventListener(RESTART_EVENT, handleRestartingSignal);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  // Fast preflight via /api/status (3s max) then full health data (sequenced to avoid race)
  await pollLite(true);
  await poll(true);
  setSnapshot({ initialCheckDone: true });
  if (!tabHidden) switchToNormalPolling();
}

function stop() {
  if (typeof window !== "undefined") {
    window.removeEventListener(RESTART_EVENT, handleRestartingSignal);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
  }
  clearPollTimer();
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  pollMode = "normal";
  fastPollCount = 0;
  offlineConsecutiveFailures = 0;
  liteInFlight = false;
  fullInFlight = false;
  tabHidden = false;
}

export function notifyGatewayRestarting() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(RESTART_EVENT));
}

export function subscribeGatewayStatus(listener: () => void) {
  listeners.add(listener);
  subscribers += 1;
  if (subscribers === 1) start();

  return () => {
    listeners.delete(listener);
    subscribers = Math.max(0, subscribers - 1);
    if (subscribers === 0) stop();
  };
}

export function getGatewayStatusSnapshot() {
  return snapshot;
}

export function getGatewayStatusServerSnapshot(): Snapshot {
  return SERVER_SNAPSHOT;
}

export function useGatewayStatusStore() {
  return useSyncExternalStore(
    subscribeGatewayStatus,
    getGatewayStatusSnapshot,
    getGatewayStatusServerSnapshot
  );
}
