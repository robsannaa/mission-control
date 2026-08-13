/**
 * Centralized notification store — pub/sub system for app-wide notifications.
 *
 * Supports multiple display modes (bell, toast, banner) and action callbacks.
 * Uses the same useSyncExternalStore pattern as gateway-status-store.ts.
 */

import { useSyncExternalStore } from "react";

/* ── Types ── */

export type NotificationSeverity = "error" | "warning" | "info" | "success";

export type NotificationDisplayMode = "bell" | "toast" | "both";

export type NotificationAction = {
  label: string;
  callback: () => void;
};

export type AppNotification = {
  id: string;
  type: string;
  severity: NotificationSeverity;
  title: string;
  detail?: string;
  source?: string;
  /** Optional in-app destination opened when the notification is selected. */
  href?: string;
  /** Stable target for deep-linking a log notification to its exact row. */
  logAnchor?: string;
  timestamp: number;
  displayMode: NotificationDisplayMode;
  actions?: NotificationAction[];
  /** Auto-dismiss toast after this many ms (default 5000). Set 0 to persist. */
  autoDismissMs?: number;
  read: boolean;
  dismissed: boolean;
  /** For deduplication: notifications with the same dedupKey are grouped. */
  dedupKey?: string;
};

export type NotificationStoreSnapshot = {
  notifications: AppNotification[];
  unreadCount: number;
};

/* ── Constants ── */

const MAX_NOTIFICATIONS = 50;
const DEFAULT_AUTO_DISMISS_MS = 5000;
const READ_IDS_KEY = "notif_store_read_ids";

/* ── State ── */

let notifications: AppNotification[] = [];
const listeners = new Set<() => void>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

/* ── Persistence ── */

function loadReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(READ_IDS_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

// Hydrate read state from localStorage on init
const _initialReadIds = loadReadIds();
if (_initialReadIds.size > 0) {
  notifications = notifications.map((n) =>
    _initialReadIds.has(n.id) ? { ...n, read: true } : n,
  );
}

function persistReadIds() {
  if (typeof window === "undefined") return;
  try {
    const ids = notifications.filter((n) => n.read).map((n) => n.id);
    localStorage.setItem(READ_IDS_KEY, JSON.stringify(ids.slice(-100)));
  } catch { /* ignore */ }
}

/* ── Internal helpers ── */

function emit() {
  listeners.forEach((fn) => {
    try { fn(); } catch { /* ignore */ }
  });
}

function buildSnapshot(): NotificationStoreSnapshot {
  const visible = notifications.filter((n) => !n.dismissed);
  return {
    notifications: visible,
    unreadCount: visible.filter((n) => !n.read).length,
  };
}

let cachedSnapshot: NotificationStoreSnapshot = buildSnapshot();
let cachedToasts: AppNotification[] = [];
let cachedBellNotifications: AppNotification[] = [];

function updateSnapshot() {
  cachedSnapshot = buildSnapshot();
  cachedToasts = notifications.filter(
    (n) => !n.dismissed && (n.displayMode === "toast" || n.displayMode === "both"),
  );
  cachedBellNotifications = notifications.filter(
    (n) => !n.dismissed && (n.displayMode === "bell" || n.displayMode === "both"),
  );
  emit();
}

function scheduleDismiss(notification: AppNotification) {
  if (notification.displayMode === "bell") return;
  const ms = notification.autoDismissMs ?? DEFAULT_AUTO_DISMISS_MS;
  if (ms <= 0) return;
  const timer = setTimeout(() => {
    dismissTimers.delete(notification.id);
    notificationStore.dismiss(notification.id);
  }, ms);
  dismissTimers.set(notification.id, timer);
}

/* ── Public API ── */

export const notificationStore = {
  /** Push a new notification into the store. */
  push(opts: {
    type: string;
    severity: NotificationSeverity;
    title: string;
    detail?: string;
    source?: string;
    href?: string;
    logAnchor?: string;
    displayMode?: NotificationDisplayMode;
    actions?: NotificationAction[];
    autoDismissMs?: number;
    dedupKey?: string;
  }): string {
    const key = opts.dedupKey ?? `${opts.type}:${opts.source ?? ""}:${opts.title}`;

    // Dedup: if an identical non-dismissed notification exists, update it
    const existing = notifications.find(
      (n) => !n.dismissed && n.dedupKey === key,
    );
    if (existing) {
      notifications = notifications.map((n) =>
        n.id === existing.id
          ? { ...n, timestamp: Date.now(), detail: opts.detail ?? n.detail, href: opts.href ?? n.href, logAnchor: opts.logAnchor ?? n.logAnchor, read: false }
          : n,
      );
      updateSnapshot();
      return existing.id;
    }

    const id = `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const notification: AppNotification = {
      id,
      type: opts.type,
      severity: opts.severity,
      title: opts.title,
      detail: opts.detail,
      source: opts.source,
      href: opts.href,
      logAnchor: opts.logAnchor,
      timestamp: Date.now(),
      displayMode: opts.displayMode ?? "both",
      actions: opts.actions,
      autoDismissMs: opts.autoDismissMs,
      read: false,
      dismissed: false,
      dedupKey: key,
    };

    // Clean up dismiss timers for evicted notifications
    const prev = notifications;
    notifications = [notification, ...prev].slice(0, MAX_NOTIFICATIONS);
    for (let i = notifications.length; i < prev.length; i++) {
      const evicted = prev[i];
      const timer = dismissTimers.get(evicted.id);
      if (timer) {
        clearTimeout(timer);
        dismissTimers.delete(evicted.id);
      }
    }
    updateSnapshot();
    scheduleDismiss(notification);
    return id;
  },

  /** Mark a notification as read. */
  markRead(id: string) {
    const n = notifications.find((n) => n.id === id);
    if (n && !n.read) {
      notifications = notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n,
      );
      persistReadIds();
      updateSnapshot();
    }
  },

  /** Mark all notifications as read. */
  markAllRead() {
    if (!notifications.some((n) => !n.read)) return;
    notifications = notifications.map((n) =>
      n.read ? n : { ...n, read: true },
    );
    persistReadIds();
    updateSnapshot();
  },

  /** Dismiss a notification (hide from UI, clear auto-dismiss timer). */
  dismiss(id: string) {
    const n = notifications.find((n) => n.id === id);
    if (n && !n.dismissed) {
      notifications = notifications.map((n) =>
        n.id === id ? { ...n, dismissed: true } : n,
      );
      const timer = dismissTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        dismissTimers.delete(id);
      }
      updateSnapshot();
    }
  },

  /** Clear all notifications. */
  clear() {
    for (const timer of dismissTimers.values()) clearTimeout(timer);
    dismissTimers.clear();
    notifications = [];
    updateSnapshot();
  },

  /** Get all active toast notifications (for ToastRenderer). */
  getToasts(): AppNotification[] {
    return cachedToasts;
  },

  /** Get all bell notifications (for NotificationCenter). */
  getBellNotifications(): AppNotification[] {
    return cachedBellNotifications;
  },

  /* ── useSyncExternalStore integration ── */

  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  getSnapshot(): NotificationStoreSnapshot {
    return cachedSnapshot;
  },

  getServerSnapshot(): NotificationStoreSnapshot {
    return { notifications: [], unreadCount: 0 };
  },
};

/* ── Convenience helpers ── */

const SEVERITY_DEFAULTS: Record<
  NotificationSeverity,
  { displayMode: NotificationDisplayMode; autoDismissMs: number }
> = {
  error:   { displayMode: "both",  autoDismissMs: 8000 },
  warning: { displayMode: "both",  autoDismissMs: 6000 },
  success: { displayMode: "toast", autoDismissMs: 4000 },
  info:    { displayMode: "toast", autoDismissMs: 4000 },
};

function notifyBySeverity(severity: NotificationSeverity, title: string, detail?: string, source?: string) {
  const defaults = SEVERITY_DEFAULTS[severity];
  return notificationStore.push({
    type: `app-${severity}`,
    severity,
    title,
    detail,
    source,
    ...defaults,
  });
}

export const notifyError   = (title: string, detail?: string, source?: string) => notifyBySeverity("error", title, detail, source);
export const notifySuccess = (title: string, detail?: string, source?: string) => notifyBySeverity("success", title, detail, source);
export const notifyWarning = (title: string, detail?: string, source?: string) => notifyBySeverity("warning", title, detail, source);
export const notifyInfo    = (title: string, detail?: string, source?: string) => notifyBySeverity("info", title, detail, source);

/* ── React hook ── */

export function useNotificationStore() {
  return useSyncExternalStore(
    notificationStore.subscribe,
    notificationStore.getSnapshot,
    notificationStore.getServerSnapshot,
  );
}
