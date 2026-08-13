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
  ChevronRight, ChevronDown, ShieldCheck, ShieldAlert,
  GitBranch, Layers3, ExternalLink, Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";
import type {
  InstalledSkillCatalogItem,
  SkillCatalogCapabilities,
  SkillCatalogItem,
  SkillCatalogSource,
} from "@/lib/skills-catalog";

/* ── Types ──────────────────────────────────────── */

type Missing = { bins: string[]; anyBins: string[]; env: string[]; config: string[]; os: string[] };
type InstallOption = { id: string; kind: string; label: string; bins?: string[] };

type Skill = {
  name: string; skillKey?: string; filePath?: string; description: string; emoji: string; eligible: boolean;
  disabled: boolean; blockedByAllowlist: boolean; source: string;
  bundled: boolean; homepage?: string; missing: Missing;
  always?: boolean;
};

/** Legacy card shape retained while the old catalog renderer remains below. */
type ClawHubItem = {
  slug: string; ref?: string; displayName?: string; summary?: string;
  version?: string; latestVersion?: string; score?: number; developer?: string;
  downloads?: number; installsCurrent?: number; stars?: number; updatedAt?: number;
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
type SkillsPageTab = "discover" | "installed" | "built-in" | "import";
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

const NO_REQUIREMENTS: Missing = { bins: [], anyBins: [], env: [], config: [], os: [] };

/**
 * Requirement bags are optional on the wire — a degraded filesystem read has no
 * eligibility data — so treat a missing bag as empty rather than throwing while
 * rendering.
 */
function requirementBag(m: Missing | undefined | null): Missing {
  if (!m) return NO_REQUIREMENTS;
  return {
    bins: m.bins ?? [],
    anyBins: m.anyBins ?? [],
    env: m.env ?? [],
    config: m.config ?? [],
    os: m.os ?? [],
  };
}

function hasMissing(m: Missing | undefined | null): boolean {
  return missingCount(m) > 0;
}

function missingCount(m: Missing | undefined | null): number {
  const bag = requirementBag(m);
  return bag.bins.length + bag.anyBins.length + bag.env.length + bag.config.length + bag.os.length;
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
      badgeClass: "border-danger-border bg-danger-bg text-danger-fg",
    };
  }
  if (skill.eligible) {
    return {
      state: "ready",
      label: "Ready",
      labelShort: "Ready",
      badgeClass: "border-success-border bg-success-bg text-success-fg",
    };
  }
  if (hasMissing(skill.missing)) {
    return {
      state: "needs-setup",
      label: "Needs setup",
      labelShort: "Setup",
      badgeClass: "border-warning-border bg-warning-bg text-warning-fg",
    };
  }
  return {
    state: "unavailable",
    label: "Unavailable",
    labelShort: "Unavailable",
    badgeClass: "border-border-strong/30 bg-muted-foreground/10 text-muted-foreground",
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
  if (normalized.includes("bundled")) return "bg-info-bg text-info-fg border-info-border";
  if (normalized.includes("workspace")) return "bg-muted-foreground/10 text-fg-secondary border-border-strong";
  if (normalized.includes("managed") || normalized.includes("local")) return "bg-info-bg text-info-fg border-info-border";
  return "bg-muted-foreground/10 text-muted-foreground border-border-strong/20";
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
    <div className={cn("glass-strong fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium", toast.type === "success" ? "text-success-fg" : "text-danger-fg")}>
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
            <div className="h-3 w-3 rounded-full bg-danger-bg" />
            <div className="h-3 w-3 rounded-full bg-warning-bg" />
            <div className="h-3 w-3 rounded-full bg-success-bg" />
          </div>
          <div className="flex items-center gap-2">
            <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-medium text-muted-foreground">
              skills install {skillName} ({installId})
            </span>
          </div>
          {running && (
            <span className="flex items-center gap-1.5 text-xs text-success-fg">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Running {formatElapsed(elapsed)}
            </span>
          )}
          {!running && exitCode !== null && (
            <span className={cn("text-xs font-medium", exitCode === 0 ? "text-success-fg" : "text-danger-fg")}>
              {exitCode === 0 ? "Done" : `Failed (${exitCode})`} — {formatElapsed(elapsed)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {running && (
            <button
              type="button"
              onClick={handleAbort}
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-danger-fg transition hover:bg-danger-bg"
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
        className="max-h-80 min-h-48 overflow-y-auto bg-muted/30 p-4 font-mono text-xs leading-5 text-foreground"
      >
        {lines.map((line, i) => (
          <span
            key={i}
            className={cn(
              "whitespace-pre-wrap break-all",
              line.stream === "stderr"
                ? "text-danger-fg"
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
        <div className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
          {error}
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded border border-success-border bg-success-bg px-1.5 py-0.5 text-success-fg">
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

function skillStatus(skill: Skill, availability: ReturnType<typeof getAvailability>): { label: string; dot: string } {
  if (skill.disabled) return { label: "Off", dot: "bg-muted-foreground/60" };
  if (availability.state === "ready") return { label: "Ready", dot: "bg-success" };
  if (availability.state === "blocked") return { label: "Blocked", dot: "bg-danger" };
  return { label: "Setup needed", dot: "bg-warning" };
}

function SkillCard({ skill, onClick, onToggle, onUninstall, toggling, uninstalling }: { skill: Skill; onClick: () => void; onToggle: (enabled: boolean) => void; onUninstall?: () => void; toggling?: boolean; uninstalling?: boolean }) {
  const missing = hasMissing(skill.missing);
  const missingTotal = missingCount(skill.missing);
  const availability = getAvailability(skill);
  const status = skillStatus(skill, availability);
  return (
    <article className="group flex min-w-0 items-start gap-3 px-4 py-3.5 transition-colors hover:bg-muted/40">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40 text-sm" aria-hidden="true">
        {skill.emoji || "\u26A1"}
      </div>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 flex-1 cursor-pointer text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <div className="flex min-w-0 items-center gap-2">
            <h4 className="truncate text-sm font-medium text-foreground">{skill.name}</h4>
            <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
              {status.label}
            </span>
            {skill.always && <span className="shrink-0 text-xs text-muted-foreground">Always on</span>}
          </div>
          <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{skill.description}</p>
          <div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
            <span title={sourceLabel(skill.source, skill.bundled)}>{sourceLabelShort(skill.source, skill.bundled)}</span>
            {!skill.disabled && missing && (
              <>
                <span aria-hidden="true">·</span>
                <span>{missingTotal} {missingTotal === 1 ? "requirement" : "requirements"} missing</span>
              </>
            )}
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
          </div>
        </button>
        <div className="flex shrink-0 items-start gap-2 pt-0.5" onClick={(e) => e.stopPropagation()}>
          {onUninstall && (
            <button
              type="button"
              onClick={onUninstall}
              disabled={uninstalling}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-danger-fg transition-colors hover:bg-danger-bg disabled:opacity-50"
              aria-label={`Uninstall ${skill.name}`}
            >
              {uninstalling ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Uninstall
            </button>
          )}
          <div className="flex flex-col items-center gap-1" role="group" aria-label={`Turn ${skill.name} on or off`}>
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
                disabled={toggling || uninstalling}
              />
            )}
            <span className="text-[11px] text-muted-foreground">{skill.disabled ? "Off" : "On"}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

/* ── Skill Detail Panel ─────────────────────────── */

/**
 * Reason this payload cannot be rendered as a skill, or null when it can.
 * Covers both an explicit `{ error }` body and a 200 whose shape is unusable.
 */
function readDetailError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return "Malformed response from /api/skills.";
  const record = payload as Record<string, unknown>;
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  if (typeof record.name !== "string" || !record.name.trim()) {
    return "The skill inventory is unavailable, so this skill's details could not be loaded.";
  }
  return null;
}

function SkillDetailPanel({ name, onBack, onAction }: { name: string; onBack: () => void; onAction: (msg: string) => void }) {
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [showMd, setShowMd] = useState(false);
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [installTerminal, setInstallTerminal] = useState<{ installId: string; label: string } | null>(null);
  const installSectionRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLoading(true);
    setDetailError(null);
    fetch("/api/skills?action=info&name=" + encodeURIComponent(name))
      .then((r) => r.json())
      .then((d) => {
        // An error payload is still an object, so storing it unchecked used to
        // pass the null guard below and then crash on `detail.missing.bins`.
        const err = readDetailError(d);
        if (err) {
          setDetail(null);
          setDetailError(err);
        } else {
          setDetail(d as SkillDetail);
        }
        setLoading(false);
      })
      .catch((err) => {
        setDetailError(String(err));
        setLoading(false);
      });
  }, [name]);

  const doAction = useCallback(async (action: string, params: Record<string, unknown>) => {
    setBusy(action);
    try {
      const res = await fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...params }) });
      const d = await res.json();
      if (d.ok) { onAction(action + " succeeded"); } else { onAction("Error: " + (d.error || "failed")); }
    } catch (err) { onAction("Error: " + String(err)); }
    finally { setBusy(null); }
    // Refresh detail. Keep the previous snapshot on a bad payload rather than
    // replacing a rendered skill with something unrenderable.
    try {
      const res = await fetch("/api/skills?action=info&name=" + encodeURIComponent(name));
      const d = await res.json();
      if (!readDetailError(d)) setDetail(d as SkillDetail);
    } catch { /* ignore */ }
  }, [name, onAction]);

  if (loading) {
    return (
      <SectionLayout>
        <ContentLoadingState />
      </SectionLayout>
    );
  }
  if (detailError) {
    return (
      <SectionLayout>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="h-5 w-5 text-warning-fg" />
          <p className="text-sm font-medium text-foreground">Could not load {name}</p>
          <p className="max-w-md text-xs text-muted-foreground">{detailError}</p>
          <button
            type="button"
            onClick={onBack}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Back to skills
          </button>
        </div>
      </SectionLayout>
    );
  }
  if (!detail) return <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">Skill not found</div>;

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
              {availability.state === "ready" ? <span className="flex items-center gap-1 rounded-full bg-success-bg px-2.5 py-0.5 text-xs font-semibold text-success-fg"><CheckCircle className="h-3 w-3" />Ready</span> : availability.state === "blocked" ? <span className="flex items-center gap-1 rounded-full bg-danger-bg px-2.5 py-0.5 text-xs font-semibold text-danger-fg"><XCircle className="h-3 w-3" />Blocked</span> : availability.state === "needs-setup" ? <span className="flex items-center gap-1 rounded-full bg-warning-bg px-2.5 py-0.5 text-xs font-semibold text-warning-fg"><AlertTriangle className="h-3 w-3" />Needs setup</span> : <span className="flex items-center gap-1 rounded-full bg-muted-foreground/20 px-2.5 py-0.5 text-xs font-semibold text-muted-foreground"><XCircle className="h-3 w-3" />Unavailable</span>}
              {detail.disabled && <span className="rounded-full bg-danger-bg px-2.5 py-0.5 text-xs font-semibold text-danger-fg">Disabled</span>}
              {detail.always && <span className="rounded-full bg-warning-bg px-2.5 py-0.5 text-xs font-semibold text-warning-fg">Always active</span>}
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
            <div className="mt-2 flex items-center gap-3 text-xs">
              <span className={cn("rounded border px-1.5 py-0.5 text-xs font-medium", sourceColor(detail.source))}>{sourceLabel(detail.source, detail.bundled)}</span>
              {detail.homepage && <a href={detail.homepage} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"><Globe className="h-3 w-3" />Homepage</a>}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{sourceHint(detail.source)}</p>
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
                <p className={cn("text-xs font-medium", detail.disabled ? "text-muted-foreground" : "text-success-fg")}>
                  {detail.disabled ? "Off" : "On"}
                </p>
                <p className="text-xs text-fg-subtle">
                  {detail.disabled ? "Agents cannot use this." : "Agents can use this when needed."}
                </p>
              </div>
            </div>
          </div>
          <div className="glass-subtle rounded-lg px-4 py-3 min-w-0 flex-1" title="Whether this skill is ready to use right now">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Status</p>
            <p className={cn("mt-0.5 text-xs font-medium", availability.state === "ready" ? "text-success-fg" : availability.state === "blocked" ? "text-danger-fg" : availability.state === "needs-setup" ? "text-warning-fg" : "text-muted-foreground")}>{availability.label}</p>
            <p className="mt-1 text-xs text-muted-foreground">{runtime}</p>
          </div>
          {missing && detail.install.length > 0 && (
            <button
              type="button"
              onClick={() => installSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
              className="shrink-0 flex items-center gap-2 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-xs font-medium text-warning-fg hover:bg-warning-bg transition-colors"
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
                      return (<span key={b} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-mono", isMissing ? "border-danger-border bg-danger-bg text-danger-fg" : "border-success-border bg-success-bg text-success-fg")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{b}</span>);
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
                      return (<span key={e} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs font-mono", isMissing ? "border-danger-border bg-danger-bg text-danger-fg" : "border-success-border bg-success-bg text-success-fg")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{e}</span>);
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
                      return (<span key={c} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs", isMissing ? "border-danger-border bg-danger-bg text-danger-fg" : "border-success-border bg-success-bg text-success-fg")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{c}</span>);
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
                      return (<span key={o} className={cn("flex items-center gap-1 rounded-lg border px-2 py-1 text-xs", isMissing ? "border-danger-border bg-danger-bg text-danger-fg" : "border-success-border bg-success-bg text-success-fg")}>{isMissing ? <XCircle className="h-3 w-3" /> : <CheckCircle className="h-3 w-3" />}{o}</span>);
                    })}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Install options */}
        {missing && detail.install.length > 0 && (
          <div ref={installSectionRef} className="rounded-lg border border-warning-border bg-warning-bg p-4 space-y-3">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-warning-fg"><Download className="h-3.5 w-3.5" />Install what’s missing</h3>
            <p className="text-xs text-warning-fg">This skill needs the following to work. Click Install to add them (when available).</p>
            <div className="space-y-2">{detail.install.map((inst) => (
                <div key={inst.id} className="glass-subtle flex items-center justify-between rounded-lg px-4 py-3">
                  <div>
                    <p className="text-xs font-medium text-foreground">{inst.label}</p>
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
                  .then((d) => { if (!readDetailError(d)) setDetail(d as SkillDetail); })
                  .catch(() => {});
              }
            }}
            onClose={() => setInstallTerminal(null)}
          />
        )}

        {/* All good */}
        {!missing && detail.eligible && (
          <div className="rounded-lg border border-success-border bg-success-bg p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-success-fg"><CheckCircle className="h-4 w-4" />All requirements met — this skill is active and available to your agents.</p>
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

/** @deprecated The app renders CatalogPanel; exported for compatibility. */
export function ClawHubPanel({
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
  const [browseNotice, setBrowseNotice] = useState<string | null>(null);
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
      // Browsing needs the standalone CLI, but search and install do not, so
      // this is a note rather than the tab-wide "not found" state.
      setBrowseNotice(typeof data?.notice === "string" ? data.notice : null);
      if (!res.ok || data?.error) {
        setClawhubNotFound(false);
        throw new Error(String(data?.error || `HTTP ${res.status}`));
      }
      const normalized: ClawHubItem[] = (data.items || []).map((item: {
        slug?: string;
        ref?: string;
        displayName?: string;
        summary?: string;
        latestVersion?: { version?: string };
        stats?: { downloads?: number; installsCurrent?: number; stars?: number };
        updatedAt?: number;
        developer?: string;
        author?: string;
      }) => ({
        slug: String(item.slug || ""),
        ref: item.ref || undefined,
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
    setBrowseNotice(null);
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
        ref?: string;
        version?: string;
        summary?: string;
        score?: number;
        developer?: string;
        author?: string;
        displayName?: string;
        stats?: { downloads?: number; installsCurrent?: number; stars?: number };
        updatedAt?: number;
      }) => ({
        slug: String(item.slug || ""),
        ref: item.ref || undefined,
        displayName: item.displayName || undefined,
        version: item.version || "latest",
        summary: item.summary || "",
        score: typeof item.score === "number" ? item.score : undefined,
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
  }, [query]);

  const installSkill = useCallback(async (slug: string, version?: string, force = false, ref?: string) => {
    setBusySlug(slug);
    setBusyAction("install");
    try {
      const res = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "install", slug, ref, version, force }),
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
          return void installSkill(slug, version, true, ref);
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
      {browseNotice && !clawhubNotFound && (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Search className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>{browseNotice}</p>
        </div>
      )}
      {clawhubNotFound && (
        <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2.5 text-sm text-warning-fg">
          <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
              <p className="font-medium">ClawHub is not available for this service</p>
            <p className="text-xs mt-0.5 text-warning-fg">
                Catalog actions are disabled until the <code className="font-mono bg-warning-bg px-1 rounded">clawhub</code> binary is installed for the same OS user that runs Mission Control.
            </p>
          </div>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <code className="rounded border border-warning-border bg-warning-bg px-2 py-1 font-mono text-xs text-warning-fg">
              {CLAWHUB_INSTALL_CMD}
            </code>
            <button
              type="button"
              onClick={() => void handleCopyInstallCommand()}
              className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-warning-bg px-2 py-1 text-xs font-medium text-warning-fg transition-colors hover:bg-warning-bg"
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
              className="inline-flex items-center gap-1 rounded-md border border-warning-border bg-warning-bg px-2 py-1 text-xs font-medium text-warning-fg transition-colors hover:bg-warning-bg"
            >
              <RefreshCw className="h-3 w-3" />
              Retry
            </button>
          </div>
          <p className="mt-2 text-xs text-warning-fg">
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
        <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
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
                  key={item.ref || item.slug}
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
                    <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-xs font-medium leading-none", isInstalled ? "border-success-border bg-success-bg text-success-fg" : "border-border text-muted-foreground")}>
                      {isInstalled ? installedVersion : `v${item.version || "latest"}`}
                    </span>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    {viewFilter === "all" && typeof item.stars === "number" && (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                        <Star className="h-3 w-3 fill-warning text-warning-fg shrink-0" />
                        {item.stars}
                      </span>
                    )}
                    <div className="flex flex-1 justify-end gap-1">
                      {isInstalled && hasUpdate && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => void updateSkill(item.slug)}
                          className="rounded-md border border-warning-border bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning-fg hover:bg-warning-bg disabled:opacity-50"
                        >
                          {isBusy && busyAction === "update" ? "…" : "Update"}
                        </button>
                      )}
                      {isInstalled && (
                        <button type="button" disabled={isBusy} onClick={() => void uninstallSkill(item.slug)} className="rounded-md border border-border bg-card px-2 py-0.5 text-xs text-danger-fg hover:bg-danger-bg disabled:opacity-50">
                          Delete
                        </button>
                      )}
                      <button type="button" disabled={isBusy || clawhubNotFound} onClick={() => void installSkill(item.slug, item.version, false, item.ref)} className="rounded-md border border-border bg-card px-2.5 py-0.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50">
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

/* ── Universal catalog ──────────────────────────── */

type CatalogMode = "discover" | "import";

const SOURCE_LABEL: Record<SkillCatalogSource, string> = {
  clawhub: "ClawHub",
  "skills-sh": "Skills.sh",
  git: "Git",
  local: "Local",
  bundled: "Built-in",
  plugin: "Plugin",
};

function sourceBadgeClass(source: SkillCatalogSource): string {
  if (source === "clawhub") return "border-success-border bg-success-bg text-success-fg";
  if (source === "skills-sh") return "border-info-border bg-info-bg text-info-fg";
  return "border-border bg-muted text-muted-foreground";
}

function normalizeImportReference(source: "skills-sh" | "git", rawValue: string): string | null {
  const raw = rawValue.trim();
  if (!raw) return null;
  if (source === "skills-sh") {
    if (raw.startsWith("skills-sh:")) return raw;
    if (/^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*\/[a-z0-9][\w./-]*$/i.test(raw)) return `skills-sh:${raw}`;
    const url = raw.match(/^https?:\/\/skills\.sh\/([^/]+)\/([^/]+)\/([^?#]+)\/?$/i);
    return url ? `skills-sh:${url[1]}/${url[2]}/${url[3]}` : null;
  }
  if (raw.startsWith("git:")) return raw;
  const github = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/tree\/([^?#]+))?\/?$/i);
  if (github) return `git:${github[1]}/${github[2]}${github[3] ? `@${github[3]}` : ""}`;
  if (/^[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*(?:@[a-z0-9][\w./-]*)?$/i.test(raw)) return `git:${raw}`;
  return null;
}

function CatalogPanel({
  mode,
  onAction,
  onInstalled,
}: {
  mode: CatalogMode;
  onAction: (msg: string) => void;
  onInstalled: (slug: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<SkillCatalogItem[]>([]);
  const [installed, setInstalled] = useState<InstalledSkillCatalogItem[]>([]);
  const [capabilities, setCapabilities] = useState<SkillCatalogCapabilities | null>(null);
  const [sourceFilter, setSourceFilter] = useState<"all" | "clawhub" | "skills-sh">("all");
  const [sort, setSort] = useState<"trending" | "downloads" | "stars" | "name">("trending");
  const [loading, setLoading] = useState(mode === "discover");
  const [error, setError] = useState<string | null>(null);
  const [pendingInstall, setPendingInstall] = useState<SkillCatalogItem | null>(null);
  const [pendingDelete, setPendingDelete] = useState<InstalledSkillCatalogItem | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [target, setTarget] = useState("workspace");
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importSource, setImportSource] = useState<"skills-sh" | "git">("skills-sh");
  const [importValue, setImportValue] = useState("");
  const [importError, setImportError] = useState<string | null>(null);

  const installedBySlug = useMemo(() => new Map(installed.map((item) => [item.slug, item])), [installed]);

  const refreshInstalled = useCallback(async () => {
    const response = await fetch("/api/skills/clawhub?action=list", { cache: "no-store" });
    const payload = await response.json();
    if (!response.ok) throw new Error(String(payload?.error || "Could not load installed skills."));
    setInstalled(Array.isArray(payload.items) ? payload.items : []);
  }, []);

  const loadCatalog = useCallback(async (searchQuery?: string) => {
    const q = (searchQuery ?? query).trim();
    setLoading(true);
    setError(null);
    try {
      const endpoint = q
        ? `/api/skills/clawhub?action=search&q=${encodeURIComponent(q)}&limit=40`
        : `/api/skills/clawhub?action=explore&sort=trending&limit=40`;
      const response = await fetch(endpoint, { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) throw new Error(String(payload?.error || "Could not load the skills catalog."));
      setItems(Array.isArray(payload.items) ? payload.items : []);
    } catch (err) {
      setItems([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    let active = true;
    Promise.all([
      fetch("/api/skills/clawhub?action=capabilities", { cache: "no-store" }).then((response) => response.json()),
      fetch("/api/agents", { cache: "no-store" }).then((response) => response.json()).catch(() => ({ agents: [] })),
    ]).then(([caps, agentPayload]) => {
      if (!active) return;
      setCapabilities(caps as SkillCatalogCapabilities);
      const options = (Array.isArray(agentPayload?.agents) ? agentPayload.agents : [])
        .map((agent: { id?: string; name?: string }) => ({ id: String(agent.id || ""), name: String(agent.name || agent.id || "") }))
        .filter((agent: AgentOption) => agent.id);
      setAgents(options);
    }).catch(() => {});
    void refreshInstalled().catch((err) => setError(String(err)));
    if (mode === "discover") void loadCatalog("");
    return () => { active = false; };
  }, [loadCatalog, mode, refreshInstalled]);

  useEffect(() => {
    if (mode !== "discover") return;
    const timer = window.setTimeout(() => void loadCatalog(query), query.trim() ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalog, mode, query]);

  const filteredItems = useMemo(() => {
    const filtered = sourceFilter === "all" ? items : items.filter((item) => item.source === sourceFilter);
    if (sort === "trending") return filtered;
    return [...filtered].sort((left, right) => {
      if (sort === "downloads") return (right.downloads || 0) - (left.downloads || 0);
      if (sort === "stars") return (right.stars || 0) - (left.stars || 0);
      return left.displayName.localeCompare(right.displayName, undefined, { sensitivity: "base" });
    });
  }, [items, sort, sourceFilter]);

  const sourceSupported = useCallback((source: SkillCatalogSource): boolean => {
    if (!capabilities) return true;
    if (source === "skills-sh") return capabilities.skillsShInstall;
    if (source === "git") return capabilities.gitInstall;
    return source === "clawhub";
  }, [capabilities]);

  const openReview = useCallback((item: SkillCatalogItem) => {
    setAcknowledged(item.trust.status === "trusted");
    setTarget("workspace");
    setPendingInstall(item);
  }, []);

  const performInstall = useCallback(async () => {
    const item = pendingInstall;
    if (!item || item.trust.status === "blocked") return;
    setBusyId(item.id);
    try {
      const response = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "install",
          slug: item.slug,
          source: item.source,
          installReference: item.installReference,
          version: item.version,
          acknowledgeRisk: acknowledged,
          scope: target === "global" ? "global" : "workspace",
          agentId: target.startsWith("agent:") ? target.slice(6) : undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(String(payload?.error || "Installation failed."));
      setPendingInstall(null);
      onAction(`Installed ${item.displayName}. It is off until you review its requirements and enable it.`);
      await refreshInstalled();
      await onInstalled(String(payload.slug || item.slug));
    } catch (err) {
      onAction(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }, [acknowledged, onAction, onInstalled, pendingInstall, refreshInstalled, target]);

  const performDelete = useCallback(async () => {
    const item = pendingDelete;
    if (!item) return;
    setBusyId(item.id);
    try {
      const response = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "uninstall", slug: item.slug, source: item.source }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(String(payload?.error || "Could not uninstall this skill."));
      setPendingDelete(null);
      onAction(`Uninstalled ${item.name}`);
      await refreshInstalled();
      await onInstalled(item.slug);
    } catch (err) {
      onAction(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }, [onAction, onInstalled, pendingDelete, refreshInstalled]);

  const performToggle = useCallback(async (item: SkillCatalogItem, local: InstalledSkillCatalogItem) => {
    setBusyId(item.id);
    const enabled = !local.enabled;
    try {
      const response = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: enabled ? "enable-skill" : "disable-skill",
          name: local.skillKey || local.slug,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(String(payload?.error || "Could not update this skill."));
      setInstalled((current) => current.map((installedItem) => installedItem.id === local.id ? { ...installedItem, enabled } : installedItem));
      onAction(`${enabled ? "Enabled" : "Disabled"} ${local.name}`);
      await refreshInstalled();
      await onInstalled(local.slug);
    } catch (err) {
      onAction(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }, [onAction, onInstalled, refreshInstalled]);

  const performUpdate = useCallback(async (item: SkillCatalogItem) => {
    setBusyId(item.id);
    try {
      const response = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          slug: item.slug,
          source: item.source,
          installReference: item.installReference,
        }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(String(payload?.error || "Update failed."));
      onAction(`Updated ${item.displayName}`);
      await refreshInstalled();
      await onInstalled(item.slug);
    } catch (err) {
      onAction(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyId(null);
    }
  }, [onAction, onInstalled, refreshInstalled]);

  const reviewImport = useCallback(() => {
    const reference = normalizeImportReference(importSource, importValue);
    if (!reference) {
      setImportError(importSource === "skills-sh"
        ? "Enter a Skills.sh URL or owner/repository/skill reference."
        : "Enter a GitHub URL or owner/repository reference.");
      return;
    }
    if (!sourceSupported(importSource)) {
      setImportError(capabilities?.reasons[importSource] || "This source is unavailable with the current OpenClaw connection.");
      return;
    }
    setImportError(null);
    const slug = reference.split("/").pop()?.split("@")[0] || "imported-skill";
    openReview({
      id: `${importSource}:${reference}`,
      slug,
      displayName: slug,
      summary: importSource === "skills-sh" ? "Import this Agent Skill from Skills.sh." : "Import Agent Skills from this Git repository.",
      source: importSource,
      installKind: importSource,
      installReference: reference,
      trust: {
        status: "unscanned",
        installability: "unknown",
        sourceFreshness: "user-supplied",
        verdict: null,
        signals: [],
      },
    });
  }, [capabilities?.reasons, importSource, importValue, openReview, sourceSupported]);

  if (mode === "import") {
    return (
      <div className="mx-auto max-w-2xl space-y-5">
        <div>
          <h2 className="text-base font-semibold text-foreground">Import a compatible skill</h2>
          <p className="mt-1 text-sm text-muted-foreground">Add a Skills.sh skill or a Git repository without using the terminal. You will review its source and security state before anything is installed.</p>
        </div>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="grid grid-cols-2 gap-px bg-border">
            {(["skills-sh", "git"] as const).map((source) => (
              <button key={source} type="button" onClick={() => { setImportSource(source); setImportError(null); }} className={cn("flex items-center justify-center gap-2 bg-card px-4 py-3 text-sm transition-colors", importSource === source ? "text-foreground" : "text-muted-foreground hover:bg-muted/40")}>
                {source === "skills-sh" ? <Layers3 className="h-4 w-4" /> : <GitBranch className="h-4 w-4" />}
                {source === "skills-sh" ? "Skills.sh" : "GitHub / Git"}
              </button>
            ))}
          </div>
          <div className="space-y-4 p-5">
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-foreground">{importSource === "skills-sh" ? "Skills.sh URL or reference" : "GitHub URL or repository"}</span>
              <input value={importValue} onChange={(event) => setImportValue(event.target.value)} placeholder={importSource === "skills-sh" ? "https://skills.sh/owner/repository/skill" : "https://github.com/owner/repository"} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring" />
            </label>
            {!sourceSupported(importSource) && capabilities && (
              <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">{capabilities.reasons[importSource]}</div>
            )}
            {importError && <p className="text-xs text-danger-fg">{importError}</p>}
            <div className="flex justify-end">
              <button type="button" onClick={reviewImport} className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background hover:opacity-90"><ShieldCheck className="h-4 w-4" />Review import</button>
            </div>
          </div>
        </div>
        {pendingInstall && <InstallReviewDialog item={pendingInstall} acknowledged={acknowledged} setAcknowledged={setAcknowledged} target={target} setTarget={setTarget} agents={agents} busy={busyId === pendingInstall.id} onCancel={() => setPendingInstall(null)} onConfirm={() => void performInstall()} />}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search ClawHub and Skills.sh" className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
          {query && <button type="button" onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>}
        </label>
        <button type="button" onClick={() => void loadCatalog(query)} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-foreground hover:bg-muted"><RefreshCw className="h-4 w-4" />Refresh</button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-border bg-muted p-0.5">
          {(["all", "clawhub", "skills-sh"] as const).map((source) => (
            <button key={source} type="button" onClick={() => setSourceFilter(source)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", sourceFilter === source ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{source === "all" ? "All sources" : SOURCE_LABEL[source]}</button>
          ))}
        </div>
        <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className="h-8 rounded-lg border border-border bg-card px-2 text-xs text-foreground outline-none">
          <option value="trending">Recommended</option><option value="downloads">Downloads</option><option value="stars">Stars</option><option value="name">Name</option>
        </select>
      </div>
      {capabilities?.openClawVersion && <p className="text-xs text-muted-foreground">Connected to OpenClaw {capabilities.openClawVersion}. Registry installs and updates happen through this UI.</p>}
      {error && <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-sm text-warning-fg">{error}</div>}
      {loading ? <ContentLoadingState size="lg" /> : filteredItems.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-6 py-12 text-center"><Search className="mx-auto h-6 w-6 text-muted-foreground" /><p className="mt-3 text-sm text-foreground">No skills found</p><p className="mt-1 text-xs text-muted-foreground">Try another phrase or source.</p></div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card divide-y divide-border">
          {filteredItems.map((item) => {
            const local = installedBySlug.get(item.slug);
            const supported = sourceSupported(item.source);
            const updateAvailable = Boolean(local?.version && item.version && local.version !== item.version);
            return (
              <article key={item.id} className="flex flex-col gap-3 px-4 py-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-start">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40"><Package className="h-4 w-4 text-muted-foreground" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-foreground">{item.displayName}</h3>
                    <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-medium", sourceBadgeClass(item.source))}>{SOURCE_LABEL[item.source]}</span>
                    {item.official && <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground"><ShieldCheck className="h-3 w-3" />Official</span>}
                    <span className={cn("inline-flex items-center gap-1 text-[11px]", item.trust.status === "blocked" ? "text-danger-fg" : item.trust.status === "warning" ? "text-warning-fg" : "text-muted-foreground")}>
                      {item.trust.status === "trusted" ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}{item.trust.status === "trusted" ? "Scanned" : item.trust.status === "blocked" ? "Blocked" : item.trust.status === "warning" ? "Review warning" : "Review required"}
                    </span>
                  </div>
                  {(item.publisher || item.owner) && <p className="mt-0.5 text-xs text-muted-foreground">by {item.publisher || item.owner}</p>}
                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{item.summary || "No description provided."}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                    {typeof item.downloads === "number" && <span>{item.downloads.toLocaleString()} downloads</span>}
                    {typeof item.stars === "number" && <span className="inline-flex items-center gap-1"><Star className="h-3 w-3" />{item.stars.toLocaleString()}</span>}
                    {item.canonicalUrl && <a href={item.canonicalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">Details <ExternalLink className="h-3 w-3" /></a>}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2 sm:pt-0.5">
                  {local ? (
                    <>
                      <span className={cn("text-xs", local.bundled ? "text-muted-foreground" : "text-success-fg")} title={local.bundled ? "Built-in skills ship with OpenClaw and can be disabled, but not uninstalled." : undefined}>
                        {local.bundled ? "Built-in" : "Installed"}{local.enabled ? "" : " · Off"}
                      </span>
                      {local.bundled ? (
                        <button type="button" disabled={busyId === item.id} onClick={() => void performToggle(item, local)} className="inline-flex h-8 items-center rounded-lg border border-border px-2.5 text-xs text-foreground hover:bg-muted disabled:opacity-50">
                          {busyId === item.id ? <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}{local.enabled ? "Turn off" : "Turn on"}
                        </button>
                      ) : (
                        <>
                          {updateAvailable && <button type="button" disabled={busyId === item.id} onClick={() => void performUpdate(item)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-foreground hover:bg-muted disabled:opacity-50"><RefreshCw className={cn("h-3.5 w-3.5", busyId === item.id && "animate-spin")} />Update</button>}
                          <button type="button" disabled={busyId === item.id} onClick={() => setPendingDelete(local)} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-danger-fg hover:bg-danger-bg disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />Uninstall</button>
                        </>
                      )}
                    </>
                  ) : (
                    <button type="button" disabled={!supported || item.trust.status === "blocked" || busyId === item.id} onClick={() => openReview(item)} title={!supported ? capabilities?.reasons[item.source as "skills-sh" | "git"] : undefined} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3 text-xs font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"><Download className="h-3.5 w-3.5" />Install</button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {pendingInstall && <InstallReviewDialog item={pendingInstall} acknowledged={acknowledged} setAcknowledged={setAcknowledged} target={target} setTarget={setTarget} agents={agents} busy={busyId === pendingInstall.id} onCancel={() => setPendingInstall(null)} onConfirm={() => void performInstall()} />}
      {pendingDelete && <DeleteSkillDialog item={pendingDelete} busy={busyId === pendingDelete.id} onCancel={() => setPendingDelete(null)} onConfirm={() => void performDelete()} />}
    </div>
  );
}

function InstallReviewDialog({ item, acknowledged, setAcknowledged, target, setTarget, agents, busy, onCancel, onConfirm }: {
  item: SkillCatalogItem; acknowledged: boolean; setAcknowledged: (value: boolean) => void;
  target: string; setTarget: (value: string) => void; agents: AgentOption[]; busy: boolean;
  onCancel: () => void; onConfirm: () => void;
}) {
  const needsAcknowledgement = item.trust.status !== "trusted";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="skill-review-title">
      <div className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4"><div><p className="text-xs font-medium text-muted-foreground">Security review</p><h2 id="skill-review-title" className="mt-0.5 text-base font-semibold text-foreground">Install {item.displayName}</h2></div><button type="button" onClick={onCancel} disabled={busy} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="h-4 w-4" /></button></div>
        <div className="space-y-4 p-5">
          <div className="grid grid-cols-2 gap-3 text-xs"><div><p className="text-muted-foreground">Source</p><p className="mt-0.5 font-medium text-foreground">{SOURCE_LABEL[item.source]}</p></div><div><p className="text-muted-foreground">Publisher</p><p className="mt-0.5 font-medium text-foreground">{item.publisher || item.owner || "Not verified"}</p></div><div className="col-span-2"><p className="text-muted-foreground">Pinned reference</p><p className="mt-0.5 break-all font-mono text-foreground">{item.installReference || "Unavailable"}</p></div></div>
          <div className={cn("rounded-lg border px-3 py-3", item.trust.status === "blocked" ? "border-danger-border bg-danger-bg" : item.trust.status === "trusted" ? "border-success-border bg-success-bg" : "border-warning-border bg-warning-bg")}>
            <p className={cn("flex items-center gap-2 text-sm font-medium", item.trust.status === "blocked" ? "text-danger-fg" : item.trust.status === "trusted" ? "text-success-fg" : "text-warning-fg")}>{item.trust.status === "trusted" ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}{item.trust.status === "trusted" ? "Registry checks passed" : item.trust.status === "blocked" ? "Installation blocked" : "This skill needs your review"}</p>
            <p className="mt-1 text-xs text-muted-foreground">{item.trust.status === "trusted" ? "The registry reports this version as installable." : item.trust.status === "blocked" ? "A registry or upstream scanner marked this skill unsafe." : "This source has no complete ClawHub scan. Agent Skills can contain executable scripts and instructions."}</p>
            {item.trust.signals.length > 0 && <div className="mt-2 space-y-1">{item.trust.signals.map((signal) => <p key={`${signal.provider}-${signal.status}`} className="text-xs text-muted-foreground">{signal.provider}: {signal.status}{signal.message ? ` — ${signal.message}` : ""}</p>)}</div>}
          </div>
          <label className="block space-y-1.5"><span className="text-xs font-medium text-foreground">Install for</span><select value={target} onChange={(event) => setTarget(event.target.value)} className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none"><option value="workspace">This workspace</option>{agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>Agent: {agent.name}</option>)}<option value="global">All workspaces on this OpenClaw host</option></select></label>
          <p className="text-xs text-muted-foreground">The skill will be installed off. Review its requirements and configuration in Installed, then enable it when ready.</p>
          {needsAcknowledgement && item.trust.status !== "blocked" && <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-xs text-foreground"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} className="mt-0.5" /><span>I understand this third-party skill is not fully scanned and may contain executable instructions or scripts.</span></label>}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-4"><button type="button" onClick={onCancel} disabled={busy} className="h-9 rounded-lg border border-border px-4 text-sm text-foreground hover:bg-muted">Cancel</button><button type="button" onClick={onConfirm} disabled={busy || item.trust.status === "blocked" || (needsAcknowledgement && !acknowledged)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background hover:opacity-90 disabled:opacity-40">{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}Install off</button></div>
      </div>
    </div>
  );
}

function DeleteSkillDialog({ item, busy, onCancel, onConfirm }: { item: InstalledSkillCatalogItem; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="skill-uninstall-title"><div className="w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-2xl"><h2 id="skill-uninstall-title" className="text-base font-semibold text-foreground">Uninstall {item.name}?</h2><p className="mt-2 text-sm text-muted-foreground">This deletes the workspace copy and removes its tracked ClawHub entry. It does not delete the skill from the registry. Built-in, shared, and global skills are protected.</p><div className="mt-5 flex justify-end gap-2"><button type="button" onClick={onCancel} disabled={busy} className="h-9 rounded-lg border border-border px-4 text-sm text-foreground hover:bg-muted">Cancel</button><button type="button" onClick={onConfirm} disabled={busy} className="inline-flex h-9 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-medium text-danger-foreground disabled:opacity-50">{busy ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}Uninstall</button></div></div></div>;
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
  const [pendingUninstall, setPendingUninstall] = useState<InstalledSkillCatalogItem | null>(null);
  const [uninstallingSkill, setUninstallingSkill] = useState<string | null>(null);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);
  const requestedTab = (searchParams.get("tab") || "").toLowerCase();
  const tab: SkillsPageTab = requestedTab === "discover" || requestedTab === "clawhub"
    ? "discover"
    : requestedTab === "built-in" ? "built-in" : requestedTab === "import" ? "import" : "installed";

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
    if (tab === "discover" || tab === "import") {
      setLoading(false);
      return;
    }
    queueMicrotask(() => {
      void fetchAll();
    });
  }, [fetchAll, selectedSkill, tab]);

  const filtered = useMemo(() => skills.filter((s) => {
    const origin = getSkillOrigin(s);
    if (tab === "built-in" && origin !== "bundled") return false;
    if (tab === "installed" && origin === "bundled") return false;
    if (search) {
      const q = search.toLowerCase();
      if (!s.name.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q)) return false;
    }
    if (filter === "eligible") return s.eligible;
    if (filter === "unavailable") return !s.eligible || s.blockedByAllowlist;
    if (filter === "workspace") return getSkillOrigin(s) === "workspace";
    if (filter === "bundled") return getSkillOrigin(s) === "bundled";
    return true;
  }), [skills, search, filter, tab]);

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
        ready: sectionSkills.filter((skill) => !skill.disabled && getAvailability(skill).state === "ready").length,
        needsSetup: sectionSkills.filter((skill) => !skill.disabled && getAvailability(skill).state === "needs-setup").length,
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

  const openWorkspaceUninstall = useCallback((skill: Skill) => {
    const slug = skill.skillKey || skill.name;
    setPendingUninstall({
      id: `workspace:${slug}`,
      slug,
      name: skill.name,
      version: "",
      source: "local",
      enabled: !skill.disabled,
      bundled: false,
      skillKey: slug,
      filePath: skill.filePath,
    });
  }, []);

  const confirmWorkspaceUninstall = useCallback(async () => {
    const item = pendingUninstall;
    if (!item) return;
    setUninstallingSkill(item.name);
    try {
      const response = await fetch("/api/skills/clawhub", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "uninstall", slug: item.slug, source: item.source }),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(String(payload?.error || "Could not uninstall this skill."));
      setPendingUninstall(null);
      setSkills((current) => current.filter((skill) => skill.name !== item.name));
      setToast({ msg: `Uninstalled ${item.name}`, type: "success" });
      requestRestart("A workspace skill was uninstalled.");
      await fetchAll();
    } catch (err) {
      setToast({ msg: `Error: ${err instanceof Error ? err.message : String(err)}`, type: "error" });
    } finally {
      setUninstallingSkill(null);
    }
  }, [fetchAll, pendingUninstall]);

  const handleClawHubInstalled = useCallback(async () => {
    try {
      const listRes = await fetch("/api/skills").then((r) => r.json());
      const latest = (listRes.skills || []) as Skill[];
      setSkills(latest);
      await fetchAll();
      requestRestart("Skill catalog was updated.");
    } catch {
      await fetchAll();
    }
  }, [fetchAll]);

  const switchTab = useCallback((next: SkillsPageTab) => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("section");
    if (next === "installed") params.delete("tab");
    else params.set("tab", next);
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
        <ContentLoadingState size="lg" />
      </SectionLayout>
    );
  }

  const workspaceCount = skills.filter((s) => getSkillOrigin(s) === "workspace").length;

  return (
    <SectionLayout>
      <SectionHeader
        className="py-2 md:py-3"
        title={
          <span className="flex items-center gap-2">
            <Wrench className="h-4 w-4 text-muted-foreground" />
            Skills
          </span>
        }
        description="Discover, install, configure, and manage Agent Skills without using the terminal."
        descriptionClassName="text-sm text-muted-foreground"
        meta={null}
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted p-0.5">
              {(["discover", "installed", "built-in", "import"] as const).map((item) => (
                <button key={item} type="button" onClick={() => switchTab(item)} className={cn("rounded-md px-2.5 py-1 text-xs font-medium transition-colors", tab === item ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {item === "discover" ? "Discover" : item === "installed" ? "Installed" : item === "built-in" ? "Built-in" : "Import"}
                </button>
              ))}
            </div>
            {(tab === "installed" || tab === "built-in") && <button type="button" onClick={fetchAll} className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted"><RefreshCw className="h-3 w-3" />Refresh</button>}
          </div>
        }
      />

      {(tab === "installed" || tab === "built-in") && (
        <SectionBody width="wide" padding="compact" innerClassName="space-y-4">
          {/* Summary + search in one scrollable area with the list */}
          {summary && (
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-4">
              <SumCard value={summary.total} label="Total" />
              <SumCard value={summary.eligible} label="Ready" title="On and ready for agents to use" />
              <SumCard value={workspaceCount} label="Installed" title="Installed in this project (e.g. from ClawHub)" />
              <SumCard value={summary.disabled} label="Off" title="Turned off" />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 min-w-44">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input placeholder="Search skills..." value={search} onChange={(e) => setSearch(e.target.value)} className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground text-foreground" />
              {search && <button onClick={() => setSearch("")} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>}
            </div>
            <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border bg-muted p-0.5">
              {(["all", "eligible", "unavailable"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={cn("rounded-md px-2 py-1 text-xs font-medium transition-colors", filter === f ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>
                  {f === "all" ? "All" : f === "eligible" ? "Ready" : "Needs attention"}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-4">
          {grouped.map((section) => (
            <section key={section.origin} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground">
                    {section.title} <span className="font-normal text-muted-foreground">{section.skills.length}</span>
                  </h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground" aria-label={`${section.ready} ready, ${section.disabled} off`}>
                  <span>{section.ready} ready</span>
                  {section.needsSetup > 0 && <span>{section.needsSetup} setup</span>}
                  {section.disabled > 0 && <span>{section.disabled} off</span>}
                </div>
              </div>
              <div className="divide-y divide-border">
                {section.skills.map((s) => (
                  <SkillCard
                    key={s.name}
                    skill={s}
                    onClick={() => router.push(`/skills/${encodeURIComponent(s.name)}`)}
                    onToggle={(enabled) => handleToggleSkill(s.name, enabled)}
                    onUninstall={getSkillOrigin(s) === "workspace" ? () => openWorkspaceUninstall(s) : undefined}
                    toggling={togglingSkill === s.name}
                    uninstalling={uninstallingSkill === s.name}
                  />
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

      {(tab === "discover" || tab === "import") && (
        <SectionBody width="wide" padding="compact" innerClassName="pb-6">
          <CatalogPanel
            mode={tab}
            onAction={handleAction}
            onInstalled={handleClawHubInstalled}
          />
        </SectionBody>
      )}
      {pendingUninstall && <DeleteSkillDialog item={pendingUninstall} busy={uninstallingSkill === pendingUninstall.name} onCancel={() => setPendingUninstall(null)} onConfirm={() => void confirmWorkspaceUninstall()} />}
      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
  );
}

/* ── Summary Card ───────────────────────────────── */

function SumCard({ value, label, title }: { value: number; label: string; title?: string }) {
  return (
    <div className="bg-card px-3 py-2.5" title={title}>
      <p className="text-base font-semibold tabular-nums leading-tight text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
