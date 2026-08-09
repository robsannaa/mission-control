"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Brain,
  Search,
  ChevronRight,
  ChevronDown,
  Trash2,
  Copy,
  Pencil,
  ClipboardCopy,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  CircleDashed,
  HelpCircle,
  GitBranch,
  RefreshCw,
  FileText,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InlineMarkdownEditor } from "./inline-markdown-editor";
import { MemoryGraphView } from "./memory-graph-view";
import { SectionLayout } from "@/components/section-layout";
import { LoadingState } from "@/components/ui/loading-state";
import { SaveShortcut } from "@/components/ui/save-shortcut";

type CtxMenuState = { x: number; y: number; entry: DailyEntry } | null;

type VectorState = "indexed" | "stale" | "not_indexed" | "unknown";

type DailyEntry = {
  name: string;
  date: string;
  size?: number;
  words?: number;
  mtime?: string;
  vectorState?: VectorState;
};

type MemoryMd = {
  content: string;
  words: number;
  size: number;
  mtime?: string;
  fileName?: string;
  path?: string;
  vectorState?: VectorState;
  hasAltCaseFile?: boolean;
} | null;

type AgentMemoryFile = {
  agentId: string;
  agentName: string;
  isDefault: boolean;
  workspace: string;
  exists: boolean;
  fileName: string;
  path: string;
  hasAltCaseFile?: boolean;
  words: number;
  size: number;
  mtime?: string;
  vectorState?: VectorState;
  dirty?: boolean;
  indexedFiles?: number;
  indexedChunks?: number;
  scanIssues?: string[];
  provider?: string;
  model?: string;
};

type WorkspaceFile = {
  name: string;
  path: string;
  exists: boolean;
  size: number;
  mtime?: string;
  words: number;
  vectorState: VectorState;
};

type DetailMeta = {
  title: string;
  words?: number;
  size?: number;
  fileKey: string;
  fileName?: string;
  mtime?: string;
  kind: "core" | "journal" | "agent-memory" | "workspace-file";
  vectorState?: VectorState;
  workspace?: string;
  agentId?: string;
};

function vectorBadge(entry: { vectorState?: VectorState }): {
  label: string;
  className: string;
  Icon: React.ComponentType<{ className?: string }>;
} | null {
  switch (entry.vectorState) {
    case "indexed":
      return {
        label: "Indexed",
        className: "border-success-border bg-success-bg text-success-fg",
        Icon: CheckCircle2,
      };
    case "stale":
      return {
        label: "Stale",
        className: "border-warning-border bg-warning-bg text-warning-fg",
        Icon: AlertTriangle,
      };
    case "not_indexed":
      return {
        label: "Not Indexed",
        className: "border-border-strong/30 bg-muted-foreground/10 text-fg-subtle",
        Icon: CircleDashed,
      };
    default:
      // No badge when state is unknown — avoids confusing users
      return null;
  }
}

function formatBytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function formatAgo(d?: string) {
  if (!d) return "";
  const now = new Date();
  const diff = now.getTime() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `about ${hours}h ago`;
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function shortWorkspace(path: string): string {
  const clean = String(path || "").trim();
  if (!clean) return "workspace";
  const bits = clean.split("/").filter(Boolean);
  return bits[bits.length - 1] || clean;
}

const PERIOD_ORDER = ["Today", "Yesterday", "This Week", "This Month"] as const;

function parseDateLike(dateStr: string): Date {
  const isoDateOnlyMatch = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s-])/.exec(dateStr);
  if (isoDateOnlyMatch) {
    const year = Number(isoDateOnlyMatch[1]);
    const month = Number(isoDateOnlyMatch[2]);
    const day = Number(isoDateOnlyMatch[3]);
    return new Date(year, month - 1, day);
  }
  return new Date(dateStr);
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function getPeriodKey(dateStr: string): string {
  const d = parseDateLike(dateStr);
  if (isNaN(d.getTime())) return "Other";
  const now = startOfLocalDay(new Date());
  const date = startOfLocalDay(d);
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "This Week";
  if (days < 30) return "This Month";
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function groupByPeriod(entries: DailyEntry[]): { key: string; entries: DailyEntry[] }[] {
  const groups: Record<string, DailyEntry[]> = {};
  for (const e of entries) {
    const key = getPeriodKey(e.date);
    if (!groups[key]) groups[key] = [];
    groups[key].push(e);
  }
  const ordered: { key: string; entries: DailyEntry[] }[] = [];
  for (const key of PERIOD_ORDER) {
    if (groups[key]?.length) ordered.push({ key, entries: groups[key] });
  }
  const restKeys = Object.keys(groups).filter(
    (k) => !PERIOD_ORDER.includes(k as (typeof PERIOD_ORDER)[number])
  );
  restKeys.sort((a, b) => {
    const dateA = groups[a]?.[0]?.date ?? "";
    const dateB = groups[b]?.[0]?.date ?? "";
    return dateB.localeCompare(dateA);
  });
  for (const key of restKeys) {
    if (groups[key]?.length) ordered.push({ key, entries: groups[key] });
  }
  return ordered;
}

function normalizeMemoryPath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\/+/, "");
  if (trimmed.startsWith("memory/")) return trimmed.slice("memory/".length);
  return trimmed;
}

const JOURNAL_PREFIX = "journal:";
const AGENT_MEMORY_PREFIX = "agent-memory:";
const WORKSPACE_FILES_COLLAPSED_KEY = "memory.workspace-files-collapsed";

function journalKey(file: string): string {
  return `${JOURNAL_PREFIX}${file}`;
}

function agentMemoryKey(agentId: string): string {
  return `${AGENT_MEMORY_PREFIX}${agentId}`;
}

function selectedJournalFile(selected: string | null): string | null {
  if (!selected || !selected.startsWith(JOURNAL_PREFIX)) return null;
  return selected.slice(JOURNAL_PREFIX.length);
}

function selectedAgentId(selected: string | null): string | null {
  if (!selected || !selected.startsWith(AGENT_MEMORY_PREFIX)) return null;
  return selected.slice(AGENT_MEMORY_PREFIX.length);
}

export function MemoryView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState<"journal" | "graph">("journal");
  const [daily, setDaily] = useState<DailyEntry[]>([]);
  const [memoryMd, setMemoryMd] = useState<MemoryMd>(null);
  const [agentMemoryFiles, setAgentMemoryFiles] = useState<AgentMemoryFile[]>([]);
  const [workspaceFiles, setWorkspaceFiles] = useState<WorkspaceFile[]>([]);
  const [ensuringIndex, setEnsuringIndex] = useState(false);
  const [selected, setSelected] = useState<string | null>("memory");
  const [detailContent, setDetailContent] = useState<string | null>(null);
  const [detailMeta, setDetailMeta] = useState<DetailMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "unsaved" | null>(null);
  const [indexingFile, setIndexingFile] = useState<string | null>(null);
  const [reindexingAll, setReindexingAll] = useState(false);
  const [collapsedPeriods, setCollapsedPeriods] = useState<Set<string>>(new Set());
  const [workspaceFilesCollapsed, setWorkspaceFilesCollapsed] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasInitializedCollapse = useRef(false);
  const hasLoadedWorkspaceFilesCollapse = useRef(false);
  const jumpTarget = searchParams.get("memoryPath") || searchParams.get("memoryFile");
  const jumpLine = searchParams.get("memoryLine");
  const [scrollToLine, setScrollToLine] = useState<number | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>(null);
  const [renaming, setRenaming] = useState<DailyEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<DailyEntry | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);

  const saveContent = useCallback(
    async (content: string) => {
      if (!detailMeta) return;
      if (detailMeta.kind === "workspace-file") return; // read-only in this view
      setSaveStatus("saving");
      try {
        let body: Record<string, unknown> = { content };
        if (detailMeta.kind === "journal") {
          if (!detailMeta.fileName) throw new Error("missing journal file name");
          body = { file: detailMeta.fileName, content };
        } else if (detailMeta.kind === "agent-memory") {
          if (!detailMeta.agentId) throw new Error("missing agent id");
          body = { agentMemory: detailMeta.agentId, content };
        }

        const res = await fetch("/api/memory", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.ok) {
          const data = await res.json();
          setDetailContent(content);
          setDetailMeta((m) =>
            m
              ? {
                  ...m,
                  words: data.words || content.split(/\s+/).filter(Boolean).length,
                  size: data.size || new TextEncoder().encode(content).length,
                }
              : null
          );
          setSaveStatus("saved");
          setTimeout(() => setSaveStatus(null), 2000);
        } else {
          setSaveStatus("unsaved");
        }
      } catch {
        setSaveStatus("unsaved");
      }
    },
    [detailMeta]
  );

  const handleContentChange = useCallback(
    (newMarkdown: string) => {
      setSaveStatus("unsaved");
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        void saveContent(newMarkdown);
      }, 300);
    },
    [saveContent]
  );

  const handleSave = useCallback(
    (markdown: string) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      void saveContent(markdown);
    },
    [saveContent]
  );

  // Close context menu on click outside / escape
  useEffect(() => {
    if (!ctxMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: DailyEntry) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, entry });
    },
    []
  );

  const selectLongTermMemory = useCallback(() => {
    if (!memoryMd) return;
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSelected("memory");
    setSaveStatus(null);
    setDetailContent(memoryMd.content);
    setDetailMeta({
      title: "Core Workspace MEMORY.md",
      words: memoryMd.words,
      size: memoryMd.size,
      fileKey: "memory-core",
      mtime: memoryMd.mtime,
      kind: "core",
      vectorState: memoryMd.vectorState,
      workspace: "default",
    });
  }, [memoryMd]);

  const loadJournalFile = useCallback((file: string, title: string) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSelected(journalKey(file));
    setSaveStatus(null);
    fetch(`/api/memory?file=${encodeURIComponent(file)}`)
      .then((r) => r.json())
      .then((data) => {
        setDetailContent(data.content || "");
        setDetailMeta({
          title,
          words: data.words,
          size: data.size,
          fileKey: journalKey(file),
          fileName: file,
          kind: "journal",
          mtime: data.mtime,
          vectorState: daily.find((d) => d.name === file)?.vectorState,
          workspace: "default/memory",
        });
      })
      .catch(() => {
        setDetailContent("Failed to load.");
        setDetailMeta({
          title,
          fileKey: journalKey(file),
          fileName: file,
          kind: "journal",
        });
      });
  }, [daily]);

  const selectAgentMemory = useCallback((entry: AgentMemoryFile) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSelected(agentMemoryKey(entry.agentId));
    setSaveStatus(null);
    fetch(`/api/memory?agentMemory=${encodeURIComponent(entry.agentId)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(String(data.error));
        setDetailContent(String(data.content || ""));
        setDetailMeta({
          title: `${entry.agentName} · ${entry.fileName}`,
          words: Number(data.words || 0),
          size: Number(data.size || 0),
          fileKey: agentMemoryKey(entry.agentId),
          kind: "agent-memory",
          mtime: data.mtime,
          vectorState: (data.vectorState as VectorState) || entry.vectorState,
          workspace: entry.workspace,
          agentId: entry.agentId,
        });
      })
      .catch(() => {
        setDetailContent(entry.exists ? "Failed to load." : "");
        setDetailMeta({
          title: `${entry.agentName} · ${entry.fileName}`,
          words: entry.words,
          size: entry.size,
          fileKey: agentMemoryKey(entry.agentId),
          kind: "agent-memory",
          mtime: entry.mtime,
          vectorState: entry.vectorState,
          workspace: entry.workspace,
          agentId: entry.agentId,
        });
      });
  }, []);

  const fetchMemoryData = useCallback(async (initializeDetail = false) => {
    setLoading(true);
    try {
      const r = await fetch("/api/memory");
      const data = await r.json();
      const nextDaily = Array.isArray(data.daily) ? (data.daily as DailyEntry[]) : [];
      const nextAgents = Array.isArray(data.agentMemoryFiles)
        ? (data.agentMemoryFiles as AgentMemoryFile[])
        : [];
      const nextCore = (data.memoryMd || null) as MemoryMd;
      const nextWorkspaceFiles = Array.isArray(data.workspaceFiles)
        ? (data.workspaceFiles as WorkspaceFile[])
        : [];

      setDaily(nextDaily);
      setMemoryMd(nextCore);
      setAgentMemoryFiles(nextAgents);
      setWorkspaceFiles(nextWorkspaceFiles);

      if (!initializeDetail) return;
      if (nextCore) {
        setDetailContent(nextCore.content);
        setDetailMeta({
          title: "Core Workspace MEMORY.md",
          words: nextCore.words,
          size: nextCore.size,
          fileKey: "memory-core",
          mtime: nextCore.mtime,
          kind: "core",
          vectorState: nextCore.vectorState,
          workspace: "default",
        });
        setSelected("memory");
      } else if (nextAgents.length > 0) {
        selectAgentMemory(nextAgents[0]);
      }
    } finally {
      setLoading(false);
    }
  }, [selectAgentMemory]);

  const deleteEntry = useCallback(
    async (entry: DailyEntry) => {
      try {
        const res = await fetch(
          `/api/memory?file=${encodeURIComponent(entry.name)}`,
          { method: "DELETE" }
        );
        const data = await res.json();
        if (data.ok) {
          setDaily((prev) => prev.filter((d) => d.name !== entry.name));
          if (selected === journalKey(entry.name)) {
            if (memoryMd) {
              selectLongTermMemory();
            } else {
              setSelected(null);
              setDetailContent(null);
              setDetailMeta(null);
            }
          }
          setActionMsg({ ok: true, msg: `Deleted ${entry.name}` });
        } else {
          setActionMsg({ ok: false, msg: data.error || "Delete failed" });
        }
      } catch {
        setActionMsg({ ok: false, msg: "Delete failed" });
      }
      setConfirmDelete(null);
      setTimeout(() => setActionMsg(null), 3000);
    },
    [memoryMd, selectLongTermMemory, selected]
  );

  const renameEntry = useCallback(
    async (entry: DailyEntry, newName: string) => {
      if (!newName.trim() || newName === entry.name) {
        setRenaming(null);
        return;
      }
      try {
        const res = await fetch("/api/memory", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "rename", file: entry.name, newName }),
        });
        const data = await res.json();
        if (data.ok) {
          setDaily((prev) =>
            prev.map((d) =>
              d.name === entry.name ? { ...d, name: data.file } : d
            )
          );
          if (selected === journalKey(entry.name)) {
            setSelected(journalKey(data.file));
            setDetailMeta((m) =>
              m
                ? { ...m, fileKey: journalKey(data.file), fileName: data.file, title: data.file }
                : null
            );
          }
          setActionMsg({ ok: true, msg: `Renamed to ${data.file}` });
        } else {
          setActionMsg({ ok: false, msg: data.error || "Rename failed" });
        }
      } catch {
        setActionMsg({ ok: false, msg: "Rename failed" });
      }
      setRenaming(null);
      setTimeout(() => setActionMsg(null), 3000);
    },
    [selected]
  );

  const duplicateEntry = useCallback(async (entry: DailyEntry) => {
    try {
      const res = await fetch("/api/memory", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "duplicate", file: entry.name }),
      });
      const data = await res.json();
      if (data.ok) {
        await fetchMemoryData();
        setActionMsg({ ok: true, msg: `Duplicated as ${data.file}` });
      } else {
        setActionMsg({ ok: false, msg: data.error || "Duplicate failed" });
      }
    } catch {
      setActionMsg({ ok: false, msg: "Duplicate failed" });
    }
    setTimeout(() => setActionMsg(null), 3000);
  }, [fetchMemoryData]);

  const copyEntryName = useCallback((entry: DailyEntry) => {
    navigator.clipboard.writeText(entry.name).then(() => {
      setActionMsg({ ok: true, msg: "Filename copied to clipboard" });
      setTimeout(() => setActionMsg(null), 2000);
    });
  }, []);

  const indexJournalEntry = useCallback(
    async (entry: DailyEntry) => {
      const key = journalKey(entry.name);
      if (indexingFile) return;
      setIndexingFile(key);
      try {
        const res = await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "index-memory", file: entry.name }),
        });
        const data = await res.json();
        if (data.ok) {
          await fetchMemoryData();
          setActionMsg({ ok: true, msg: `Indexed ${entry.name}` });
        } else {
          setActionMsg({ ok: false, msg: data.error || "Indexing failed" });
        }
      } catch {
        setActionMsg({ ok: false, msg: "Indexing failed" });
      } finally {
        setIndexingFile(null);
        setTimeout(() => setActionMsg(null), 3000);
      }
    },
    [fetchMemoryData, indexingFile]
  );

  const indexAgentMemory = useCallback(
    async (entry: AgentMemoryFile) => {
      const key = agentMemoryKey(entry.agentId);
      if (indexingFile) return;
      setIndexingFile(key);
      try {
        const res = await fetch("/api/memory", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "index-memory",
            agentId: entry.agentId,
            file: entry.fileName,
          }),
        });
        const data = await res.json();
        if (data.ok) {
          await fetchMemoryData();
          setActionMsg({ ok: true, msg: `Indexed ${entry.agentName} memory` });
        } else {
          setActionMsg({ ok: false, msg: data.error || "Indexing failed" });
        }
      } catch {
        setActionMsg({ ok: false, msg: "Indexing failed" });
      } finally {
        setIndexingFile(null);
        setTimeout(() => setActionMsg(null), 3000);
      }
    },
    [fetchMemoryData, indexingFile]
  );

  const loadWorkspaceFile = useCallback((file: WorkspaceFile) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    const key = `workspace:${file.name}`;
    setSelected(key);
    setSaveStatus(null);
    fetch(`/api/memory?file=${encodeURIComponent(file.name)}&workspaceRoot=1`)
      .then((r) => r.json())
      .then((data) => {
        setDetailContent(String(data.content || ""));
        setDetailMeta({
          title: file.name,
          words: data.words ?? file.words,
          size: data.size ?? file.size,
          fileKey: key,
          fileName: file.name,
          kind: "workspace-file",
          mtime: data.mtime ?? file.mtime,
          vectorState: file.vectorState,
        });
      })
      .catch(() => {
        setDetailContent("Failed to load.");
        setDetailMeta({
          title: file.name,
          words: file.words,
          size: file.size,
          fileKey: key,
          fileName: file.name,
          kind: "workspace-file",
          mtime: file.mtime,
          vectorState: file.vectorState,
        });
      });
  }, []);

  const ensureWorkspaceIndex = useCallback(async () => {
    if (ensuringIndex) return;
    setEnsuringIndex(true);
    try {
      const res = await fetch("/api/vector", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "ensure-extra-paths" }),
      });
      const data = await res.json();
      if (data.ok) {
        await fetchMemoryData();
        setActionMsg({ ok: true, msg: "Workspace files added to index" });
      } else {
        setActionMsg({ ok: false, msg: data.error || "Index failed" });
      }
    } catch {
      setActionMsg({ ok: false, msg: "Index failed" });
    } finally {
      setEnsuringIndex(false);
      setTimeout(() => setActionMsg(null), 3000);
    }
  }, [ensuringIndex, fetchMemoryData]);

  const reindexAllMemory = useCallback(async () => {
    if (reindexingAll) return;
    setReindexingAll(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "index-memory", force: true }),
      });
      const data = await res.json();
      if (data.ok) {
        await fetchMemoryData();
        setActionMsg({ ok: true, msg: "Full memory reindex completed" });
      } else {
        setActionMsg({ ok: false, msg: data.error || "Reindex failed" });
      }
    } catch {
      setActionMsg({ ok: false, msg: "Reindex failed" });
    } finally {
      setReindexingAll(false);
      setTimeout(() => setActionMsg(null), 3000);
    }
  }, [fetchMemoryData, reindexingAll]);

  useEffect(() => {
    void fetchMemoryData(true);
  }, [fetchMemoryData]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(WORKSPACE_FILES_COLLAPSED_KEY);
      if (raw == null) return;
      setWorkspaceFilesCollapsed(raw === "1");
    } catch {
      // ignore storage errors
    } finally {
      hasLoadedWorkspaceFilesCollapse.current = true;
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!hasLoadedWorkspaceFilesCollapse.current) return;
    try {
      window.localStorage.setItem(
        WORKSPACE_FILES_COLLAPSED_KEY,
        workspaceFilesCollapsed ? "1" : "0"
      );
    } catch {
      // ignore storage errors
    }
  }, [workspaceFilesCollapsed]);

  const clearSearchJumpParams = useCallback(() => {
    const next = new URLSearchParams(searchParams.toString());
    let changed = false;
    for (const key of ["memoryPath", "memoryFile", "memoryLine", "memoryQuery"]) {
      if (next.has(key)) {
        next.delete(key);
        changed = true;
      }
    }
    if (!changed) return;
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const filteredDaily = useMemo(() => {
    if (!search.trim()) return daily;
    const q = search.toLowerCase();
    return daily.filter(
      (e) =>
        e.date.toLowerCase().includes(q) ||
        e.name.toLowerCase().includes(q)
    );
  }, [daily, search]);

  const filteredAgentMemories = useMemo(() => {
    if (!search.trim()) return agentMemoryFiles;
    const q = search.toLowerCase();
    return agentMemoryFiles.filter((entry) => {
      return (
        entry.agentName.toLowerCase().includes(q) ||
        entry.agentId.toLowerCase().includes(q) ||
        entry.fileName.toLowerCase().includes(q) ||
        entry.workspace.toLowerCase().includes(q)
      );
    });
  }, [agentMemoryFiles, search]);

  const filteredWorkspaceFiles = useMemo(() => {
    if (!search.trim()) return workspaceFiles;
    const q = search.toLowerCase();
    return workspaceFiles.filter((f) => f.name.toLowerCase().includes(q));
  }, [workspaceFiles, search]);

  const hasUnindexedWorkspaceFiles = workspaceFiles.some(
    (f) => f.vectorState === "not_indexed" || f.vectorState === "stale"
  );

  const periodGroups = groupByPeriod(filteredDaily);

  const periodGroupKeys = periodGroups.map((g) => g.key).join(",");
  useEffect(() => {
    if (loading || periodGroups.length === 0 || hasInitializedCollapse.current) return;
    hasInitializedCollapse.current = true;
    setCollapsedPeriods((prev) => {
      const next = new Set(prev);
      periodGroups.forEach(({ key }) => {
        if (key !== "Today" && key !== "Yesterday" && key !== "This Week") next.add(key);
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, periodGroupKeys]);

  useEffect(() => {
    if (loading || !jumpTarget) return;
    const normalized = normalizeMemoryPath(jumpTarget);
    if (!normalized) {
      clearSearchJumpParams();
      return;
    }

    const lineNum = jumpLine ? parseInt(jumpLine, 10) : null;
    const validLine = lineNum && Number.isFinite(lineNum) ? lineNum : null;

    setActiveTab("journal");
    const normalizedLower = normalized.toLowerCase();
    const isLongTerm = normalizedLower === "memory.md" || normalizedLower === "memory";

    if (isLongTerm && memoryMd) {
      selectLongTermMemory();
      if (validLine) setScrollToLine(validLine);
      clearSearchJumpParams();
      return;
    }

    const byJournal = daily.find((d) => d.name.toLowerCase() === normalizedLower);
    if (byJournal) {
      loadJournalFile(byJournal.name, byJournal.date);
      if (validLine) setScrollToLine(validLine);
      clearSearchJumpParams();
      return;
    }

    const byAgentPath = agentMemoryFiles.find((entry) => {
      const p = entry.path.toLowerCase();
      return p === normalizedLower || normalizedLower.endsWith(`/${entry.fileName.toLowerCase()}`) && normalizedLower.includes(shortWorkspace(entry.workspace).toLowerCase());
    });

    if (byAgentPath) {
      selectAgentMemory(byAgentPath);
      if (validLine) setScrollToLine(validLine);
      clearSearchJumpParams();
      return;
    }

    // Check workspace files (AGENTS.md, IDENTITY.md, etc.)
    const byWorkspace = workspaceFiles.find(
      (f) => f.name.toLowerCase() === normalizedLower
    );
    if (byWorkspace) {
      setWorkspaceFilesCollapsed(false);
      loadWorkspaceFile(byWorkspace);
      if (validLine) setScrollToLine(validLine);
      clearSearchJumpParams();
      return;
    }

    loadJournalFile(normalized, normalized);
    if (validLine) setScrollToLine(validLine);
    clearSearchJumpParams();
  }, [
    agentMemoryFiles,
    clearSearchJumpParams,
    daily,
    jumpLine,
    jumpTarget,
    loadJournalFile,
    loadWorkspaceFile,
    loading,
    memoryMd,
    selectAgentMemory,
    selectLongTermMemory,
    workspaceFiles,
  ]);

  // Clear scrollToLine after it's been consumed by the editor
  useEffect(() => {
    if (scrollToLine == null) return;
    const timer = setTimeout(() => setScrollToLine(null), 500);
    return () => clearTimeout(timer);
  }, [scrollToLine]);

  const togglePeriod = (key: string) => {
    setCollapsedPeriods((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const isExpanded = (key: string) => !collapsedPeriods.has(key);
  const currentJournalFile = selectedJournalFile(selected);
  const currentAgentId = selectedAgentId(selected);

  const selectedDailyEntry = currentJournalFile
    ? daily.find((d) => d.name === currentJournalFile) || null
    : null;
  const selectedAgentMemory = currentAgentId
    ? agentMemoryFiles.find((a) => a.agentId === currentAgentId) || null
    : null;

  const canIndexSelectedJournal =
    !!selectedDailyEntry &&
    (selectedDailyEntry.vectorState === "stale" ||
      selectedDailyEntry.vectorState === "not_indexed");

  const canIndexSelectedAgent =
    !!selectedAgentMemory &&
    (selectedAgentMemory.vectorState === "stale" ||
      selectedAgentMemory.vectorState === "not_indexed" ||
      Boolean(selectedAgentMemory.dirty));

  const tabBar = (
    <div className="shrink-0 border-b border-foreground/10 bg-card/50 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-foreground/10 bg-card p-1">
          <button
            type="button"
            onClick={() => setActiveTab("journal")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === "journal"
                ? "bg-muted-foreground/15 text-fg-secondary"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Brain className="h-3.5 w-3.5" />
            Memory Files
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("graph")}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
              activeTab === "graph"
                ? "bg-info-bg text-info-fg"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <GitBranch className="h-3.5 w-3.5" />
            Knowledge Graph
          </button>
        </div>
        <button
          type="button"
          onClick={() => void reindexAllMemory()}
          disabled={reindexingAll}
          className="inline-flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-foreground/5 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/10 disabled:opacity-50"
          title="Re-index all memory files into the vector store"
        >
          {reindexingAll ? (
            <span className="inline-flex items-center gap-0.5">
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
            </span>
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          {reindexingAll ? "Reindexing..." : "Reindex All"}
        </button>
      </div>
    </div>
  );

  if (activeTab === "graph") {
    return (
      <SectionLayout>
        {tabBar}
        <MemoryGraphView />
      </SectionLayout>
    );
  }

  return (
    <SectionLayout>
      {tabBar}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
        {/* Left panel */}
        <div className="flex max-h-96 w-full shrink-0 flex-col overflow-hidden border-b border-foreground/10 bg-card/60 md:max-h-none md:w-80 md:border-b-0 md:border-r">
          <div className="shrink-0 p-3">
            <div className="flex items-center gap-2 rounded-lg border border-foreground/10 bg-card px-3 py-2 text-sm text-muted-foreground">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                placeholder="Search memory files, agents, workspaces..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search memory files, agents, workspaces"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 pb-3">
         

            {/* Core workspace memory */}
            {memoryMd && (
              <button
                type="button"
                onClick={selectLongTermMemory}
                className={cn(
                  "mb-4 flex w-full flex-col gap-1.5 rounded-xl border p-4 text-left transition-colors",
                  selected === "memory"
                    ? "border-border-strong bg-muted-foreground/10 ring-1 ring-border"
                    : "border-border-strong bg-muted-foreground/5 hover:bg-muted-foreground/10"
                )}
              >
                <div className="flex items-center gap-2 text-fg-secondary">
                  <Brain className="h-4 w-4" />
                  <span className="text-sm font-medium">Core Workspace MEMORY.md</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  {(() => {
                    const badge = vectorBadge(memoryMd);
                    if (!badge) return null;
                    const Icon = badge.Icon;
                    return (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-1 py-0.5 text-xs font-medium",
                          badge.className
                        )}
                      >
                        <Icon className="h-2.5 w-2.5" />
                        {badge.label}
                      </span>
                    );
                  })()}
                  <span className="text-xs text-muted-foreground">
                    {memoryMd.words} words • {formatAgo(memoryMd.mtime) || "Updated recently"}
                  </span>
                </div>
              </button>
            )}

            {/* Workspace reference files */}
            {filteredWorkspaceFiles.length > 0 && (
              <div className="mb-4">
                <div className="mb-2 flex items-center gap-2 px-1">
                  <button
                    type="button"
                    onClick={() => setWorkspaceFilesCollapsed((prev) => !prev)}
                    aria-expanded={!workspaceFilesCollapsed}
                    aria-controls="workspace-files-list"
                    className="inline-flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-fg-subtle transition-colors hover:text-muted-foreground"
                  >
                    {workspaceFilesCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>Workspace Files</span>
                    <span className="rounded bg-muted/80 px-1.5 py-0.5 text-xs text-muted-foreground">
                      {filteredWorkspaceFiles.length}
                    </span>
                  </button>
                  {hasUnindexedWorkspaceFiles && (
                    <button
                      type="button"
                      onClick={() => void ensureWorkspaceIndex()}
                      disabled={ensuringIndex}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-info-border bg-info-bg px-2 py-0.5 text-xs font-medium text-info-fg hover:bg-info-bg disabled:opacity-60"
                    >
                      {ensuringIndex ? (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                        </span>
                      ) : (
                        <RefreshCw className="h-2.5 w-2.5" />
                      )}
                      {ensuringIndex ? "Indexing…" : "Add to Index"}
                    </button>
                  )}
                </div>
                <div
                  id="workspace-files-list"
                  className={cn("space-y-1.5", workspaceFilesCollapsed && "hidden")}
                >
                    {filteredWorkspaceFiles.map((file) => {
                      const key = `workspace:${file.name}`;
                      const selectedHere = selected === key;
                      const badge = vectorBadge(file);
                      return (
                        <button
                          key={file.name}
                          type="button"
                          onClick={() => loadWorkspaceFile(file)}
                          className={cn(
                            "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                            selectedHere
                              ? "border-info-border bg-info-bg ring-1 ring-info-border"
                              : "border-foreground/10 bg-foreground/5 hover:bg-foreground/8"
                          )}
                        >
                          <div className="flex items-center gap-2">
                            <FileText className="h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                            <span className="flex-1 truncate text-xs font-medium text-foreground">
                              {file.name}
                            </span>
                          </div>
                          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                            {badge && (() => {
                              const BadgeIcon = badge.Icon;
                              return (
                                <span
                                  className={cn(
                                    "inline-flex items-center gap-1 rounded-full border px-1 py-0.5 text-xs font-medium",
                                    badge.className
                                  )}
                                >
                                  <BadgeIcon className="h-2.5 w-2.5" />
                                  {badge.label}
                                </span>
                              );
                            })()}
                            <span className="text-xs text-muted-foreground">
                              {file.words > 0 ? `${file.words}w` : "empty"}
                              {file.mtime ? ` • ${formatAgo(file.mtime)}` : ""}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            {/* Agent memory files */}
            <div className="mb-2 flex items-center gap-2 px-1">
              <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                Agent MEMORY Files
              </span>
              <span className="rounded bg-muted/80 px-1.5 py-0.5 text-xs text-muted-foreground">
                {filteredAgentMemories.length}
              </span>
            </div>

            <div className="mb-4 space-y-1.5">
              {filteredAgentMemories.map((entry) => {
                const key = agentMemoryKey(entry.agentId);
                const selectedHere = selected === key;
                const needsIndex =
                  entry.vectorState === "stale" ||
                  entry.vectorState === "not_indexed" ||
                  Boolean(entry.dirty);
                const badge = vectorBadge(entry);

                return (
                  <button
                    key={entry.agentId}
                    type="button"
                    onClick={() => selectAgentMemory(entry)}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                      selectedHere
                        ? "border-info-border bg-info-bg ring-1 ring-info-border"
                        : "border-foreground/10 bg-foreground/5 hover:bg-foreground/5"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-foreground">
                          {entry.agentName}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {entry.agentId} • {shortWorkspace(entry.workspace)}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        {entry.isDefault && (
                          <span className="rounded bg-muted-foreground/20 px-1.5 py-0.5 text-xs font-medium text-fg-secondary">
                            default
                          </span>
                        )}
                        {!entry.exists && (
                          <span className="rounded bg-warning-bg px-1.5 py-0.5 text-xs font-medium text-warning-fg">
                            missing
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {badge && (() => {
                        const BadgeIcon = badge.Icon;
                        return (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1 rounded-full border px-1 py-0.5 text-xs font-medium",
                              badge.className
                            )}
                          >
                            <BadgeIcon className="h-2.5 w-2.5" />
                            {badge.label}
                          </span>
                        );
                      })()}
                      {entry.dirty && (
                        <span className="rounded border border-warning-border bg-warning-bg px-1.5 py-0.5 text-xs font-medium text-warning-fg">
                          index dirty
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {entry.exists ? `${entry.words}w` : "No file"} • {entry.indexedFiles ?? 0} files
                      </span>
                      {needsIndex && (
                        <span
                          role="button"
                          tabIndex={0}
                          onClick={(ev) => {
                            ev.preventDefault();
                            ev.stopPropagation();
                            if (indexingFile !== key) void indexAgentMemory(entry);
                          }}
                          onKeyDown={(ev) => {
                            if (ev.key === "Enter" || ev.key === " ") {
                              ev.preventDefault();
                              ev.stopPropagation();
                              if (indexingFile !== key) void indexAgentMemory(entry);
                            }
                          }}
                          className={cn(
                            "ml-auto inline-flex cursor-pointer items-center gap-1 rounded-md border border-info-border bg-info-bg px-1.5 py-0.5 text-xs font-medium text-info-fg hover:bg-info-bg",
                            indexingFile === key && "opacity-60 pointer-events-none"
                          )}
                        >
                          {indexingFile === key ? (
                            <span className="inline-flex items-center gap-0.5">
                              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                              <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                            </span>
                          ) : (
                            <RefreshCw className="h-2.5 w-2.5" />
                          )}
                          {indexingFile === key ? "Indexing" : "Index"}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}

              {!loading && filteredAgentMemories.length === 0 && (
                <p className="px-1 text-xs text-muted-foreground">No matching agent memory files.</p>
              )}
            </div>

            {/* Daily journal section */}
            <div className="flex items-center gap-2 px-1">
              <span className="text-xs font-medium uppercase tracking-wider text-fg-subtle">
                Daily Journal
              </span>
              <span className="rounded bg-muted/80 px-1.5 py-0.5 text-xs text-muted-foreground">
                {filteredDaily.length}
              </span>
            </div>

            {loading ? (
              <LoadingState className="mt-4 px-1 justify-start" />
            ) : (
              <div className="mt-2 space-y-0">
                {periodGroups.map(({ key, entries: entriesInGroup }) => {
                  const expanded = isExpanded(key);
                  return (
                    <div key={key} className="border-b border-foreground/5 last:border-0">
                      <button
                        type="button"
                        onClick={() => togglePeriod(key)}
                        className="flex w-full items-center gap-1.5 py-2 text-left text-xs font-medium text-muted-foreground hover:text-muted-foreground"
                      >
                        {expanded ? (
                          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span>
                          {key} ({entriesInGroup.length})
                        </span>
                      </button>
                      {expanded && (
                        <div className="space-y-0.5 pb-2 pl-5">
                          {entriesInGroup.map((e) => {
                            const isRenaming = renaming?.name === e.name;
                            const isDeleting = confirmDelete?.name === e.name;
                            const key = journalKey(e.name);

                            if (isDeleting) {
                              return (
                                <div
                                  key={e.name}
                                  className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-1.5"
                                >
                                  <Trash2 className="h-3 w-3 shrink-0 text-danger-fg" />
                                  <span className="flex-1 truncate text-xs text-danger-fg">
                                    Delete {e.name}?
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => deleteEntry(e)}
                                    className="rounded-full bg-destructive px-2 py-0.5 text-xs font-medium text-white hover:bg-destructive/88"
                                  >
                                    Delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDelete(null)}
                                    className="text-xs text-muted-foreground hover:text-fg-secondary"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              );
                            }

                            if (isRenaming) {
                              return (
                                <div
                                  key={e.name}
                                  className="flex items-center gap-2 rounded-lg border border-border-strong bg-card px-3 py-1.5"
                                >
                                  <Pencil className="h-3 w-3 shrink-0 text-fg-secondary" />
                                  <input
                                    value={renameValue}
                                    onChange={(ev) =>
                                      setRenameValue(ev.target.value)
                                    }
                                    onKeyDown={(ev) => {
                                      if (ev.key === "Enter")
                                        void renameEntry(e, renameValue);
                                      if (ev.key === "Escape")
                                        setRenaming(null);
                                    }}
                                    onBlur={() => void renameEntry(e, renameValue)}
                                    aria-label="Rename file"
                                    className="flex-1 bg-transparent text-sm text-foreground outline-none"
                                    autoFocus
                                  />
                                </div>
                              );
                            }

                            return (
                              <button
                                key={e.name}
                                type="button"
                                onClick={() => loadJournalFile(e.name, e.date)}
                                onContextMenu={(ev) =>
                                  handleContextMenu(ev, e)
                                }
                                className={cn(
                                  "flex w-full justify-between rounded-lg px-3 py-1.5 text-left text-sm transition-colors",
                                  selected === key
                                    ? "bg-muted text-fg-secondary"
                                    : "text-muted-foreground hover:bg-muted/60 hover:text-fg-secondary"
                                )}
                              >
                                <span className="text-sm">
                                  {(() => {
                                    const d = parseDateLike(e.date);
                                    return isNaN(d.getTime())
                                      ? e.date
                                      : d.toLocaleDateString("en-US", {
                                          weekday: "short",
                                          month: "short",
                                          day: "numeric",
                                        });
                                  })()}
                                </span>
                                <span className="flex items-center gap-2">
                                  <span className="text-xs text-fg-subtle">
                                    {e.words ?? 0}w
                                  </span>
                                  {(() => {
                                    const badge = vectorBadge(e);
                                    if (!badge) return null;
                                    const Icon = badge.Icon;
                                    return (
                                      <span
                                        className={cn(
                                          "inline-flex items-center gap-1 rounded-full border px-1 py-0.5 text-xs font-medium",
                                          badge.className
                                        )}
                                        title={`Vector status: ${badge.label}`}
                                      >
                                        <Icon className="h-2.5 w-2.5" />
                                        {badge.label}
                                      </span>
                                    );
                                  })()}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background/40">
          {detailMeta ? (
            <>
              <div className="shrink-0 border-b border-foreground/10 px-6 py-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  {detailMeta.kind === "workspace-file" ? (
                    <FileText className="h-4 w-4 text-info-fg" />
                  ) : (
                    <Brain className="h-4 w-4 text-fg-secondary" />
                  )}
                  <h2 className="text-xs font-semibold text-foreground">
                    {detailMeta.title}
                  </h2>

                  {detailMeta.vectorState && (() => {
                    const badge = vectorBadge({ vectorState: detailMeta.vectorState });
                    if (!badge) return null;
                    const Icon = badge.Icon;
                    return (
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 rounded-full border px-1 py-0.5 text-xs font-medium",
                          badge.className
                        )}
                      >
                        <Icon className="h-2.5 w-2.5" />
                        {badge.label}
                      </span>
                    );
                  })()}

                  {saveStatus === "saving" && (
                    <span className="text-xs text-muted-foreground">Saving...</span>
                  )}
                  {saveStatus === "saved" && (
                    <span className="text-xs text-success-fg">Saved</span>
                  )}
                  {saveStatus === "unsaved" && (
                    <span className="text-xs text-warning-fg">Unsaved</span>
                  )}

                  {detailMeta.kind === "workspace-file" &&
                    (detailMeta.vectorState === "not_indexed" || detailMeta.vectorState === "stale") && (
                    <button
                      type="button"
                      onClick={() => void ensureWorkspaceIndex()}
                      disabled={ensuringIndex}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-info-border bg-info-bg px-2 py-0.5 text-xs font-medium text-info-fg transition-colors hover:bg-info-bg disabled:cursor-not-allowed disabled:opacity-60"
                      title="Add this file to the vector index"
                    >
                      {ensuringIndex ? (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                        </span>
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {ensuringIndex ? "Indexing..." : "Add to Index"}
                    </button>
                  )}

                  {canIndexSelectedJournal && selectedDailyEntry && (
                    <button
                      type="button"
                      onClick={() => void indexJournalEntry(selectedDailyEntry)}
                      disabled={indexingFile === journalKey(selectedDailyEntry.name)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-info-border bg-info-bg px-2 py-0.5 text-xs font-medium text-info-fg transition-colors hover:bg-info-bg disabled:cursor-not-allowed disabled:opacity-60"
                      title="Re-index this memory entry"
                    >
                      {indexingFile === journalKey(selectedDailyEntry.name) ? (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                        </span>
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {indexingFile === journalKey(selectedDailyEntry.name) ? "Indexing..." : "Index now"}
                    </button>
                  )}

                  {canIndexSelectedAgent && selectedAgentMemory && (
                    <button
                      type="button"
                      onClick={() => void indexAgentMemory(selectedAgentMemory)}
                      disabled={indexingFile === agentMemoryKey(selectedAgentMemory.agentId)}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-info-border bg-info-bg px-2 py-0.5 text-xs font-medium text-info-fg transition-colors hover:bg-info-bg disabled:cursor-not-allowed disabled:opacity-60"
                      title="Re-index this agent memory file"
                    >
                      {indexingFile === agentMemoryKey(selectedAgentMemory.agentId) ? (
                        <span className="inline-flex items-center gap-0.5">
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                          <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                        </span>
                      ) : (
                        <RefreshCw className="h-3 w-3" />
                      )}
                      {indexingFile === agentMemoryKey(selectedAgentMemory.agentId) ? "Indexing..." : "Index now"}
                    </button>
                  )}
                </div>

                <p className="mt-1 text-xs text-fg-subtle">
                  {detailMeta.words != null && `${detailMeta.words} words`}
                  {detailMeta.size != null && ` • ${formatBytes(detailMeta.size)}`}
                  {detailMeta.workspace && ` • ${detailMeta.workspace}`}
                  {detailMeta.mtime && ` • ${formatAgo(detailMeta.mtime)}`}
                  {detailMeta.kind !== "workspace-file" && (
                    <>
                      {" • Use "}
                      <span className="inline-flex items-center rounded-md border border-foreground/10 bg-card/50 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                        Edit
                      </span>
                      {" to modify • "}
                      <SaveShortcut /> to save
                    </>
                  )}
                  {detailMeta.kind === "workspace-file" && " • Read-only workspace file"}
                </p>
              </div>

              <div className="flex-1 overflow-y-auto px-4 py-5 md:px-6 min-w-0">
                {detailMeta.kind === "agent-memory" && selectedAgentMemory && !selectedAgentMemory.exists && (
                  <div className="mb-3 rounded-lg border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
                    This agent has no `{selectedAgentMemory.fileName}` yet. Start typing and save to create it.
                  </div>
                )}

                {detailMeta.kind === "agent-memory" && selectedAgentMemory?.hasAltCaseFile && (
                  <div className="mb-3 rounded-lg border border-info-border bg-info-bg px-3 py-2 text-xs text-info-fg">
                    Both `MEMORY.md` and `memory.md` exist in this workspace. Mission Control edits the canonical file shown in the title.
                  </div>
                )}

                {detailContent != null ? (
                  <InlineMarkdownEditor
                    key={detailMeta.fileKey}
                    content={detailContent}
                    onContentChange={handleContentChange}
                    onSave={handleSave}
                    placeholder="Click to start writing..."
                    scrollToLine={scrollToLine}
                  />
                ) : null}
              </div>
            </>
          ) : !loading ? (
            <div className="flex flex-1 items-center justify-center text-sm text-fg-subtle">
              Select a memory entry
            </div>
          ) : null}
        </div>

        {/* Context menu */}
        {ctxMenu && (
          <div
            ref={ctxRef}
            className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-foreground/10 bg-card/95 py-1 shadow-xl backdrop-blur-sm"
            style={{
              left: Math.min(ctxMenu.x, window.innerWidth - 200),
              top: Math.min(ctxMenu.y, window.innerHeight - 220),
            }}
          >
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                loadJournalFile(ctxMenu.entry.name, ctxMenu.entry.date);
                setCtxMenu(null);
              }}
            >
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              Open
            </button>
            {(ctxMenu.entry.vectorState === "stale" ||
              ctxMenu.entry.vectorState === "not_indexed") && (
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-info-fg transition-colors hover:bg-info-bg"
                onClick={() => {
                  void indexJournalEntry(ctxMenu.entry);
                  setCtxMenu(null);
                }}
                disabled={indexingFile === journalKey(ctxMenu.entry.name)}
              >
                {indexingFile === journalKey(ctxMenu.entry.name) ? (
                  <span className="inline-flex items-center gap-0.5">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {indexingFile === journalKey(ctxMenu.entry.name) ? "Indexing..." : "Index now"}
              </button>
            )}
            <div className="mx-2 my-1 h-px bg-foreground/10" />
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                setRenaming(ctxMenu.entry);
                setRenameValue(ctxMenu.entry.name);
                setCtxMenu(null);
              }}
            >
              <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              Rename
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                void duplicateEntry(ctxMenu.entry);
                setCtxMenu(null);
              }}
            >
              <Copy className="h-3.5 w-3.5 text-muted-foreground" />
              Duplicate
            </button>
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => {
                copyEntryName(ctxMenu.entry);
                setCtxMenu(null);
              }}
            >
              <ClipboardCopy className="h-3.5 w-3.5 text-muted-foreground" />
              Copy Filename
            </button>
            <div className="mx-2 my-1 h-px bg-foreground/10" />
            <button
              type="button"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-danger-fg transition-colors hover:bg-danger-bg hover:text-danger-fg"
              onClick={() => {
                setConfirmDelete(ctxMenu.entry);
                setCtxMenu(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          </div>
        )}

        {/* Toast */}
        {actionMsg && (
          <div
            className={cn(
              "fixed bottom-4 right-4 z-50 rounded-lg border px-4 py-2.5 text-sm shadow-lg backdrop-blur-sm transition-all",
              actionMsg.ok
                ? "border-success-border bg-success-bg text-success-fg"
                : "border-danger-border bg-danger-bg text-danger-fg"
            )}
          >
            {actionMsg.msg}
          </div>
        )}
      </div>
    </SectionLayout>
  );
}
