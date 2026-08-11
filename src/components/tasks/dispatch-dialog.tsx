"use client";

/**
 * Handing a card to an agent.
 *
 * Dispatching starts a real agent on the user's machine, so the dialog says in
 * plain language what is about to happen, and where. Two choices only — which
 * agent, and whether it runs in that agent's own session or as an isolated
 * subagent — plus room for anything the card does not already say.
 *
 * The prompt itself is built server-side and always invites the agent to ask
 * rather than guess. That is worth stating here: a question coming back is the
 * system working, not the run failing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, CornerDownLeft, Play, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBodyScrollLock, useFocusTrap } from "@/hooks/use-modal-accessibility";
import { useSubmitModifier } from "@/hooks/use-shortcut-label";
import { agentEmoji, type AgentInfo, type DispatchAssignee, type Task } from "./types";

export type DispatchIntent = {
  task: Task;
  /** Pre-selected from the card, if it already has an agent. */
  agentId?: string;
  assignee: DispatchAssignee;
};

export function DispatchDialog({
  intent,
  agents,
  onClose,
  onDispatch,
}: {
  intent: DispatchIntent;
  agents: AgentInfo[];
  onClose: () => void;
  /** Resolves once the server has answered, so the dialog can report failure. */
  onDispatch: (opts: {
    agentId: string;
    assignee: DispatchAssignee;
    context?: string;
  }) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [agentId, setAgentId] = useState(intent.agentId ?? agents[0]?.id ?? "");
  const [assignee, setAssignee] = useState<DispatchAssignee>(intent.assignee);
  // Prefill with the card's standing instructions so a run starts from them and
  // the user can tweak per-run without retyping.
  const [context, setContext] = useState(intent.task.customPrompt ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const contextRef = useRef<HTMLTextAreaElement>(null);
  const trapRef = useFocusTrap(true);
  useBodyScrollLock(true);
  const submitModifier = useSubmitModifier();

  const chosen = agents.find((a) => a.id === agentId);
  const agentName = chosen?.name ?? agentId ?? "the agent";

  const start = useCallback(async () => {
    if (!agentId || busy) return;
    setBusy(true);
    setError(null);
    const result = await onDispatch({
      agentId,
      assignee,
      context: context.trim() || undefined,
    });
    if (result.ok) {
      onClose();
      return;
    }
    setError(result.error || "The run could not be started.");
    setBusy(false);
  }, [agentId, assignee, busy, context, onClose, onDispatch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, start]);

  useEffect(() => {
    const id = window.setTimeout(() => contextRef.current?.focus(), 50);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 animate-backdrop-in"
      onClick={() => !busy && onClose()}
    >
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-label="Start a run"
        className="flex max-h-[82vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-xl animate-modal-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border-subtle px-5 py-3.5">
          <h3 className="text-sm font-semibold text-foreground">Start a run</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground" title={intent.task.title}>
            {intent.task.title}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {agents.length > 1 && (
            <label className="block">
              <span className="text-xs font-medium text-fg-secondary">Which agent</span>
              <select
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-border-subtle bg-background px-3 py-2 text-[13px] text-foreground outline-none transition-colors focus:border-border-strong"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.emoji} {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {/* Where it runs — two real choices, each with its consequence stated. */}
          <div>
            <span className="text-xs font-medium text-fg-secondary">Where it runs</span>
            <div className="mt-1.5 space-y-1.5">
              <RunModeOption
                selected={assignee === "agent"}
                onSelect={() => setAssignee("agent")}
                icon={
                  chosen ? (
                    <span className="leading-none">{agentEmoji(agents, agentId)}</span>
                  ) : (
                    <User className="h-3.5 w-3.5" />
                  )
                }
                title={agents.length > 1 ? `${agentName}'s own session` : "The agent's own session"}
                detail="Keeps its memory and everything you have said before. Retries continue the same conversation."
              />
              <RunModeOption
                selected={assignee === "subagent"}
                onSelect={() => setAssignee("subagent")}
                icon={<Boxes className="h-3.5 w-3.5" />}
                title="An isolated subagent"
                detail="A clean transcript every time, with no history to distract it. Nothing it does touches the main session."
              />
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-medium text-fg-secondary">
              Anything else it should know
              <span className="ml-1.5 font-normal text-fg-subtle">Optional</span>
            </span>
            <textarea
              ref={contextRef}
              value={context}
              onChange={(e) => setContext(e.target.value)}
              rows={3}
              placeholder="Constraints, a starting point, what to leave alone…"
              className="mt-1.5 w-full resize-y rounded-xl border border-border-subtle bg-background px-3 py-2.5 text-[13px] leading-relaxed text-foreground outline-none transition-colors placeholder:text-fg-placeholder focus:border-border-strong"
            />
          </label>

          {/* What will actually happen, said plainly. An agent id is not a
              sentence opener — it reads as a typo — so the name sits inside. */}
          <p className="text-[11px] leading-relaxed text-fg-subtle">
            This card&apos;s title, description and attachments go to {agentName},
            which is asked to raise a question rather than guess. If it does, the
            card moves to Review on its own and waits for you.
          </p>

          {error && (
            <p className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs leading-relaxed text-danger-fg">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-full px-3.5 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={start}
            disabled={!agentId || busy}
            className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Play className="h-3.5 w-3.5" />
            {busy ? "Starting…" : "Start the run"}
            <kbd className="ml-0.5 inline-flex items-center rounded border border-primary-foreground/25 px-1 text-[10px] font-medium opacity-70">
              {submitModifier}
              <CornerDownLeft className="h-2.5 w-2.5" />
            </kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

function RunModeOption({
  selected,
  onSelect,
  icon,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
        selected
          ? "border-border-strong bg-muted/60"
          : "border-border-subtle hover:border-border-strong hover:bg-muted/30",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          selected ? "border-foreground bg-foreground" : "border-border-strong",
        )}
      >
        {selected && <span className="h-1.5 w-1.5 rounded-full bg-card" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
          <span className="flex h-3.5 w-3.5 items-center justify-center text-muted-foreground">
            {icon}
          </span>
          {title}
        </span>
        <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
          {detail}
        </span>
      </span>
    </button>
  );
}
