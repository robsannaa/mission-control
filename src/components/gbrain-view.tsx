"use client";

/**
 * G-Brain — a full window onto the standalone knowledge brain installed on
 * this machine. Everything is driven through /api/g-brain, which shells out
 * to the `gbrain` binary (there is no gateway RPC for it — see
 * src/lib/gbrain.ts for the safety model: argv-only, first-token allowlist).
 *
 * Six surfaces, reached through one pill tab bar:
 *  - Overview: health, category scores, brain stats, coverage.
 *  - Dreaming: the things the brain does on its own — the overnight Dream
 *    cycle (with a safe dry-run preview), Autopilot, and the Minions job queue.
 *  - Search: hybrid ask + keyword search, rendered as real result cards.
 *  - Browse: pages, backlinks, graph, timeline, tags and history — read any
 *    page in the brain.
 *  - Integration: the real seam into OpenClaw — retrieval reflex, senses,
 *    reflexes, infrastructure.
 *  - Explore: the complete command catalog, grouped and searchable, so every
 *    command G-Brain supports stays one click away.
 */

import { useCallback, useEffect, useState } from "react";
import { Cable, Compass, Moon, RefreshCw, Search as SearchIcon, Sparkles, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { SegmentedControl } from "@/components/gbrain/primitives";
import { OverviewTab } from "@/components/gbrain/overview-tab";
import { DreamingTab } from "@/components/gbrain/dreaming-tab";
import { SearchTab } from "@/components/gbrain/search-tab";
import { BrowseTab } from "@/components/gbrain/browse-tab";
import { IntegrationTab } from "@/components/gbrain/integration-tab";
import { ExploreTab } from "@/components/gbrain/explore-tab";
import type { GbrainCommand, Overview } from "@/components/gbrain/types";

type Tab = "overview" | "dreaming" | "search" | "browse" | "integration" | "explore";

const TABS: Array<{ value: Tab; label: string; icon: React.ReactNode }> = [
  { value: "overview", label: "Overview", icon: <Sparkles className="h-3.5 w-3.5" /> },
  { value: "dreaming", label: "Dreaming", icon: <Moon className="h-3.5 w-3.5" /> },
  { value: "search", label: "Search", icon: <SearchIcon className="h-3.5 w-3.5" /> },
  { value: "browse", label: "Browse", icon: <Compass className="h-3.5 w-3.5" /> },
  { value: "integration", label: "Integration", icon: <Cable className="h-3.5 w-3.5" /> },
  { value: "explore", label: "Explore", icon: <SlidersHorizontal className="h-3.5 w-3.5" /> },
];

export function GBrainView() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [commands, setCommands] = useState<GbrainCommand[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  const loadOverview = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      const res = await fetch("/api/g-brain?action=overview", { cache: "no-store" });
      setOverview(await res.json());
    } catch {
      setOverview({ installed: false });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    fetch("/api/g-brain?action=catalog", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setCommands(Array.isArray(d?.commands) ? d.commands : []))
      .catch(() => setCommands([]));
  }, [loadOverview]);

  const openPage = useCallback((slug: string) => {
    setSelectedSlug(slug);
    setTab("browse");
  }, []);

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border-subtle bg-surface-subtle">
              <Sparkles className="h-4 w-4 text-foreground" />
            </span>
            G-Brain
          </span>
        }
        description={
          <>
            Your personal knowledge brain, running locally
            {overview?.detection?.engine ? ` on ${overview.detection.engine}` : ""}
            {overview?.detection?.schemaPack ? ` · ${overview.detection.schemaPack}` : ""}.
          </>
        }
        actions={
          <button
            type="button"
            onClick={() => void loadOverview(true)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-border-strong hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            Refresh
          </button>
        }
      />
      <SectionBody width="wide" padding="regular" innerClassName="space-y-6">
        <SegmentedControl options={TABS} value={tab} onChange={setTab} />

        <div>
          {tab === "overview" && (
            <OverviewTab
              overview={overview}
              loading={loading}
              refreshing={refreshing}
              onRefresh={() => void loadOverview(true)}
              onGoToDreaming={() => setTab("dreaming")}
            />
          )}
          {tab === "dreaming" && <DreamingTab overview={overview} />}
          {tab === "search" && <SearchTab onOpenPage={openPage} />}
          {tab === "browse" && <BrowseTab selectedSlug={selectedSlug} onSelectSlug={setSelectedSlug} />}
          {tab === "integration" && <IntegrationTab doctor={overview?.doctor ?? null} />}
          {tab === "explore" && <ExploreTab commands={commands} />}
        </div>
      </SectionBody>
    </SectionLayout>
  );
}
