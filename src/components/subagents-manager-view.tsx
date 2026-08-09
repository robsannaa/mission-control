"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Play,
  Square,
  RefreshCw,
  Network,
  Settings2,
  Terminal,
  Send,
  Activity,
} from "lucide-react";
import { SectionBody } from "@/components/section-layout";
import { requestRestart } from "@/lib/restart-store";

type Agent = { id: string; name: string; emoji: string; subagents: string[] };

type SubagentsDefaults = {
  maxSpawnDepth: number;
  maxChildrenPerAgent: number;
  maxConcurrent: number;
  archiveAfterMinutes: number;
  runTimeoutSeconds: number;
  model: string;
  thinking: string;
};

type ThreadBindingsSettings = {
  enabled: boolean;
  idleHours: number;
  maxAgeHours: number;
  discordEnabled: boolean;
  discordIdleHours: number;
  discordMaxAgeHours: number;
  spawnSubagentSessions: boolean;
};

type SubagentsAction =
  | "list"
  | "spawn"
  | "kill"
  | "info"
  | "log"
  | "steer"
  | "send"
  | "raw"
  | "agent-send";

type ToolResult = {
  toolName: string | null;
  text: string;
  parsed: unknown;
};

type CommandResponse = {
  ok: boolean;
  error?: string;
  text?: string;
  command?: string;
  runId?: string;
  sessionKey?: string;
  assistantText?: string;
  spawnAccepted?: {
    status?: string;
    childSessionKey?: string;
    runId?: string;
    note?: string;
    modelApplied?: boolean;
    label?: string;
  } | null;
  toolResults?: ToolResult[];
};

type SubagentSnapshot = {
  status?: string;
  action?: string;
  total?: number;
  active?: Array<Record<string, unknown>>;
  recent?: Array<Record<string, unknown>>;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function readString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function readNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function quoteForDisplay(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
}

function shortJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function controlSessionKey(agentId: string): string {
  return `agent:${agentId}:subagents:mission-control`;
}

function getEntryId(entry: Record<string, unknown>, idx: number): string {
  const candidates = [entry.id, entry.runId, entry.sessionKey, entry.childSessionKey, entry.key, entry.label];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return `#${idx + 1}`;
}

export function SubagentsManagerView({
  agents,
  onAgentsReload,
}: {
  agents: Agent[];
  onAgentsReload: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [baseHash, setBaseHash] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [defaults, setDefaults] = useState<SubagentsDefaults>({
    maxSpawnDepth: 2,
    maxChildrenPerAgent: 2,
    maxConcurrent: 4,
    archiveAfterMinutes: 180,
    runTimeoutSeconds: 600,
    model: "",
    thinking: "minimal",
  });
  const [threadBindings, setThreadBindings] = useState<ThreadBindingsSettings>({
    enabled: false,
    idleHours: 24,
    maxAgeHours: 168,
    discordEnabled: false,
    discordIdleHours: 24,
    discordMaxAgeHours: 168,
    spawnSubagentSessions: false,
  });

  const [activeAgentId, setActiveAgentId] = useState<string>("main");
  const [sessionKey, setSessionKey] = useState<string>(controlSessionKey("main"));
  const [isolateSession, setIsolateSession] = useState(true);

  const [action, setAction] = useState<SubagentsAction>("list");
  const [target, setTarget] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agentParamsJson, setAgentParamsJson] = useState("{}");
  const [output, setOutput] = useState("");
  const [lastRun, setLastRun] = useState<CommandResponse | null>(null);

  const [spawnAgentId, setSpawnAgentId] = useState("gilfoyle");
  const [spawnModel, setSpawnModel] = useState("");
  const [spawnThinking, setSpawnThinking] = useState("minimal");
  const [spawnRunTimeoutSeconds, setSpawnRunTimeoutSeconds] = useState(600);
  const [spawnCleanup, setSpawnCleanup] = useState(false);
  const [spawnLabel, setSpawnLabel] = useState("");

  const [logLimit, setLogLimit] = useState(40);
  const [logIncludeTools, setLogIncludeTools] = useState(false);

  const [commandThinking, setCommandThinking] = useState("minimal");
  const [commandTimeoutSeconds, setCommandTimeoutSeconds] = useState(600);
  const [waitTimeoutMs, setWaitTimeoutMs] = useState(120000);

  const [editingAgentId, setEditingAgentId] = useState<string>("");
  const [allowedSet, setAllowedSet] = useState<Set<string>>(new Set());

  const agentMap = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const activeAgent = useMemo(() => agentMap.get(activeAgentId), [agentMap, activeAgentId]);
  const spawnableAgentIds = useMemo(() => {
    const allowed = Array.isArray(activeAgent?.subagents) ? activeAgent.subagents : [];
    const available = new Set(agents.map((a) => a.id));
    return allowed.filter((id) => available.has(id));
  }, [activeAgent, agents]);

  useEffect(() => {
    if (!editingAgentId && agents.length > 0) {
      setEditingAgentId(agents[0].id);
      setAllowedSet(new Set(agents[0].subagents || []));
    }
  }, [agents, editingAgentId]);

  useEffect(() => {
    if (!activeAgentId && agents.length > 0) setActiveAgentId(agents[0].id);
  }, [activeAgentId, agents]);

  useEffect(() => {
    if (isolateSession) setSessionKey(controlSessionKey(activeAgentId || "main"));
  }, [activeAgentId, isolateSession]);

  useEffect(() => {
    if (spawnableAgentIds.length === 0) {
      setSpawnAgentId("");
      return;
    }
    if (!spawnAgentId || !spawnableAgentIds.includes(spawnAgentId)) {
      setSpawnAgentId(spawnableAgentIds[0]);
    }
  }, [spawnAgentId, spawnableAgentIds]);

  const snapshot = useMemo(() => {
    const toolResults = lastRun?.toolResults || [];
    for (let i = toolResults.length - 1; i >= 0; i -= 1) {
      const parsed = asRecord(toolResults[i].parsed);
      if (Array.isArray(parsed.active) || Array.isArray(parsed.recent)) {
        return parsed as SubagentSnapshot;
      }
    }
    return null;
  }, [lastRun]);

  const activeEntries = Array.isArray(snapshot?.active) ? snapshot?.active : [];
  const recentEntries = Array.isArray(snapshot?.recent) ? snapshot?.recent : [];

  const commandPreview = useMemo(() => {
    if (action === "list") return "/subagents list";
    if (action === "kill") return `/subagents kill ${target || "<id|#|all>"}`;
    if (action === "info") return `/subagents info ${target || "<id|#>"}`;
    if (action === "log") {
      const lim = Number.isFinite(logLimit) && logLimit > 0 ? ` ${Math.trunc(logLimit)}` : "";
      const tools = logIncludeTools ? " tools" : "";
      return `/subagents log ${target || "<id|#>"}${lim}${tools}`;
    }
    if (action === "send") return `/subagents send ${target || "<id|#>"} ${quoteForDisplay(prompt || "<message>")}`;
    if (action === "steer") return `/subagents steer ${target || "<id|#>"} ${quoteForDisplay(prompt || "<message>")}`;
    if (action === "spawn") {
      let s = `/subagents spawn ${spawnAgentId || "<agentId>"} ${quoteForDisplay(prompt || "<task>")}`;
      if (spawnModel.trim()) s += ` --model ${quoteForDisplay(spawnModel.trim())}`;
      if (spawnThinking.trim()) s += ` --thinking ${spawnThinking.trim()}`;
      if (spawnRunTimeoutSeconds > 0) s += ` --run-timeout-seconds ${Math.trunc(spawnRunTimeoutSeconds)}`;
      if (spawnCleanup) s += " --cleanup";
      if (spawnLabel.trim()) s += ` --label ${quoteForDisplay(spawnLabel.trim())}`;
      return s;
    }
    if (action === "raw") return prompt || "/subagents <command>";
    return prompt || "<agent message>";
  }, [action, target, logLimit, logIncludeTools, prompt, spawnAgentId, spawnCleanup, spawnLabel, spawnModel, spawnRunTimeoutSeconds, spawnThinking]);

  const loadDefaults = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));

      const raw = asRecord(data?.config);
      const agentsCfg = asRecord(raw.agents);
      const defaultsCfg = asRecord(agentsCfg.defaults);
      const subagentsCfg = asRecord(defaultsCfg.subagents);
      const sessionCfg = asRecord(raw.session);
      const sessionThreadCfg = asRecord(sessionCfg.threadBindings);
      const channelsCfg = asRecord(raw.channels);
      const discordCfg = asRecord(channelsCfg.discord);
      const discordThreadCfg = asRecord(discordCfg.threadBindings);

      setDefaults({
        maxSpawnDepth: readNumber(subagentsCfg.maxSpawnDepth, 2),
        maxChildrenPerAgent: readNumber(subagentsCfg.maxChildrenPerAgent, 2),
        maxConcurrent: readNumber(subagentsCfg.maxConcurrent, 4),
        archiveAfterMinutes: readNumber(subagentsCfg.archiveAfterMinutes, 180),
        runTimeoutSeconds: readNumber(subagentsCfg.runTimeoutSeconds, 600),
        model: readString(subagentsCfg.model, ""),
        thinking: readString(subagentsCfg.thinking, "minimal"),
      });
      setThreadBindings({
        enabled: Boolean(sessionThreadCfg.enabled),
        idleHours: readNumber(sessionThreadCfg.idleHours, 24),
        maxAgeHours: readNumber(sessionThreadCfg.maxAgeHours, 168),
        discordEnabled: Boolean(discordThreadCfg.enabled),
        discordIdleHours: readNumber(discordThreadCfg.idleHours, 24),
        discordMaxAgeHours: readNumber(discordThreadCfg.maxAgeHours, 168),
        spawnSubagentSessions: Boolean(discordThreadCfg.spawnSubagentSessions),
      });
      setBaseHash(String(data?.meta?.baseHash || ""));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const executeCommand = useCallback(
    async (override?: Partial<Record<string, unknown>>) => {
      setRunning(true);
      setError(null);
      setNotice(null);
      try {
        const payload: Record<string, unknown> = {
          action,
          agentId: activeAgentId,
          sessionKey,
          thinking: commandThinking,
          timeoutSeconds: commandTimeoutSeconds,
          waitTimeoutMs,
        };

        if (action === "spawn") {
          const task = prompt.trim();
          if (!task) {
            throw new Error("Task is required to spawn a subagent.");
          }
          if (!spawnAgentId) {
            throw new Error(
              `Control agent "${activeAgentId}" has no allowed subagents. Update allowAgents first.`
            );
          }
          if (!spawnableAgentIds.includes(spawnAgentId)) {
            throw new Error(
              `Control agent "${activeAgentId}" cannot spawn "${spawnAgentId}". Update allowAgents first.`
            );
          }
          payload.spawnAgentId = spawnAgentId;
          payload.task = task;
          payload.model = spawnModel;
          payload.spawnThinking = spawnThinking;
          payload.runTimeoutSeconds = spawnRunTimeoutSeconds;
          payload.cleanup = spawnCleanup;
          payload.label = spawnLabel;
        } else if (action === "send" || action === "steer") {
          payload.target = target;
          payload.prompt = prompt;
        } else if (action === "log") {
          payload.target = target;
          payload.limit = logLimit;
          payload.includeTools = logIncludeTools;
        } else if (action === "kill" || action === "info") {
          payload.target = target;
        } else if (action === "raw") {
          payload.rawCommand = prompt;
        } else if (action === "agent-send") {
          let parsedParams: Record<string, unknown> = {};
          try {
            parsedParams = asRecord(JSON.parse(agentParamsJson || "{}"));
          } catch {
            throw new Error("Agent params JSON is invalid.");
          }
          payload.message = prompt;
          payload.agentParams = parsedParams;
        }

        Object.assign(payload, override || {});

        const res = await fetch("/api/subagents", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json()) as CommandResponse;
        if (!res.ok || !data.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));

        setLastRun(data);
        setOutput(String(data?.text || "No output"));
        setNotice(`Ran ${String(payload.action)} on ${activeAgentId}.`);

        if (payload.action === "spawn" || payload.action === "kill") {
          onAgentsReload();
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
      }
    },
    [
      action,
      activeAgentId,
      commandThinking,
      commandTimeoutSeconds,
      logIncludeTools,
      logLimit,
      onAgentsReload,
      prompt,
      agentParamsJson,
      sessionKey,
      spawnAgentId,
      spawnableAgentIds,
      spawnCleanup,
      spawnLabel,
      spawnModel,
      spawnRunTimeoutSeconds,
      spawnThinking,
      target,
      waitTimeoutMs,
    ]
  );

  const runList = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/subagents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list",
          agentId: activeAgentId,
          sessionKey,
          thinking: commandThinking,
          timeoutSeconds: commandTimeoutSeconds,
          waitTimeoutMs,
        }),
      });
      const data = (await res.json()) as CommandResponse;
      if (!res.ok || !data.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
      setLastRun(data);
      setOutput(String(data?.text || "No output"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [activeAgentId, commandThinking, commandTimeoutSeconds, sessionKey, waitTimeoutMs]);

  useEffect(() => {
    void loadDefaults();
    void runList();
  }, [loadDefaults, runList]);

  const saveDefaults = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseHash,
          patch: { agents: { defaults: { subagents: defaults } } },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
      setNotice("Subagent defaults saved.");
      requestRestart("Subagent defaults were updated.");
      await loadDefaults();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [baseHash, defaults, loadDefaults]);

  const saveThreadBindings = useCallback(async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseHash,
          patch: {
            session: {
              threadBindings: {
                enabled: threadBindings.enabled,
                idleHours: threadBindings.idleHours,
                maxAgeHours: threadBindings.maxAgeHours,
              },
            },
            channels: {
              discord: {
                threadBindings: {
                  enabled: threadBindings.discordEnabled,
                  idleHours: threadBindings.discordIdleHours,
                  maxAgeHours: threadBindings.discordMaxAgeHours,
                  spawnSubagentSessions: threadBindings.spawnSubagentSessions,
                },
              },
            },
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
      setNotice("Thread binding settings saved.");
      requestRestart("Thread binding settings were updated.");
      await loadDefaults();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [baseHash, loadDefaults, threadBindings]);

  const saveAgentAllowList = useCallback(async () => {
    if (!editingAgentId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: editingAgentId,
          subagents: Array.from(allowedSet),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(String(data?.error || `HTTP ${res.status}`));
      setNotice(`Updated allowAgents for ${editingAgentId}.`);
      requestRestart("Agent subagent allow-list was updated.");
      onAgentsReload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [allowedSet, editingAgentId, onAgentsReload]);

  return (
    <SectionBody width="content" padding="roomy" innerClassName="space-y-5">
      <div className="rounded-xl border border-border/70 bg-card p-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Network className="h-4 w-4" /> Subagents Mission Control
        </div>
        <p className="mt-2">
          Full control for subagent orchestration via gateway agent RPC: spawn, list, inspect, log,
          steer, send, kill, plus direct agent-send.
        </p>
        <a
          className="mt-2 inline-block text-xs text-fg-secondary hover:text-fg-secondary"
          href="https://docs.openclaw.ai/tools/subagents#sub-agents"
          target="_blank"
          rel="noreferrer"
        >
          Subagents docs
        </a>
        <span className="mx-2 text-xs text-fg-subtle">•</span>
        <a
          className="inline-block text-xs text-fg-secondary hover:text-fg-secondary"
          href="https://docs.openclaw.ai/tools/agent-send"
          target="_blank"
          rel="noreferrer"
        >
          Agent-send docs
        </a>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Settings2 className="h-4 w-4" /> Subagent Defaults
          </div>
          {([
            ["maxSpawnDepth", "Max spawn depth"],
            ["maxChildrenPerAgent", "Max children per agent"],
            ["maxConcurrent", "Max concurrent"],
            ["archiveAfterMinutes", "Archive after minutes"],
            ["runTimeoutSeconds", "Run timeout seconds"],
          ] as const).map(([key, label]) => (
            <label key={key} className="block">
              <span className="text-xs text-muted-foreground">{label}</span>
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={defaults[key]}
                onChange={(e) =>
                  setDefaults((prev) => ({ ...prev, [key]: Number(e.target.value || 1) }))
                }
              />
            </label>
          ))}
          <label className="block">
            <span className="text-xs text-muted-foreground">Default model (optional)</span>
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={defaults.model}
              onChange={(e) => setDefaults((prev) => ({ ...prev, model: e.target.value }))}
              placeholder="provider/model"
            />
          </label>
          <label className="block">
            <span className="text-xs text-muted-foreground">Default thinking</span>
            <select
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={defaults.thinking}
              onChange={(e) => setDefaults((prev) => ({ ...prev, thinking: e.target.value }))}
            >
              {[
                "off",
                "minimal",
                "low",
                "medium",
                "high",
              ].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void saveDefaults()}
              disabled={loading || saving || !baseHash}
              className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              Save Defaults
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
          <div className="flex items-center gap-2 font-medium text-foreground">
            <Bot className="h-4 w-4" /> Agent allowAgents
          </div>
          <select
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            value={editingAgentId}
            onChange={(e) => {
              const next = e.target.value;
              setEditingAgentId(next);
              setAllowedSet(new Set(agentMap.get(next)?.subagents || []));
            }}
          >
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.emoji} {a.name} ({a.id})
              </option>
            ))}
          </select>
          <div className="max-h-56 space-y-1 overflow-auto rounded-md border border-border p-2">
            {agents
              .filter((a) => a.id !== editingAgentId)
              .map((a) => (
                <label key={a.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={allowedSet.has(a.id)}
                    onChange={(e) => {
                      setAllowedSet((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(a.id);
                        else next.delete(a.id);
                        return next;
                      });
                    }}
                  />
                  <span>
                    {a.emoji} {a.name}{" "}
                    <span className="text-xs text-muted-foreground">({a.id})</span>
                  </span>
                </label>
              ))}
          </div>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void saveAgentAllowList()}
              disabled={saving || !editingAgentId}
              className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
            >
              Save allowAgents
            </button>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Network className="h-4 w-4" /> Thread Bindings (Discord)
        </div>
        <p className="text-xs text-muted-foreground">
          Controls thread-bound subagent/session routing for Discord as documented in OpenClaw.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={threadBindings.enabled}
              onChange={(e) =>
                setThreadBindings((prev) => ({ ...prev, enabled: e.target.checked }))
              }
            />
            Global thread bindings enabled
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={threadBindings.discordEnabled}
              onChange={(e) =>
                setThreadBindings((prev) => ({ ...prev, discordEnabled: e.target.checked }))
              }
            />
            Discord override enabled
          </label>
          <label>
            <span className="text-xs text-muted-foreground">Global idle hours</span>
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={threadBindings.idleHours}
              onChange={(e) =>
                setThreadBindings((prev) => ({
                  ...prev,
                  idleHours: Number(e.target.value || 24),
                }))
              }
            />
          </label>
          <label>
            <span className="text-xs text-muted-foreground">Global max age hours</span>
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={threadBindings.maxAgeHours}
              onChange={(e) =>
                setThreadBindings((prev) => ({
                  ...prev,
                  maxAgeHours: Number(e.target.value || 168),
                }))
              }
            />
          </label>
          <label>
            <span className="text-xs text-muted-foreground">Discord idle hours</span>
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={threadBindings.discordIdleHours}
              onChange={(e) =>
                setThreadBindings((prev) => ({
                  ...prev,
                  discordIdleHours: Number(e.target.value || 24),
                }))
              }
            />
          </label>
          <label>
            <span className="text-xs text-muted-foreground">Discord max age hours</span>
            <input
              type="number"
              min={1}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={threadBindings.discordMaxAgeHours}
              onChange={(e) =>
                setThreadBindings((prev) => ({
                  ...prev,
                  discordMaxAgeHours: Number(e.target.value || 168),
                }))
              }
            />
          </label>
          <label className="inline-flex items-center gap-2 text-sm md:col-span-2">
            <input
              type="checkbox"
              checked={threadBindings.spawnSubagentSessions}
              onChange={(e) =>
                setThreadBindings((prev) => ({
                  ...prev,
                  spawnSubagentSessions: e.target.checked,
                }))
              }
            />
            Auto-bind spawned subagent sessions to Discord threads
          </label>
        </div>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void saveThreadBindings()}
            disabled={loading || saving || !baseHash}
            className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            Save Thread Bindings
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Terminal className="h-4 w-4" /> Runtime Command Center
        </div>

        <div className="grid gap-2 md:grid-cols-4">
          <label className="md:col-span-1">
            <span className="text-xs text-muted-foreground">Control agent</span>
            <select
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={activeAgentId}
              onChange={(e) => setActiveAgentId(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </select>
          </label>

          <label className="md:col-span-1">
            <span className="text-xs text-muted-foreground">Action</span>
            <select
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={action}
              onChange={(e) => setAction(e.target.value as SubagentsAction)}
            >
              <option value="list">list</option>
              <option value="spawn">spawn</option>
              <option value="kill">kill</option>
              <option value="info">info</option>
              <option value="log">log</option>
              <option value="send">send</option>
              <option value="steer">steer</option>
              <option value="raw">raw command</option>
              <option value="agent-send">agent-send</option>
            </select>
          </label>

          <label className="md:col-span-2">
            <span className="text-xs text-muted-foreground">Session key</span>
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={sessionKey}
              onChange={(e) => {
                setSessionKey(e.target.value);
                setIsolateSession(false);
              }}
              placeholder="agent:main:subagents:mission-control"
            />
            <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={isolateSession}
                onChange={(e) => {
                  setIsolateSession(e.target.checked);
                  if (e.target.checked) setSessionKey(controlSessionKey(activeAgentId));
                }}
              />
              Isolated control session
            </label>
          </label>
        </div>

        {(action === "kill" || action === "info" || action === "log" || action === "send" || action === "steer") && (
          <label className="block">
            <span className="text-xs text-muted-foreground">Target subagent id / # / all</span>
            <input
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={action === "kill" ? "all" : "id or #"}
            />
          </label>
        )}

        {action === "spawn" && (
          <div className="grid gap-2 md:grid-cols-2">
            <label>
              <span className="text-xs text-muted-foreground">Spawn agentId</span>
              <select
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={spawnAgentId}
                onChange={(e) => setSpawnAgentId(e.target.value)}
                disabled={spawnableAgentIds.length === 0}
              >
                {spawnableAgentIds.length === 0 ? <option value="">(no allowed subagents)</option> : null}
                {spawnableAgentIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="text-xs text-muted-foreground">Label (optional)</span>
              <input
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={spawnLabel}
                onChange={(e) => setSpawnLabel(e.target.value)}
                placeholder="market-research-1"
              />
            </label>
            <label>
              <span className="text-xs text-muted-foreground">Model override (optional)</span>
              <input
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={spawnModel}
                onChange={(e) => setSpawnModel(e.target.value)}
                placeholder="provider/model"
              />
            </label>
            <label>
              <span className="text-xs text-muted-foreground">Thinking override</span>
              <select
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={spawnThinking}
                onChange={(e) => setSpawnThinking(e.target.value)}
              >
                {["off", "minimal", "low", "medium", "high"].map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="text-xs text-muted-foreground">Run timeout seconds</span>
              <input
                type="number"
                min={10}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={spawnRunTimeoutSeconds}
                onChange={(e) => setSpawnRunTimeoutSeconds(Number(e.target.value || 600))}
              />
            </label>
            <label className="inline-flex items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                checked={spawnCleanup}
                onChange={(e) => setSpawnCleanup(e.target.checked)}
              />
              Cleanup mode
            </label>
          </div>
        )}
        {action === "spawn" && spawnableAgentIds.length === 0 && (
          <div className="rounded-md border border-warning-border bg-warning-bg p-2 text-xs text-warning-fg">
            Control agent <code>{activeAgentId}</code> has no allowed subagents. Configure
            <span className="mx-1 font-medium">allowAgents</span>
            above before spawning.
          </div>
        )}

        {(action === "send" || action === "steer" || action === "spawn" || action === "raw" || action === "agent-send") && (
          <label className="block">
            <span className="text-xs text-muted-foreground">
              {action === "spawn"
                ? "Task"
                : action === "raw"
                  ? "Raw /subagents command"
                  : "Message"}
            </span>
            <textarea
              className="mt-1 min-h-24 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={
                action === "spawn"
                  ? "Investigate pricing differences and return a concise summary"
                  : action === "raw"
                    ? "/subagents list"
                    : action === "agent-send"
                      ? "Free-form agent message"
                      : "Your instruction"
              }
            />
          </label>
        )}

        {action === "agent-send" && (
          <label className="block">
            <span className="text-xs text-muted-foreground">Extra agent params (JSON)</span>
            <textarea
              className="mt-1 min-h-20 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
              value={agentParamsJson}
              onChange={(e) => setAgentParamsJson(e.target.value)}
              placeholder='{"thinking":"minimal","lane":"subagents","extraSystemPrompt":"..."}'
            />
          </label>
        )}

        {action === "log" && (
          <div className="grid gap-2 md:grid-cols-2">
            <label>
              <span className="text-xs text-muted-foreground">Log lines</span>
              <input
                type="number"
                min={1}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                value={logLimit}
                onChange={(e) => setLogLimit(Number(e.target.value || 40))}
              />
            </label>
            <label className="inline-flex items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                checked={logIncludeTools}
                onChange={(e) => setLogIncludeTools(e.target.checked)}
              />
              Include tools
            </label>
          </div>
        )}

        <div className="grid gap-2 md:grid-cols-3">
          <label>
            <span className="text-xs text-muted-foreground">Parent thinking</span>
            <select
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={commandThinking}
              onChange={(e) => setCommandThinking(e.target.value)}
            >
              {["off", "minimal", "low", "medium", "high"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="text-xs text-muted-foreground">Parent timeout seconds</span>
            <input
              type="number"
              min={10}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={commandTimeoutSeconds}
              onChange={(e) => setCommandTimeoutSeconds(Number(e.target.value || 600))}
            />
          </label>
          <label>
            <span className="text-xs text-muted-foreground">Wait timeout ms</span>
            <input
              type="number"
              min={5000}
              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              value={waitTimeoutMs}
              onChange={(e) => setWaitTimeoutMs(Number(e.target.value || 120000))}
            />
          </label>
        </div>

        <div className="rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">Command preview</div>
          <code className="mt-1 block whitespace-pre-wrap">{commandPreview}</code>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void executeCommand()}
            disabled={running}
            className="inline-flex items-center gap-1 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:bg-primary/90 disabled:opacity-50"
          >
            {running ? (
              <span className="inline-flex items-center gap-0.5">
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
              </span>
            ) : action === "kill" ? (
              <Square className="h-3.5 w-3.5" />
            ) : (
              <Play className="h-3.5 w-3.5" />
            )}
            {running ? "Running..." : "Run"}
          </button>
          <button
            type="button"
            onClick={() => void runList()}
            disabled={running}
            className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            <RefreshCw className="h-3.5 w-3.5" /> List / refresh
          </button>
          <button
            type="button"
            onClick={() =>
              void executeCommand({
                action: "kill",
                target: "all",
              })
            }
            disabled={running}
            className="inline-flex items-center gap-1 rounded-md border border-danger-border px-3 py-1.5 text-xs text-danger-fg hover:bg-danger-bg disabled:opacity-50"
          >
            <Square className="h-3.5 w-3.5" /> Kill all
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Activity className="h-4 w-4" /> Live Subagent Snapshot
        </div>
        <div className="text-xs text-muted-foreground">
          Active: <span className="text-foreground">{activeEntries.length}</span> • Recent:{" "}
          <span className="text-foreground">{recentEntries.length}</span>
        </div>

        {activeEntries.length === 0 && recentEntries.length === 0 ? (
          <div className="rounded-md border border-border bg-background p-3 text-xs text-muted-foreground">
            No subagent entries in last response.
          </div>
        ) : (
          <div className="grid gap-2">
            {activeEntries.map((entry, idx) => {
              const id = getEntryId(entry, idx);
              return (
                <div key={`a-${id}-${idx}`} className="rounded-md border border-border bg-background p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="font-medium text-foreground">{id}</div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-0.5 hover:bg-muted"
                        onClick={() => void executeCommand({ action: "info", target: id })}
                      >
                        info
                      </button>
                      <button
                        type="button"
                        className="rounded border border-border px-2 py-0.5 hover:bg-muted"
                        onClick={() => void executeCommand({ action: "log", target: id })}
                      >
                        log
                      </button>
                      <button
                        type="button"
                        className="rounded border border-danger-border px-2 py-0.5 text-danger-fg hover:bg-danger-bg"
                        onClick={() => void executeCommand({ action: "kill", target: id })}
                      >
                        kill
                      </button>
                    </div>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{shortJson(entry)}</pre>
                </div>
              );
            })}

            {recentEntries.map((entry, idx) => {
              const id = getEntryId(entry, idx);
              return (
                <div key={`r-${id}-${idx}`} className="rounded-md border border-border bg-background p-2 text-xs opacity-90">
                  <div className="font-medium text-foreground">recent: {id}</div>
                  <pre className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{shortJson(entry)}</pre>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-border/70 bg-card p-4 space-y-2">
        <div className="flex items-center gap-2 font-medium text-foreground">
          <Send className="h-4 w-4" /> Last command output
        </div>
        {lastRun?.spawnAccepted?.childSessionKey && (
          <div className="rounded-md border border-success-border bg-success-bg p-2 text-xs text-success-fg">
            <p className="font-medium text-success-fg">Spawn accepted</p>
            <p>
              childSessionKey: <code>{lastRun.spawnAccepted.childSessionKey}</code>
            </p>
            <p>
              runId: <code>{lastRun.spawnAccepted.runId || "—"}</code>
            </p>
          </div>
        )}
        <div className="grid gap-1 text-xs text-muted-foreground">
          <p>
            session: <code>{lastRun?.sessionKey || sessionKey}</code>
          </p>
          <p>
            runId: <code>{lastRun?.runId || "—"}</code>
          </p>
          <p>
            command: <code>{lastRun?.command || commandPreview}</code>
          </p>
        </div>
        <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background p-3 text-xs text-muted-foreground whitespace-pre-wrap">
          {output || "No output yet."}
        </pre>
      </div>

      {error && (
        <div className="rounded-md border border-danger-border bg-danger-bg p-3 text-xs text-danger-fg">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-success-border bg-success-bg p-3 text-xs text-success-fg">
          {notice}
        </div>
      )}
    </SectionBody>
  );
}
