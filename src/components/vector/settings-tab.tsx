"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, ExternalLink, KeyRound, Loader2,
  RefreshCw, RotateCcw, Trash2, X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentMemory, ProviderAvailability, VectorDocOption } from "./types";
import { CodeLine, Disclosure, Panel, Pill, StatusDot, type Tone } from "./primitives";
import { formatBytes, pluralize } from "./format";
import {
  DEFAULT_LOCAL_MODEL_PATH,
  LOCAL_EMBEDDING_PLUGIN_INSTALL_COMMAND,
  OPENAI_MODELS,
  PROVIDER_ROWS,
  matchProviderRow,
  type ProviderRowId,
} from "./providers";

function Dots() {
  return (
    <span className="inline-flex items-center gap-0.5">
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
    </span>
  );
}

const GHOST_BTN =
  "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-accent disabled:opacity-50";
const PRIMARY_BTN =
  "inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50";
const DANGER_GHOST_BTN =
  "inline-flex items-center gap-1.5 rounded-full border border-danger-border bg-danger-bg px-3 py-1.5 text-xs font-medium text-danger-fg transition-colors hover:bg-danger-bg/70 disabled:opacity-50";

type SwitchTarget = { provider: string; model: string; localModelPath?: string; row: ProviderRowId };

type SettingsTabProps = {
  agents: AgentMemory[];
  isConfigured: boolean;
  curProv: string;
  curModel: string;
  curDims: number | null;
  totalFiles: number;
  totalChunks: number;
  totalDb: number;
  providerAvailability: ProviderAvailability;
  onSwitchProvider: (target: SwitchTarget) => Promise<void>;
  switching: boolean;
  onSaveKey: (provider: "openai" | "google", key: string) => Promise<boolean>;
  savingKey: "openai" | "google" | null;
  onDisable: () => void;
  disabling: boolean;
  onReindex: (agentId: string, force: boolean) => void;
  reindexingAgents: Set<string>;
  onDeleteNamespace: (agentId: string) => void;
  deletingNamespace: string | null;
};

export function SettingsTab({
  agents,
  isConfigured,
  curProv,
  curModel,
  curDims,
  totalFiles,
  totalChunks,
  totalDb,
  providerAvailability,
  onSwitchProvider,
  switching,
  onSaveKey,
  savingKey,
  onDisable,
  disabling,
  onReindex,
  reindexingAgents,
  onDeleteNamespace,
  deletingNamespace,
}: SettingsTabProps) {
  const activeRow = useMemo(() => matchProviderRow(curProv, curModel), [curProv, curModel]);
  const [confirmTarget, setConfirmTarget] = useState<SwitchTarget | null>(null);
  const [openaiModel, setOpenaiModel] = useState<string>(
    curProv === "openai" ? curModel : OPENAI_MODELS[0].model
  );
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [geminiKeyDraft, setGeminiKeyDraft] = useState("");
  const [ollamaModel, setOllamaModel] = useState(
    curProv === "ollama" ? curModel : providerAvailability.ollama.embeddingModels[0] || ""
  );

  /** Exact match on provider AND model — a row can be the active provider while a
   *  different model tier is selected within it (e.g. OpenAI Standard -> Higher
   *  quality), which is still a real, actionable switch. */
  const isExactMatch = useCallback(
    (provider: string, model: string) => provider === curProv && model === curModel,
    [curProv, curModel]
  );

  const requestSwitch = useCallback(
    (target: SwitchTarget) => {
      const isFirstTimeSetup = !isConfigured;
      if (isExactMatch(target.provider, target.model)) return;
      if (isFirstTimeSetup) {
        void onSwitchProvider(target);
        return;
      }
      setConfirmTarget(target);
    },
    [isConfigured, isExactMatch, onSwitchProvider]
  );

  const confirmSwitch = useCallback(async () => {
    if (!confirmTarget) return;
    await onSwitchProvider(confirmTarget);
    setConfirmTarget(null);
  }, [confirmTarget, onSwitchProvider]);

  return (
    <div className="space-y-6">
      {/* Current selection */}
      <Panel className="p-4">
        <p className="text-xs font-medium uppercase tracking-wider text-fg-subtle">Currently using</p>
        {isConfigured ? (
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <StatusDot tone="positive" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  {activeRow ? PROVIDER_ROWS[activeRow].label : curProv}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{curModel}</span>
                </p>
                <p className="text-xs text-muted-foreground">
                  {curDims ? `${curDims} dimensions · ` : ""}
                  {formatBytes(totalDb)} on disk
                </p>
              </div>
            </div>
            <button type="button" onClick={onDisable} disabled={disabling} className={DANGER_GHOST_BTN}>
              {disabling ? <><Dots />Turning off…</> : <><X className="h-3 w-3" />Turn off</>}
            </button>
          </div>
        ) : (
          <p className="mt-1.5 text-sm text-muted-foreground">Not set up. Pick a provider below to turn on semantic search.</p>
        )}
      </Panel>

      {/* Provider rows */}
      <div>
        <h2 className="text-sm font-semibold text-foreground">
          {isConfigured ? "Change provider" : "Choose a provider"}
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {isConfigured
            ? "Switching rebuilds your whole search index with the new model."
            : "Pick whichever fits — free and local, or a hosted API with a key."}
        </p>

        <div className="mt-3 space-y-2">
          {/* OpenAI */}
          <ProviderRow
            id="openai"
            active={activeRow === "openai"}
            tone={providerAvailability.openai.keyPresent ? "positive" : "neutral"}
            statusLabel={providerAvailability.openai.keyPresent ? "Key on file" : "Needs an API key"}
          >
            <div className="flex flex-wrap items-center gap-2">
              {OPENAI_MODELS.map((m) => (
                <button
                  key={m.model}
                  type="button"
                  data-control-radius="pill"
                  onClick={() => setOpenaiModel(m.model)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                    openaiModel === m.model
                      ? "border-border-strong bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                  title={m.description}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {providerAvailability.openai.keyPresent ? (
              isExactMatch("openai", openaiModel) ? null : (
                <SwitchAction
                  label={activeRow === "openai" ? "Switch model" : "Switch to OpenAI"}
                  onClick={() => requestSwitch({ provider: "openai", model: openaiModel, row: "openai" })}
                  busy={switching}
                />
              )
            ) : (
              <KeyEntry
                placeholder="sk-…"
                keyDraft={openaiKeyDraft}
                setKeyDraft={setOpenaiKeyDraft}
                saving={savingKey === "openai"}
                onSave={async () => {
                  const ok = await onSaveKey("openai", openaiKeyDraft.trim());
                  if (ok) setOpenaiKeyDraft("");
                }}
                helpUrl="https://platform.openai.com/api-keys"
                helpLabel="platform.openai.com"
              />
            )}
          </ProviderRow>

          {/* Gemini */}
          <ProviderRow
            id="gemini"
            active={activeRow === "gemini"}
            tone={providerAvailability.google.keyPresent ? "positive" : "neutral"}
            statusLabel={providerAvailability.google.keyPresent ? "Key on file" : "Needs an API key"}
          >
            {providerAvailability.google.keyPresent ? (
              activeRow === "gemini" ? null : (
                <SwitchAction
                  label="Switch to Gemini"
                  onClick={() => requestSwitch({ provider: "gemini", model: "gemini-embedding-001", row: "gemini" })}
                  busy={switching}
                />
              )
            ) : (
              <KeyEntry
                placeholder="Paste Gemini API key…"
                keyDraft={geminiKeyDraft}
                setKeyDraft={setGeminiKeyDraft}
                saving={savingKey === "google"}
                onSave={async () => {
                  const ok = await onSaveKey("google", geminiKeyDraft.trim());
                  if (ok) setGeminiKeyDraft("");
                }}
                helpUrl="https://aistudio.google.com/apikey"
                helpLabel="aistudio.google.com"
              />
            )}
          </ProviderRow>

          {/* Ollama */}
          <ProviderRow
            id="ollama"
            active={activeRow === "ollama"}
            tone={providerAvailability.ollama.reachable ? "positive" : "neutral"}
            statusLabel={providerAvailability.ollama.reachable ? "Running on this machine" : "Not running"}
          >
            {providerAvailability.ollama.reachable ? (
              <>
                {providerAvailability.ollama.embeddingModels.length > 0 ? (
                  <select
                    value={ollamaModel}
                    onChange={(e) => setOllamaModel(e.target.value)}
                    aria-label="Ollama embedding model"
                    className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none"
                  >
                    {providerAvailability.ollama.embeddingModels.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={ollamaModel}
                    onChange={(e) => setOllamaModel(e.target.value)}
                    placeholder="e.g. nomic-embed-text"
                    aria-label="Ollama embedding model name"
                    className="rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-fg-secondary outline-none"
                  />
                )}
                {isExactMatch("ollama", ollamaModel.trim()) ? null : (
                  <SwitchAction
                    label={activeRow === "ollama" ? "Switch model" : "Switch to Ollama"}
                    onClick={() => requestSwitch({ provider: "ollama", model: ollamaModel.trim(), row: "ollama" })}
                    busy={switching}
                    disabled={!ollamaModel.trim()}
                  />
                )}
                {providerAvailability.ollama.embeddingModels.length === 0 && (
                  <p className="w-full text-xs text-fg-subtle">
                    No embedding model detected. Pull one, e.g. <code className="font-mono">ollama pull nomic-embed-text</code>, or type an installed model name above.
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-fg-subtle">Start Ollama on this machine to use it here.</p>
            )}
          </ProviderRow>

          {/* Local GGUF */}
          <ProviderRow
            id="local"
            active={activeRow === "local"}
            tone={providerAvailability.local.pluginInstalled ? "positive" : "neutral"}
            statusLabel={providerAvailability.local.pluginInstalled ? "Ready" : "Plugin not installed"}
          >
            {providerAvailability.local.pluginInstalled ? (
              activeRow === "local" ? null : (
                <SwitchAction
                  label="Switch to local model"
                  onClick={() =>
                    requestSwitch({
                      provider: "local",
                      model: "auto",
                      localModelPath: DEFAULT_LOCAL_MODEL_PATH,
                      row: "local",
                    })
                  }
                  busy={switching}
                />
              )
            ) : (
              <div className="w-full space-y-1.5">
                <p className="text-xs text-fg-subtle">Install the local embedding plugin first, then reload this page:</p>
                <CodeLine>{LOCAL_EMBEDDING_PLUGIN_INSTALL_COMMAND}</CodeLine>
              </div>
            )}
          </ProviderRow>
        </div>

        <p className="mt-3 px-1 text-xs text-fg-subtle">
          OpenClaw also supports Bedrock, DeepInfra, Mistral, Voyage, GitHub Copilot, LM Studio, and
          any OpenAI-compatible endpoint. Set those up directly in <code className="font-mono">openclaw.json</code> under{" "}
          <code className="font-mono">agents.defaults.memorySearch</code> — see the memory search docs.
        </p>

        {confirmTarget && (
          <Panel className="mt-3 border-warning-border bg-warning-bg p-4">
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-fg" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-warning-fg">
                  This rebuilds your whole search index
                </p>
                <p className="mt-1 text-xs text-warning-fg/90">
                  Switching to {PROVIDER_ROWS[confirmTarget.row].label} re-processes {pluralize(totalFiles, "file")}
                  {" "}({pluralize(totalChunks, "piece")} of memory) with the new model. It can take a few minutes.
                  Search keeps working on the current index until the new one is ready.
                </p>
                <div className="mt-3 flex items-center gap-2">
                  <button type="button" onClick={confirmSwitch} disabled={switching} className={PRIMARY_BTN}>
                    {switching ? <><Dots />Switching…</> : "Switch and rebuild"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmTarget(null)}
                    disabled={switching}
                    className={GHOST_BTN}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          </Panel>
        )}
      </div>

      {/* Also search these files */}
      <DocumentSelection isConfigured={isConfigured} />

      {/* Advanced / per-namespace details */}
      <div>
        <h2 className="text-sm font-semibold text-foreground">Advanced</h2>
        <div className="mt-3 space-y-2">
          {agents.map((agent) => (
            <NamespaceDetail
              key={agent.agentId}
              agent={agent}
              multi={agents.length > 1}
              onReindex={onReindex}
              onDelete={onDeleteNamespace}
              reindexing={reindexingAgents.has(agent.agentId)}
              deleting={deletingNamespace === agent.agentId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ── Provider row shell ────────────────────────────── */

function ProviderRow({
  id,
  active,
  tone,
  statusLabel,
  children,
}: {
  id: ProviderRowId;
  active: boolean;
  tone: Tone;
  statusLabel: string;
  children: React.ReactNode;
}) {
  const meta = PROVIDER_ROWS[id];
  return (
    <Panel className={cn("p-4", active && "border-border-strong")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <StatusDot tone={tone} className="mt-1" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{meta.label}</span>
              {active && <Pill tone="positive">Active</Pill>}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{meta.blurb}</p>
            <p className="mt-0.5 text-xs text-fg-subtle">{statusLabel}</p>
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 pl-[18px]">{children}</div>
    </Panel>
  );
}

function SwitchAction({
  label,
  onClick,
  busy,
  disabled,
}: {
  label: string;
  onClick: () => void;
  busy: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      data-control-radius="pill"
      onClick={onClick}
      disabled={busy || disabled}
      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-accent disabled:opacity-50"
    >
      {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : label}
    </button>
  );
}

function KeyEntry({
  placeholder,
  keyDraft,
  setKeyDraft,
  saving,
  onSave,
  helpUrl,
  helpLabel,
}: {
  placeholder: string;
  keyDraft: string;
  setKeyDraft: (v: string) => void;
  saving: boolean;
  onSave: () => void;
  helpUrl: string;
  helpLabel: string;
}) {
  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <KeyRound className="absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-fg-subtle" />
        <input
          type="password"
          value={keyDraft}
          onChange={(e) => setKeyDraft(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-md border border-border bg-muted py-1.5 pl-7 pr-2 font-mono text-xs text-foreground outline-none focus:border-border-strong"
        />
      </div>
      <button
        type="button"
        data-control-radius="pill"
        disabled={saving || !keyDraft.trim()}
        onClick={onSave}
        className="inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-accent disabled:opacity-50"
      >
        {saving ? <><Dots />Saving…</> : "Save key"}
      </button>
      <a
        href={helpUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-subtle underline hover:text-foreground"
      >
        Get a key <ExternalLink className="h-2.5 w-2.5" />
      </a>
    </div>
  );
}

/* ── Document selection ────────────────────────────── */

function DocumentSelection({ isConfigured }: { isConfigured: boolean }) {
  const [docs, setDocs] = useState<VectorDocOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/vector?scope=documents")
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setDocs(Array.isArray(data.docs) ? data.docs : []); })
      .catch(() => { if (!cancelled) setDocs([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const selectedPaths = useMemo(() => docs.filter((d) => d.selected).map((d) => d.path), [docs]);
  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.path.toLowerCase().includes(q));
  }, [docs, filter]);

  const save = useCallback(async () => {
    setSaving(true);
    setToast(null);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-extra-paths", extraPaths: selectedPaths, reindex: true }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) throw new Error(typeof d.error === "string" ? d.error : "Save failed");
      setToast(`Saved. Searching ${pluralize(selectedPaths.length, "extra file")} now.`);
    } catch (e) {
      setToast(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }, [selectedPaths]);

  if (!isConfigured) return null;

  return (
    <Disclosure label="Also search these files" defaultOpen={selectedPaths.length > 0 || docs.some((d) => d.source === "custom")}>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Beyond MEMORY.md and daily memory notes, you can include other Markdown files from the workspace.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter files…"
            aria-label="Filter files"
            className="min-w-56 flex-1 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground outline-none focus:border-border-strong"
          />
          <span className="text-xs text-muted-foreground">{selectedPaths.length} selected</span>
          <button type="button" onClick={save} disabled={saving} className={GHOST_BTN}>
            {saving ? <><Dots />Saving…</> : "Save"}
          </button>
        </div>
        {toast && <p className="text-xs text-muted-foreground">{toast}</p>}
        <div className="max-h-56 overflow-auto rounded-lg border border-border bg-card">
          {loading ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-3 text-xs text-muted-foreground">No other Markdown files found.</div>
          ) : (
            filtered.map((doc) => (
              <label
                key={doc.path}
                className="flex cursor-pointer items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-muted dark:hover:bg-secondary"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={doc.selected}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setDocs((prev) => prev.map((row) => (row.path === doc.path ? { ...row, selected: checked } : row)));
                    }}
                    className="rounded border-border"
                  />
                  <span className="truncate font-mono text-xs text-foreground" title={doc.path}>{doc.path}</span>
                </div>
                {doc.source === "custom" && <Pill tone="attention">Outside workspace</Pill>}
              </label>
            ))
          )}
        </div>
      </div>
    </Disclosure>
  );
}

/* ── Per-namespace advanced detail ─────────────────── */

function NamespaceDetail({
  agent,
  multi,
  onReindex,
  onDelete,
  reindexing,
  deleting,
}: {
  agent: AgentMemory;
  multi: boolean;
  onReindex: (id: string, force: boolean) => void;
  onDelete: (id: string) => void;
  reindexing: boolean;
  deleting: boolean;
}) {
  const st = agent.status;
  return (
    <Disclosure label={multi ? `${agent.agentId} — technical details` : "Technical details"}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Detail label="Backend" value={st.backend} />
          <Detail label="Provider" value={st.provider} />
          <Detail label="Model" value={st.model} />
          <Detail label="Dimensions" value={st.vector.dims ? String(st.vector.dims) : "—"} />
        </div>
        <div className="rounded-lg bg-muted/50 px-3 py-2">
          <p className="text-xs text-fg-subtle mb-0.5">Database file</p>
          <code className="text-xs text-muted-foreground break-all">{st.dbPath}</code>
        </div>
        {agent.scan.issues.length > 0 && (
          <div className="rounded-lg border border-warning-border bg-warning-bg px-3 py-2 space-y-1">
            <p className="flex items-center gap-1.5 text-xs font-medium text-warning-fg">
              <AlertTriangle className="h-3 w-3" />Issues
            </p>
            {agent.scan.issues.map((issue, i) => (
              <p key={i} className="pl-5 text-xs text-warning-fg">{issue}</p>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onReindex(agent.agentId, false)} disabled={reindexing || deleting} className={GHOST_BTN}>
            {reindexing ? <><Dots />Updating…</> : <><RefreshCw className="h-3 w-3" />Update index</>}
          </button>
          <button type="button" onClick={() => onReindex(agent.agentId, true)} disabled={reindexing || deleting} className={GHOST_BTN}>
            <RotateCcw className="h-3 w-3" />Rebuild from scratch
          </button>
          <button type="button" onClick={() => onDelete(agent.agentId)} disabled={reindexing || deleting} className={DANGER_GHOST_BTN}>
            {deleting ? <><Dots />Deleting…</> : <><Trash2 className="h-3 w-3" />Delete index</>}
          </button>
        </div>
      </div>
    </Disclosure>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted px-2.5 py-2">
      <div className="text-xs font-medium uppercase tracking-wider text-fg-subtle mb-0.5">{label}</div>
      <p className="truncate font-mono text-xs text-fg-secondary" title={value}>{value}</p>
    </div>
  );
}
