"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SlashCommand } from "@/components/chat/types";

/**
 * The `/` catalogue.
 *
 * Cached per browser session in a module-level promise so switching sessions
 * or agents never refetches 124 commands, and the menu opens instantly on the
 * first keystroke rather than after a round trip.
 */

let cached: SlashCommand[] | null = null;
let inFlight: Promise<SlashCommand[]> | null = null;

async function load(): Promise<SlashCommand[]> {
  if (cached) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const res = await fetch("/api/chat/commands", { cache: "no-store" });
    if (!res.ok) throw new Error(`commands ${res.status}`);
    const body = (await res.json()) as { commands?: SlashCommand[] };
    cached = Array.isArray(body.commands) ? body.commands : [];
    return cached;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

export function useSlashCommands(enabled: boolean) {
  const [commands, setCommands] = useState<SlashCommand[]>(cached ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await load();
      if (!alive.current) return;
      setCommands(next);
      setError(null);
    } catch {
      if (!alive.current) return;
      setError("Command list unavailable — is the gateway online?");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled || cached) return;
    void refresh();
  }, [enabled, refresh]);

  return { commands, loading, error, refresh };
}
