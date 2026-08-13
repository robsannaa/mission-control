"use client";

import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import {
  Search,
  FileText,
  Hash,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Trash2,
  Copy,
  Pencil,
  ClipboardCopy,
  ExternalLink,
  Code,
  Eye,
  CheckCircle,
  Plus,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { InlineMarkdownEditor } from "./inline-markdown-editor";
import { SectionLayout } from "@/components/section-layout";
import { LoadingState } from "@/components/ui/loading-state";
import { SaveShortcut } from "@/components/ui/save-shortcut";

/* ── types ─────────────────────────────────────── */

type Doc = {
  path: string;
  name: string;
  mtime: string;
  size: number;
  tag: string;
  workspace: string;
  ext: string;
};

type WorkspaceGroup = {
  name: string;
  label: string;
  typeGroups: DocTypeGroup[];
};

type DocTypeGroup = {
  key: string;
  label: string;
  docs: Doc[];
};

type ContextMenuState = {
  x: number;
  y: number;
  doc: Doc;
} | null;

/* ── helpers ───────────────────────────────────── */

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function formatAgo(d: string | Date) {
  const now = new Date();
  const diff = now.getTime() - new Date(d).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins > 1 ? "s" : ""} ago`;
  if (hours < 24) return `about ${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Friendly workspace label using agent name from API, with fallback to folder suffix. */
function workspaceLabel(name: string, agentNameMap?: Record<string, string>): string {
  if (agentNameMap?.[name]) {
    return agentNameMap[name];
  }
  // Fallback: capitalize folder suffix
  const suffix = name.replace(/^workspace-?/, "");
  return suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : name;
}

/** Last path segment of agent workspace (e.g. "workspace", "workspace-gilfoyle") to match doc.workspace. */
function workspaceNameFromPath(workspacePath: string): string {
  const trimmed = (workspacePath || "").trim().replace(/[/\\]+$/, "");
  const segment = trimmed.split(/[/\\]/).filter(Boolean).pop();
  return segment ?? (trimmed || "workspace");
}

const TAG_COLORS: Record<string, string> = {
  "Core Prompt": "bg-muted-foreground/20 text-fg-secondary border-border-strong",
  Journal: "bg-warning-bg text-warning-fg border-warning-border",
  Other: "bg-fg-secondary/20 text-muted-foreground border-border-strong/30",
  Notes: "bg-info-bg text-info-fg border-info-border",
  Content: "bg-success-bg text-success-fg border-success-border",
  Newsletters: "bg-muted-foreground/20 text-fg-secondary border-border-strong",
  "YouTube Scripts": "bg-danger-bg text-danger-fg border-danger-border",
};

const TYPE_ORDER = ["Core Prompt", "Journal", "Notes", "Content", "Newsletters", "YouTube Scripts", "Other"];

function sortTypeKeys(a: string, b: string): number {
  const ai = TYPE_ORDER.indexOf(a);
  const bi = TYPE_ORDER.indexOf(b);
  const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
  const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
  if (av !== bv) return av - bv;
  return a.localeCompare(b);
}

function normalizeWorkspaceQuery(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] || null;
}

function normalizePathQuery(pathValue: string | null, workspaceValue: string | null): string | null {
  if (!pathValue) return null;
  const cleanPath = pathValue.replace(/\\/g, "/").replace(/^\/+/, "").trim();
  if (!cleanPath) return null;

  const parts = cleanPath.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) return null;

  // Links copied from logs or chat may contain an absolute path. Documents use
  // OpenClaw-relative paths, so retain the path from its workspace segment.
  const workspaceIndex = parts.findIndex((part) => part.startsWith("workspace"));
  if (workspaceIndex >= 0) return parts.slice(workspaceIndex).join("/");

  const ws = normalizeWorkspaceQuery(workspaceValue);
  return ws ? `${ws}/${cleanPath}` : cleanPath;
}

function findRequestedDoc(docs: Doc[], requestedPath: string): Doc | null {
  const exact = docs.find((doc) => doc.path === requestedPath);
  if (exact) return exact;

  // A path such as `MEMORY.md` or `memory/2026-08-11.md` means the main
  // workspace unless the link explicitly names another workspace.
  const mainWorkspace = docs.find(
    (doc) => doc.path === `workspace/${requestedPath}`
  );
  if (mainWorkspace) return mainWorkspace;

  // Per-agent installations do not always have a folder literally named
  // `workspace`. A unique suffix match still gives bare links a deterministic
  // destination without silently choosing between multiple agents.
  const suffix = `/${requestedPath}`;
  const matches = docs.filter((doc) => doc.path.endsWith(suffix));
  return matches.length === 1 ? matches[0] : null;
}

/* ── JSON Viewer ──────────────────────────────── */

function highlightJson(json: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  // Regex: key strings (followed by :), value strings, booleans, null, numbers
  const regex =
    /("(?:[^"\\]|\\.)*")(?=\s*:)|"(?:[^"\\]|\\.)*"|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  let lastIndex = 0;
  let idx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(json)) !== null) {
    // Plain text before match (structural chars, whitespace)
    if (match.index > lastIndex) {
      result.push(
        <span key={`p${idx++}`} className="text-fg-subtle">
          {json.slice(lastIndex, match.index)}
        </span>
      );
    }

    const m = match[0];
    if (match[1]) {
      // Key
      result.push(
        <span key={`k${idx++}`} className="text-fg-secondary">
          {m}
        </span>
      );
    } else if (m.startsWith('"')) {
      // String value
      const display = m.length > 120 ? m.slice(0, 117) + '…"' : m;
      result.push(
        <span key={`s${idx++}`} className="text-success-fg">
          {display}
        </span>
      );
    } else if (m === "true" || m === "false") {
      result.push(
        <span key={`b${idx++}`} className="text-info-fg">
          {m}
        </span>
      );
    } else if (m === "null") {
      result.push(
        <span key={`n${idx++}`} className="text-danger-fg italic">
          {m}
        </span>
      );
    } else {
      // Number
      result.push(
        <span key={`d${idx++}`} className="text-warning-fg">
          {m}
        </span>
      );
    }

    lastIndex = regex.lastIndex;
  }

  // Remaining
  if (lastIndex < json.length) {
    result.push(
      <span key={`p${idx}`} className="text-fg-subtle">
        {json.slice(lastIndex)}
      </span>
    );
  }

  return result;
}

function JsonViewer({
  content,
  onContentChange,
  onSave,
}: {
  content: string;
  onContentChange: (c: string) => void;
  onSave: (content: string) => void;
}) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [copied, setCopied] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);

  let parsed: unknown = null;
  let valid = false;
  try {
    parsed = JSON.parse(content);
    valid = true;
  } catch {
    /* invalid JSON */
  }

  const prettyJson = useMemo(
    () => (valid ? JSON.stringify(parsed, null, 2) : content),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [content, valid]
  );

  const highlighted = useMemo(() => {
    if (!valid) return null;
    return highlightJson(prettyJson);
  }, [prettyJson, valid]);

  const lineCount = prettyJson.split("\n").length;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(prettyJson);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [prettyJson]);

  // Focus textarea when switching to edit
  useEffect(() => {
    if (mode === "edit") {
      setTimeout(() => {
        editRef.current?.focus();
      }, 50);
    }
  }, [mode]);

  const handleEditChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onContentChange(e.target.value);
    },
    [onContentChange]
  );

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        onSave(content);
      }
      // Tab → insert 2 spaces
      if (e.key === "Tab") {
        e.preventDefault();
        const ta = e.target as HTMLTextAreaElement;
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const newVal = content.slice(0, start) + "  " + content.slice(end);
        onContentChange(newVal);
        setTimeout(() => {
          ta.selectionStart = ta.selectionEnd = start + 2;
        }, 0);
      }
    },
    [content, onContentChange, onSave]
  );

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="mb-3 flex items-center gap-2">
        <div className="flex rounded-lg border border-foreground/10 bg-card">
          <button
            type="button"
            onClick={() => setMode("view")}
            className={cn(
              "flex items-center gap-1.5 rounded-l-lg px-3 py-1.5 text-xs font-medium transition",
              mode === "view"
                ? "bg-[var(--accent-brand-subtle)] text-[var(--accent-brand-text)]"
                : "text-muted-foreground hover:text-fg-secondary"
            )}
          >
            <Eye className="h-3 w-3" />
            Formatted
          </button>
          <button
            type="button"
            onClick={() => setMode("edit")}
            className={cn(
              "flex items-center gap-1.5 rounded-r-lg px-3 py-1.5 text-xs font-medium transition",
              mode === "edit"
                ? "bg-[var(--accent-brand-subtle)] text-[var(--accent-brand-text)]"
                : "text-muted-foreground hover:text-fg-secondary"
            )}
          >
            <Code className="h-3 w-3" />
            Edit
          </button>
        </div>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1.5 rounded-lg border border-foreground/10 bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-fg-secondary"
        >
          {copied ? (
            <CheckCircle className="h-3 w-3 text-success-fg" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
        {!valid && (
          <span className="text-xs text-warning-fg">
            Invalid JSON — showing raw text
          </span>
        )}
        {valid && mode === "view" && (
          <span className="text-xs text-fg-subtle">
            {lineCount} lines
          </span>
        )}
      </div>

      {/* Content */}
      {mode === "edit" ? (
        <textarea
          ref={editRef}
          value={content}
          onChange={handleEditChange}
          onKeyDown={handleEditKeyDown}
          spellCheck={false}
          className="flex-1 resize-none rounded-lg border border-foreground/10 bg-foreground/5 p-4 font-mono text-sm leading-6 text-foreground outline-none focus:border-[var(--accent-brand-border)]"
        />
      ) : (
        <div className="flex flex-1 overflow-auto rounded-lg border border-foreground/10 bg-foreground/5">
          {/* Line numbers */}
          <div className="shrink-0 select-none border-r border-foreground/5 py-4 pr-1 text-right">
            {Array.from({ length: lineCount }, (_, i) => (
              <div
                key={i}
                className="px-3 font-mono text-xs leading-6 text-fg-subtle"
              >
                {i + 1}
              </div>
            ))}
          </div>
          {/* Highlighted JSON */}
          <pre className="flex-1 overflow-x-auto whitespace-pre p-4 font-mono text-sm leading-6">
            {highlighted ?? (
              <span className="text-fg-secondary">{prettyJson}</span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

/* ── component ─────────────────────────────────── */

export function DocsView() {
  const searchParams = useSearchParams();
  const requestedWorkspace = searchParams.get("workspace");
  const requestedPath = searchParams.get("path");
  const requestedDocPath = useMemo(
    () => normalizePathQuery(requestedPath, requestedWorkspace),
    [requestedPath, requestedWorkspace]
  );
  const [docs, setDocs] = useState<Doc[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [allExts, setAllExts] = useState<string[]>([]);
  const [selected, setSelected] = useState<Doc | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [words, setWords] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [extFilter, setExtFilter] = useState<string | null>(null);
  const [collapsedWorkspace, setCollapsedWorkspace] = useState<Record<string, boolean>>({});
  const [collapsedType, setCollapsedType] = useState<Record<string, boolean>>({});
  const [agents, setAgents] = useState<Array<{ id: string; name: string; emoji: string; workspace: string; isDefault?: boolean }>>([]);

  // Save state
  const [saveStatus, setSaveStatus] = useState<
    "saved" | "saving" | "unsaved" | null
  >(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [renaming, setRenaming] = useState<Doc | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Doc | null>(null);
  const [actionMsg, setActionMsg] = useState<{ ok: boolean; msg: string } | null>(null);
  const ctxRef = useRef<HTMLDivElement>(null);
  const deepLinkedDocRef = useRef<string | null>(null);

  // Create document state
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createFilename, setCreateFilename] = useState("");
  const [createWorkspace, setCreateWorkspace] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const fetchDocs = useCallback(() => {
    setLoading(true);
    fetch("/api/docs")
      .then((r) => r.json())
      .then((data) => {
        const nextDocs = (data.docs || []) as Doc[];
        setDocs(nextDocs);
        setAllTags([...(data.tags || [])].sort(sortTypeKeys));
        setAllExts(data.extensions || []);

        if (
          requestedDocPath &&
          deepLinkedDocRef.current !== requestedDocPath
        ) {
          const target = findRequestedDoc(nextDocs, requestedDocPath);
          if (target) {
            deepLinkedDocRef.current = requestedDocPath;
            setSelected(target);
            setSaveStatus(null);
            setContent(null);
            fetch(`/api/docs?path=${encodeURIComponent(target.path)}`)
              .then((resp) => resp.json())
              .then((payload) => {
                setContent(payload.content ?? "");
                setWords(payload.words ?? 0);
              })
              .catch(() => setContent("Failed to load."));
          }
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [requestedDocPath]);

  useEffect(() => {
    queueMicrotask(() => fetchDocs());
  }, [fetchDocs]);

  // Load agents for workspace → emoji / name (identity from OpenClaw config)
  const fetchAgents = useCallback(() => {
    fetch("/api/agents", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        const list = (data.agents || []) as Array<{ id: string; name: string; emoji: string; workspace: string; isDefault?: boolean }>;
        setAgents(list);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAgents();
  }, [fetchAgents]);

  // Re-fetch agents when page becomes visible (picks up renames from /agents)
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") fetchAgents();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [fetchAgents]);

  // Map workspace folder name → agent emoji (from identity)
  const workspaceEmojiByFolder = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) {
      const folder = workspaceNameFromPath(a.workspace);
      if (folder && a.emoji) map[folder] = a.emoji;
    }
    return map;
  }, [agents]);

  // Map workspace folder name → agent display name (for labels)
  const workspaceNameByFolder = useMemo(() => {
    const map: Record<string, string> = {};
    for (const a of agents) {
      const folder = workspaceNameFromPath(a.workspace);
      if (folder && a.name) {
        const label = a.isDefault ? `${a.name} (main)` : a.name;
        map[folder] = label;
      }
    }
    return map;
  }, [agents]);

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

  /* ── save & edit ──────────────────────────────── */

  const saveContent = useCallback(
    async (docPath: string, newContent: string) => {
      setSaveStatus("saving");
      try {
        const res = await fetch("/api/docs", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: docPath, content: newContent }),
        });
        if (res.ok) {
          const data = await res.json();
          setContent(newContent);
          setWords(
            data.words || newContent.split(/\s+/).filter(Boolean).length
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
    []
  );

  const handleContentChange = useCallback(
    (newMarkdown: string) => {
      setSaveStatus("unsaved");
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (selected) {
        saveTimeoutRef.current = setTimeout(() => {
          saveContent(selected.path, newMarkdown);
        }, 300); // short delay since editor already debounces
      }
    },
    [selected, saveContent]
  );

  // Cmd+S: flush pending debounce and save immediately
  const handleSave = useCallback(
    (markdown: string) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      if (selected) {
        saveContent(selected.path, markdown);
      }
    },
    [selected, saveContent]
  );

  const loadDoc = useCallback((doc: Doc) => {
    // Flush any pending save
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    setSelected(doc);
    setSaveStatus(null);
    setContent(null);
    fetch(`/api/docs?path=${encodeURIComponent(doc.path)}`)
      .then((r) => r.json())
      .then((data) => {
        setContent(data.content ?? "");
        setWords(data.words ?? 0);
      })
      .catch(() => setContent("Failed to load."));
  }, []);

  /* ── file operations ────────────────────────────── */

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, doc: Doc) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, doc });
    },
    []
  );

  const deleteDoc = useCallback(
    async (doc: Doc) => {
      try {
        const res = await fetch(
          `/api/docs?path=${encodeURIComponent(doc.path)}`,
          { method: "DELETE" }
        );
        const data = await res.json();
        if (data.ok) {
          setDocs((prev) => prev.filter((d) => d.path !== doc.path));
          if (selected?.path === doc.path) {
            setSelected(null);
            setContent(null);
          }
          setActionMsg({ ok: true, msg: `Deleted ${doc.name}` });
        } else {
          setActionMsg({ ok: false, msg: data.error || "Delete failed" });
        }
      } catch {
        setActionMsg({ ok: false, msg: "Delete failed" });
      }
      setConfirmDelete(null);
      setTimeout(() => setActionMsg(null), 3000);
    },
    [selected]
  );

  const renameDoc = useCallback(
    async (doc: Doc, newName: string) => {
      if (!newName.trim() || newName === doc.name) {
        setRenaming(null);
        return;
      }
      try {
        const res = await fetch("/api/docs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "rename", path: doc.path, newName }),
        });
        const data = await res.json();
        if (data.ok) {
          // Update in list
          setDocs((prev) =>
            prev.map((d) =>
              d.path === doc.path
                ? { ...d, path: data.path, name: newName }
                : d
            )
          );
          if (selected?.path === doc.path) {
            setSelected({ ...doc, path: data.path, name: newName });
          }
          setActionMsg({ ok: true, msg: `Renamed to ${newName}` });
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

  const duplicateDoc = useCallback(
    async (doc: Doc) => {
      try {
        const res = await fetch("/api/docs", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "duplicate", path: doc.path }),
        });
        const data = await res.json();
        if (data.ok) {
          // Refresh the list to pick up the new file
          fetchDocs();
          setActionMsg({ ok: true, msg: `Duplicated as ${data.name}` });
        } else {
          setActionMsg({ ok: false, msg: data.error || "Duplicate failed" });
        }
      } catch {
        setActionMsg({ ok: false, msg: "Duplicate failed" });
      }
      setTimeout(() => setActionMsg(null), 3000);
    },
    [fetchDocs]
  );

  const createDoc = useCallback(async () => {
    const name = createFilename.trim();
    if (!name || !createWorkspace) return;
    // Auto-add .md extension if none provided
    const filename = /\.\w+$/.test(name) ? name : `${name}.md`;
    setCreateBusy(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/docs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace: createWorkspace, filename }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setCreateError(data.error || "Failed to create document");
        setCreateBusy(false);
        return;
      }
      // Add to doc list and select it
      const newDoc = data.doc as Doc;
      setDocs((prev) => [newDoc, ...prev]);
      setSelected(newDoc);
      setContent("");
      setWords(0);
      setSaveStatus(null);
      setShowCreateModal(false);
      setCreateFilename("");
      setCreateError(null);
      setActionMsg({ ok: true, msg: `Created ${newDoc.name}` });
      setTimeout(() => setActionMsg(null), 3000);
    } catch {
      setCreateError("Failed to create document");
    }
    setCreateBusy(false);
  }, [createFilename, createWorkspace]);

  const copyPath = useCallback((doc: Doc) => {
    navigator.clipboard.writeText(doc.path).then(() => {
      setActionMsg({ ok: true, msg: "Path copied to clipboard" });
      setTimeout(() => setActionMsg(null), 2000);
    });
  }, []);

  /* ── filtered & grouped ──────────────────────── */

  const filtered = useMemo(
    () =>
      docs.filter((d) => {
        const matchSearch =
          !search ||
          d.name.toLowerCase().includes(search.toLowerCase()) ||
          d.path.toLowerCase().includes(search.toLowerCase());
        const matchTag = !tagFilter || d.tag === tagFilter;
        const matchExt = !extFilter || d.ext === extFilter;
        return matchSearch && matchTag && matchExt;
      }),
    [docs, search, tagFilter, extFilter]
  );

  const workspaceGroups: WorkspaceGroup[] = useMemo(() => {
    const byWorkspace = new Map<string, Doc[]>();
    for (const doc of filtered) {
      const wsName = doc.workspace;
      if (!byWorkspace.has(wsName)) byWorkspace.set(wsName, []);
      byWorkspace.get(wsName)!.push(doc);
    }

    return Array.from(byWorkspace.entries())
      .map(([name, wsDocs]) => {
        const byType = new Map<string, Doc[]>();
        for (const doc of wsDocs) {
          const typeKey = doc.tag || "Other";
          if (!byType.has(typeKey)) byType.set(typeKey, []);
          byType.get(typeKey)!.push(doc);
        }
        const typeGroups: DocTypeGroup[] = Array.from(byType.entries())
          .sort(([a], [b]) => sortTypeKeys(a, b))
          .map(([key, typeDocs]) => ({
            key,
            label: key,
            docs: [...typeDocs].sort(
              (a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime()
            ),
          }));

        return {
          name,
          label: workspaceLabel(name, workspaceNameByFolder),
          typeGroups,
        };
      })
      .sort((a, b) => {
        if (a.name === "workspace") return -1;
        if (b.name === "workspace") return 1;
        return a.label.localeCompare(b.label);
      });
  }, [filtered, workspaceNameByFolder]);

  const toggleWorkspaceCollapse = (ws: string) =>
    setCollapsedWorkspace((prev) => ({ ...prev, [ws]: !prev[ws] }));

  const toggleTypeCollapse = (ws: string, type: string) => {
    const key = `${ws}::${type}`;
    setCollapsedType((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  /* ── render ──────────────────────────────────── */

  return (
    <SectionLayout>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
      {/* Left panel */}
      <div className="flex max-h-96 w-full shrink-0 flex-col overflow-hidden border-b border-foreground/10 bg-[var(--surface-1)] md:max-h-none md:w-80 md:border-b-0 md:border-r">
        <div className="shrink-0 space-y-3 p-3">
          {/* Search + New */}
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-2 rounded-lg border border-foreground/10 bg-card px-3 py-2 text-sm text-muted-foreground transition-colors focus-within:border-[var(--accent-brand-border)] focus-within:ring-1 focus-within:ring-[var(--accent-brand-ring)]">
              <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
              <input
                placeholder="Search documents..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-fg-subtle"
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setCreateWorkspace(workspaceGroups[0]?.name || "workspace");
                setCreateFilename("");
                setCreateError(null);
                setShowCreateModal(true);
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-lg bg-[var(--accent-brand)] px-2.5 py-2 text-xs font-medium text-[var(--accent-brand-on)] transition-colors hover:opacity-90"
              title="Create new document"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Tag filter pills */}
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs font-medium transition-colors",
                  tagFilter === tag
                    ? "border-[var(--accent-brand-border)] bg-[var(--accent-brand-subtle)] text-[var(--accent-brand-text)]"
                    : "border-foreground/10 bg-muted/70 text-muted-foreground hover:bg-muted hover:text-muted-foreground"
                )}
              >
                {tag}
              </button>
            ))}
          </div>

          {/* File type chips */}
          <div className="flex flex-wrap gap-1.5">
            <Hash className="h-3.5 w-3.5 text-fg-subtle" />
            {allExts.map((ext) => (
              <button
                key={ext}
                type="button"
                onClick={() => setExtFilter(extFilter === ext ? null : ext)}
                className={cn(
"rounded border px-2 py-0.5 text-xs font-mono transition-colors",
                  extFilter === ext
                    ? "border-[var(--accent-brand-border)] bg-[var(--accent-brand-subtle)] text-[var(--accent-brand-text)]"
                    : "border-foreground/10 bg-muted/60 text-muted-foreground hover:text-muted-foreground"
              )}
            >
                {ext}
              </button>
            ))}
          </div>
        </div>

        {/* Document list grouped by workspace -> type */}
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {loading ? (
            <LoadingState className="px-3 py-4 justify-start" />
          ) : workspaceGroups.length === 0 ? (
            <p className="px-3 py-4 text-sm text-fg-subtle">
              No documents found
            </p>
          ) : (
            <div className="space-y-1">
              {workspaceGroups.map((ws) => {
                const isCollapsed = collapsedWorkspace[ws.name] || false;
                const icon = workspaceEmojiByFolder[ws.name] || "📁";
                const wsCount = ws.typeGroups.reduce((sum, tg) => sum + tg.docs.length, 0);
                return (
                  <div key={ws.name}>
                    {/* Workspace header */}
                    <button
                      type="button"
                      onClick={() => toggleWorkspaceCollapse(ws.name)}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors hover:bg-muted/60"
                    >
                      {isCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-fg-subtle" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-xs">{icon}</span>
                      <span className="text-xs font-semibold text-fg-secondary">
                        {ws.label}
                      </span>
                      <span className="text-xs text-fg-subtle">
                        {wsCount}
                      </span>
                    </button>

                    {/* Types + docs in this workspace */}
                    {!isCollapsed && (
                      <div className="space-y-0.5 pl-4">
                        {ws.typeGroups.map((typeGroup) => {
                          const typeKey = `${ws.name}::${typeGroup.key}`;
                          const isTypeCollapsed = collapsedType[typeKey] || false;
                          return (
                            <div key={typeKey} className="space-y-0.5">
                              <button
                                type="button"
                                onClick={() => toggleTypeCollapse(ws.name, typeGroup.key)}
                                className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
                              >
                                {isTypeCollapsed ? (
                                  <ChevronRight className="h-3 w-3 text-fg-subtle" />
                                ) : (
                                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                                )}
                                <span
                                  className={cn(
                                    "rounded border px-1.5 py-0.5 text-xs font-medium",
                                    TAG_COLORS[typeGroup.key] || TAG_COLORS.Other
                                  )}
                                >
                                  {typeGroup.label}
                                </span>
                                <span className="text-xs text-fg-subtle">
                                  {typeGroup.docs.length}
                                </span>
                              </button>

                              {!isTypeCollapsed && (
                                <div className="space-y-0.5 pl-4">
                                  {typeGroup.docs.map((doc) => {
                                    const isSelected = selected?.path === doc.path;
                                    const isRenaming = renaming?.path === doc.path;
                                    const isDeleting = confirmDelete?.path === doc.path;
                                    // Show relative path inside workspace
                                    const relPath = doc.path
                                      .replace(`${ws.name}/`, "")
                                      .replace(`/${doc.name}`, "");
                                    const showSubpath = relPath && relPath !== doc.name;

                                    if (isDeleting) {
                                      return (
                                        <div
                                          key={doc.path}
                                          className="flex items-center gap-2 rounded-lg bg-danger-bg px-3 py-2.5"
                                        >
                                          <Trash2 className="h-3.5 w-3.5 shrink-0 text-danger-fg" />
                                          <span className="flex-1 truncate text-xs text-danger-fg">
                                            Delete {doc.name}?
                                          </span>
                                          <button
                                            type="button"
                                            onClick={() => deleteDoc(doc)}
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
                                          key={doc.path}
                                          className="flex items-center gap-2 rounded-lg border border-[var(--accent-brand-border)] bg-card px-3 py-2"
                                        >
                                          <Pencil className="h-3 w-3 shrink-0 text-[var(--accent-brand-text)]" />
                                          <input
                                            value={renameValue}
                                            onChange={(e) =>
                                              setRenameValue(e.target.value)
                                            }
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter")
                                                renameDoc(doc, renameValue);
                                              if (e.key === "Escape")
                                                setRenaming(null);
                                            }}
                                            onBlur={() =>
                                              renameDoc(doc, renameValue)
                                            }
                                            className="flex-1 bg-transparent text-sm text-foreground outline-none"
                                            autoFocus
                                          />
                                        </div>
                                      );
                                    }

                                    return (
                                      <button
                                        key={doc.path}
                                        type="button"
                                        onClick={() => loadDoc(doc)}
                                        onContextMenu={(e) =>
                                          handleContextMenu(e, doc)
                                        }
                                        className={cn(
                                          "flex w-full items-start gap-2.5 rounded-lg px-3 py-2 text-left transition-colors",
                                          isSelected
                                            ? "bg-muted ring-1 ring-[var(--accent-brand-border)]"
                                            : "hover:bg-muted/60"
                                        )}
                                      >
                                        <FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                                        <div className="min-w-0 flex-1">
                                          <span
                                            className={cn(
                                              "block truncate text-sm font-medium",
                                              isSelected
                                                ? "text-foreground"
                                                : "text-fg-secondary"
                                            )}
                                          >
                                            {doc.name}
                                          </span>
                                          {showSubpath && (
                                            <span className="block truncate text-xs text-fg-subtle">
                                              {relPath}
                                            </span>
                                          )}
                                          <div className="mt-1 flex items-center gap-2">
                                            <span className="rounded border border-foreground/10 px-1.5 py-0.5 text-xs font-mono text-muted-foreground">
                                              {doc.ext}
                                            </span>
                                            <span className="text-xs text-fg-subtle">
                                              {formatAgo(doc.mtime)}
                                            </span>
                                          </div>
                                        </div>
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
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right panel: preview / editor */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background/40">
        {selected ? (
          <>
            {/* Header */}
            <div className="shrink-0 border-b border-foreground/10 px-4 py-4 md:px-6">
              <div className="flex items-center gap-3">
                <span className="text-xs">
                  {workspaceEmojiByFolder[selected.workspace] || "📁"}
                </span>
                <h2 className="text-xs font-semibold text-foreground">
                  {selected.name}
                </h2>
                <span
                  className={cn(
                    "rounded border px-2 py-0.5 text-xs font-medium",
                    TAG_COLORS[selected.tag] || TAG_COLORS.Other
                  )}
                >
                  {selected.tag}
                </span>
                {saveStatus === "saving" && (
                  <span className="text-xs text-muted-foreground">Saving...</span>
                )}
                {saveStatus === "saved" && (
                  <span className="text-xs text-success-fg">Saved</span>
                )}
                {saveStatus === "unsaved" && (
                  <span className="text-xs text-warning-fg">Unsaved</span>
                )}
              </div>
              <p className="mt-1 flex items-center gap-2 text-xs text-fg-subtle">
                <span className="rounded bg-muted/70 px-1.5 py-0.5 text-xs text-muted-foreground">
                  {workspaceLabel(selected.workspace, workspaceNameByFolder)}
                </span>
                {formatBytes(selected.size)} &bull; {words} words &bull;
                Modified {formatAgo(selected.mtime)} &bull;
                Use
                <span className="inline-flex items-center rounded-md border border-foreground/10 bg-card/50 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
                  Edit
                </span>
                to modify &bull; <SaveShortcut /> to save
              </p>
            </div>

            {/* Content */}
            <div className="flex min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
              {content != null ? (
                selected.ext === ".json" ? (
                  <JsonViewer
                    key={selected.path}
                    content={content}
                    onContentChange={handleContentChange}
                    onSave={handleSave}
                  />
                ) : (
                  <InlineMarkdownEditor
                    key={selected.path}
                    content={content}
                    onContentChange={handleContentChange}
                    onSave={handleSave}
                    className="w-full"
                    placeholder="Click to start writing..."
                  />
                )
              ) : (
                <LoadingState className="py-12" />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-fg-subtle">
            <FolderOpen className="h-8 w-8 text-fg-subtle" />
            <p className="text-sm">Select a document</p>
            <p className="text-xs text-fg-subtle">
              Documents are grouped by agent and type
            </p>
          </div>
        )}
      </div>
    </div>

      {/* ── Context menu ──────────────────────────── */}
      {ctxMenu && (
        <div
          ref={ctxRef}
          className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-foreground/10 bg-card py-1 shadow-xl animate-menu-pop"
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 200),
            top: Math.min(ctxMenu.y, window.innerHeight - 260),
          }}
        >
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => {
              loadDoc(ctxMenu.doc);
              setCtxMenu(null);
            }}
          >
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            Open
          </button>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-[var(--accent-brand-text)] transition-colors hover:bg-[var(--accent-brand-subtle)]"
            onClick={() => {
              setCreateWorkspace(ctxMenu.doc.workspace);
              setCreateFilename("");
              setCreateError(null);
              setShowCreateModal(true);
              setCtxMenu(null);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New Document
          </button>
          <div className="mx-2 my-1 h-px bg-foreground/10" />
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-fg-secondary transition-colors hover:bg-muted hover:text-foreground"
            onClick={() => {
              setRenaming(ctxMenu.doc);
              setRenameValue(ctxMenu.doc.name);
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
              duplicateDoc(ctxMenu.doc);
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
              copyPath(ctxMenu.doc);
              setCtxMenu(null);
            }}
          >
            <ClipboardCopy className="h-3.5 w-3.5 text-muted-foreground" />
            Copy Path
          </button>
          <div className="mx-2 my-1 h-px bg-foreground/10" />
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-danger-fg transition-colors hover:bg-danger-bg hover:text-danger-fg"
            onClick={() => {
              setConfirmDelete(ctxMenu.doc);
              setCtxMenu(null);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
        </div>
      )}

      {/* ── Create Document Modal ──────────────────── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-backdrop-in" onClick={() => !createBusy && setShowCreateModal(false)} />
          <div className="relative z-10 w-full max-w-sm rounded-2xl glass-strong animate-modal-in">
            <div className="flex items-center justify-between border-b border-foreground/10 px-5 py-4">
              <h2 className="text-sm font-bold text-foreground">New Document</h2>
              <button type="button" onClick={() => !createBusy && setShowCreateModal(false)} className="rounded p-1 text-fg-subtle hover:text-fg-secondary">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-fg-secondary">Workspace</label>
                <select
                  value={createWorkspace}
                  onChange={(e) => setCreateWorkspace(e.target.value)}
                  disabled={createBusy}
                  className="w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground outline-none focus:border-[var(--accent-brand-border)]"
                >
                  {workspaceGroups.map((ws) => (
                    <option key={ws.name} value={ws.name}>{ws.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-fg-secondary">Filename</label>
                <input
                  type="text"
                  value={createFilename}
                  onChange={(e) => { setCreateFilename(e.target.value); setCreateError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter" && createFilename.trim()) createDoc(); }}
                  disabled={createBusy}
                  placeholder="my-notes.md"
                  autoFocus
                  className="w-full rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2 text-sm text-foreground outline-none placeholder:text-fg-subtle focus:border-[var(--accent-brand-border)]"
                />
                <p className="mt-1 text-xs text-fg-subtle">.md extension added automatically if omitted</p>
              </div>
              {createError && (
                <p className="rounded-lg border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">{createError}</p>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  disabled={createBusy}
                  className="rounded-lg border border-foreground/10 px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-foreground/5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={createDoc}
                  disabled={createBusy || !createFilename.trim()}
                  className="rounded-lg bg-[var(--accent-brand)] px-3 py-1.5 text-xs font-medium text-[var(--accent-brand-on)] transition hover:opacity-90 disabled:opacity-40"
                >
                  {createBusy ? "Creating..." : "Create"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast notification ────────────────────── */}
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
    </SectionLayout>
  );
}
