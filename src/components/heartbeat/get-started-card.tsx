"use client";

/**
 * The first thing a person sees when heartbeat has no explicit configuration
 * yet. OpenClaw still runs a heartbeat in the background even without one
 * (built-in default: every 30 minutes, delivered nowhere) — so this is not
 * "turn a dead feature on", it is "point the thing that is already running at
 * you". `lastEvent`, when present, makes that concrete instead of abstract.
 */

import { useState } from "react";
import { Heart, Sparkles } from "lucide-react";
import { ChoicePill, Panel, fieldInputClass } from "./primitives";
import { CADENCE_PRESETS } from "./lib";
import type { ChannelOption, HeartbeatEvent } from "./types";

function timeAgo(ts: number): string {
  const diffMs = Date.now() - ts;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "moments ago";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function GetStartedCard({
  lastEvent,
  channelOptions,
  busy,
  onActivate,
}: {
  lastEvent: HeartbeatEvent;
  channelOptions: ChannelOption[];
  busy: boolean;
  onActivate: (opts: { every: string; target: string }) => void;
}) {
  const [cadence, setCadence] = useState("30m");
  const [customCadence, setCustomCadence] = useState("");
  const isCustom = !CADENCE_PRESETS.some((p) => p.value === cadence);
  const [target, setTarget] = useState("last");

  const hasEvidence =
    lastEvent && lastEvent.status === "skipped" && lastEvent.reason === "target-none" && lastEvent.preview;

  const effectiveEvery = isCustom ? customCadence.trim() || "30m" : cadence;

  return (
    <Panel className="p-6 md:p-7">
      <div className="flex items-start gap-4">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-danger-bg">
          <Heart className="h-5 w-5 text-danger-fg" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold tracking-[-0.01em] text-foreground">
            Never miss what matters
          </h3>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Your agent already checks in on its own every 30 minutes — that&rsquo;s happening right
            now, quietly, in the background. It just has nowhere to send what it finds. Turn this on
            and it will tell you when something needs you, instead of keeping it to itself.
          </p>

          {hasEvidence && (
            <div className="mt-4 rounded-xl border border-border-subtle bg-surface-subtle px-4 py-3">
              <p className="text-xs font-medium text-fg-subtle">
                Its last check-in, {timeAgo(lastEvent!.ts)}, found something — and had nowhere to
                put it:
              </p>
              <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-fg-secondary">
                &ldquo;{lastEvent!.preview}&rdquo;
              </p>
            </div>
          )}

          <div className="mt-6 space-y-5">
            <div>
              <p className="mb-2 text-xs font-medium text-foreground">How often should it check?</p>
              <div className="flex flex-wrap gap-2">
                {CADENCE_PRESETS.map((preset) => (
                  <ChoicePill
                    key={preset.value}
                    selected={cadence === preset.value}
                    onClick={() => setCadence(preset.value)}
                  >
                    {preset.label}
                  </ChoicePill>
                ))}
                <ChoicePill selected={isCustom} onClick={() => setCadence("__custom__")}>
                  Custom
                </ChoicePill>
              </div>
              {isCustom && (
                <input
                  value={customCadence}
                  onChange={(e) => setCustomCadence(e.target.value)}
                  placeholder="e.g. 45m or 2h"
                  className={`${fieldInputClass} mt-2 max-w-[12rem]`}
                />
              )}
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-foreground">Where should it tell you?</p>
              <div className="flex flex-wrap gap-2">
                <ChoicePill selected={target === "last"} onClick={() => setTarget("last")}>
                  Wherever we last talked
                </ChoicePill>
                {channelOptions.map((opt) => (
                  <ChoicePill key={opt.value} selected={target === opt.value} onClick={() => setTarget(opt.value)}>
                    {opt.label}
                  </ChoicePill>
                ))}
                <ChoicePill selected={target === "none"} onClick={() => setTarget("none")}>
                  Nowhere — stay silent
                </ChoicePill>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => onActivate({ every: effectiveEvery, target })}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              {busy ? "Turning on..." : "Turn on heartbeat"}
            </button>
            <span className="text-xs text-fg-subtle">Takes effect immediately — no restart needed.</span>
          </div>
        </div>
      </div>
    </Panel>
  );
}
