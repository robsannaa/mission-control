"use client";

import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CommandRunner } from "./command-runner";
import { EmptyState } from "./primitives";
import type { GbrainCategory, GbrainCommand } from "./types";

const CATEGORY_LABELS: Record<GbrainCategory, string> = {
  overview: "Overview & health",
  "auto-jobs": "Auto-jobs (dreaming, autopilot, minions)",
  search: "Search & ask",
  pages: "Pages",
  links: "Links & graph",
  tags: "Tags",
  timeline: "Timeline, salience & anomalies",
  sources: "Sources, import & export",
  files: "Files",
  code: "Code indexing",
  brain: "Ideation",
  maintenance: "Maintenance",
  integration: "OpenClaw integration",
};

const CATEGORY_ORDER: GbrainCategory[] = [
  "overview", "auto-jobs", "search", "pages", "links", "tags", "timeline",
  "sources", "files", "code", "brain", "maintenance", "integration",
];

/**
 * The complete command catalog, grouped and searchable. Every G-Brain
 * command stays reachable here even once it has a bespoke screen elsewhere —
 * this is what makes "run any command" literally true.
 */
export function ExploreTab({ commands }: { commands: GbrainCommand[] }) {
  const [filter, setFilter] = useState("");

  const grouped = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matches = (c: GbrainCommand) =>
      !q || c.label.toLowerCase().includes(q) || c.description.toLowerCase().includes(q) || c.id.includes(q);
    const by: Record<string, GbrainCommand[]> = {};
    for (const c of commands) {
      if (!matches(c)) continue;
      (by[c.category] ??= []).push(c);
    }
    return by;
  }, [commands, filter]);

  const total = Object.values(grouped).reduce((n, arr) => n + arr.length, 0);

  if (commands.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">Loading the command catalog…</div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Search all ${commands.length} commands…`}
          className="h-10 pl-10"
        />
      </div>

      {total === 0 ? (
        <EmptyState icon={<Search className="h-8 w-8" />} title="No matching commands" description="Try a different word." />
      ) : (
        CATEGORY_ORDER.filter((cat) => grouped[cat]?.length).map((cat) => (
          <section key={cat}>
            <h2 className="mb-2.5 text-sm font-semibold text-foreground">{CATEGORY_LABELS[cat]}</h2>
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {grouped[cat].map((c) => <CommandRunner key={c.id} command={c} />)}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
