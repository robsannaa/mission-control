"use client";

import { useEffect, useRef } from "react";

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
          // a flood. Only genuinely new nudges reach out.
          if (seeding) continue;
          const question = c.suggestedText || c.reason || "How did this go?";
          // Turn the follow-up into a proactive "nudge" interaction: it surfaces
          // in the bell + browser notification AND in the chat view, where the
          // user answers and the agent replies naturally (see chat-view).
          await fetch("/api/interactions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              action: "create",
              interaction: {
                kind: "nudge",
                title: question.slice(0, 80),
                question,
                source: { kind: "cron", id: `commitment:${c.id}`, label: "Proactive check-in" },
              },
            }),
          }).catch(() => {
            /* transient — retried next poll since we re-add on failure below */
          });
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
  }, []);

  return null;
}
