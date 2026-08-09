"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Loader2, Play, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { Celebration } from "./celebration";
import {
  cardClass,
  primaryBtnClass,
  secondaryBtnClass,
  type DetectPayload,
} from "./types";

const POLL_MS = 3000;

function StatusRow({
  label,
  ok,
  detail,
  pending,
}: {
  label: string;
  ok: boolean;
  detail?: string | null;
  pending?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="relative flex h-2 w-2 shrink-0">
        {ok && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            pending ? "bg-border-strong" : ok ? "bg-success" : "bg-danger",
          )}
        />
      </span>
      <span className="text-sm text-fg-secondary">{label}</span>
      {detail && (
        <span className="ml-auto font-mono text-[11px] text-fg-subtle">
          {detail}
        </span>
      )}
    </div>
  );
}

export function StepGateway({
  onDone,
  onSkip,
}: {
  onDone: (meta?: Record<string, unknown>) => void;
  onSkip: () => void;
}) {
  const [detect, setDetect] = useState<DetectPayload | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [justCameOnline, setJustCameOnline] = useState(false);
  const wasRunningRef = useRef<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/detect", { cache: "no-store" });
      if (!res.ok) return;
      const data: DetectPayload = await res.json();
      setDetect(data);
      if (wasRunningRef.current === false && data.running) {
        setJustCameOnline(true);
      }
      wasRunningRef.current = data.running;
    } catch {
      // transient — next poll retries
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleStart = useCallback(async () => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await fetch("/api/onboarding/detect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      const data = await res.json();
      if (!data.ok) {
        setStartError(data.error || "Could not start the gateway.");
      } else if (data.running) {
        setJustCameOnline(true);
      }
      await refresh();
    } catch {
      setStartError("Network error while starting the gateway.");
    } finally {
      setStarting(false);
    }
  }, [refresh]);

  const checking = detect === null;
  const running = detect?.running === true;

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="space-y-0.5">
        <div className="mb-1 flex items-center gap-2">
          <Server className="h-3.5 w-3.5 text-fg-subtle dark:text-muted-foreground" />
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Your OpenClaw gateway
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Mission Control talks to a local OpenClaw gateway. Checking it now — this updates live.
        </p>
      </div>

      <div className={cn(cardClass, "divide-y divide-border dark:divide-border-subtle py-1")}>
        <StatusRow
          label="OpenClaw installed"
          ok={detect?.installed === true}
          pending={checking}
          detail={detect?.cliVersion ? `v${detect.cliVersion}` : checking ? "checking…" : "not found"}
        />
        <StatusRow
          label="Gateway running"
          ok={running}
          pending={checking}
          detail={running ? `port ${detect?.port}` : checking ? "checking…" : "stopped"}
        />
        <StatusRow
          label="Gateway healthy"
          ok={detect?.healthy === true}
          pending={checking || !running}
          detail={detect?.healthy ? "responding" : running ? "starting…" : "—"}
        />
      </div>

      {detect && !detect.installed && (
        <p className="text-xs leading-relaxed text-warning-fg">
          OpenClaw was not found on this machine. If it is hosted for you, this page will light up
          as soon as your instance is provisioned.
        </p>
      )}

      {detect?.installed && !running && (
        <button type="button" onClick={handleStart} disabled={starting} className={primaryBtnClass}>
          {starting ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Starting gateway…
            </>
          ) : (
            <>
              <Play className="h-3.5 w-3.5" />
              Start gateway
            </>
          )}
        </button>
      )}

      {startError && (
        <p className="flex items-center gap-1.5 text-xs text-danger-fg">
          <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-danger" />
          {startError}
        </p>
      )}

      {justCameOnline && running && (
        <Celebration message="Gateway is up and answering. Nicely done." />
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onSkip} className={secondaryBtnClass}>
          Skip for now
        </button>
        <button
          type="button"
          onClick={() => onDone({ version: detect?.cliVersion ?? null })}
          disabled={!running}
          className={primaryBtnClass}
        >
          Continue
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
