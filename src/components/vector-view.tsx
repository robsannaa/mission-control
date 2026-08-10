"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Database, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ApiWarningBadge } from "@/components/ui/api-warning-badge";
import { VectorSkeleton } from "@/components/vector/skeleton";
import { SegmentedControl } from "@/components/vector/primitives";
import { TryTab } from "@/components/vector/try-tab";
import { SettingsTab } from "@/components/vector/settings-tab";
import type { AgentMemory, ProviderAvailability, StatusResponse, Toast } from "@/components/vector/types";

type Tab = "try" | "settings";

const EMPTY_AVAILABILITY: ProviderAvailability = {
  openai: { keyPresent: false },
  google: { keyPresent: false },
  ollama: { reachable: false, embeddingModels: [] },
  local: { pluginInstalled: false },
};

function ToastBar({ toast, onDone }: { toast: Toast; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border px-4 py-2.5 text-sm font-medium shadow-xl backdrop-blur-sm",
        toast.type === "success"
          ? "border-success-border bg-success-bg text-success-fg"
          : "border-danger-border bg-danger-bg text-danger-fg"
      )}
    >
      <div className="flex items-center gap-2">
        {toast.type === "success" ? <Check className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        {toast.message}
      </div>
    </div>
  );
}

/**
 * Vector Memory page.
 *
 * Two views, same split the Search page uses:
 *  - Try it (default) — browse what's indexed and run real searches. Where
 *    people actually spend time on this page.
 *  - Settings — provider, keys, indexing controls. Visited rarely, so its
 *    own data (document list, per-namespace detail) loads lazily inside it
 *    rather than on every page load.
 */
export function VectorView() {
  const [tab, setTab] = useState<Tab>("try");
  const [loading, setLoading] = useState(true);
  const [agents, setAgents] = useState<AgentMemory[]>([]);
  const [memorySearch, setMemorySearch] = useState<Record<string, unknown> | null>(null);
  const [providerAvailability, setProviderAvailability] = useState<ProviderAvailability>(EMPTY_AVAILABILITY);
  const [apiWarning, setApiWarning] = useState<string | null>(null);
  const [apiDegraded, setApiDegraded] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const [reindexingAgents, setReindexingAgents] = useState<Set<string>>(new Set());
  const [reindexingAll, setReindexingAll] = useState(false);
  const [deletingNamespace, setDeletingNamespace] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [savingKey, setSavingKey] = useState<"openai" | "google" | null>(null);
  const [disabling, setDisabling] = useState(false);

  const fetchStatus = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/vector?scope=status${fresh ? "&fresh=1" : ""}`);
      if (!res.ok) throw new Error(`Status fetch failed (${res.status})`);
      const data: StatusResponse = await res.json();
      setApiWarning(typeof data.warning === "string" && data.warning.trim() ? data.warning.trim() : null);
      setApiDegraded(Boolean(data.degraded));
      setAgents(data.agents || []);
      setMemorySearch(data.memorySearch || null);
      setProviderAvailability(data.providerAvailability || EMPTY_AVAILABILITY);
    } catch (err) {
      console.error("Vector fetch:", err);
      setApiWarning(err instanceof Error ? err.message : String(err));
      setApiDegraded(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  const primary = agents.find((a) => a.agentId === "main") || agents[0];
  const curProv = (memorySearch?.provider as string) || primary?.status.provider || "";
  const curModel = (memorySearch?.model as string) || primary?.status.model || "";
  const curDims = primary?.status.vector.dims || null;
  const isConfigured = Boolean(
    memorySearch && (memorySearch as Record<string, unknown>).provider &&
    (memorySearch as Record<string, unknown>).enabled !== false
  );

  const totalChunks = agents.reduce((s, a) => s + a.status.chunks, 0);
  const totalFiles = agents.reduce((s, a) => s + a.status.files, 0);
  const totalDb = agents.reduce((s, a) => s + a.dbSizeBytes, 0);
  const anyDirty = agents.some((a) => a.status.dirty);

  const activeProviderLabel = useMemo(() => {
    if (curProv === "openai") return "OpenAI";
    if (curProv === "gemini") return "Google Gemini";
    if (curProv === "ollama") return "Ollama";
    if (curProv === "local") return "your local model";
    return curProv || "an embedding provider";
  }, [curProv]);

  const handleReindex = useCallback(async (agentId: string, force: boolean) => {
    setReindexingAgents((prev) => new Set(prev).add(agentId));
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex", agent: agentId, force }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: force ? "Rebuilt from scratch." : "Index updated.", type: "success" });
        await fetchStatus(true);
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Update failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Update failed", type: "error" });
    } finally {
      setReindexingAgents((prev) => { const next = new Set(prev); next.delete(agentId); return next; });
    }
  }, [fetchStatus]);

  const handleReindexAll = useCallback(async () => {
    setReindexingAll(true);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reindex" }),
      });
      if (!res.ok) throw new Error(`Update failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: "Index updated.", type: "success" });
        await fetchStatus(true);
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Update failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Update failed", type: "error" });
    } finally {
      setReindexingAll(false);
    }
  }, [fetchStatus]);

  const handleDeleteNamespace = useCallback(async (agentId: string) => {
    const confirmed = window.confirm(
      `Delete the search index for "${agentId}"?\n\nThis removes the current index files. You can rebuild it later with "Update index."`
    );
    if (!confirmed) return;
    setDeletingNamespace(agentId);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-namespace", agent: agentId }),
      });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: `Deleted the index for ${agentId}.`, type: "success" });
        await fetchStatus(true);
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Delete failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Delete failed", type: "error" });
    } finally {
      setDeletingNamespace(null);
    }
  }, [fetchStatus]);

  const handleSwitchProvider = useCallback(async (target: { provider: string; model: string; localModelPath?: string }) => {
    setSwitching(true);
    try {
      const action = isConfigured ? "update-embedding-model" : "setup-memory";
      const body: Record<string, unknown> = { action, provider: target.provider, model: target.model };
      if (target.localModelPath) body.localModelPath = target.localModelPath;
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Switch failed (${res.status})`);
      const d = await res.json();
      if (d.ok) {
        setToast({ message: "Switched. Rebuilding the index now — this can take a few minutes.", type: "success" });
        await fetchStatus(true);
      } else {
        setToast({ message: typeof d.error === "string" ? d.error : "Switch failed", type: "error" });
      }
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Switch failed", type: "error" });
    } finally {
      setSwitching(false);
    }
  }, [isConfigured, fetchStatus]);

  const handleSaveKey = useCallback(async (provider: "openai" | "google", apiKey: string): Promise<boolean> => {
    if (!apiKey) {
      setToast({ message: "Enter a key first.", type: "error" });
      return false;
    }
    setSavingKey(provider);
    try {
      const res = await fetch("/api/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "auth-provider", provider, token: apiKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        throw new Error(typeof data.error === "string" ? data.error : "That key didn't validate.");
      }
      setToast({ message: "Key saved.", type: "success" });
      await fetchStatus(true);
      return true;
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to save key", type: "error" });
      return false;
    } finally {
      setSavingKey(null);
    }
  }, [fetchStatus]);

  const handleDisable = useCallback(async () => {
    const confirmed = window.confirm("Turn off semantic search? Your index stays on disk and picks back up if you turn it on again.");
    if (!confirmed) return;
    setDisabling(true);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable-memory" }),
      });
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const d = await res.json();
      if (!d.ok) throw new Error(typeof d.error === "string" ? d.error : "Failed to turn off");
      setToast({ message: "Semantic search is off. Turn it back on anytime.", type: "success" });
      await fetchStatus(true);
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "Failed to turn off", type: "error" });
    } finally {
      setDisabling(false);
    }
  }, [fetchStatus]);

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="flex items-center gap-2">
            <Database className="h-5 w-5 text-fg-secondary" />
            Memory search
          </span>
        }
        description="Semantic search across what your agent remembers"
        actions={
          <div className="flex items-center gap-2">
            <ApiWarningBadge warning={apiWarning} degraded={apiDegraded} />
            <button
              onClick={() => { setLoading(true); fetchStatus(true); }}
              className="rounded-lg p-2 text-muted-foreground hover:bg-foreground/10 hover:text-fg-secondary"
              aria-label="Refresh"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
          </div>
        }
      />
      <SectionBody width="content" padding="regular" innerClassName="space-y-5">
        {loading ? (
          <VectorSkeleton />
        ) : (
          <>
            <SegmentedControl
              options={[
                { value: "try" as Tab, label: "Try it" },
                { value: "settings" as Tab, label: "Settings" },
              ]}
              value={tab}
              onChange={setTab}
            />

            {tab === "try" ? (
              <TryTab
                agents={agents}
                isConfigured={isConfigured}
                providerLabel={activeProviderLabel}
                modelLabel={curModel}
                totalFiles={totalFiles}
                totalChunks={totalChunks}
                anyDirty={anyDirty}
                onGoToSettings={() => setTab("settings")}
                onReindexAll={handleReindexAll}
                reindexingAll={reindexingAll}
              />
            ) : (
              <SettingsTab
                agents={agents}
                isConfigured={isConfigured}
                curProv={curProv}
                curModel={curModel}
                curDims={curDims}
                totalFiles={totalFiles}
                totalChunks={totalChunks}
                totalDb={totalDb}
                providerAvailability={providerAvailability}
                onSwitchProvider={handleSwitchProvider}
                switching={switching}
                onSaveKey={handleSaveKey}
                savingKey={savingKey}
                onDisable={handleDisable}
                disabling={disabling}
                onReindex={handleReindex}
                reindexingAgents={reindexingAgents}
                onDeleteNamespace={handleDeleteNamespace}
                deletingNamespace={deletingNamespace}
              />
            )}
          </>
        )}
      </SectionBody>
      {toast && <ToastBar toast={toast} onDone={() => setToast(null)} />}
    </SectionLayout>
  );
}
