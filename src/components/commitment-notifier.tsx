"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { notificationStore } from "@/lib/notification-store";

/**
 * Headless global watcher that makes commitments proactive INSIDE Mission
 * Control — not just on Telegram. It polls pending follow-ups and, when a new
 * one appears, surfaces it in the bell + a toast AND fires a browser
 * notification, so the agent reaches you even when you're just in the browser.
 *
 * First run seeds silently into the bell (no desktop spam for a backlog); only
 * genuinely new commitments after that pop a toast + desktop notification.
 */

const SEEN_KEY = "commitment_seen_ids";
const POLL_MS = 60_000;

function loadSeen(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-500)));
  } catch {
    /* ignore */
  }
}

export function CommitmentNotifier() {
  const router = useRouter();
  const seededRef = useRef(false);

  useEffect(() => {
    // The user asked for browser notifications — ask once if undecided.
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      try {
        void Notification.requestPermission();
      } catch {
        /* ignore */
      }
    }

    let active = true;
    const seen = loadSeen();

    async function poll() {
      try {
        const res = await fetch("/api/commitments?status=pending", {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok || !active) return;
        const body = await res.json();
        const commitments: Array<{ id?: string; suggestedText?: string; reason?: string }> = Array.isArray(
          body?.commitments,
        )
          ? body.commitments
          : [];
        const seeding = !seededRef.current && seen.size === 0;

        for (const c of commitments) {
          if (!c.id || seen.has(c.id)) continue;
          seen.add(c.id);
          // First run seeds the backlog silently — we never replay old loops as
          // a flood of toasts/desktop pings. Only genuinely new nudges surface.
          if (seeding) continue;
          const title = "Your agent";
          const detail = c.suggestedText || c.reason || "A follow-up needs you.";
          notificationStore.push({
            type: "commitment",
            severity: "info",
            title,
            detail,
            href: "/commitments",
            displayMode: "both",
            actions: [{ label: "Answer", callback: () => router.push("/commitments") }],
            dedupKey: `commitment:${c.id}`,
          });
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            try {
              new Notification(title, { body: detail, tag: `commitment-${c.id}`, icon: "/favicon.ico" });
            } catch {
              /* ignore */
            }
          }
        }
        seededRef.current = true;
        saveSeen(seen);
      } catch {
        /* transient; try again next tick */
      }
    }

    void poll();
    const iv = setInterval(poll, POLL_MS);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [router]);

  return null;
}
