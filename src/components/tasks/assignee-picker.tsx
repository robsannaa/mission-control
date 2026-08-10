"use client";

/**
 * Who runs this card.
 *
 * Two decisions, one control: which agent owns the work, and whether it runs in
 * that agent's own session or as an isolated subagent. Most machines have a
 * single agent, so the common case is a two-line menu — the agent list only
 * earns its own section when there is more than one to choose from.
 */

import { Boxes, Check, ChevronDown, User } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AgentInfo, DispatchAssignee } from "./types";
import { agentEmoji, agentLabel } from "./types";

export function AssigneePicker({
  agents,
  agentId,
  assignee,
  disabled,
  onChange,
  className,
}: {
  agents: AgentInfo[];
  agentId?: string;
  assignee: DispatchAssignee;
  /** True while a run is in flight — reassigning mid-run would be a lie. */
  disabled?: boolean;
  onChange: (next: { agentId?: string; assignee: DispatchAssignee }) => void;
  className?: string;
}) {
  const label = agentId ? agentLabel(agents, agentId) : "Assign";
  const emoji = agentId ? agentEmoji(agents, agentId) : null;

  if (disabled) {
    return (
      <span
        className={cn(
          "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle px-2 py-0.5 text-xs text-muted-foreground",
          className,
        )}
      >
        <AssigneeFace emoji={emoji} assignee={assignee} />
        <span className="truncate">{label}</span>
        {assignee === "subagent" && <IsolatedTag />}
      </span>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-subtle px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:bg-muted hover:text-foreground data-[state=open]:border-border-strong data-[state=open]:bg-muted data-[state=open]:text-foreground",
            !agentId && "border-dashed",
            className,
          )}
          title="Choose who runs this task"
        >
          <AssigneeFace emoji={emoji} assignee={assignee} />
          <span className="truncate">{label}</span>
          {assignee === "subagent" && <IsolatedTag />}
          <ChevronDown className="h-3 w-3 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64"
        onClick={(e) => e.stopPropagation()}
      >
        {agents.length > 1 && (
          <>
            <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-fg-subtle">
              Agent
            </DropdownMenuLabel>
            {agents.map((agent) => (
              <Option
                key={agent.id}
                selected={agent.id === agentId}
                title={`${agent.emoji} ${agent.name}`}
                onSelect={() => onChange({ agentId: agent.id, assignee })}
              />
            ))}
            <div className="my-1 h-px bg-border-subtle" />
          </>
        )}

        <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-medium text-fg-subtle">
          Run this task with
        </DropdownMenuLabel>
        {agents.length === 1 && (
          <Option
            selected={agentId === agents[0].id && assignee === "agent"}
            title={`${agents[0].emoji} ${agents[0].name}`}
            detail="In the agent's own session, with its memory and context."
            onSelect={() => onChange({ agentId: agents[0].id, assignee: "agent" })}
          />
        )}
        {agents.length !== 1 && (
          <Option
            selected={Boolean(agentId) && assignee === "agent"}
            title="The agent's session"
            detail="Runs where the agent already lives, with its memory and context."
            onSelect={() => onChange({ agentId, assignee: "agent" })}
            disabled={!agentId}
          />
        )}
        <Option
          selected={Boolean(agentId) && assignee === "subagent"}
          title="An isolated subagent"
          detail="A fresh background run in its own session. Reports back when done."
          icon={<Boxes className="h-3.5 w-3.5" />}
          onSelect={() =>
            onChange({ agentId: agentId ?? agents[0]?.id, assignee: "subagent" })
          }
          disabled={!agentId && agents.length === 0}
        />

        {agentId && (
          <>
            <div className="my-1 h-px bg-border-subtle" />
            <Option
              selected={false}
              title="Unassign"
              onSelect={() => onChange({ agentId: undefined, assignee: "agent" })}
            />
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Option({
  selected,
  title,
  detail,
  icon,
  disabled,
  onSelect,
}: {
  selected: boolean;
  title: string;
  detail?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onSelect();
      }}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus:bg-muted focus:outline-none disabled:pointer-events-none disabled:opacity-40",
        selected && "bg-muted/60",
      )}
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground">
        {selected ? <Check className="h-3.5 w-3.5 text-foreground" /> : icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-foreground">{title}</span>
        {detail && (
          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
            {detail}
          </span>
        )}
      </span>
    </button>
  );
}

function AssigneeFace({
  emoji,
  assignee,
}: {
  emoji: string | null;
  assignee: DispatchAssignee;
}) {
  if (!emoji) return <User className="h-3 w-3 shrink-0" />;
  if (assignee === "subagent") return <Boxes className="h-3 w-3 shrink-0" />;
  return <span className="shrink-0 leading-none">{emoji}</span>;
}

function IsolatedTag() {
  return (
    <span className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
      isolated
    </span>
  );
}
