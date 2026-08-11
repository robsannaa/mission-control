"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Cable, Ear, Loader2, Radio, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownContent } from "@/components/markdown-content";
import { runGbrainCommand } from "./api";
import { Disclosure, EmptyState, Panel, Pill, type Tone } from "./primitives";
import type { Doctor } from "./types";

type IntegrationEntry = {
  id: string;
  name: string;
  version?: string;
  description: string;
  category: string;
  status: string;
  setup_time?: string;
  requires: string[];
};

type IntegrationsPayload = {
  infra: IntegrationEntry[];
  senses: IntegrationEntry[];
  reflexes: IntegrationEntry[];
};

function statusTone(status: string): Tone {
  if (status === "configured") return "positive";
  if (status === "available") return "neutral";
  return "unknown";
}

function IntegrationRow({ item }: { item: IntegrationEntry }) {
  const [detail, setDetail] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const d = await runGbrainCommand("integrations-show", { id: item.id });
    setDetail(d.ok ? d.stdout : d.error || "Could not load this recipe.");
    setLoading(false);
  }, [item.id]);

  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">{item.name}</span>
            <Pill tone={statusTone(item.status)}>{item.status}</Pill>
            {item.setup_time && <span className="text-xs text-fg-subtle">{item.setup_time} setup</span>}
          </div>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{item.description}</p>
          {item.requires.length > 0 && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
              needs
              {item.requires.map((r) => <Pill key={r} tone="neutral" className="py-0.5">{r}</Pill>)}
            </div>
          )}
        </div>
      </div>
      <Disclosure
        label="Setup details"
        openLabel="Hide setup details"
        className="mt-2.5"
        onOpenChange={(open) => { if (open && detail === null && !loading) void load(); }}
      >
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : (
          <div className="max-h-96 overflow-y-auto rounded-lg border border-border-subtle bg-surface-inset px-4 py-3">
            <MarkdownContent content={detail ?? ""} className="[&_p]:text-xs [&_p]:leading-relaxed [&_h1]:text-xs [&_h2]:text-xs [&_li]:text-xs" />
          </div>
        )}
      </Disclosure>
    </div>
  );
}

function IntegrationGroup({ title, icon, items }: { title: string; icon: React.ReactNode; items: IntegrationEntry[] }) {
  if (items.length === 0) return null;
  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        {icon}
        <p className="text-sm font-semibold text-foreground">{title}</p>
        <span className="ml-auto text-xs text-fg-subtle">{items.length}</span>
      </div>
      <div className="divide-y divide-border-subtle">
        {items.map((item) => <IntegrationRow key={item.id} item={item} />)}
      </div>
    </Panel>
  );
}

export function IntegrationTab({ doctor }: { doctor: Doctor | null }) {
  const [payload, setPayload] = useState<IntegrationsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void runGbrainCommand("integrations-list").then((d) => {
      if (cancelled) return;
      if (d.ok && d.json) setPayload(d.json as IntegrationsPayload);
      else setError(d.error || "Could not load integrations.");
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  const reflexCheck = doctor?.checks?.find((c) => c.name === "retrieval_reflex_health");

  return (
    <div className="space-y-5">
      <Panel className="p-5">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border-subtle bg-surface-subtle">
            <Cable className="h-4.5 w-4.5 text-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">How G-Brain reaches OpenClaw</p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              A deterministic <span className="font-medium text-foreground">retrieval reflex</span> scans every turn for
              entities it recognises and injects a pointer (name → slug → one-line summary) — zero-LLM, fail-open — so
              the host agent knows a page exists before deciding whether to open it. Everything else here is a
              recipe: senses that feed the brain, and infrastructure the senses depend on.
            </p>
            {reflexCheck && (
              <div
                className={cn(
                  "mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs leading-relaxed",
                  reflexCheck.status === "ok" ? "border-success-border bg-success-bg text-success-fg" : "border-warning-border bg-warning-bg text-warning-fg",
                )}
              >
                {reflexCheck.status === "ok" ? <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
                <span>{reflexCheck.message}</span>
              </div>
            )}
          </div>
        </div>
      </Panel>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading integrations…
        </div>
      ) : error || !payload ? (
        <EmptyState icon={<Cable className="h-8 w-8" />} title="Could not load integrations" description={error ?? undefined} />
      ) : (
        <div className="space-y-5">
          <IntegrationGroup title="Reflexes — automated responses" icon={<Radio className="h-4 w-4 text-foreground" />} items={payload.reflexes} />
          <IntegrationGroup title="Senses — data flowing in" icon={<Ear className="h-4 w-4 text-foreground" />} items={payload.senses} />
          <IntegrationGroup title="Infrastructure — set up first" icon={<Cable className="h-4 w-4 text-foreground" />} items={payload.infra} />
        </div>
      )}
    </div>
  );
}
