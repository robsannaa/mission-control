"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  Check,
  CircleCheck,
  CircleX,
  Globe,
  History,
  KeyRound,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { ContentLoadingState, InlineSpinner } from "@/components/ui/loading-state";
import { McpCatalogSheet, ConnectorIcon } from "@/components/mcp-catalog-sheet";
import { cn } from "@/lib/utils";
import {
  shortToolName,
  toolMatchesFilter,
  type McpProbeResult,
  type McpServerView,
  type McpTransport,
} from "@/lib/mcp-types";
import type { FormPreset } from "@/lib/mcp-catalog";

/** The Google Calendar MCP recipe used when the user opts into agent tools. */
const GOOGLE_CAL_MCP_PRESET: FormPreset = {
  title: "Google Calendar (agent tools)",
  name: "google-calendar",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@cocal/google-calendar-mcp"],
  secrets: [
    {
      key: "GOOGLE_OAUTH_CREDENTIALS",
      label: "Path to Google OAuth credentials JSON",
      help: "Download an OAuth client (Desktop) from Google Cloud and point this at the file.",
      placeholder: "/Users/you/gcp-oauth.keys.json",
    },
  ],
};

// ── data ───────────────────────────────────────────────────────────────────

interface McpState {
  servers: McpServerView[];
  ok: boolean;
  path: string;
}

async function fetchState(): Promise<McpState> {
  const res = await fetch("/api/mcp", { cache: "no-store" });
  const body = await res.json();
  if (!res.ok) throw new Error(body?.error || "Failed to load MCP servers");
  return body as McpState;
}

async function postAction(payload: Record<string, unknown>): Promise<McpState | null> {
  const res = await fetch("/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.ok === false) throw new Error(body?.error || "Action failed");
  return body?.servers ? (body as McpState) : null;
}

// ── status helpers ──────────────────────────────────────────────────────────

type Tone = "success" | "destructive" | "secondary" | "outline" | "warning";

function statusOf(s: McpServerView): { label: string; tone: Tone } {
  if (!s.enabled) return { label: "Disabled", tone: "secondary" };
  if (s.ok === true) return { label: "Healthy", tone: "success" };
  if (s.ok === false) return { label: "Unreachable", tone: "destructive" };
  return { label: "Enabled", tone: "outline" };
}

function transportMeta(t: McpTransport): { label: string; Icon: typeof Terminal } {
  if (t === "stdio") return { label: "Local process", Icon: Terminal };
  if (t === "sse") return { label: "HTTP · SSE", Icon: Globe };
  return { label: "HTTP", Icon: Globe };
}

function errorIssues(s: McpServerView) {
  return s.issues.filter((i) => i.level === "error");
}
function warnIssues(s: McpServerView) {
  return s.issues.filter((i) => i.level !== "error");
}

// ── main view ────────────────────────────────────────────────────────────────

export function McpView() {
  const [state, setState] = useState<McpState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [openName, setOpenName] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [preset, setPreset] = useState<FormPreset | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);

  const load = useCallback(async (soft = false) => {
    if (soft) setRefreshing(true);
    try {
      const next = await fetchState();
      setState(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyState = useCallback((next: McpState | null) => {
    if (next) setState(next);
    else void load(true);
  }, [load]);

  const servers = state?.servers ?? [];
  const openServer = servers.find((s) => s.name === openName) ?? null;

  const warnCount = servers.reduce((n, s) => n + warnIssues(s).length, 0);
  const errCount = servers.reduce((n, s) => n + errorIssues(s).length, 0);

  return (
    <SectionLayout>
      <SectionHeader
        title="MCP"
        description="Connect Model Context Protocol servers so your agents can use external tools. Add, configure, and check everything here — no config files to touch."
        meta={
          servers.length > 0
            ? `${servers.length} server${servers.length === 1 ? "" : "s"}${
                errCount ? ` · ${errCount} error${errCount === 1 ? "" : "s"}` : ""
              }${warnCount ? ` · ${warnCount} warning${warnCount === 1 ? "" : "s"}` : ""}`
            : undefined
        }
        actions={
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void load(true)}
              disabled={refreshing}
              aria-label="Refresh"
              title="Refresh"
            >
              <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setEditing(null);
                setPreset(null);
                setFormOpen(true);
              }}
            >
              <Plus className="size-4" />
              Add manually
            </Button>
            <Button onClick={() => setCatalogOpen(true)}>
              <Sparkles className="size-4" />
              Browse connectors
            </Button>
          </>
        }
      />

      <SectionBody width="content">
        {loading ? (
          <ContentLoadingState />
        ) : error ? (
          <ErrorCard message={error} onRetry={() => void load()} />
        ) : servers.length === 0 ? (
          <EmptyState onBrowse={() => setCatalogOpen(true)} />
        ) : (
          <div className="flex flex-col gap-3">
            {servers.map((s) => (
              <ServerCard
                key={s.name}
                server={s}
                onOpen={() => setOpenName(s.name)}
                onToggle={async (enabled) => {
                  applyState(await postAction({ action: enabled ? "enable" : "disable", name: s.name }));
                }}
              />
            ))}
          </div>
        )}
      </SectionBody>

      {openServer && (
        <ServerDrawer
          server={openServer}
          onClose={() => setOpenName(null)}
          onChanged={applyState}
          onEdit={() => {
            setEditing(openServer);
            setOpenName(null);
            setFormOpen(true);
          }}
        />
      )}

      <ServerForm
        open={formOpen}
        editing={editing}
        preset={preset}
        onClose={() => setFormOpen(false)}
        onSaved={(next) => {
          setFormOpen(false);
          setPreset(null);
          applyState(next);
        }}
      />

      <McpCatalogSheet
        open={catalogOpen}
        installedNames={new Set(servers.map((s) => s.name))}
        isHosted={process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true"}
        onClose={() => setCatalogOpen(false)}
        onPick={(p) => {
          setCatalogOpen(false);
          setEditing(null);
          setPreset(p);
          setFormOpen(true);
        }}
        onPickManaged={() => {
          setCatalogOpen(false);
          setGoogleOpen(true);
        }}
      />

      <GoogleCalendarPanel
        open={googleOpen}
        alreadyAdded={servers.some((s) => s.name === "google-calendar")}
        onClose={() => setGoogleOpen(false)}
        onAddAgentTools={() => {
          setGoogleOpen(false);
          setEditing(null);
          setPreset(GOOGLE_CAL_MCP_PRESET);
          setFormOpen(true);
        }}
      />
    </SectionLayout>
  );
}

// ── server card ───────────────────────────────────────────────────────────────

function ServerCard({
  server,
  onOpen,
  onToggle,
}: {
  server: McpServerView;
  onOpen: () => void;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const status = statusOf(server);
  const { label: tLabel, Icon } = transportMeta(server.transport);
  const warns = warnIssues(server);
  const errs = errorIssues(server);

  return (
    <div
      className="group flex items-center gap-4 rounded-xl border border-border bg-card px-4 py-3.5 transition-colors hover:border-border-strong"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-secondary text-fg-secondary">
        <Icon className="size-4" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{server.name}</span>
          <Badge variant={status.tone}>{status.label}</Badge>
          {errs.length > 0 && (
            <Badge variant="destructive" title={errs.map((i) => i.message).join("\n")}>
              <AlertTriangle className="size-3" /> {errs.length}
            </Badge>
          )}
          {errs.length === 0 && warns.length > 0 && (
            <Badge variant="warning" title={warns.map((i) => i.message).join("\n")}>
              <AlertTriangle className="size-3" /> {warns.length}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          <span className="not-italic text-fg-subtle">{tLabel}</span>
          <span className="mx-1.5 text-border-strong">·</span>
          {server.launch}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-3" onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={server.enabled}
          disabled={busy}
          onCheckedChange={async (v) => {
            setBusy(true);
            try {
              await onToggle(v);
            } finally {
              setBusy(false);
            }
          }}
          aria-label={server.enabled ? "Disable server" : "Enable server"}
        />
        <Button variant="ghost" size="sm" onClick={onOpen} className="opacity-0 group-hover:opacity-100">
          Manage
        </Button>
      </div>
    </div>
  );
}

// ── detail drawer ─────────────────────────────────────────────────────────────

function ServerDrawer({
  server,
  onClose,
  onChanged,
  onEdit,
}: {
  server: McpServerView;
  onClose: () => void;
  onChanged: (next: McpState | null) => void;
  onEdit: () => void;
}) {
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeErr, setProbeErr] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const status = statusOf(server);

  const runProbe = useCallback(async () => {
    setProbing(true);
    setProbeErr(null);
    try {
      const res = await fetch(`/api/mcp/probe?name=${encodeURIComponent(server.name)}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Probe failed");
      setProbe(body as McpProbeResult);
    } catch (e) {
      setProbeErr(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }, [server.name]);

  useEffect(() => {
    if (server.enabled) void runProbe();
  }, [server.enabled, runProbe]);

  const tools = probe?.tools ?? [];

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-5">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-lg">{server.name}</SheetTitle>
            <Badge variant={status.tone}>{status.label}</Badge>
          </div>
          <SheetDescription className="font-mono text-xs">{server.launch}</SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {/* Diagnostics */}
          {server.issues.length > 0 && (
            <div className="space-y-2">
              {server.issues.map((issue, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-2 rounded-control border px-3 py-2 text-xs leading-relaxed",
                    issue.level === "error"
                      ? "border-danger-border bg-danger-bg text-danger-fg"
                      : "border-warning-border bg-warning-bg text-warning-fg",
                  )}
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span>{issue.message}</span>
                </div>
              ))}
            </div>
          )}

          <DetailGrid server={server} />

          {/* Tools */}
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Wrench className="size-4 text-fg-subtle" /> Tools
              </h3>
              <Button variant="ghost" size="xs" onClick={() => void runProbe()} disabled={probing}>
                {probing ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
                {probe ? "Re-probe" : "Probe"}
              </Button>
            </div>
            {!server.enabled ? (
              <p className="text-xs text-muted-foreground">Enable this server to list its tools.</p>
            ) : probeErr ? (
              <p className="text-xs text-danger-fg">{probeErr}</p>
            ) : probing && !probe ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <InlineSpinner /> Connecting…
              </div>
            ) : (
              <ToolFilter
                serverName={server.name}
                tools={tools.map((t) => shortToolName(t, server.name))}
                include={server.include ?? []}
                exclude={server.exclude ?? []}
                busy={busy === "tools"}
                onSave={async (include, exclude) => {
                  setBusy("tools");
                  try {
                    onChanged(await postAction({ action: "tools", name: server.name, include, exclude }));
                  } finally {
                    setBusy(null);
                  }
                }}
              />
            )}
          </section>

          {/* Run history */}
          <ServerRunHistory serverName={server.name} />

          {/* OAuth */}
          {server.auth === "oauth" && (
            <OAuthPanel serverName={server.name} onChanged={onChanged} />
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-between border-t border-border px-6 py-4">
          {confirmRemove ? (
            <div className="flex w-full items-center justify-between gap-3">
              <span className="text-xs text-muted-foreground">Remove {server.name}?</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(false)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={busy === "remove"}
                  onClick={async () => {
                    setBusy("remove");
                    try {
                      onChanged(await postAction({ action: "remove", name: server.name }));
                      onClose();
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {busy === "remove" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="text-danger-fg" onClick={() => setConfirmRemove(true)}>
                <Trash2 className="size-3.5" /> Remove
              </Button>
              <div className="flex gap-2">
                <SheetClose asChild>
                  <Button variant="outline" size="sm">
                    Close
                  </Button>
                </SheetClose>
                <Button size="sm" onClick={onEdit}>
                  Edit connection
                </Button>
              </div>
            </>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function DetailGrid({ server }: { server: McpServerView }) {
  const rows: Array<[string, React.ReactNode]> = [];
  rows.push(["Transport", transportMeta(server.transport).label]);
  if (server.transport === "stdio") {
    if (server.command) rows.push(["Command", <Mono key="c">{server.command}</Mono>]);
    if (server.args?.length) rows.push(["Arguments", <Mono key="a">{server.args.join(" ")}</Mono>]);
    if (server.cwd) rows.push(["Working dir", <Mono key="w">{server.cwd}</Mono>]);
    if (server.envKeys?.length)
      rows.push(["Environment", <SecretList key="e" keys={server.envKeys} />]);
  } else {
    if (server.url) rows.push(["URL", <Mono key="u">{server.url}</Mono>]);
    if (server.headerKeys?.length)
      rows.push(["Headers", <SecretList key="h" keys={server.headerKeys} />]);
    rows.push(["Auth", server.auth === "oauth" ? "OAuth" : "None"]);
    if (server.sslVerify === false) rows.push(["TLS verify", <Badge key="t" variant="warning">Disabled</Badge>]);
    if (server.hasClientCert) rows.push(["mTLS", "Client certificate set"]);
  }
  if (server.requestTimeoutMs) rows.push(["Request timeout", `${Math.round(server.requestTimeoutMs / 1000)}s`]);
  if (server.connectionTimeoutMs) rows.push(["Connect timeout", `${Math.round(server.connectionTimeoutMs / 1000)}s`]);
  rows.push(["Parallel calls", server.parallel ? "Allowed" : "Serialized"]);

  return (
    <dl className="grid grid-cols-[130px_1fr] gap-x-4 gap-y-2.5 text-sm">
      {rows.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-subtle">{k}</dt>
          <dd className="min-w-0 break-words text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="break-all font-mono text-xs text-foreground">{children}</span>;
}

/** Renders secret-bearing keys as key names only, with a masked value chip. */
function SecretList({ keys }: { keys: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {keys.map((k) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary px-2 py-0.5 font-mono text-xs text-fg-secondary"
        >
          <KeyRound className="size-3 text-fg-subtle" />
          {k}
          <span className="text-fg-subtle">••••</span>
        </span>
      ))}
    </div>
  );
}

// ── tool include/exclude ──────────────────────────────────────────────────────

function ToolFilter({
  tools,
  include,
  exclude,
  busy,
  onSave,
}: {
  serverName: string;
  tools: string[];
  include: string[];
  exclude: string[];
  busy: boolean;
  onSave: (include: string[], exclude: string[]) => Promise<void>;
}) {
  // Local exclude set drives per-tool visibility. Existing include globs are
  // preserved; toggling a tool off adds it to exclude, on removes it.
  const [ex, setEx] = useState<Set<string>>(new Set(exclude));
  const dirty = useMemo(() => {
    const a = [...ex].sort().join(",");
    const b = [...exclude].sort().join(",");
    return a !== b;
  }, [ex, exclude]);

  if (tools.length === 0) {
    return <p className="text-xs text-muted-foreground">No tools reported by this server.</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Toggle which tools your agents may call. Hidden tools stay configured but are never offered.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {tools.map((t) => {
          const exposed = toolMatchesFilter(t, include, [...ex]);
          return (
            <button
              key={t}
              type="button"
              onClick={() =>
                setEx((prev) => {
                  const next = new Set(prev);
                  if (next.has(t)) next.delete(t);
                  else next.add(t);
                  return next;
                })
              }
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-xs transition-colors",
                exposed
                  ? "border-success-border bg-success-bg text-success-fg"
                  : "border-border bg-secondary text-fg-subtle line-through",
              )}
            >
              {exposed ? <Check className="size-3" /> : <X className="size-3" />}
              {t}
            </button>
          );
        })}
      </div>
      {dirty && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void onSave(include, [...ex])}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
            Save tool access
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setEx(new Set(exclude))} disabled={busy}>
            Reset
          </Button>
        </div>
      )}
    </div>
  );
}

// ── OAuth ──────────────────────────────────────────────────────────────────────

function OAuthPanel({
  serverName,
  onChanged,
}: {
  serverName: string;
  onChanged: (next: McpState | null) => void;
}) {
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login", name: serverName }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Login failed");
      if (body.authUrl) setAuthUrl(body.authUrl);
      else setMsg("Authorized.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "login", name: serverName, code }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Login failed");
      setAuthUrl(null);
      setCode("");
      setMsg("Authorized.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-xl border border-border bg-muted/40 p-4">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <KeyRound className="size-4 text-fg-subtle" /> OAuth
      </h3>
      {authUrl ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Authorize in your browser, then paste the code from the redirect.
          </p>
          <a
            href={authUrl}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-xs text-info-fg underline underline-offset-2"
          >
            {authUrl}
          </a>
          <div className="flex gap-2">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Authorization code" />
            <Button size="sm" onClick={() => void complete()} disabled={busy || !code.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Finish"}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => void begin()} disabled={busy}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Authorize"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-danger-fg"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                onChanged(await postAction({ action: "logout", name: serverName }));
                setMsg("Signed out.");
              } catch (e) {
                setMsg(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out
          </Button>
        </div>
      )}
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
    </section>
  );
}

// ── run history (from the audit log) ─────────────────────────────────────────────

interface ToolCallEvent {
  eventId: string;
  occurredAt: number;
  action: string;
  status: string;
  toolName?: string;
  agentId?: string;
  sessionKey?: string;
}

function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/**
 * Recent tool calls for this server, read from `openclaw audit`. MCP tools are
 * namespaced `<server>__<tool>`, so we filter the tool_action events by prefix.
 */
function ServerRunHistory({ serverName }: { serverName: string }) {
  const [events, setEvents] = useState<ToolCallEvent[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch("/api/audit?kind=tool_action&limit=200", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || "Failed to load run history");
      const prefix = `${serverName}__`;
      const all: ToolCallEvent[] = Array.isArray(body.events) ? body.events : [];
      // Keep the terminal (finished/failed) event per tool call; show newest first.
      const filtered = all
        .filter((e) => typeof e.toolName === "string" && e.toolName.startsWith(prefix))
        .sort((a, b) => b.occurredAt - a.occurredAt)
        .slice(0, 25);
      setEvents(filtered);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [serverName]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <History className="size-4 text-fg-subtle" /> Run history
        </h3>
        <Button variant="ghost" size="xs" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
          Refresh
        </Button>
      </div>
      {loading && !events ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <InlineSpinner /> Loading…
        </div>
      ) : err ? (
        <p className="text-xs text-muted-foreground">Run history unavailable ({err}).</p>
      ) : !events || events.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No tool calls recorded yet. Once your agents use this server, calls show up here.
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {events.map((e) => {
            const failed = /fail|error|deny/i.test(e.status);
            return (
              <li key={e.eventId} className="flex items-center gap-3 px-3 py-2 text-xs">
                {failed ? (
                  <CircleX className="size-3.5 shrink-0 text-danger-fg" />
                ) : (
                  <CircleCheck className="size-3.5 shrink-0 text-success-fg" />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                  {shortToolName(e.toolName || "", serverName)}
                </span>
                {e.agentId && (
                  <span className="hidden truncate text-fg-subtle sm:inline" title={e.sessionKey}>
                    {e.agentId}
                  </span>
                )}
                <span className="shrink-0 tabular-nums text-fg-subtle">{relativeTime(e.occurredAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ── Google Calendar managed connector ────────────────────────────────────────────

function GoogleCalendarPanel({
  open,
  alreadyAdded,
  onClose,
  onAddAgentTools,
}: {
  open: boolean;
  alreadyAdded: boolean;
  onClose: () => void;
  onAddAgentTools: () => void;
}) {
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<{ connected: boolean; count: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    (async () => {
      try {
        const res = await fetch("/api/calendar?days=14", { cache: "no-store" });
        const body = await res.json().catch(() => ({}));
        const connectors = Array.isArray(body?.connectors) ? body.connectors : [];
        const google = connectors.find((c: { provider?: string }) => c?.provider === "google") as
          | { detection?: { storedAuth?: boolean } }
          | undefined;
        const events = Array.isArray(body?.upcomingEvents) ? body.upcomingEvents : [];
        const count = events.filter((e: { provider?: string }) => e?.provider === "google").length;
        const connected = Boolean(google?.detection?.storedAuth) || count > 0;
        if (active) setSnapshot({ connected, count });
      } catch {
        if (active) setSnapshot({ connected: false, count: 0 });
      }
    })();
    return () => {
      active = false;
    };
  }, [open]);

  const connected = snapshot?.connected ?? false;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle className="flex items-center gap-2 text-lg">
            <ConnectorIcon domain="calendar.google.com" accent="#4285F4" title="Google Calendar" />
            Google Calendar
          </SheetTitle>
          <SheetDescription>
            One calendar, two places: your Calendar tab and your agent — both on the same Google sign-in.
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {/* Calendar tab sync */}
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <CalendarDays className="size-4 text-fg-subtle" />
              <h3 className="text-sm font-semibold text-foreground">Calendar tab sync</h3>
              {connected ? (
                <Badge variant="success">Synced{snapshot?.count ? ` · ${snapshot.count} events` : ""}</Badge>
              ) : (
                <Badge variant="outline">Not connected</Badge>
              )}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {connected
                ? "Your Google Calendar is flowing into the Calendar tab. Nothing else to do."
                : "Connect your Google account once and your real events appear in the Calendar tab."}
            </p>
            <Button size="sm" variant={connected ? "outline" : "default"} onClick={() => router.push("/calendar")}>
              <CalendarDays className="size-3.5" />
              {connected ? "Open Calendar" : "Connect Google Calendar"}
            </Button>
          </div>

          {/* Agent tools */}
          <div className="space-y-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <Plug className="size-4 text-fg-subtle" />
              <h3 className="text-sm font-semibold text-foreground">Agent tools (MCP)</h3>
              {alreadyAdded && <Badge variant="success">Added</Badge>}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Let your agent read and manage this calendar in chat and cron — book, move, and check events on
              your behalf. Runs the Google Calendar MCP locally with your own OAuth credentials.
            </p>
            {!alreadyAdded && (
              <Button size="sm" variant="outline" onClick={onAddAgentTools}>
                <ArrowRight className="size-3.5" /> Add agent tools
              </Button>
            )}
          </div>
        </div>

        <SheetFooter className="flex-row justify-end border-t border-border px-6 py-4">
          <Button variant="outline" size="sm" onClick={onClose}>
            Done
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── add / edit form ─────────────────────────────────────────────────────────────

interface KV {
  key: string;
  value: string;
  locked?: boolean; // existing secret, value hidden
}

function ServerForm({
  open,
  editing,
  preset,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: McpServerView | null;
  preset?: FormPreset | null;
  onClose: () => void;
  onSaved: (next: McpState | null) => void;
}) {
  const isEdit = Boolean(editing);
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwd, setCwd] = useState("");
  const [env, setEnv] = useState<KV[]>([]);
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<KV[]>([]);
  const [auth, setAuth] = useState(false);
  const [sslVerify, setSslVerify] = useState(true);
  const [parallel, setParallel] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // hydrate from the server being edited, or a catalog preset, or blank
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setTransport(editing.transport);
      setName(editing.name);
      setCommand(editing.command ?? "");
      setArgsText((editing.args ?? []).join(" "));
      setCwd(editing.cwd ?? "");
      setEnv((editing.envKeys ?? []).map((k) => ({ key: k, value: "", locked: true })));
      setUrl(editing.url ?? "");
      setHeaders((editing.headerKeys ?? []).map((k) => ({ key: k, value: "", locked: true })));
      setAuth(editing.auth === "oauth");
      setSslVerify(editing.sslVerify !== false);
      setParallel(Boolean(editing.parallel));
    } else if (preset) {
      setTransport(preset.transport);
      setName(preset.name);
      setCommand(preset.command ?? "");
      setArgsText((preset.args ?? []).join(" "));
      setCwd("");
      // Pre-seed the required secret fields so the user only fills values.
      const secretRows = (preset.secrets ?? []).map((s) => ({ key: s.key, value: "" }));
      if (preset.transport === "stdio") {
        setEnv(secretRows);
        setHeaders([]);
      } else {
        setHeaders(secretRows);
        setEnv([]);
      }
      setUrl(preset.url ?? "");
      setAuth(Boolean(preset.oauth));
      setSslVerify(true);
      setParallel(false);
    } else {
      setTransport("stdio");
      setName("");
      setCommand("");
      setArgsText("");
      setCwd("");
      setEnv([]);
      setUrl("");
      setHeaders([]);
      setAuth(false);
      setSslVerify(true);
      setParallel(false);
    }
    setErr(null);
  }, [open, editing, preset]);

  const submit = async () => {
    setSaving(true);
    setErr(null);
    try {
      const server: Record<string, unknown> = {
        name,
        transport,
        parallel,
      };
      if (transport === "stdio") {
        server.command = command;
        server.args = argsText.trim() ? argsText.trim().split(/\s+/) : [];
        server.cwd = cwd || undefined;
        server.env = env.filter((e) => e.key.trim()).map((e) => ({ key: e.key.trim(), value: e.value }));
      } else {
        server.url = url;
        server.headers = headers.filter((h) => h.key.trim()).map((h) => ({ key: h.key.trim(), value: h.value }));
        server.auth = auth ? "oauth" : null;
        server.sslVerify = sslVerify;
      }
      const next = await postAction({ action: isEdit ? "update" : "create", server });
      onSaved(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b border-border px-6 py-5">
          <SheetTitle>{isEdit ? `Edit ${editing?.name}` : "Add MCP server"}</SheetTitle>
          <SheetDescription>
            {transport === "stdio"
              ? "A local process the harness launches and speaks MCP to over stdio."
              : "A remote MCP server reached over HTTP."}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          {!isEdit && (
            <div className="grid grid-cols-2 gap-2 rounded-control bg-secondary p-1">
              {(["stdio", "streamable-http"] as const).map((t) => {
                const active = transport === t || (t === "streamable-http" && transport === "sse");
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTransport(t)}
                    className={cn(
                      "flex items-center justify-center gap-2 rounded-[calc(var(--radius-control)-2px)] px-3 py-1.5 text-sm font-medium transition-colors",
                      active ? "bg-card text-foreground shadow-sm" : "text-fg-subtle hover:text-foreground",
                    )}
                  >
                    {t === "stdio" ? <Terminal className="size-3.5" /> : <Globe className="size-3.5" />}
                    {t === "stdio" ? "Local (stdio)" : "HTTP"}
                  </button>
                );
              })}
            </div>
          )}

          <Field label="Name">
            <Input
              value={name}
              disabled={isEdit}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. context7"
            />
          </Field>

          {transport === "stdio" ? (
            <>
              <Field label="Command" hint="The executable to spawn.">
                <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="uvx" className="font-mono" />
              </Field>
              <Field label="Arguments" hint="Space-separated.">
                <Input
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder="context7-mcp"
                  className="font-mono"
                />
              </Field>
              <Field label="Working directory" hint="Optional.">
                <Input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/project" className="font-mono" />
              </Field>
              <KVEditor label="Environment" entries={env} onChange={setEnv} secret keyPlaceholder="API_KEY" />
              <p className="flex items-start gap-2 rounded-control border border-warning-border bg-warning-bg px-3 py-2 text-xs text-warning-fg">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                This runs a program on the Mission Control host. Only add commands you trust.
              </p>
            </>
          ) : (
            <>
              <Field label="URL">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" className="font-mono" />
              </Field>
              <div className="flex items-center gap-2">
                <SegBtn active={transport !== "sse"} onClick={() => setTransport("streamable-http")}>
                  Streamable HTTP
                </SegBtn>
                <SegBtn active={transport === "sse"} onClick={() => setTransport("sse")}>
                  SSE
                </SegBtn>
              </div>
              <KVEditor label="Headers" entries={headers} onChange={setHeaders} secret keyPlaceholder="Authorization" valuePlaceholder="Bearer …" />
              <Toggle label="OAuth" description="Authorize with an OAuth flow instead of a static header." checked={auth} onChange={setAuth} />
              <Toggle label="Verify TLS certificate" description="Turn off only for trusted internal hosts." checked={sslVerify} onChange={setSslVerify} />
            </>
          )}

          <Toggle
            label="Allow parallel tool calls"
            description="Mark this server safe for concurrent calls."
            checked={parallel}
            onChange={setParallel}
          />

          {err && (
            <p className="flex items-start gap-2 rounded-control border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger-fg">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {err}
            </p>
          )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border px-6 py-4">
          <SheetClose asChild>
            <Button variant="outline" size="sm">
              Cancel
            </Button>
          </SheetClose>
          <Button size="sm" onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Plug className="size-3.5" />}
            {isEdit ? "Save changes" : "Add & connect"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ── small form primitives ────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-fg-secondary">{label}</span>
      {children}
      {hint && <span className="block text-xs text-fg-subtle">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-xs font-medium text-fg-secondary">{label}</p>
        {description && <p className="text-xs text-fg-subtle">{description}</p>}
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-control border px-3 py-1.5 text-xs font-medium transition-colors",
        active ? "border-border-strong bg-card text-foreground" : "border-border text-fg-subtle hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function KVEditor({
  label,
  entries,
  onChange,
  secret,
  keyPlaceholder,
  valuePlaceholder,
}: {
  label: string;
  entries: KV[];
  onChange: (next: KV[]) => void;
  secret?: boolean;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  const set = (i: number, patch: Partial<KV>) =>
    onChange(entries.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium text-fg-secondary">{label}</span>
      <div className="space-y-2">
        {entries.map((e, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={e.key}
              onChange={(ev) => set(i, { key: ev.target.value })}
              placeholder={keyPlaceholder || "KEY"}
              className="font-mono"
            />
            <Input
              value={e.value}
              type={secret ? "password" : "text"}
              onChange={(ev) => set(i, { value: ev.target.value, locked: false })}
              placeholder={e.locked ? "•••••• (unchanged)" : valuePlaceholder || "value"}
              className="font-mono"
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onChange(entries.filter((_, idx) => idx !== i))}
              aria-label="Remove"
            >
              <X className="size-4" />
            </Button>
          </div>
        ))}
      </div>
      <Button variant="ghost" size="xs" onClick={() => onChange([...entries, { key: "", value: "" }])}>
        <Plus className="size-3" /> Add {label.toLowerCase().replace(/s$/, "")}
      </Button>
    </div>
  );
}

// ── states ────────────────────────────────────────────────────────────────────

function EmptyState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-4 rounded-xl border border-dashed border-border px-8 py-12 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-secondary text-fg-secondary">
        <Plug className="size-5" />
      </div>
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-foreground">Give your agents superpowers</h2>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connect a Model Context Protocol server and your agents gain new tools — calendars, code hosts,
          browsers, databases. Start from a ready-made connector or add your own.
        </p>
      </div>
      <Button onClick={onBrowse}>
        <Sparkles className="size-4" /> Browse connectors
      </Button>
    </div>
  );
}

function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-danger-border bg-danger-bg px-6 py-10 text-center">
      <AlertTriangle className="size-6 text-danger-fg" />
      <p className="max-w-md text-sm text-danger-fg">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3.5" /> Retry
      </Button>
    </div>
  );
}
