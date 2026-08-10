"use client";

/**
 * Everything that is real but not essential for a first setup: message
 * detail toggles, a different schedule per agent, and what each connected
 * app is allowed to show. All folded behind disclosures so the page a person
 * meets first is five choices, not fifty.
 */

import { Save, Trash2 } from "lucide-react";
import {
  ChoicePill,
  Disclosure,
  FieldLabel,
  Panel,
  Pill,
  fieldInputClass,
} from "./primitives";
import { CADENCE_PRESETS } from "./lib";
import type { ChannelOption, EditorState, HeartbeatAgent, ModelOption, TriState } from "./types";

const MESSAGE_DETAIL_LABELS: Record<string, string> = {
  askFirst: "Ask you before sending an alert",
  showSleepStatus: "Mention when it's outside active hours",
  showNoMessageStatus: "Mention when there's nothing new to report",
  showMessage: "Include the full message text",
  showThinking: "Show its reasoning alongside the answer",
  showModelName: "Name which model ran the check",
  showUsage: "Show usage and cost details",
  showDuration: "Show how long the check took",
  showGoal: "Show the goal it was working from",
  showNextRunTime: "Show when it will check again",
};

function TriToggle({ value, onChange }: { value: TriState; onChange: (v: TriState) => void }) {
  return (
    <div className="flex shrink-0 gap-1">
      <ChoicePill selected={value === ""} onClick={() => onChange("")} className="px-2 py-0.5 text-[11px]">
        Default
      </ChoicePill>
      <ChoicePill selected={value === "true"} onClick={() => onChange("true")} className="px-2 py-0.5 text-[11px]">
        Yes
      </ChoicePill>
      <ChoicePill selected={value === "false"} onClick={() => onChange("false")} className="px-2 py-0.5 text-[11px]">
        No
      </ChoicePill>
    </div>
  );
}

function MessageDetails({
  editor,
  onChange,
}: {
  editor: EditorState;
  onChange: (next: EditorState) => void;
}) {
  return (
    <div className="space-y-1.5">
      {Object.entries(MESSAGE_DETAIL_LABELS).map(([key, label]) => (
        <div
          key={key}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2"
        >
          <span className="text-xs text-fg-secondary">{label}</span>
          <TriToggle
            value={(editor.form as unknown as Record<string, TriState>)[key]}
            onChange={(v) =>
              onChange({ ...editor, form: { ...editor.form, [key]: v } as EditorState["form"] })
            }
          />
        </div>
      ))}
    </div>
  );
}

function AgentOverrideRow({
  agent,
  editor,
  onChange,
  onSave,
  onClear,
  channelOptions,
  modelOptions,
  busy,
}: {
  agent: HeartbeatAgent;
  editor: EditorState;
  onChange: (next: EditorState) => void;
  onSave: () => void;
  onClear: () => void;
  channelOptions: ChannelOption[];
  modelOptions: ModelOption[];
  busy: boolean;
}) {
  const hasOverride = Boolean(agent.heartbeat);
  const form = editor.form;

  return (
    <div className="rounded-xl border border-border-subtle p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{agent.name}</span>
        <Pill tone={hasOverride ? "positive" : "neutral"}>
          {hasOverride ? "Custom schedule" : "Uses the main schedule"}
        </Pill>
      </div>

      {!hasOverride ? (
        <div className="mt-3">
          <button
            type="button"
            onClick={() => onChange({ ...editor, form: { ...form, every: form.every || "30m" } })}
            className="rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
          >
            Give this agent its own schedule
          </button>
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          <div>
            <FieldLabel>How often</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {CADENCE_PRESETS.map((preset) => (
                <ChoicePill
                  key={preset.value}
                  selected={form.every === preset.value}
                  onClick={() => onChange({ ...editor, form: { ...form, every: preset.value } })}
                >
                  {preset.label}
                </ChoicePill>
              ))}
            </div>
            <input
              value={form.every}
              onChange={(e) => onChange({ ...editor, form: { ...form, every: e.target.value } })}
              placeholder="e.g. 45m or 2h"
              className={`${fieldInputClass} mt-2 max-w-[10rem]`}
            />
          </div>

          <div>
            <FieldLabel>Where alerts go</FieldLabel>
            <select
              value={form.target}
              onChange={(e) => onChange({ ...editor, form: { ...form, target: e.target.value } })}
              className={fieldInputClass}
            >
              <option value="">Use the main setting</option>
              <option value="last">Wherever we last talked</option>
              <option value="none">Nowhere — stay silent</option>
              {channelOptions.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <FieldLabel>What should it check for?</FieldLabel>
            <textarea
              value={form.prompt}
              onChange={(e) => onChange({ ...editor, form: { ...form, prompt: e.target.value } })}
              rows={2}
              placeholder="Leave blank to use the main instructions"
              className={fieldInputClass}
            />
          </div>

          <div>
            <FieldLabel>Model (optional)</FieldLabel>
            <select
              value={form.model}
              onChange={(e) => onChange({ ...editor, form: { ...form, model: e.target.value } })}
              className={fieldInputClass}
            >
              <option value="">Use the main model</option>
              {modelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onSave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full border border-danger-border px-3 py-1.5 text-xs text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Remove custom schedule
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AdvancedSection({
  defaultsEditor,
  onDefaultsChange,
  agents,
  agentEditors,
  onAgentChange,
  onAgentSave,
  onAgentClear,
  channelOptions,
  modelOptions,
  visibilityJson,
  onVisibilityChange,
  onVisibilitySave,
  onVisibilityFormat,
  busy,
}: {
  defaultsEditor: EditorState;
  onDefaultsChange: (next: EditorState) => void;
  agents: HeartbeatAgent[];
  agentEditors: Record<string, EditorState>;
  onAgentChange: (agentId: string, next: EditorState) => void;
  onAgentSave: (agentId: string) => void;
  onAgentClear: (agentId: string) => void;
  channelOptions: ChannelOption[];
  modelOptions: ModelOption[];
  visibilityJson: string;
  onVisibilityChange: (text: string) => void;
  onVisibilitySave: () => void;
  onVisibilityFormat: () => void;
  busy: boolean;
}) {
  return (
    <Panel className="p-5">
      <p className="text-sm font-semibold text-foreground">Advanced</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        Fine control most people never need to touch: message detail, per-agent schedules, and what
        each connected app is allowed to show.
      </p>

      <div className="mt-4 space-y-5">
        <Disclosure label="Message detail" openLabel="Message detail">
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            &ldquo;Default&rdquo; follows OpenClaw&rsquo;s built-in behavior. Only change these if you
            want a specific message to look different.
          </p>
          <MessageDetails editor={defaultsEditor} onChange={onDefaultsChange} />
        </Disclosure>

        {agents.length > 0 && (
          <Disclosure label={`Per-agent schedules (${agents.length})`} openLabel="Per-agent schedules">
            <div className="space-y-3">
              {agents.map((agent) => {
                const editor = agentEditors[agent.id];
                if (!editor) return null;
                return (
                  <AgentOverrideRow
                    key={agent.id}
                    agent={agent}
                    editor={editor}
                    onChange={(next) => onAgentChange(agent.id, next)}
                    onSave={() => onAgentSave(agent.id)}
                    onClear={() => onAgentClear(agent.id)}
                    channelOptions={channelOptions}
                    modelOptions={modelOptions}
                    busy={busy}
                  />
                );
              })}
            </div>
          </Disclosure>
        )}

        <Disclosure label="What each app can show" openLabel="What each app can show">
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Per-channel and per-account visibility. This is edited as JSON on purpose — it is a
            precise, rarely-touched override, not a everyday setting.
          </p>
          <textarea
            value={visibilityJson}
            onChange={(e) => onVisibilityChange(e.target.value)}
            spellCheck={false}
            className="h-44 w-full rounded-lg border border-border bg-surface-inset px-3 py-2 font-mono text-xs text-foreground outline-none"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              onClick={onVisibilityFormat}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-muted/60"
            >
              Format
            </button>
            <button
              type="button"
              onClick={onVisibilitySave}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/88 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              Save
            </button>
          </div>
        </Disclosure>

        <Disclosure label="Extra settings (JSON)" openLabel="Extra settings (JSON)">
          <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
            Any heartbeat setting not covered above. Most people never need this.
          </p>
          <textarea
            value={defaultsEditor.extrasJson}
            onChange={(e) => onDefaultsChange({ ...defaultsEditor, extrasJson: e.target.value })}
            spellCheck={false}
            placeholder='{"accountId": "ops-bot"}'
            className="h-28 w-full rounded-lg border border-border bg-surface-inset px-3 py-2 font-mono text-xs text-foreground outline-none"
          />
        </Disclosure>
      </div>
    </Panel>
  );
}
