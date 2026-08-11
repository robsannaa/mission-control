"use client";

import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { runGbrainCommand } from "./api";
import { CodeLine, Panel } from "./primitives";
import type { GbrainCommand } from "./types";

/** Multi-line args get a textarea instead of a single-line input. */
function isLongFormArg(name: string, flag?: string): boolean {
  const key = `${name} ${flag ?? ""}`.toLowerCase();
  return key.includes("content") || key.includes("json") || key.includes("query");
}

function pretty(json: unknown): string {
  try {
    return JSON.stringify(json, null, 2);
  } catch {
    return String(json);
  }
}

/**
 * One runnable catalog command: label, description, argument inputs, a Run
 * button, and its result. This is the building block behind the Explore tab
 * — every G-Brain command stays reachable here even once it also has a
 * bespoke screen elsewhere.
 */
export function CommandRunner({ command, onRan }: { command: GbrainCommand; onRan?: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const run = useCallback(async (confirm = false) => {
    setRunning(true);
    setError(null);
    setConfirming(false);
    try {
      const d = await runGbrainCommand(command.id, values, confirm);
      if (d.needsConfirm) {
        setConfirming(true);
        return;
      }
      if (d.ok) {
        setOutput(d.json ? pretty(d.json) : d.stdout || "(no output)");
        onRan?.();
      } else {
        setError(d.error || "Command failed");
        setOutput(d.stdout || null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, [command.id, values, onRan]);

  return (
    <Panel className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{command.label}</span>
            {command.mutates && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
                  command.dangerous ? "bg-danger-bg text-danger-fg" : "bg-warning-bg text-warning-fg",
                )}
              >
                {command.dangerous ? "destructive" : "writes"}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{command.description}</p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={running}
          onClick={() => void run(confirming)}
          variant={confirming ? "destructive" : "default"}
        >
          {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
          {confirming ? "Confirm" : "Run"}
        </Button>
      </div>

      {command.args && command.args.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {command.args.map((a) =>
            isLongFormArg(a.name, a.flag) ? (
              <Textarea
                key={a.name}
                value={values[a.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                placeholder={`${a.placeholder ?? a.name}${a.required ? " *" : ""}`}
                className="min-h-[4.5rem] flex-1 basis-full text-xs"
              />
            ) : (
              <Input
                key={a.name}
                value={values[a.name] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [a.name]: e.target.value }))}
                placeholder={`${a.placeholder ?? a.name}${a.required ? " *" : ""}`}
                className="h-8 min-w-[8rem] flex-1 basis-40 text-xs"
              />
            ),
          )}
        </div>
      )}

      {confirming && !running && (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-warning-fg">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This is destructive. Click Confirm to go ahead, or change the fields above to cancel.
        </p>
      )}
      {error && (
        <p className="mt-2.5 flex items-start gap-1.5 text-xs text-danger-fg">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
      {output != null && (
        <div className="mt-2.5">
          {!error && (
            <p className="mb-1 flex items-center gap-1 text-[11px] text-success-fg">
              <CheckCircle2 className="h-3 w-3" /> done
            </p>
          )}
          <CodeLine className="max-h-72 overflow-y-auto">{output}</CodeLine>
        </div>
      )}
    </Panel>
  );
}
