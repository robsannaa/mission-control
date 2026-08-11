"use client";

import { useState, useCallback, useRef, useEffect, useMemo, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, CheckCheck, CheckCircle, Clock, AlertCircle, AlertTriangle, Info, Zap, Terminal, Radio, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import {
  notificationStore,
  type AppNotification,
} from "@/lib/notification-store";

type NotificationEvent = {
  id: string;
  type: "cron" | "session" | "log" | "system" | "pairing" | "usage-alert";
  timestamp: number;
  title: string;
  detail?: string;
  status?: "ok" | "error" | "info" | "warning";
  source?: string;
};

type PairingResponse = {
  dm?: Array<{
    channel: string;
    code: string;
    account?: string;
    senderId?: string;
    senderName?: string;
    message?: string;
    createdAt?: string;
  }>;
  devices?: Array<{
    requestId: string;
    displayName?: string;
    platform?: string;
    role?: string;
    createdAtMs?: number;
  }>;
};

/** Stable signature so a recurring log/warning stays dismissed across re-polls
 *  even though each poll assigns it a fresh, timestamp-based id. */
function signatureOf(type: string, title: string, source?: string): string {
  return `${type}|${source ?? ""}|${title}`;
}

/**
 * Internal engine chatter that must never reach a person: embedded-run traces,
 * prep-stage dumps, raw run/session-id lines. These arrive as `log` events with
 * `warning` severity and used to crowd out the notifications that matter.
 */
const NOISE_LOG_RE =
  /\[trace|embedded-run|prep stages|prep_stages|runid=|sessionid=|\bdebug\b/i;

function isNoiseLog(e: NotificationEvent): boolean {
  if (e.type !== "log" && e.type !== "system") return false;
  return NOISE_LOG_RE.test(`${e.title} ${e.detail ?? ""}`);
}

/**
 * A cron run the user actually wants to hear about: one the agent scheduled to
 * ping them (a reminder / heads-up), as opposed to routine background jobs like
 * a mail sweep that fire constantly. Matched on the message the run produced.
 */
const REMINDER_RE = /remind|reminder|⏰|🔔|don'?t forget|heads[- ]?up|follow[- ]?up|check (on|that|the)|nudge/i;

function isUserFacingCron(e: NotificationEvent): boolean {
  if (e.type !== "cron") return false;
  // A failed job is always worth surfacing; otherwise only reminder-shaped ones.
  return e.status === "error" || REMINDER_RE.test(`${e.title} ${e.detail ?? ""}`);
}

/**
 * Events worth a person's attention: things that failed (error/warning) and
 * reminders the agent scheduled for them. A successful reminder is `ok`, so an
 * error-only filter dropped it — that is the bug that let a "check the boiling
 * water" reminder fire with nothing shown in the app. Routine successful cron
 * jobs are deliberately excluded so the bell stays signal, not a job log.
 */
function worthShowing(e: NotificationEvent): boolean {
  if (isNoiseLog(e)) return false;
  return e.status === "error" || e.status === "warning" || isUserFacingCron(e);
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const STATUS_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  ok: CheckCircle,
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
  success: CheckCircle,
};

const TYPE_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  cron: Clock,
  session: Zap,
  log: Terminal,
  system: Radio,
  pairing: Bell,
  "usage-alert": AlertTriangle,
};

const TYPE_ROUTE: Record<string, string> = {
  cron: "/cron",
  session: "/sessions",
  log: "/logs",
  system: "/activity",
  pairing: "/dashboard",
  "usage-alert": "/usage",
};

const TYPE_QUERY_PARAM: Record<string, string> = {
  cron: "job",
  session: "id",
};

/** Merged display item for the bell panel. */
type DisplayItem = {
  id: string;
  type: string;
  timestamp: number;
  title: string;
  detail?: string;
  status: string;
  source?: string;
  read: boolean;
  /** If from the notification store, the original notification. */
  storeNotification?: AppNotification;
  /** If from polling, the original event. */
  polledEvent?: NotificationEvent;
};

function getBellNotifications() {
  return notificationStore.getBellNotifications();
}
const emptyBell: AppNotification[] = [];

export function NotificationCenter() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<NotificationEvent[]>([]);
  const [lastSeenTs, setLastSeenTs] = useState(() => {
    if (typeof window === "undefined") return 0;
    const stored = localStorage.getItem("notif_last_seen");
    return stored ? Number(stored) : 0;
  });
  const [readIds, setReadIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("notif_read_ids");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  // Signatures of individually-dismissed items — persisted so they stay gone
  // even when the next poll re-derives them with a new id.
  const [dismissedSigs, setDismissedSigs] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      const stored = localStorage.getItem("notif_dismissed_sigs");
      return stored ? new Set(JSON.parse(stored) as string[]) : new Set();
    } catch { return new Set(); }
  });
  // Mute: hide the badge, silence desktop notifications, poll slowly.
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("notif_muted") === "1";
  });
  const panelRef = useRef<HTMLDivElement>(null);
  // Ids we've already surfaced, so a re-poll of the same event doesn't re-notify.
  const seenEventIdsRef = useRef<Set<string>>(new Set());
  const slowBackgroundPolling = !open || muted;

  // Subscribe to store-pushed bell notifications
  const storeNotifications = useSyncExternalStore(
    notificationStore.subscribe,
    getBellNotifications,
    () => emptyBell,
  );

  // Persist readIds to localStorage whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem("notif_read_ids", JSON.stringify([...readIds]));
    } catch { /* ignore */ }
  }, [readIds]);

  // Persist dismissed signatures (cap to keep localStorage small)
  useEffect(() => {
    try {
      localStorage.setItem(
        "notif_dismissed_sigs",
        JSON.stringify([...dismissedSigs].slice(-200)),
      );
    } catch { /* ignore */ }
  }, [dismissedSigs]);

  const fetchNotifications = useCallback(async () => {
    try {
      const [activityRes, pairingRes, alertsRes] = await Promise.all([
        fetch("/api/activity", { cache: "no-store", signal: AbortSignal.timeout(6000) })
          .catch(() => new Response("[]", { status: 200 })),
        fetch("/api/pairing", { cache: "no-store", signal: AbortSignal.timeout(6000) })
          .catch(() => new Response("{}", { status: 200 })),
        fetch("/api/usage/alerts?poll=1", { cache: "no-store", signal: AbortSignal.timeout(6000) }).catch(() => null),
      ]);

      const activityData = activityRes.ok ? ((await activityRes.json()) as NotificationEvent[]) : [];
      const pairingData = pairingRes.ok ? ((await pairingRes.json()) as PairingResponse) : {};
      const alertsData = alertsRes?.ok
        ? ((await alertsRes.json()) as { alerts?: Array<{ id: string; message: string; firedAt?: number }> })
        : {};

      // Errors, warnings, and things the agent did on its own (cron/reminders) —
      // minus internal trace noise. See worthShowing().
      const actionable = (Array.isArray(activityData) ? activityData : []).filter(worthShowing);

      // Actively surface anything NEW since the last poll: a badge is easy to
      // miss, and the whole point of a reminder is that it reaches you. The
      // first poll seeds the backlog silently so we never replay old events.
      {
        const seen = seenEventIdsRef.current;
        const seeding = seen.size === 0;
        for (const e of actionable) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          if (seeding || muted) continue;
          notificationStore.push({
            type: e.type,
            severity:
              e.status === "error" ? "error" : e.status === "warning" ? "warning" : "info",
            title: e.title,
            detail: e.detail,
            source: e.source,
            displayMode: "toast",
            dedupKey: `activity:${e.id}`,
          });
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(e.title, { body: e.detail, tag: e.id, icon: "/favicon.ico" });
            } catch { /* ignore */ }
          }
        }
      }

      const pairingEvents: NotificationEvent[] = [
        ...((pairingData.dm || []).map((req) => ({
          id: `pairing:dm:${req.channel}:${req.account || "default"}:${req.code}`,
          type: "pairing" as const,
          timestamp: req.createdAt ? new Date(req.createdAt).getTime() || Date.now() : Date.now(),
          title: `${req.channel} pairing request`,
          detail:
            req.senderName || req.senderId
              ? `${req.senderName || req.senderId}${req.message ? `: ${req.message}` : ""}`
              : "New sender waiting for approval",
          status: "warning" as const,
          source: req.channel,
        }))),
        ...((pairingData.devices || []).map((req) => ({
          id: `pairing:device:${req.requestId}`,
          type: "pairing" as const,
          timestamp: req.createdAtMs || Date.now(),
          title: "Device pairing request",
          detail: req.displayName || req.platform || req.role || "A device is waiting for approval",
          status: "warning" as const,
          source: req.requestId,
        }))),
      ];

      // Usage alert firings → notification events + desktop notification
      const alertEvents: NotificationEvent[] = (alertsData.alerts || []).map((alert) => {
        // Fire a desktop notification for each new alert (unless muted)
        if (!muted && typeof Notification !== "undefined" && Notification.permission === "granted") {
          try {
            new Notification("Usage Alert", {
              body: alert.message,
              tag: `usage-alert:${alert.id}`,
              icon: "/favicon.ico",
            });
          } catch { /* ignore */ }
        }
        return {
          id: `usage-alert:${alert.id}`,
          type: "usage-alert" as const,
          timestamp: alert.firedAt || Date.now(),
          title: "Usage alert triggered",
          detail: alert.message,
          status: "warning" as const,
          source: alert.id,
        };
      });

      const merged = [...alertEvents, ...pairingEvents, ...actionable]
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 20);

      setEvents(merged);
    } catch {
      /* ignore */
    }
  }, [open, muted]);

  useSmartPoll(fetchNotifications, { intervalMs: slowBackgroundPolling ? 60_000 : 20_000 });

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handler), 50);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handler);
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open]);

  // Merge polled events + store notifications into unified display list
  const displayItems = useMemo((): DisplayItem[] => {
    const polledItems: DisplayItem[] = events.map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      title: e.title,
      detail: e.detail,
      status: e.status || "info",
      source: e.source,
      read: e.timestamp <= lastSeenTs || readIds.has(e.id),
      polledEvent: e,
    }));

    const storeItems: DisplayItem[] = storeNotifications.map((n) => ({
      id: n.id,
      type: n.type,
      timestamp: n.timestamp,
      title: n.title,
      detail: n.detail,
      status: n.severity,
      source: n.source,
      read: n.read,
      storeNotification: n,
    }));

    // Dedup by id, drop anything the user dismissed, then sort by timestamp desc
    const byId = new Map<string, DisplayItem>();
    for (const item of [...polledItems, ...storeItems]) {
      if (byId.has(item.id)) continue;
      if (dismissedSigs.has(signatureOf(item.type, item.title, item.source))) continue;
      byId.set(item.id, item);
    }
    return Array.from(byId.values())
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 25);
  }, [events, storeNotifications, lastSeenTs, readIds, dismissedSigs]);

  const unreadCount = muted ? 0 : displayItems.filter((d) => !d.read).length;

  const dismissItem = useCallback((item: DisplayItem, e: React.MouseEvent) => {
    e.stopPropagation();
    if (item.storeNotification) notificationStore.dismiss(item.id);
    setDismissedSigs((prev) => {
      const next = new Set(prev);
      next.add(signatureOf(item.type, item.title, item.source));
      return next;
    });
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      try { localStorage.setItem("notif_muted", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const markAllRead = useCallback(() => {
    const now = Date.now();
    setLastSeenTs(now);
    setReadIds(new Set());
    try {
      localStorage.setItem("notif_last_seen", String(now));
      localStorage.removeItem("notif_read_ids");
    } catch { /* ignore */ }
    notificationStore.markAllRead();
  }, []);

  // Get rid of everything currently shown — not just mute it. Store-backed
  // notifications are dismissed; polled events are remembered as dismissed by
  // signature so they stay gone across re-polls.
  const clearAll = useCallback(() => {
    setDismissedSigs((prev) => {
      const next = new Set(prev);
      for (const item of displayItems) {
        next.add(signatureOf(item.type, item.title, item.source));
        if (item.storeNotification) notificationStore.dismiss(item.id);
      }
      return next;
    });
    setLastSeenTs(Date.now());
  }, [displayItems]);

  const handleOpen = () => {
    setOpen(!open);
  };

  const handleItemClick = (item: DisplayItem) => {
    // Mark as read
    if (item.storeNotification) {
      notificationStore.markRead(item.id);
    } else {
      setReadIds((prev) => {
        const next = new Set(prev);
        next.add(item.id);
        return next;
      });
    }

    // If store notification has actions, don't navigate — actions are in-panel
    if (item.storeNotification?.actions?.length) return;

    // Navigate to relevant page
    const base = TYPE_ROUTE[item.type] || "/activity";
    const paramKey = TYPE_QUERY_PARAM[item.type];
    const route = paramKey && item.source
      ? `${base}?${paramKey}=${encodeURIComponent(item.source)}`
      : base;
    setOpen(false);
    router.push(route);
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        data-notification-bell
        onClick={handleOpen}
        className={cn(
          "relative flex h-9 w-9 items-center justify-center rounded-md border border-border bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-fg-secondary dark:hover:bg-secondary dark:hover:text-foreground",
          open && "bg-muted text-fg-secondary dark:bg-secondary dark:text-foreground",
        )}
        aria-label="Notifications"
      >
        {muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white shadow-lg">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-card shadow-2xl animate-in slide-in-from-top-1 fade-in duration-150">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <p className="text-sm font-semibold text-foreground">
              Notifications
            </p>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-fg-secondary dark:hover:bg-secondary dark:hover:text-foreground"
                >
                  <CheckCheck className="h-3 w-3" />
                  Mark read
                </button>
              )}
              {displayItems.length > 0 && (
                <button
                  type="button"
                  onClick={clearAll}
                  title="Remove all notifications"
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-danger-bg hover:text-danger-fg"
                >
                  <X className="h-3 w-3" />
                  Clear all
                </button>
              )}
              <button
                type="button"
                onClick={toggleMute}
                aria-pressed={muted}
                title={muted ? "Notifications muted — click to unmute" : "Mute notifications"}
                className={cn(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  muted
                    ? "text-warning-fg hover:bg-warning-bg"
                    : "text-muted-foreground hover:bg-muted hover:text-fg-secondary dark:hover:bg-secondary dark:hover:text-foreground",
                )}
              >
                {muted ? <BellOff className="h-3 w-3" /> : <Bell className="h-3 w-3" />}
                {muted ? "Muted" : "Mute"}
              </button>
            </div>
          </div>

          {/* Events */}
          <div className="max-h-80 overflow-y-auto overscroll-contain" role="list" aria-label="Alert notifications" aria-live="polite">
            {displayItems.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
                <Bell className="h-5 w-5 text-fg-subtle" />
                <p className="text-xs text-muted-foreground">
                  No alerts — everything looks good
                </p>
              </div>
            ) : (
              displayItems.map((item) => {
                const Icon =
                  item.type === "pairing"
                    ? TYPE_ICON.pairing
                    : STATUS_ICON[item.status] || Info;
                return (
                  <div key={item.id} role="listitem" className="group relative">
                    <button
                      type="button"
                      onClick={() => handleItemClick(item)}
                      className={cn(
                        "flex w-full gap-3 border-b border-border px-4 py-3 pr-9 text-left transition-colors last:border-b-0 hover:bg-muted dark:hover:bg-card",
                        !item.read && "bg-muted",
                      )}
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
                          item.status === "error"
                            ? "bg-danger-bg"
                            : item.status === "warning"
                              ? "bg-warning-bg"
                              : item.status === "success"
                                ? "bg-success-bg"
                                : "bg-muted dark:bg-secondary",
                        )}
                      >
                        <Icon
                          className={cn(
                            "h-3 w-3",
                            item.status === "error"
                              ? "text-danger-fg"
                              : item.status === "warning"
                                ? "text-warning-fg"
                                : item.status === "success"
                                  ? "text-success-fg"
                                  : "text-fg-subtle dark:text-muted-foreground",
                          )}
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground">
                          {item.title}
                        </p>
                        {item.detail && (
                          <p className="mt-0.5 truncate text-xs text-muted-foreground">
                            {item.detail}
                          </p>
                        )}
                        {/* Action buttons for store notifications */}
                        {item.storeNotification?.actions && item.storeNotification.actions.length > 0 && (
                          <div className="mt-1.5 flex items-center gap-1.5">
                            {item.storeNotification.actions.map((action) => (
                              <button
                                key={action.label}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  action.callback();
                                  notificationStore.markRead(item.id);
                                }}
                                className="rounded bg-muted px-2 py-0.5 text-xs font-medium text-fg-secondary transition-colors hover:bg-secondary dark:bg-secondary"
                              >
                                {action.label}
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="mt-1 flex items-center gap-2">
                          <p className="text-xs text-fg-subtle">
                            {timeAgo(item.timestamp)}
                          </p>
                          <span className="text-xs text-fg-subtle">
                            {TYPE_ROUTE[item.type]?.slice(1) || item.type}
                          </span>
                        </div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={(e) => dismissItem(item, e)}
                      aria-label="Remove notification"
                      title="Remove this notification"
                      className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-md text-fg-subtle opacity-60 transition-opacity hover:bg-secondary hover:text-fg-secondary hover:opacity-100 focus:opacity-100 group-hover:opacity-100 dark:hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
