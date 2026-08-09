"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { requestRestart } from "@/lib/restart-store";
import {
  CheckCircle, XCircle, Search, RefreshCw,
  AlertTriangle, X, Check, Download,
  Settings2, Package, Cpu,
  FileText, Terminal, Globe, Wrench, ArrowLeft,
  Info, CircleStop, Play, Copy, Star,
  ChevronRight, ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { LoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";

/* ── Types ──────────────────────────────────────── */

type Missing = { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
type InstallOption = { id: string; kind: string; label: string; bins?: string[] };

type Skill = {
  name: string; description: string; emoji: string; eligible: boolean;
  disabled: boolean; blockedByAllowlist: boolean; source: string;
  bundled: boolean; homepage?: string; missing: Missing;
  always?: boolean;
};

type ClawHubItem = {
  slug: string;
  displayName?: string;
  summary?: string;
  version?: string;
  /** Catalog latest version (for "installed" view); in "all" view, version is the catalog latest */
  latestVersion?: string;
  score?: number;
  developer?: string;
  downloads?: number;
  installsCurrent?: number;
  stars?: number;
  updatedAt?: number;
};

type SkillDetail = Skill & {
  filePath: string; baseDir: string; skillKey: string; always: boolean;
  requirements: Missing; install: InstallOption[];
  configChecks: unknown[]; skillMd?: string | null;
  skillConfig?: Record<string, unknown> | null;
};

type Summary = { total: number; eligible: number; disabled: number; blocked: number; missingRequirements: number };
type Toast = { msg: string; type: "success" | "error" };
type AvailabilityState = "ready" | "needs-setup" | "blocked" | "unavailable";
type SkillOrigin = "bundled" | "workspace" | "shared" | "other";
type SkillsFilter = "all" | "eligible" | "unavailable" | "bundled" | "workspace";
type AgentOption = { id: string; name: string };
type SkillTestResult = {
  ok: boolean;
  skillName: string;
  agentId: string;
  message: string;
  cliCommand: string;
  output: string;
  durationMs: number;
};

const SKILL_ORIGIN_META: Record<SkillOrigin, { title: string; description: string }> = {
  bundled: {
    title: "Bundled Skills",
    description: "Built into OpenClaw. Turn on to let your agents use them; some may need extra setup first.",
  },
  workspace: {
    title: "Workspace Skills",
    description: "Installed for this project (e.g. from ClawHub). Turn on to use.",
  },
  shared: {
    title: "Shared Local Skills",
    description: "Loaded from a shared folder on your computer. Turn on to use.",
  },
  other: {
    title: "Other Sources",
    description: "Custom or external skills. Turn on to use.",
  },
};

const SKILL_ORIGIN_ORDER: SkillOrigin[] = ["bundled", "workspace", "shared", "other"];

/* ── Helpers ────────────────────────────────────── */

function hasMissing(m: Missing): boolean {
  return m.bins.length > 0 || m.anyBins.length > 0 || m.env.length > 0 || m.config.length > 0 || m.os.length > 0;
}

function missingCount(m: Missing): number {
  return m.bins.length + m.anyBins.length + m.env.length + m.config.length + m.os.length;
}

function getAvailability(skill: Pick<Skill, "eligible" | "missing" | "blockedByAllowlist">): {
  state: AvailabilityState;
  label: string;
  labelShort: string;
  badgeClass: string;
} {
  if (skill.blockedByAllowlist) {
    return {
      state: "blocked",
      label: "Blocked",
      labelShort: "Blocked",
      badgeClass: "border-red-500/30 bg-red-500/10 text-red-300",
    };
  }
  if (skill.eligible) {
    return {
      state: "ready",
      label: "Ready",
      labelShort: "Ready",
      badgeClass: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    };
  }
  if (hasMissing(skill.missing)) {
    return {
      state: "needs-setup",
      label: "Needs setup",
      labelShort: "Setup",
      badgeClass: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    };
  }
  return {
    state: "unavailable",
    label: "Unavailable",
    labelShort: "Unavailable",
    badgeClass: "border-zinc-500/30 bg-zinc-500/10 text-muted-foreground",
  };
}

function getSkillOrigin(skill: Pick<Skill, "source" | "bundled">): SkillOrigin {
  const source = (skill.source || "").toLowerCase();
  if (skill.bundled || source.includes("bundled")) return "bundled";
  if (source.includes("workspace")) return "workspace";
  if (source.includes("managed") || source.includes("local") || source.includes(".openclaw/skills")) return "shared";
  return "other";
}

function sourceLabel(source: string, bundled?: boolean): string {
  const normalized = (source || "").toLowerCase();
  if (bundled || normalized.includes("bundled")) return "Bundled • Built-in";
  if (normalized.includes("workspace")) return "Workspace • Installed";
  if (normalized.includes("managed") || normalized.includes("local")) return "Shared • Local";
  return `Custom • ${source}`;
}

/** Short label for card badges to avoid wrapping */
function sourceLabelShort(source: string, bundled?: boolean): string {
  const normalized = (source || "").toLowerCase();
  if (bundled || normalized.includes("bundled")) return "Bundled";
  if (normalized.includes("workspace")) return "Workspace";
  if (normalized.includes("managed") || normalized.includes("local")) return "Shared";
  return "Custom";
}

function sourceColor(source: string): string {
  const normalized = (source || "").toLowerCase();
  if (normalized.includes("bundled")) return "bg-sky-500/10 text-sky-400 border-sky-500/20";
  if (normalized.includes("workspace")) return "bg-violet-500/10 text-violet-400 border-violet-500/20";
  if (normalized.includes("managed") || normalized.includes("local")) return "bg-cyan-500/10 text-cyan-400 border-cyan-500/20";
  return "bg-zinc-500/10 text-muted-foreground border-zinc-500/20";
}

function sourceHint(source: string): string {
  const normalized = (source || "").toLowerCase();
  if (normalized.includes("bundled")) {
    return "Bundled with OpenClaw. Enabling only allows usage; dependencies/config still decide runtime readiness.";
  }
  if (normalized.includes("workspace")) {
    return "Installed in your workspace (usually via ClawHub).";
  }
  if (normalized.includes("managed") || normalized.includes("local")) {
    return "Installed in a shared local skills directory.";
  }
  return "Custom source.";
}

function runtimeMessage(skill: Skill, availability: ReturnType<typeof getAvailability>, missingTotal: number): string {
  if (skill.disabled) return "Disabled in config. Agent will not attempt to use this skill.";
  if (availability.state === "ready") return "Enabled and ready to use now.";
  if (availability.state === "blocked") return "Enabled, but blocked by allowlist policy.";
  if (availability.state === "needs-setup") {
    return `Enabled, waiting for ${missingTotal} requirement${missingTotal === 1 ? "" : "s"} to pass.`;
  }
  return "Enabled, but runtime checks are not passing yet.";
}

/* ── Toast ──────────────────────────────────────── */

function ToastBar({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div className={cn("glass-strong fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium", toast.type === "success" ? "text-emerald-700 dark:text-emerald-300" : "text-red-600 dark:text-red-300")}>
      <div className="flex items-center gap-2">{toast.type === "success" ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}{toast.msg}</div>
    </div>
  );
}

/* ── Install Terminal ───────────────────────────── */

type TermLine = { text: string; stream: "stdout" | "stderr" | "system" };

function InstallTerminal({
  skillName,
  installId,
  label,
  onDone,
  onClose,
}: {
  skillName: string;
  installId: string;
  label: string;
  onDone: (ok: boolean) => void;
  onClose: () => void;
}) {
  const [lines, setLines] = useState<TermLine[]>([]);
  const [running, setRunning] = useState(true);
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const startTime = useRef(Date.now());

  // Elapsed timer
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setElapsed(Math.floor((Date.now() - startTime.current) / 1000)), 200);
    return () => clearInterval(iv);
  }, [running]);

  // Auto-scroll
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Stream install
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;

    setLines([{ text: `Installing ${label}...\n`, stream: "system" }]);
    setRunning(true);
    setExitCode(null);
    startTime.current = Date.now();

    (async () => {
      try {
        const res = await fetch("/api/skills/install", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: skillName, installId }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const err = await res.text();
          setLines((p) => [...p, { text: `Error: ${err}\n`, stream: "stderr" }]);
          setRunning(false);
          setExitCode(1);
          onDone(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";

          for (const part of parts) {
            const line = part.replace(/^data: /, "").trim();
            if (!line) continue;
            try {
              const ev = JSON.parse(line) as { type: string; text?: string; code?: number };
              if (ev.type === "stdout") {
                setLines((p) => [...p, { text: ev.text || "", stream: "stdout" }]);
              } else if (ev.type === "stderr") {
                setLines((p) => [...p, { text: ev.text || "", stream: "stderr" }]);
              } else if (ev.type === "exit") {
                const code = ev.code ?? 1;
                setExitCode(code);
                setRunning(false);
                const ok = code === 0;
                setLines((p) => [
                  ...p,
                  {
                    text: ok
                      ? `\n\u2705 Installed successfully (exit 0)\n`
                      : `\n\u274C Process exited with code ${code}\n`,
                    stream: "system",
                  },
                ]);
                onDone(ok);
              } else if (ev.type === "error") {
                setLines((p) => [...p, { text: `Error: ${ev.text}\n`, stream: "stderr" }]);
                setRunning(false);
                setExitCode(1);
                onDone(false);
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setLines((p) => [...p, { text: `Connection error: ${String(err)}\n`, stream: "stderr" }]);
          setRunning(false);
          setExitCode(1);
          onDone(false);
        }
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skillName, installId]);

  const handleAbort = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
    setLines((p) => [...p, { text: "\n\u26A0\uFE0F Installation cancelled by user\n", stream: "system" }]);
  }, []);

  const formatElapsed = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
  };

  return (
    <div className="glass flex flex-col overflow-hidden rounded-lg">
      {/* Terminal header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          {/* Traffic lights */}
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-3 rounded-full bg-red-500/80" />
            <div className="h-3 w-3 rounded-full bg-amber-500/80" />
            <div className="h-3 w-3 rounded-full bg-emerald-500/80" />
          </div>
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              skills install {skillName} ({installId})
            </span>
          </div>
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Running {formatElapsed(elapsed)}
            </span>
          )}
          {!running && exitCode !== null && (
            <span className={cn("text-xs font-medium", exitCode === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
              {exitCode === 0 ? "Done" : `Failed (${exitCode})`} — {formatElapsed(elapsed)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {running && (
            <button
              type="button"
              onClick={handleAbort}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-red-600 dark:text-red-400 transition hover:bg-red-500/10"
            >
              <CircleStop className="h-3 w-3" />
              Stop
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal body */}
      <div
        ref={scrollRef}
        className="max-h-80 min-h-48 overflow-y-auto bg-muted/30 p-4 font-mono text-xs leading-5 text-foreground/90"
      >
        {lines.map((line, i) => (
          <span
            key={i}
            className={cn(
              "whitespace-pre-wrap break-all",
              line.stream === "stderr"
                ? "text-red-600 dark:text-red-400"
                : line.stream === "system"
                  ? "text-foreground font-semibold"
                  : "text-muted-foreground"
            )}
          >
            {line.text}
          </span>
        ))}
        {running && (
          <span className="inline-block h-4 w-1.5 animate-pulse bg-foreground/50" />
        )}
      </div>
    </div>
  );
}

/* ── Skill Playground ───────────────────────────── */

function SkillPlayground({ skillName }: { skillName: string }) {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("main");
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SkillTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showCommandPreview, setShowCommandPreview] = useState(false);

  const commandMessage = useMemo(() => {
    const prompt = input.trim();
    return prompt ? `/skill ${skillName} ${prompt}` : `/skill ${skillName}`;
  }, [input, skillName]);

  const commandPreview = useMemo(() => {
    return `openclaw agent --agent ${agentId} --message ${JSON.stringify(commandMessage)}`;
  }, [agentId, commandMessage]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const res = await fetch("/api/agents", { cache: "no-store" });
        const data = await res.json();
        if (!mounted) return;
        const rows = Array.isArray(data?.agents) ? data.agents : [];
        const options: AgentOption[] = rows
          .map((row: { id?: string; name?: string }) => ({
            id: String(row?.id || "").trim(),
            name: String(row?.name || row?.id || "").trim(),
          }))
          .filter((row: AgentOption) => row.id.length > 0);
        if (options.length === 0) {
          setAgents([{ id: "main", name: "main" }]);
          setAgentId("main");
          return;
        }
        setAgents(options);
        if (!options.some((opt) => opt.id === "main")) {
          setAgentId(options[0].id);
        }
      } catch {
        if (!mounted) return;
        setAgents([{ id: "main", name: "main" }]);
        setAgentId("main");
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const runTest = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          skillName,
          agentId,
          input: input.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data?.ok) {
        const message = String(data?.error || "Skill test failed");
        setError(message);
        return;
      }
      setResult(data as SkillTestResult);
    } catch (err) {
      const message = String(err);
      setError(message);
    } finally {
      setRunning(false);
    }
  }, [agentId, input, skillName]);

  const copyCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(commandPreview);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }, [commandPreview]);

  return (
    <div className="glass-subtle rounded-lg p-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Terminal className="h-3.5 w-3.5" />
          Try this skill
        </h3>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        Send a test message below to see if this skill works. Pick an agent and optional input, then run the test.
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <label className="space-y-1 md:min-w-48 md:max-w-48">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Agent</span>
          <select
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            disabled={running}
            className="w-full rounded-lg border border-border bg-card px-2.5 py-2 text-xs text-foreground outline-none transition-colors focus:ring-2 focus:ring-ring disabled:opacity-50"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name} ({agent.id})
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 md:min-w-48 md:max-w-48">
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Input (optional)</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="example: list my currently playing songs"
            disabled={running}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground outline-none transition-colors focus:ring-2 focus:ring-ring disabled:opacity-50"
          />
        </label>
      </div>

      {showCommandPreview ? (
        <div className="rounded-lg border border-border bg-muted/30 p-2.5 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Run in terminal</p>
            <button type="button" onClick={() => setShowCommandPreview(false)} className="text-xs text-muted-foreground hover:text-foreground">Hide</button>
          </div>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded bg-background/50 px-2 py-1 font-mono text-xs text-foreground">
              {commandPreview}
            </code>
            <button
              type="button"
              onClick={() => void copyCommand()}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted"
            >
              <Copy className="h-3 w-3" />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setShowCommandPreview(true)} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
          <Terminal className="h-3.5 w-3.5" />
          Show command for terminal
        </button>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void runTest()}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-60"
        >
          {running ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
            </span>
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {running ? "Running..." : "Run test"}
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-700 dark:text-red-200">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-300">
              completed
            </span>
            <span>agent: {result.agentId}</span>
            <span>duration: {(result.durationMs / 1000).toFixed(1)}s</span>
          </div>
          <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {result.output || "(no output)"}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── Skill Card (list view) ─────────────────────── */

function skillStatus(skill: Skill): { label: string; color: string; toggleColor: "green" | "amber" | "default" } {
  if (skill.disabled) return { label: "Off", color: "text-muted-foreground/60", toggleColor: "default" };
  return { label: "On", color: "text-emerald-400", toggleColor: "green" };
}

function SkillCard({ skill, onClick, onToggle, toggling }: { skill: Skill; onClick: () => void; onToggle: (enabled: boolean) => void; toggling?: boolean }) {
  const missing = hasMissing(skill.missing);
  const missingTotal = missingCount(skill.missing);
  const availability = getAvailability(skill);
  const status = skillStatus(skill);
  return (
    <div
      className={cn("glass w-full rounded-lg p-3.5 text-left transition-colors", skill.disabled && "opacity-60 hover:opacity-90")}
    >
      <div className="flex items-start gap-3">
        <span className="text-sm leading-none mt-0.5">{skill.emoji || "\u26A1"}</span>
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 flex-1 text-left cursor-pointer group"
        >
          <div className="flex items-center gap-2">
            <p className={cn("text-xs font-semibold group-hover:text-foreground", skill.disabled ? "text-foreground/50 line-through" : "text-foreground/90")}>{skill.name}</p>
            {skill.disabled ? (
              <span className="rounded bg-red-500/15 px-1.5 py-0.5 text-xs font-medium text-red-400/80">DISABLED</span>
            ) : availability.state === "ready" ? (
              <CheckCircle className="h-3 w-3 shrink-0 text-emerald-500" />
            ) : availability.state === "blocked" ? (
              <XCircle className="h-3 w-3 shrink-0 text-red-400/80" />
            ) : (
              <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400/70" />
            )}
            {skill.always && <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-400">ALWAYS</span>}
          </div>
          <p className="mt-0.5 text-xs leading-snug text-muted-foreground break-words">{skill.description}</p>
          <div className="mt-2 flex flex-nowrap items-center gap-1.5 overflow-hidden">
            <span className={cn("shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide whitespace-nowrap", sourceColor(skill.source))} title={sourceLabel(skill.source, skill.bundled)}>{sourceLabelShort(skill.source, skill.bundled)}</span>
            <span className={cn("shrink-0 rounded border px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide whitespace-nowrap", availability.badgeClass)} title={availability.label}>{availability.labelShort ?? availability.label}</span>
            {!skill.disabled && missing && <span className="shrink-0 text-[10px] text-muted-foreground whitespace-nowrap">{missingTotal} missing</span>}
          </div>
          <span className="mt-1.5 inline-flex items-center gap-0.5 text-[10px] font-medium text-muted-foreground group-hover:text-foreground">
            View details <ChevronRight className="h-3 w-3" />
          </span>
        </button>
        <div className="flex flex-col items-center gap-1 mt-0.5 shrink-0" onClick={(e) => e.stopPropagation()} role="group" aria-label="Use this skill">
          {toggling ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
            </span>
          ) : (
            <Switch
              checked={!skill.disabled}
              onCheckedChange={(checked) => onToggle(checked)}
              size="sm"
              disabled={toggling}
            />
          )}
          <span className={cn("text-xs font-medium", status.color)} title="Turn this skill on or off for your agents">
            {status.label}
          </span>
          <span className="text-xs text-muted-foreground/60">Use</span>
        </div>
      </div>
    </div>
  );
}

/* ── Skill Detail Panel ─────────────────────────── */

function SkillDetailPanel({ name, onBack, onAction }: { name: string; onBack: () => void; onAction: (msg: string) => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showMd, setShowMd] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [installTerminal, setInstallTerminal] = useState<{ installId: string; label: string } | null>(null);
  const installSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    fetch("/api/skills?action=info&name=" + encodeURIComponent(name))
      .then((r) => r.json())
      .then((d) => { setDetail(d); setLoading(false); })
      .catch(() => setLoading(false));
  }, [name]);

  const doAction = useCallback(async (action: string, params: Record<string, unknown>) => {
    setBusy(action);
    try {
      const res = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...params }) });
      const d = await res.json();
      if (d.ok) { onAction(action + " succeeded"); } else { onAction("Error: " + (d.error || "failed")); }
    } catch (err) { onAction("Error: " + String(err)); }
    finally { setBusy(null); }
    // Refresh detail
    try {
      const res = await fetch("/api/skills?action=info&name=" + encodeURIComponent(name));
      const d = await res.json();
      setDetail(d);
    } catch { /* ignore */ }
  }, [name, onAction]);

  if (loading) {
    return (
      <SectionLayout>
        <LoadingState label="Loading skill..." />
      </SectionLayout>
    );
  }
  if (!detail) return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/60">Skill not found</div>;

  const missing = hasMissing(detail.missing);
  const missingTotal = missingCount(detail.missing);
  const availability = getAvailability(detail);
  const hasReqs = hasMissing(detail.requirements);
  const runtime = runtimeMessage(detail, availability, missingTotal);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Back + header */}
      <div className="shrink-0 border-b border-border px-4 md:px-6 py-4">
        <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground mb-3"><ArrowLeft className="h-3.5 w-3.5" />Back to Skills</button>
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-xl">{detail.emoji || "\u26A1"}</div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3">
              <h1 className="text-sm font-semibold text-foreground">{detail.name}</h1>
              {availability.state === "ready" ? <span className="flex items-center gap-1 rounded-full bg-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-300"><CheckCircle className="h-3 w-3" />Ready</span> : availability.state === "blocked" ? <span className="flex items-center gap-1 rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-semibold text-red-300"><XCircle className="h-3 w-3" />Blocked</span> : availability.state === "needs-setup" ? <span className="flex items-center gap-1 rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-300"><AlertTriangle className="h-3 w-3" />Needs setup</span> : <span className="flex items-center gap-1 rounded-full bg-zinc-500/20 px-2.5 py-0.5 text-xs font-semibold text-muted-foreground"><XCircle className="h-3 w-3" />Unavailable</span>}
              {detail.disabled && <span className="rounded-full bg-red-500/20 px-2.5 py-0.5 text-xs font-semibold text-red-400">Disabled</span>}
              {detail.always && <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-xs font-semibold text-amber-300">Always active</span>}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
            <div className="mt-2 flex items-center gap-3 text-xs">
              <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", sourceColor(detail.source))}>{sourceLabel(detail.source, detail.bundled)}</span>
              {detail.homepage && <a href={detail.homepage} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"><Globe className="h-3 w-3" />Homepage</a>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground/70">{sourceHint(detail.source)}</p>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 py-5 space-y-5">
        {/* Hero row: Use + Status (and optional CTA) */}
        <div className="flex flex-wrap items-stretch gap-3">
          <div className="glass-subtle flex items-center gap-3 rounded-lg px-4 py-3 min-w-0">
            <div className="flex items-center gap-2">
              {(busy === "enable-skill" || busy === "disable-skill") ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
                </span>
              ) : (
                <Switch
                  checked={!detail.disabled}
                  onCheckedChange={(enabled) => doAction(enabled ? "enable-skill" : "disable-skill", { name: detail.name })}
                  disabled={busy !== null}
                />
              )}
              <div>
                <p className={cn("text-xs font-medium", detail.disabled ? "text-muted-foreground" : "text-emerald-400")}>
                  {detail.disabled ? "Off" : "On"}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  {detail.disabled ? "Agents cannot use this." : "Agents can use this when needed."}
                </p>
              </div>
            </div>
          </div>
          <div className="glass-subtle rounded-lg px-4 py-3 min-w-0 flex-1" title="Whether this skill is ready to use right now">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</p>
            <p className={cn("mt-0.5 text-xs font-medium", availability.state === "ready" ? "text-emerald-400" : availability.state === "blocked" ? "text-red-400" : availability.state === "needs-setup" ? "text-amber-400" : "text-muted-foreground")}>{availability.label}</p>
            <p className="mt-1 text-xs text-muted-foreground/70">{runtime}</p>
          </div>
          {missing && detail.install.length > 0 && (
            <button
              type="button"
              onClick={() => installSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="shrink-0 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/15 px-4 py-3 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 transition-colors"
            >
              <Download className="h-4 w-4" />
              Install what’s missing
            </button>
          )}
        </div>

        <SkillPlayground skillName={detail.name} />


        {/* Requirements section */}
        {hasReqs && (
          <div className="glass-subtle rounded-lg p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground"><Package className="h-3.5 w-3.5" />Requirements</h3>
            <p className="text-xs text-muted-foreground">This skill needs the following to work. Green check = already available; red = still needed.</p>
            <div className="space-y-2">
              {detail.requirements.bins.length > 0 && (
                <div className="flex items-start gap-3">
                  <Terminal className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Tools required</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">{detail.requirements.bins.map((b) => {
                      const isMissing = detail.missing.bins.includes(b);
                      return (<span key={b} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-mono", isMissing ? "border-red-500/20 bg-red-500/10 text-red-400" : "border-emerald-500/20 bg-emerald-500/10 text-emerald-400")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{b}</span>);
                    })}</div>
                  </div>
                </div>
              )}
              {detail.requirements.env.length > 0 && (
                <div className="flex items-start gap-3">
                  <Settings2 className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Environment variables (e.g. API keys)</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">{detail.requirements.env.map((e) => {
                      const isMissing = detail.missing.env.includes(e);
                      return (<span key={e} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-mono", isMissing ? "border-red-500/20 bg-red-500/10 text-red-400" : "border-emerald-500/20 bg-emerald-500/10 text-emerald-400")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{e}</span>);
                    })}</div>
                  </div>
                </div>
              )}
              {detail.requirements.config.length > 0 && (
                <div className="flex items-start gap-3">
                  <Wrench className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Settings this skill needs</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">{detail.requirements.config.map((c) => {
                      const isMissing = detail.missing.config.includes(c);
                      return (<span key={c} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs", isMissing ? "border-red-500/20 bg-red-500/10 text-red-400" : "border-emerald-500/20 bg-emerald-500/10 text-emerald-400")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{c}</span>);
                    })}</div>
                  </div>
                </div>
              )}
              {detail.requirements.os.length > 0 && (
                <div className="flex items-start gap-3">
                  <Cpu className="h-4 w-4 shrink-0 text-muted-foreground mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-muted-foreground">Operating system</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">{detail.requirements.os.map((o) => {
                      const isMissing = detail.missing.os.includes(o);
                      return (<span key={o} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs", isMissing ? "border-red-500/20 bg-red-500/10 text-red-400" : "border-emerald-500/20 bg-emerald-500/10 text-emerald-400")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{o}</span>);
                    })}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Install options */}
        {missing && detail.install.length > 0 && (
          <div ref={installSectionRef} className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300"><Download className="h-3.5 w-3.5" />Install what’s missing</h3>
            <p className="text-xs text-amber-800/90 dark:text-amber-200/90">This skill needs the following to work. Click Install to add them (when available).</p>
            <div className="space-y-2">{detail.install.map((inst) => (
                <div key={inst.id} className="glass-subtle flex items-center justify-between rounded-lg px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-foreground/90">{inst.label}</p>
                    <p className="text-xs text-muted-foreground">{inst.kind}{inst.bins ? " \u2022 installs " + inst.bins.join(", ") : ""}</p>
                  </div>
                  <button
                    onClick={() => setInstallTerminal({ installId: inst.id, label: inst.label })}
                    disabled={installTerminal !== null}
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    <Terminal className="h-3 w-3" />Install
                  </button>
                </div>
              ))}</div>
          </div>
        )}

        {/* Install terminal */}
        {installTerminal && (
          <InstallTerminal
            skillName={name}
            installId={installTerminal.installId}
            label={installTerminal.label}
            onDone={(ok) => {
              if (ok) {
                onAction(`${installTerminal.label} completed`);
                // Refresh skill detail
                fetch("/api/skills?action=info&name=" + encodeURIComponent(name))
                  .then((r) => r.json())
                  .then((d) => setDetail(d))
                  .catch(() => {});
              }
            }}
            onClose={() => setInstallTerminal(null)}
          />
        )}

        {/* All good */}
        {!missing && detail.eligible && (
          <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-emerald-700 dark:text-emerald-300"><CheckCircle className="h-4 w-4" />All requirements met — this skill is active and available to your agents.</p>
          </div>
        )}

        {/* Technical details: collapsible (Details + Config + SKILL.md) */}
        <div className="glass-subtle rounded-lg overflow-hidden">
          <button
            type="button"
            onClick={() => setShowTechnicalDetails((v) => !v)}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:bg-muted/30 transition-colors"
          >
            <span className="flex items-center gap-2">
              <Info className="h-3.5 w-3.5" />
              Technical details
            </span>
            <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform", showTechnicalDetails && "rotate-180")} />
          </button>
          {showTechnicalDetails && (
            <div className="border-t border-border space-y-4 p-4">
              {/* File info */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Where this skill lives</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Skill key</p><p className="text-xs font-mono text-foreground mt-0.5">{detail.skillKey || detail.name}</p></div>
                  <div className="rounded-lg border border-border bg-muted/30 px-3 py-2"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Source</p><p className="text-xs text-foreground mt-0.5">{detail.source}</p></div>
                  <div className="col-span-2 rounded-lg border border-border bg-muted/30 px-3 py-2"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">File path</p><p className="text-xs font-mono text-muted-foreground mt-0.5 break-all">{detail.filePath}</p></div>
                  <div className="col-span-2 rounded-lg border border-border bg-muted/30 px-3 py-2"><p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Folder</p><p className="text-xs font-mono text-muted-foreground mt-0.5 break-all">{detail.baseDir}</p></div>
                </div>
              </div>
              {/* Skill config */}
              {detail.skillConfig && Object.keys(detail.skillConfig).length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Configuration</p>
                  <pre className="rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs text-muted-foreground overflow-auto max-h-72">{JSON.stringify(detail.skillConfig, null, 2)}</pre>
                </div>
              )}
              {/* SKILL.md */}
              {detail.skillMd && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><FileText className="h-3.5 w-3.5" />SKILL.md</span>
                    <button type="button" onClick={() => setShowMd((m) => !m)} className="text-xs font-medium text-foreground hover:underline">
                      {showMd ? "Hide" : "Show"}
                    </button>
                  </div>
                  {showMd && (
                    <pre className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">{detail.skillMd}</pre>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ClawHubPanel({
  onAction,
  onInstalled,
}: {
  onAction: (msg: string) => void;
  onInstalled: (slug: string) => Promise<void>;
}) {
  const CLAWHUB_INSTALL_CMD = "npm i -g clawhub";
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ClawHubItem[]>([]);
  const [installed, setInstalled] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<"trending" | "search">("trending");
  const [viewFilter, setViewFilter] = useState<"all" | "installed">("all");
  const [sortBy, setSortBy] = useState<"trending" | "stars" | "downloads" | "name">("trending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clawhubNotFound, setClawhubNotFound] = useState(false);
  const [copiedInstallCmd, setCopiedInstallCmd] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<"install" | "update" | "uninstall" | null>(null);

  const handleCopyInstallCommand = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(CLAWHUB_INSTALL_CMD);
      setCopiedInstallCmd(true);
      onAction("Copied install command.");
      window.setTimeout(() => setCopiedInstallCmd(false), 1500);
    } catch {
      onAction("Could not copy command. Please copy it manually.");
    }
  }, [onAction]);

  const displayedItems: ClawHubItem[] = viewFilter === "installed"
    ? Object.entries(installed).map(([slug, version]) => {
        const fromCatalog = items.find((i) => i.slug === slug);
        return {
          slug,
          version,
          latestVersion: fromCatalog?.version,
          summary: fromCatalog?.summary ?? "",
          displayName: fromCatalog?.displayName,
          developer: fromCatalog?.developer,
          stars: fromCatalog?.stars,
          downloads: fromCatalog?.downloads,
        };
      })
    : items;

  const sortedItems = useMemo(() => {
    if (sortBy === "trending") return [...displayedItems];
    return [...displayedItems].sort((a, b) => {
      if (sortBy === "stars") return (b.stars ?? 0) - (a.stars ?? 0);
      if (sortBy === "downloads") return (b.downloads ?? 0) - (a.downloads ?? 0);
      if (sortBy === "name") return (a.displayName || a.slug).localeCompare(b.displayName || b.slug, undefined, { sensitivity: "base" });
      return 0;
    });
  }, [displayedItems, sortBy]);

  const fetchInstalled = useCallback(async () => {
    try {
      const res = await fetch("/api/skills/clawhub?action=list");
      const data = await res.json();
      if (data?.code === "CLAWHUB_NOT_FOUND") {
        setClawhubNotFound(true);
        setCopiedInstallCmd(false);
        setError(null);
        setInstalled({});
        return;
      }
      if (!res.ok || data?.error) {
        setClawhubNotFound(false);
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      const map: Record<string, string> = {};
      for (const row of data.items || []) {
        const slug = String((row as { slug?: string }).slug || "");
        const version = String((row as { version?: string }).version || "");
        if (slug) map[slug] = version;
      }
      setInstalled(map);
      setError(null);
      setClawhubNotFound(false);
    } catch (err) {
      setInstalled({});
      setError(String(err));
    }
  }, []);

  const fetchExplore = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/skills/clawhub?action=explore&limit=28&sort=trending");
      const data = await res.json();
      if (data?.code === "CLAWHUB_NOT_FOUND") {
        setClawhubNotFound(true);
        setCopiedInstallCmd(false);
        setError(null);
        setItems([]);
        setLoading(false);
        return;
      }
      if (!res.ok || data?.error) {
        setClawhubNotFound(false);
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      const normalized: ClawHubItem[] = (data.items || []).map((item: {
        slug?: string;
        displayName?: string;
        summary?: string;
        latestVersion?: { version?: string };
        stats?: { downloads?: number; installsCurrent?: number; stars?: number };
        updatedAt?: number;
        developer?: string;
        author?: string;
      }) => ({
        slug: String(item.slug || ""),
        displayName: item.displayName || undefined,
        summary: item.summary || "",
        version: item.latestVersion?.version || "latest",
        developer: (item.developer ?? item.author) || undefined,
        downloads: item.stats?.downloads || 0,
        installsCurrent: item.stats?.installsCurrent || 0,
        stars: item.stats?.stars || 0,
        updatedAt: item.updatedAt,
      })).filter((item: ClawHubItem) => item.slug);
      setItems(normalized);
      setError(null);
      setClawhubNotFound(false);
    } catch (err) {
      setItems([]);
      setError(String(err));
    }
    setLoading(false);
  }, []);

  const runSearch = useCallback(async (searchQuery?: string) => {
    const q = (searchQuery ?? query).trim();
    if (!q) return;
    setLoading(true);
    setMode("search");
    try {
      const res = await fetch(`/api/skills/clawhub?action=search&q=${encodeURIComponent(q)}&limit=28`);
      const data = await res.json();
      if (data?.code === "CLAWHUB_NOT_FOUND") {
        setClawhubNotFound(true);
        setCopiedInstallCmd(false);
        setError(null);
        setItems([]);
        setLoading(false);
        return;
      }
      if (!res.ok || data?.error) {
        setClawhubNotFound(false);
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      const normalized: ClawHubItem[] = (data.items || []).map((item: {
        slug?: string;
        version?: string;
        summary?: string;
        score?: number;
        developer?: string;
        author?: string;
        displayName?: string;
      }) => ({
        slug: String(item.slug || ""),
        displayName: item.displayName || undefined,
        version: item.version || "latest",
        summary: item.summary || "",
        score: typeof item.score === "number" ? item.score : undefined,
        developer: (item.developer ?? item.author) || undefined,
      })).filter((item: ClawHubItem) => item.slug);
      setItems(normalized);
      setError(null);
      setClawhubNotFound(false);
    } catch (err) {
      setItems([]);
      setError(String(err));
    }
    setLoading(false);
  }, [query]);

  const installSkill = useCallback(async (slug: string, version?: string, force = false) => {
    setBusySlug(slug);
    setBusyAction("install");
    try {
      const res = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", slug, version, force }),
      });
      const data = await res.json();
      if (data?.code === "CLAWHUB_NOT_FOUND") {
        setClawhubNotFound(true);
        onAction("ClawHub is missing for this Mission Control service. Install it, restart the service, then retry.");
        setBusySlug(null);
        setBusyAction(null);
        return;
      }
      if (!res.ok || !data.ok) {
        const errMsg = String(data?.error || "install failed");
        const isSuspicious = /suspicious|Use --force/i.test(errMsg);
        if (isSuspicious && !force && window.confirm("This skill is flagged as suspicious by VirusTotal (e.g. risky patterns). Install anyway? Review the skill code after installing.")) {
          setBusySlug(null);
          setBusyAction(null);
          return void installSkill(slug, version, true);
        }
        onAction(`Error: ${errMsg}`);
      } else {
        onAction(`Installed ${slug}`);
        await fetchInstalled();
        await onInstalled(slug);
      }
    } catch (err) {
      onAction(`Error: ${String(err)}`);
    }
    setBusySlug(null);
    setBusyAction(null);
  }, [fetchInstalled, onAction, onInstalled]);

  const updateSkill = useCallback(async (slug: string) => {
    setBusySlug(slug);
    setBusyAction("update");
    try {
      const res = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update", slug }),
      });
      const data = await res.json();
      if (data?.code === "CLAWHUB_NOT_FOUND") {
        setClawhubNotFound(true);
        onAction("ClawHub is missing for this Mission Control service. Install it, restart the service, then retry.");
      } else if (!res.ok || !data.ok) {
        onAction(`Error: ${data.error || "update failed"}`);
      } else {
        onAction(`Updated ${slug}`);
        await fetchInstalled();
        await onInstalled(slug);
      }
    } catch (err) {
      onAction(`Error: ${String(err)}`);
    }
    setBusySlug(null);
    setBusyAction(null);
  }, [fetchInstalled, onAction, onInstalled]);

  const uninstallSkill = useCallback(async (slug: string) => {
    if (!window.confirm(`Delete "${slug}" from workspace skills?`)) {
      return;
    }
    setBusySlug(slug);
    setBusyAction("uninstall");
    try {
      const res = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "uninstall", slug }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        onAction(`Error: ${data.error || "delete failed"}`);
      } else {
        onAction(`Deleted ${slug}`);
        await fetchInstalled();
        await onInstalled(slug);
      }
    } catch (err) {
      onAction(`Error: ${String(err)}`);
    }
    setBusySlug(null);
    setBusyAction(null);
  }, [fetchInstalled, onAction, onInstalled]);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInstalled();
      void fetchExplore();
    });
  }, [fetchExplore, fetchInstalled]);

  // Search as you type (debounced); clear input -> show trending again
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setMode("trending");
      void fetchExplore();
      return;
    }
    setMode("search");
    const t = setTimeout(() => {
      void runSearch(trimmed);
    }, 350);
    return () => clearTimeout(t);
  }, [query, runSearch, fetchExplore]);

  return (
    <div className="space-y-3">
      {clawhubNotFound && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
          <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
              <p className="font-medium">ClawHub is not available for this service</p>
            <p className="text-xs mt-0.5 text-amber-700 dark:text-amber-300">
                Catalog actions are disabled until the <code className="font-mono bg-amber-500/20 px-1 rounded">clawhub</code> binary is installed for the same OS user that runs Mission Control.
            </p>
          </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 font-mono text-xs text-amber-700 dark:text-amber-200">
              {CLAWHUB_INSTALL_CMD}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyInstallCommand()}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
            >
              <Copy className="h-3 w-3" />
              {copiedInstallCmd ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              onClick={() => {
                void fetchInstalled();
                void fetchExplore();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-200"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
          <p className="mt-2 text-xs text-amber-700/90 dark:text-amber-300">
            After installing, restart Mission Control and click Retry.
          </p>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Browse and install skills from the catalog. Install adds them to your project; then turn them on from Local Skills.</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 min-w-44">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            placeholder="Search skills..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground text-foreground"
          />
        </div>
        <button type="button" onClick={() => { setMode("trending"); void fetchExplore(); }} className={cn("rounded-lg border border-border bg-muted px-2.5 py-1.5 text-xs font-medium transition-colors", mode === "trending" && !query ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/80")}>
          Trending
        </button>
        <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
          <button type="button" onClick={() => setViewFilter("all")} className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors", viewFilter === "all" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            All
          </button>
          <button type="button" onClick={() => setViewFilter("installed")} className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors", viewFilter === "installed" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
            Installed ({Object.keys(installed).length})
          </button>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground shrink-0">Sort:</span>
          <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
            {(["trending", "stars", "downloads", "name"] as const).map((s) => (
              <button key={s} type="button" onClick={() => setSortBy(s)} className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors", sortBy === s ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                {s === "trending" ? "Trending" : s === "stars" ? "Stars" : s === "downloads" ? "Downloads" : "Name"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-200">
          {error}
        </div>
      )}

      <div>
        {loading && viewFilter === "all" ? (
          <div className="flex items-center justify-center py-12">
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
              <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
            </span>
          </div>
        ) : sortedItems.length === 0 ? (
          <div className="glass-subtle rounded-lg px-4 py-6 text-center text-xs text-muted-foreground">
            {viewFilter === "installed" ? "No skills installed from ClawHub yet. Try Trending or search, then click Install on one you like." : "No skills found. Try a different search."}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
            {sortedItems.map((item) => {
              const installedVersion = installed[item.slug];
              const isInstalled = Boolean(installedVersion);
              const catalogVersion = item.latestVersion ?? item.version;
              const hasUpdate = isInstalled && catalogVersion && catalogVersion !== installedVersion;
              const isBusy = busySlug === item.slug;
              const installLabel = isBusy && busyAction === "install" ? "Installing..." : isBusy && busyAction === "update" ? "Updating..." : isBusy && busyAction === "uninstall" ? "Deleting..." : isInstalled ? "Reinstall" : "Install";
              return (
                <div
                  key={item.slug}
                  className="glass w-full rounded-lg p-3.5 text-left transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-foreground">{item.displayName || item.slug}</p>
                      {item.developer && (
                        <p className="mt-0.5 text-xs text-muted-foreground truncate" title={item.developer}>
                          by {item.developer}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs leading-snug text-muted-foreground break-words">
                        {item.summary || item.slug}
                      </p>
                    </div>
                    <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none", isInstalled ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" : "border-border text-muted-foreground")}>
                      {isInstalled ? installedVersion : `v${item.version || "latest"}`}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {viewFilter === "all" && typeof item.stars === "number" && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Star className="h-3 w-3 fill-amber-500/80 text-amber-500/80 shrink-0" />
                        {item.stars}
                      </span>
                    )}
                    <div className="flex flex-1 justify-end gap-1">
                      {isInstalled && hasUpdate && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void updateSkill(item.slug)}
                          className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                        >
                          {isBusy && busyAction === "update" ? "…" : "Update"}
                        </button>
                      )}
                      {isInstalled && (
                        <button type="button" disabled={isBusy} onClick={() => void uninstallSkill(item.slug)} className="rounded-md border border-border bg-card px-2 py-0.5 text-xs text-red-600 dark:text-red-400 hover:bg-red-500/10 disabled:opacity-50">
                          Delete
                        </button>
                      )}
                      <button type="button" disabled={isBusy || clawhubNotFound} onClick={() => void installSkill(item.slug, item.version)} className="rounded-md border border-border bg-card px-2.5 py-0.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">
                        {installLabel}
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Main SkillsView ────────────────────────────── */

export function SkillsView({ initialSkillName = null }: { initialSkillName?: string | null } = {}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SkillsFilter>("all");
  const [selectedSkill, setSelectedSkill] = useState<string | null>(initialSkillName);
  const [toast, setToast] = useState<Toast | null>(null);
  const [togglingSkill, setTogglingSkill] = useState<string | null>(null);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);
  const tab: "skills" | "clawhub" =
    (searchParams.get("tab") || "").toLowerCase() === "clawhub" ? "clawhub" : "skills";

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setApiWarning(null);
    setApiDegraded(false);
    try {
      const [listRes, checkRes] = await Promise.all([
        fetch("/api/skills"),
        fetch("/api/skills?action=check"),
      ]);
      const listData = (await listRes.json()) as {
        skills?: Skill[];
        warning?: unknown;
        degraded?: unknown;
      };
      const checkData = (await checkRes.json()) as {
        summary?: Summary | null;
        warning?: unknown;
        degraded?: unknown;
      };

      const warnings = [listData.warning, checkData.warning]
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim());
      setApiWarning(warnings.length > 0 ? warnings.join(" | ") : null);
      setApiDegraded(Boolean(listData.degraded) || Boolean(checkData.degraded));

      setSkills(listData.skills || []);
      setSummary(checkData.summary || null);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    setSelectedSkill(initialSkillName);
  }, [initialSkillName]);

  useEffect(() => {
    if (selectedSkill) {
      setLoading(false);
      return;
    }
    if (tab === "clawhub") {
      setLoading(false);
      return;
    }
    queueMicrotask(() => {
      void fetchAll();
    });
  }, [fetchAll, selectedSkill, tab]);

  const filtered = useMemo(() => skills.filter((s) => {
    if (search) {
      const q = search.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    }
    if (filter === "eligible") return s.eligible;
    if (filter === "unavailable") return !s.eligible || s.blockedByAllowlist;
    if (filter === "workspace") return getSkillOrigin(s) === "workspace";
    if (filter === "bundled") return getSkillOrigin(s) === "bundled";
    return true;
  }), [skills, search, filter]);

  const grouped = useMemo(() => {
    const buckets: Record<SkillOrigin, Skill[]> = {
      bundled: [],
      workspace: [],
      shared: [],
      other: [],
    };
    for (const skill of filtered) {
      buckets[getSkillOrigin(skill)].push(skill);
    }
    return SKILL_ORIGIN_ORDER.map((origin) => {
      const sectionSkills = buckets[origin];
      return {
        origin,
        title: SKILL_ORIGIN_META[origin].title,
        description: SKILL_ORIGIN_META[origin].description,
        skills: sectionSkills,
        ready: sectionSkills.filter((skill) => getAvailability(skill).state === "ready").length,
        needsSetup: sectionSkills.filter((skill) => getAvailability(skill).state === "needs-setup").length,
        disabled: sectionSkills.filter((skill) => skill.disabled).length,
      };
    }).filter((section) => section.skills.length > 0);
  }, [filtered]);

  const handleAction = useCallback((msg: string) => {
    const isError = msg.startsWith("Error");
    setToast({ msg, type: isError ? "error" : "success" });
    if (!isError) requestRestart("Skill configuration was updated.");
    fetchAll(); // Refresh list after action
  }, [fetchAll]);

  const handleToggleSkill = useCallback(async (skillName: string, enabled: boolean) => {
    setTogglingSkill(skillName);
    try {
      const action = enabled ? "enable-skill" : "disable-skill";
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, name: skillName }),
      });
      const d = await res.json();
      if (d.ok) {
        // Optimistic update for instant feedback
        setSkills((prev) => prev.map((s) => s.name === skillName ? { ...s, disabled: !enabled } : s));
        setToast({ msg: `${skillName} ${enabled ? "enabled" : "disabled"}`, type: "success" });
        requestRestart("Skill configuration was updated.");
        fetchAll();
      } else {
        setToast({ msg: "Error: " + (d.error || "failed"), type: "error" });
      }
    } catch (err) {
      setToast({ msg: "Error: " + String(err), type: "error" });
    }
    setTogglingSkill(null);
  }, [fetchAll]);

  const handleClawHubInstalled = useCallback(async (slug: string) => {
    try {
      const listRes = await fetch("/api/skills").then((r) => r.json());
      const latest = (listRes.skills || []) as Skill[];
      setSkills(latest);
      const match = latest.find((s) => s.name === slug);
      if (match?.disabled) {
        await fetch("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "enable-skill", name: slug }),
        });
      }
      await fetchAll();
      requestRestart("Skill catalog was updated.");
    } catch {
      await fetchAll();
    }
  }, [fetchAll]);

  const switchTab = useCallback((next: "skills" | "clawhub") => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("section");
    if (next === "clawhub") params.set("tab", "clawhub");
    else params.delete("tab");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  // Detail view
  if (selectedSkill) {
    return (
      <>
        <SkillDetailPanel
          name={selectedSkill}
          onBack={() => {
            if (initialSkillName) {
              router.push("/skills");
              return;
            }
            setSelectedSkill(null);
          }}
          onAction={handleAction}
        />
        {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
      </>
    );
  }

  if (loading) {
    return (
      <SectionLayout>
        <LoadingState label="Loading skills..." size="lg" />
      </SectionLayout>
    );
  }

  const workspaceCount = skills.filter((s) => getSkillOrigin(s) === "workspace").length;

  return (
    <SectionLayout>
      <SectionHeader
        className="py-2 md:py-3"
        title={
          <span className="flex items-center gap-2 text-xs">
            <Wrench className="h-5 w-5 text-muted-foreground" />
            Skills
          </span>
        }
        description="Skills are tools your agents can use (e.g. search, calendar). Turn them on or off; click a skill for more."
        descriptionClassName="text-sm text-muted-foreground"
        meta={null}
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
              <button
                type="button"
                onClick={() => switchTab("skills")}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", tab === "skills" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                Local Skills
              </button>
              <button
                type="button"
                onClick={() => switchTab("clawhub")}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", tab === "clawhub" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                ClawHub
              </button>
            </div>
            <button type="button" onClick={fetchAll} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"><RefreshCw className="h-3 w-3" />Refresh</button>
          </div>
        }
      />

      {tab === "skills" && (
        <SectionBody width="wide" padding="compact" innerClassName="space-y-4">
          {/* Summary + search in one scrollable area with the list */}
          {summary && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <SumCard value={summary.total} label="Total" color="text-foreground" />
              <SumCard value={summary.eligible} label="Ready" color="text-emerald-600 dark:text-emerald-400" border="border-emerald-500/20" bg="bg-emerald-500/5" title="On and ready for agents to use" />
              <SumCard value={workspaceCount} label="Installed" color="text-violet-600 dark:text-violet-400" border="border-violet-500/20" bg="bg-violet-500/5" title="Installed in this project (e.g. from ClawHub)" />
              <SumCard value={summary.disabled} label="Off" color="text-muted-foreground" border="border-border" bg="bg-muted/30" title="Turned off" />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 min-w-44">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input placeholder="Search skills..." value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground text-foreground" />
              {search && <button onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
            </div>
            <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted p-0.5">
              {(["all", "eligible", "unavailable", "bundled", "workspace"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors", filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {f === "all" ? "All" : f === "eligible" ? "Ready" : f === "unavailable" ? "Unavailable" : f === "bundled" ? "Bundled" : "Workspace"}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-4">
          {grouped.map((section) => (
            <section key={section.origin} className="glass-subtle rounded-lg p-4">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground border-b border-border pb-2">
                {section.title} <span className="font-normal">({section.skills.length})</span>
              </h3>
              <div className="mt-3 columns-1 gap-x-4 sm:columns-2 lg:columns-3">
                {section.skills.map((s) => (
                  <div key={s.name} className="break-inside-avoid mb-2">
                    <SkillCard
                      skill={s}
                      onClick={() => router.push(`/skills/${encodeURIComponent(s.name)}`)}
                      onToggle={(enabled) => handleToggleSkill(s.name, enabled)}
                      toggling={togglingSkill === s.name}
                    />
                  </div>
                ))}
              </div>
            </section>
          ))}
          {filtered.length === 0 && (
            <div className="glass-subtle flex flex-col items-center justify-center rounded-lg py-12">
              <Search className="h-8 w-8 text-muted-foreground mb-3" />
              <p className="text-sm text-muted-foreground">No skills found</p>
              <p className="text-xs text-muted-foreground mt-1">Try a different search or filter.</p>
            </div>
          )}
          </div>
        </SectionBody>
      )}

      {tab === "clawhub" && (
        <SectionBody width="wide" padding="compact" innerClassName="pb-6">
          <ClawHubPanel
            onAction={handleAction}
            onInstalled={handleClawHubInstalled}
          />
        </SectionBody>
      )}
      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
  );
}

/* ── Summary Card ───────────────────────────────── */

function SumCard({ value, label, color, border, bg, title }: { value: number; label: string; color: string; border?: string; bg?: string; title?: string }) {
  return (
    <div className={cn("rounded-lg border px-3 py-2", border || "border-border", bg || "bg-muted/30")} title={title}>
      <p className={cn("text-sm font-semibold tabular-nums leading-tight", color)}>{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
    </div>
  );
}
