"use client";

/**
 * The configured state: one sentence that says what is actually happening,
 * then the handful of choices that change it. Everything here maps to a real
 * top-level key under `agents.defaults.heartbeat` — nothing here is decorative.
 */

import { useCallback, useState } from "react";
import { Check, Save } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { ChoicePill, FieldLabel, Panel, Pill, fieldInputClass } from "./primitives";
import { ACTIVE_DAYS, CADENCE_PRESETS, describeCadence, describeTarget } from "./lib";
import type { ChannelOption, EditorState } from "./types";

export function ScheduleCard({
  editor,
  onChange,
  isOn,
  onToggle,
  channelOptions,
  channelLabels,
  onSave,
  busy,
  justSaved,
}: {
  editor: EditorState;
  onChange: (next: EditorState) => void;
  isOn: boolean;
  onToggle: () => void;
  channelOptions: ChannelOption[];
  channelLabels: Map<string, string>;
  onSave: () => void;
  busy: boolean;
  justSaved: boolean;
}) {
  const form = editor.form;
  const [showCustomCadence, setShowCustomCadence] = useState(
    () => !CADENCE_PRESETS.some((p) => p.value === (form.every || "30m")) && form.every !== "0m"
  );

  const setForm = useCallback(
    (patch: Partial<typeof form>) => {
      onChange({ ...editor, form: { ...form, ...patch } });
    },
    [editor, form, onChange]
  );

  const effectiveEvery = form.every || "30m";
  const effectiveTarget = form.target || "none";

  return (
    <Panel className="p-6 md:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="text-base font-semibold tracking-[-0.01em] text-foreground">Heartbeat</h3>
            <Pill tone={isOn ? "positive" : "neutral"}>{isOn ? "On" : "Off"}</Pill>
          </div>
          <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted-foreground">
            {isOn ? (
              <>
                Checks in <strong className="font-medium text-foreground">{describeCadence(effectiveEvery)}</strong>{" "}
                and tells you{" "}
                <strong className="font-medium text-foreground">{describeTarget(effectiveTarget, channelLabels)}</strong>{" "}
                when something needs you.
              </>
            ) : (
              "Turned off. Your agent will not run scheduled check-ins."
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <span className="text-xs text-muted-foreground">{isOn ? "On" : "Off"}</span>
          <Switch checked={isOn} onCheckedChange={onToggle} disabled={busy} aria-label="Turn heartbeat on or off" />
        </div>
      </div>

      {isOn && (
        <div className="mt-6 space-y-5 border-t border-border-subtle pt-6">
          <div>
            <p className="mb-2 text-xs font-medium text-foreground">How often</p>
            <div className="flex flex-wrap gap-2">
              {CADENCE_PRESETS.map((preset) => (
                <ChoicePill
                  key={preset.value}
                  selected={!showCustomCadence && effectiveEvery === preset.value}
                  onClick={() => {
                    setShowCustomCadence(false);
                    setForm({ every: preset.value });
                  }}
                >
                  {preset.label}
                </ChoicePill>
              ))}
              <ChoicePill selected={showCustomCadence} onClick={() => setShowCustomCadence(true)}>
                Custom
              </ChoicePill>
            </div>
            {showCustomCadence && (
              <input
                value={form.every}
                onChange={(e) => setForm({ every: e.target.value })}
                placeholder="e.g. 45m or 2h"
                className={`${fieldInputClass} mt-2 max-w-[12rem]`}
              />
            )}
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-foreground">Where alerts go</p>
            <div className="flex flex-wrap gap-2">
              <ChoicePill selected={effectiveTarget === "last"} onClick={() => setForm({ target: "last" })}>
                Wherever we last talked
              </ChoicePill>
              {channelOptions.map((opt) => (
                <ChoicePill
                  key={opt.value}
                  selected={effectiveTarget === opt.value}
                  onClick={() => setForm({ target: opt.value })}
                >
                  {opt.label}
                </ChoicePill>
              ))}
              <ChoicePill selected={effectiveTarget === "none"} onClick={() => setForm({ target: "none" })}>
                Nowhere — stay silent
              </ChoicePill>
            </div>
          </div>

          <div>
            <FieldLabel>What should it check for? (optional)</FieldLabel>
            <textarea
              value={form.prompt}
              onChange={(e) => setForm({ prompt: e.target.value })}
              rows={2}
              placeholder="Leave blank for the standard check: review HEARTBEAT.md and flag anything urgent."
              className={fieldInputClass}
            />
          </div>

          <div className="rounded-lg border border-border-subtle bg-surface-subtle p-3.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-foreground">Only during certain hours</p>
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={form.activeEnabled}
                  onChange={(e) => setForm({ activeEnabled: e.target.checked })}
                  className="h-3.5 w-3.5 rounded border-border bg-transparent"
                />
                Enable
              </label>
            </div>

            {form.activeEnabled && (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <FieldLabel>From</FieldLabel>
                    <input
                      value={form.activeStart}
                      onChange={(e) => setForm({ activeStart: e.target.value })}
                      placeholder="08:00"
                      className={fieldInputClass}
                    />
                  </div>
                  <div>
                    <FieldLabel>Until</FieldLabel>
                    <input
                      value={form.activeEnd}
                      onChange={(e) => setForm({ activeEnd: e.target.value })}
                      placeholder="22:00"
                      className={fieldInputClass}
                    />
                  </div>
                  <div>
                    <FieldLabel>Timezone</FieldLabel>
                    <input
                      value={form.activeTimezone}
                      onChange={(e) => setForm({ activeTimezone: e.target.value })}
                      placeholder={Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time"}
                      className={fieldInputClass}
                    />
                  </div>
                </div>
                <div>
                  <FieldLabel>Days</FieldLabel>
                  <div className="flex flex-wrap gap-1.5">
                    {ACTIVE_DAYS.map((day) => {
                      const selected = form.activeDays.includes(day.value);
                      return (
                        <ChoicePill
                          key={day.value}
                          selected={selected}
                          onClick={() => {
                            const next = selected
                              ? form.activeDays.filter((d) => d !== day.value)
                              : [...form.activeDays, day.value];
                            setForm({ activeDays: next });
                          }}
                          className="px-2.5 py-1"
                        >
                          {day.label}
                        </ChoicePill>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              onClick={onSave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {busy ? "Saving..." : "Save changes"}
            </button>
            {justSaved && (
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-fg">
                <Check className="h-3.5 w-3.5" />
                Saved — live now, no restart needed
              </span>
            )}
          </div>
        </div>
      )}
    </Panel>
  );
}
