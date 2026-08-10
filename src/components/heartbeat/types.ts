/**
 * Shared types for the Heartbeat page.
 *
 * Field names mirror OpenClaw's real config keys 1:1 (see
 * `agents.defaults.heartbeat` / `agents.list[].heartbeat` /
 * `channels.*.heartbeat` in the gateway config schema) so that what the form
 * writes is exactly what `config.get` reads back — there is no translation
 * layer that could drift from the real thing.
 */

export type JsonObject = Record<string, unknown>;
export type TriState = "" | "true" | "false";

export type HeartbeatAgent = {
  id: string;
  name: string;
  heartbeat: JsonObject | null;
};

export type VisibilityShape = {
  defaults: JsonObject | null;
  channels: Record<
    string,
    { heartbeat: JsonObject | null; accounts: Record<string, JsonObject | null> }
  >;
};

export type HeartbeatEvent = {
  ts: number;
  status: string;
  reason?: string;
  preview?: string;
} | null;

export type HeartbeatApiState = {
  ok: boolean;
  docsUrl: string;
  defaultsHeartbeat: JsonObject | null;
  effectiveDefaultsHeartbeat: JsonObject | null;
  agents: HeartbeatAgent[];
  visibility: VisibilityShape;
  reloadKind: "hot" | "restart" | "unknown";
  stats: {
    agentsTotal: number;
    agentsWithOverrides: number;
    channelsWithOverrides: number;
  };
  error?: string;
  warning?: string;
  degraded?: boolean;
};

export type HeartbeatForm = {
  every: string;
  model: string;
  prompt: string;
  target: string;
  to: string;
  askFirst: TriState;
  showSleepStatus: TriState;
  showNoMessageStatus: TriState;
  showMessage: TriState;
  showThinking: TriState;
  showModelName: TriState;
  showUsage: TriState;
  showDuration: TriState;
  showGoal: TriState;
  showNextRunTime: TriState;
  sleepMessage: string;
  awakeMessage: string;
  quietMessage: string;
  activeEnabled: boolean;
  activeStart: string;
  activeEnd: string;
  activeTimezone: string;
  activeDays: string[];
};

export type EditorState = {
  form: HeartbeatForm;
  extras: JsonObject;
  activeHoursExtras: JsonObject;
  extrasJson: string;
};

export type ModelOption = {
  value: string;
  label: string;
};

export type ChannelOption = {
  value: string;
  label: string;
};

export type Toast = { type: "success" | "error"; message: string };
