"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { useSearchParams } from "next/navigation";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Eye,
  ExternalLink,
  HardDrive,
  Inbox,
  Mail,
  MailCheck,
  MailPlus,
  RefreshCw,
  Search,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { InlineSpinner, ScreenLoadingState } from "@/components/ui/loading-state";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

type AgentSummary = {
  id: string;
  name: string;
  isDefault: boolean;
};

type Capability = {
  key: string;
  service: "gmail" | "calendar" | "drive";
  label: string;
  description: string;
  category: "read" | "draft" | "write";
  enabled?: boolean;
  policy?: "deny" | "ask" | "allow" | null;
};

type AccountRecord = {
  id: string;
  email: string;
  label: string;
  status: "connected" | "pending" | "needs-reauthorization" | "limited-access" | "error";
  accessLevel: "read-only" | "read-draft" | "read-write" | "custom";
  pendingAuthUrl: string | null;
  pendingAuthStartedAt: number | null;
  lastCheckedAt: number | null;
  lastError: string | null;
  capabilityMatrix: Capability[];
  connectionNotes: string[];
  serviceStates: Record<
    "gmail" | "calendar" | "drive",
    {
      enabled: boolean;
      apiStatus: "ready" | "unverified" | "error";
      scopeStatus: "full" | "readonly" | "unknown";
      lastCheckedAt: number | null;
      lastError: string | null;
    }
  >;
  watch: {
    enabled: boolean;
    status: "inactive" | "configured" | "watching" | "error";
    targetAgentId: string | null;
    label: string;
    projectId: string;
    topic: string;
    subscription: string;
    hookUrl: string;
    hookToken: string;
    pushEndpoint: string;
    pushToken: string;
    port: string;
    path: string;
    tailscaleMode: "funnel" | "serve" | "off";
    includeBody: boolean;
    maxBytes: number;
    lastConfiguredAt: number | null;
    lastCheckedAt: number | null;
    lastError: string | null;
  };
  diagnostics?: {
    accountId: string;
    generatedAt: number;
    checks: Array<{
      key: string;
      label: string;
      ok: boolean;
      detail: string;
      fixAction: string | null;
    }>;
  };
};

type Approval = {
  id: string;
  accountId: string;
  agentId: string;
  capability: string;
  actionLabel: string;
  summary: string;
  status: "pending" | "approved" | "denied" | "completed" | "failed";
  createdAt: number;
  resolvedAt: number | null;
  resultSummary: string | null;
  error: string | null;
};

type AuditEntry = {
  id: string;
  accountId: string | null;
  agentId: string | null;
  capability: string;
  action: string;
  summary: string;
  status: "success" | "error" | "queued" | "denied" | "info";
  detail: string | null;
  createdAt: number;
};

type Snapshot = {
  generatedAt: number;
  runtime: {
    gog: {
      available: boolean;
      bin: string | null;
    };
    auth: {
      credentialsExists: boolean;
      credentialsPath: string | null;
      keyringBackend: string | null;
      keyringSource: string | null;
      serviceAccountConfigured: boolean;
    };
    storedAccounts: Array<{ email: string; source: "gog" | "keychain-fallback" }>;
    supportsGmailWatch: boolean;
  };
  agents: AgentSummary[];
  selectedAgentId: string | null;
  capabilities: Capability[];
  store: {
    updatedAt: number;
    accounts: AccountRecord[];
    approvals: Approval[];
    audit: AuditEntry[];
  };
};

type ApiResponse = {
  ok?: boolean;
  error?: string;
  authUrl?: string;
  authMode?: "live" | "remote";
  authStatus?: "waiting" | "completed" | "failed" | "timeout" | "none";
  queued?: boolean;
  result?: unknown;
  approval?: Approval | null;
  snapshot?: Snapshot;
  warning?: string | null;
};

type MailboxThread = {
  id: string;
  messageId: string | null;
  subject: string;
  snippet: string;
  from: string;
  to: string[];
  lastMessageAt: string | null;
};

type ThreadMessage = {
  id: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: string | null;
  snippet: string;
  bodyText: string;
};

type ThreadDetails = {
  id: string;
  subject: string;
  snippet: string;
  messages: ThreadMessage[];
};

type CalendarEvent = {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  calendarName: string;
  location?: string;
  notes?: string;
};

const ACCESS_LEVEL_LABELS: Record<AccountRecord["accessLevel"], string> = {
  "read-only": "Read Only",
  "read-draft": "Read + Draft",
  "read-write": "Read + Write",
  custom: "Custom",
};

const POLICY_OPTIONS = [
  { value: "deny", label: "Denied" },
  { value: "ask", label: "Requires Approval" },
  { value: "allow", label: "Allowed" },
] as const;

function formatAgo(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatDateTime(ts: number | null): string {
  if (!ts) return "n/a";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ts));
}

function statusTone(status: AccountRecord["status"]): string {
  switch (status) {
    case "connected":
      return "border-success-border bg-success-bg text-success-fg";
    case "limited-access":
      return "border-warning-border bg-warning-bg text-warning-fg";
    case "pending":
      return "border-info-border bg-info-bg text-info-fg";
    default:
      return "border-danger-border bg-danger-bg text-danger-fg";
  }
}

function serviceStatusTone(status: "ready" | "unverified" | "error") {
  switch (status) {
    case "ready":
      return "border-success-border bg-success-bg text-success-fg";
    case "error":
      return "border-danger-border bg-danger-bg text-danger-fg";
    default:
      return "border-border-strong bg-muted text-fg-secondary dark:border-border dark:text-muted-foreground";
  }
}

function capabilityIcon(capability: Capability["key"]) {
  if (capability.includes("send") || capability.includes("reply")) return Send;
  if (capability.includes("draft")) return MailCheck;
  return Eye;
}

function firstDefault<T extends { isDefault?: boolean }>(rows: T[]): T | null {
  return rows.find((entry) => entry.isDefault) || rows[0] || null;
}

const DRAFT_KEY = "openclaw:integrations-drafts";

function loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFT_KEY) || "{}");
  } catch {
    return {};
  }
}

function saveDraft(field: string, value: string) {
  try {
    const drafts = loadDrafts();
    if (value) drafts[field] = value;
    else delete drafts[field];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(drafts));
  } catch { /* quota exceeded — ignore */ }
}

function clearAllDrafts() {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

/** useState backed by localStorage — saves instantly on every change. */
function useDraft(field: string, fallback = ""): [string, (v: string) => void] {
  const [value, setValue] = useState(() => loadDrafts()[field] ?? fallback);
  const set = useCallback((v: string) => {
    setValue(v);
    saveDraft(field, v);
  }, [field]);
  return [value, set];
}

export function IntegrationsView() {
  const searchParams = useSearchParams();
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");
  const [connectEmail, setConnectEmail] = useState("");
  const [connectAccessLevel, setConnectAccessLevel] = useState<AccountRecord["accessLevel"]>("read-only");
  const [redirectUrl, setRedirectUrl] = useState("");
  const [searchQuery, setSearchQuery] = useState("in:inbox newer_than:14d");
  const [threads, setThreads] = useState<MailboxThread[]>([]);
  const [threadBusy, setThreadBusy] = useState<string | null>(null);
  const [threadDetails, setThreadDetails] = useState<ThreadDetails | null>(null);
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [composeTo, setComposeTo] = useDraft("composeTo");
  const [composeSubject, setComposeSubject] = useDraft("composeSubject");
  const [composeBody, setComposeBody] = useDraft("composeBody");
  const [replyBody, setReplyBody] = useDraft("replyBody");
  const [calendarTitle, setCalendarTitle] = useDraft("calendarTitle");
  const [calendarFrom, setCalendarFrom] = useDraft("calendarFrom");
  const [calendarTo, setCalendarTo] = useDraft("calendarTo");
  const [calendarLocation, setCalendarLocation] = useDraft("calendarLocation");
  const [calendarDescription, setCalendarDescription] = useDraft("calendarDescription");
  const [calendarEventId, setCalendarEventId] = useDraft("calendarEventId");
  const [notice, setNotice] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);

  const load = useCallback(async (agentId?: string) => {
    setLoading(true);
    setError(null);
    try {
      const url = agentId ? `/api/integrations?agentId=${encodeURIComponent(agentId)}` : "/api/integrations";
      const response = await fetch(url, { cache: "no-store" });
      const json = (await response.json()) as Snapshot & { error?: string };
      if (!response.ok) {
        throw new Error(json.error || `Failed to load integrations (${response.status})`);
      }
      setData(json);
      const nextAgentId = agentId || json.selectedAgentId || firstDefault(json.agents)?.id || "";
      setSelectedAgentId(nextAgentId);
      setSelectedAccountId((current) =>
        current && json.store.accounts.some((entry) => entry.id === current)
          ? current
          : json.store.accounts[0]?.id || "",
      );
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const agentId = searchParams.get("agentId");
    void load(agentId || undefined);
  }, [load, searchParams]);

  // Poll for live auth completion when an account has a pending auth URL
  const pendingAuthEmail = useMemo(
    () => data?.store.accounts.find((a) => a.pendingAuthUrl)?.email || null,
    [data],
  );

  useSmartPoll(
    async () => {
      if (!pendingAuthEmail) return;
      try {
        const response = await fetch("/api/integrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "poll-auth-status", email: pendingAuthEmail }),
        });
        const json = await response.json();
        if (json.authStatus === "completed" && json.snapshot) {
          setData(json.snapshot);
          setNotice("Google account connected successfully.");
        }
      } catch { /* ignore polling errors */ }
    },
    { intervalMs: 10000, enabled: !!pendingAuthEmail },
  );

  const runAction = useCallback(
    async (action: string, body: Record<string, unknown>) => {
      setActionBusy(action);
      setError(null);
      setNotice(null);
      try {
        const response = await fetch("/api/integrations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            ...body,
            agentId: body.agentId || selectedAgentId || undefined,
          }),
        });
        const json = (await response.json()) as ApiResponse;
        if (!response.ok || json.ok === false) {
          throw new Error(json.error || `Action failed: ${action}`);
        }
        if (json.snapshot) {
          setData(json.snapshot);
          if (json.snapshot.selectedAgentId) setSelectedAgentId(json.snapshot.selectedAgentId);
          if (!selectedAccountId && json.snapshot.store.accounts[0]) {
            setSelectedAccountId(json.snapshot.store.accounts[0].id);
          }
          // Auto-select the account that just started auth so the user sees the Finish Connection card
          if (action === "start-connect" && body.email) {
            const pending = json.snapshot.store.accounts.find(
              (a: AccountRecord) => a.email === String(body.email).toLowerCase() && a.pendingAuthUrl,
            );
            if (pending) setSelectedAccountId(pending.id);
          }
        }
        if (json.warning) setNotice(json.warning);
        if (json.queued) {
          setNotice("Action queued for approval. Review it in the Approval Queue below.");
        }
        // Clear drafts after successful send/draft/calendar actions
        if (action === "gmail-send") {
          setComposeTo(""); setComposeSubject(""); setComposeBody("");
        } else if (action === "gmail-reply" || action === "gmail-draft") {
          setReplyBody("");
        } else if (action === "calendar-create" || action === "calendar-update") {
          setCalendarTitle(""); setCalendarFrom(""); setCalendarTo("");
          setCalendarLocation(""); setCalendarDescription(""); setCalendarEventId("");
        }
        return json;
      } catch (actionError) {
        const message = actionError instanceof Error ? actionError.message : String(actionError);
        setError(message);
        throw actionError;
      } finally {
        setActionBusy(null);
      }
    },
    [selectedAgentId, selectedAccountId],
  );

  const selectedAccount = useMemo(
    () => data?.store.accounts.find((entry) => entry.id === selectedAccountId) || null,
    [data, selectedAccountId],
  );

  const selectedAgent = useMemo(
    () => data?.agents.find((entry) => entry.id === selectedAgentId) || null,
    [data, selectedAgentId],
  );

  const pendingApprovals = useMemo(
    () => (data?.store.approvals || []).filter((entry) => entry.status === "pending"),
    [data],
  );

  const accountMatrix = useMemo(
    () => selectedAccount?.capabilityMatrix || [],
    [selectedAccount],
  );

  const serviceSummaries = useMemo(() => {
    if (!selectedAccount) return [];
    return (["gmail", "calendar", "drive"] as const).map((service) => {
      const capabilities = accountMatrix.filter((capability) => capability.service === service);
      const readEnabled = capabilities.some(
        (capability) => capability.enabled && capability.category === "read",
      );
      const writeEnabled = capabilities.some(
        (capability) => capability.enabled && capability.category !== "read",
      );
      const writePolicies = capabilities
        .filter((capability) => capability.category !== "read" && capability.enabled)
        .map((capability) => capability.policy);
      const approvalSummary =
        writePolicies.length === 0
          ? "No write actions enabled"
          : writePolicies.every((policy) => policy === "ask")
            ? "Writes require approval"
            : writePolicies.every((policy) => policy === "allow")
              ? "Writes allowed automatically"
              : writePolicies.every((policy) => policy === "deny")
                ? "Writes denied"
                : "Mixed write policies";
      return {
        service,
        label: service === "gmail" ? "Gmail" : service === "calendar" ? "Calendar" : "Drive",
        description:
          service === "gmail"
            ? "Read and send email"
            : service === "calendar"
              ? "Read and manage events"
              : "Browse and manage files",
        capabilities,
        readEnabled,
        writeEnabled,
        serviceState: selectedAccount.serviceStates[service],
        approvalSummary,
      };
    });
  }, [accountMatrix, selectedAccount]);

  const canAct = Boolean(selectedAccount && selectedAgent);

  const syncAgentSelection = useCallback(
    async (agentId: string) => {
      setSelectedAgentId(agentId);
      await load(agentId);
    },
    [load],
  );

  const focusSection = useCallback((id: string) => {
    if (typeof document === "undefined") return;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handlePolicyChange = useCallback(
    async (capability: string, policy: string) => {
      if (!selectedAccount || !selectedAgent || !policy) return;
      await runAction("set-agent-policy", {
        accountId: selectedAccount.id,
        agentId: selectedAgent.id,
        capability,
        policy,
      });
    },
    [runAction, selectedAccount, selectedAgent],
  );

  const handleServiceAccess = useCallback(
    async (service: "gmail" | "calendar" | "drive", mode: "read" | "write") => {
      if (!selectedAccount) return;
      await runAction("set-service-access", {
        accountId: selectedAccount.id,
        service,
        mode,
      });
    },
    [runAction, selectedAccount],
  );

  const handleSearch = useCallback(async () => {
    if (!selectedAccount || !selectedAgent) return;
    const response = await runAction("gmail-search", {
      accountId: selectedAccount.id,
      agentId: selectedAgent.id,
      query: searchQuery.trim() || "in:inbox",
      max: 20,
    });
    if (response?.result && Array.isArray(response.result)) {
      setThreads(response.result as MailboxThread[]);
    }
  }, [runAction, searchQuery, selectedAccount, selectedAgent]);

  const handleThreadOpen = useCallback(
    async (threadId: string) => {
      if (!selectedAccount || !selectedAgent) return;
      setThreadBusy(threadId);
      try {
        const response = await runAction("gmail-read-thread", {
          accountId: selectedAccount.id,
          agentId: selectedAgent.id,
          threadId,
        });
        if (response?.result && typeof response.result === "object") {
          const detail = response.result as ThreadDetails;
          setThreadDetails(detail);
          setReplyBody("");
          setComposeSubject(detail.subject);
        }
      } finally {
        setThreadBusy(null);
      }
    },
    [runAction, selectedAccount, selectedAgent],
  );

  const loadCalendar = useCallback(async () => {
    if (!selectedAccount || !selectedAgent) return;
    const response = await runAction("calendar-list", {
      accountId: selectedAccount.id,
      agentId: selectedAgent.id,
      days: 7,
    });
    if (response?.result && Array.isArray(response.result)) {
      setCalendarEvents(response.result as CalendarEvent[]);
    }
  }, [runAction, selectedAccount, selectedAgent]);

  const handleDiagnosticFixAction = useCallback(
    async (fixAction: string) => {
      if (!selectedAccount) return;
      switch (fixAction) {
        case "Reconnect": {
          const response = await runAction("start-connect", {
            email: selectedAccount.email,
            accessLevel: selectedAccount.accessLevel,
          });
          return;
        }
        case "Check Access":
          await runAction("check-access", { accountId: selectedAccount.id });
          return;
        case "Update Permissions":
          focusSection("agent-permissions");
          return;
        case "Enable Watch":
          focusSection("incoming-events");
          return;
        default:
          return;
      }
    },
    [focusSection, runAction, selectedAccount],
  );

  if (loading && !data) {
    return <ScreenLoadingState />;
  }

  return (
    <SectionLayout>
      <SectionHeader
        title="Integrations"
        description="Connect Google, set clear read/write permissions, control what each agent can do, and handle approvals without touching a terminal."
        meta={
          data
            ? `Updated ${formatAgo(data.store.updatedAt)} · ${
                data.runtime.gog.available ? "gog is available" : "gog is unavailable"
              }`
            : undefined
        }
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowGuide((current) => !current)}
            >
              <Shield className="mr-2 h-4 w-4" />
              Setup Guide
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void load(selectedAgentId || undefined)}
              disabled={loading}
            >
              {loading ? <InlineSpinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Refresh
            </Button>
          </>
        }
      />
      <SectionBody width="wide" padding="regular">
        <div className="space-y-6">
          {showGuide ? (
            <Card id="setup-guide">
              <CardHeader>
                <CardTitle>Setup guide</CardTitle>
                <CardDescription>
                  Follow this if you want the browser-only path without touching a terminal.
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 md:grid-cols-2">
                <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                  <p className="font-medium text-foreground">1. Choose access level</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-secondary dark:text-muted-foreground">
                    <li><strong>Read Only</strong>: read inbox and calendar, but no sending or updates.</li>
                    <li><strong>Read + Draft</strong>: read plus draft replies for approval.</li>
                    <li><strong>Read + Write</strong>: read and perform the write actions you allow.</li>
                  </ul>
                </div>
                <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                  <p className="font-medium text-foreground">2. Connect Google</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-fg-secondary dark:text-muted-foreground">
                    <li>Enter your email and click <strong>Start Browser-Safe Connect</strong>.</li>
                    <li>Complete Google sign-in in the new tab.</li>
                    <li>Copy the complete final redirect URL.</li>
                    <li>Paste it into <strong>Finish Connection</strong> and submit.</li>
                  </ol>
                </div>
                <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                  <p className="font-medium text-foreground">3. Pick an agent</p>
                  <p className="mt-2 text-sm text-fg-secondary dark:text-muted-foreground">
                    Each capability can be set to <strong>Denied</strong>, <strong>Requires Approval</strong>, or <strong>Allowed</strong> for the selected agent.
                  </p>
                </div>
                <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                  <p className="font-medium text-foreground">4. Recover if something breaks</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-fg-secondary dark:text-muted-foreground">
                    <li>Use <strong>Check Access</strong> if Gmail or Calendar stops working.</li>
                    <li>Use <strong>Reconnect</strong> if the account needs reauthorization.</li>
                    <li>Use <strong>Configure Gmail Watch</strong> after filling in the project and webhook details.</li>
                  </ul>
                </div>
              </CardContent>
            </Card>
          ) : null}
          {error ? (
            <Card className="border-danger-border bg-danger-bg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-danger-fg">
                  <AlertCircle className="h-5 w-5" />
                  Something needs attention
                </CardTitle>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}
          {notice ? (
            <Card className="border-info-border bg-info-bg">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-info-fg">
                  <ShieldCheck className="h-5 w-5" />
                  Update
                </CardTitle>
                <CardDescription>{notice}</CardDescription>
              </CardHeader>
            </Card>
          ) : null}

          <div className="grid gap-6 lg:grid-cols-[1.05fr_1.95fr]">
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>Runtime</CardTitle>
                  <CardDescription>
                    Mission Control uses `gogcli` behind the scenes so non-technical users stay in the browser.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  <div className="flex items-center justify-between rounded-lg border border-border/80 px-3 py-2 dark:border-border">
                    <span>gog runtime</span>
                    <Badge className={cn("border", data?.runtime.gog.available ? statusTone("connected") : statusTone("error"))}>
                      {data?.runtime.gog.available ? "Available" : "Unavailable"}
                    </Badge>
                  </div>
                  <div className="flex items-center justify-between rounded-lg border border-border/80 px-3 py-2 dark:border-border">
                    <span>OAuth client</span>
                    <Badge className={cn("border", data?.runtime.auth.credentialsExists ? statusTone("connected") : serviceStatusTone("unverified"))}>
                      {data?.runtime.auth.credentialsExists ? "Configured" : "Using gog default client"}
                    </Badge>
                  </div>
                  <div className="rounded-lg border border-border/80 px-3 py-2 dark:border-border">
                    <div className="flex items-center justify-between">
                      <span>Stored Google accounts</span>
                      <span className="text-sm font-medium">{data?.runtime.storedAccounts.length || 0}</span>
                    </div>
                    {(data?.runtime.storedAccounts.length ?? 0) > 0 && (
                      <div className="mt-2 space-y-1">
                        {data!.runtime.storedAccounts.map((acct) => (
                          <div
                            key={acct.email}
                            className="flex items-center gap-2 rounded px-2 py-1 text-xs text-fg-secondary dark:bg-background dark:text-muted-foreground"
                          >
                            <Mail className="h-3 w-3 shrink-0 opacity-60" />
                            <span className="truncate">{acct.email}</span>
                            {acct.source === "keychain-fallback" ? (
                              <Badge variant="outline" className="ml-auto shrink-0 border-warning-border px-1 py-0 text-[10px] text-warning-fg">
                                needs re-auth
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="ml-auto shrink-0 border-success-border px-1 py-0 text-[10px] text-success-fg">
                                ready
                              </Badge>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                    {data?.runtime.storedAccounts.every((a) => a.source === "keychain-fallback") && (data?.runtime.storedAccounts.length ?? 0) > 0 && (
                      <p className="mt-2 text-[11px] text-warning-fg">
                        Tokens found in macOS Keychain but not recognized by gog. Use Connect Google below to re-authorize.
                      </p>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Keyring backend: {data?.runtime.auth.keyringBackend || "unknown"} · source:{" "}
                    {data?.runtime.auth.keyringSource || "unknown"}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Connect Google</CardTitle>
                  <CardDescription>
                    Choose an explicit access level first. The default safe option is Read Only.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground dark:text-fg-subtle">
                      Google account email
                    </label>
                    <Input
                      value={connectEmail}
                      onChange={(event) => setConnectEmail(event.target.value)}
                      placeholder="you@company.com"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground dark:text-fg-subtle">
                      Connection access
                    </label>
                    <select
                      className="flex h-10 w-full rounded-md border border-border bg-card px-3 text-sm dark:bg-background"
                      value={connectAccessLevel}
                      onChange={(event) => setConnectAccessLevel(event.target.value as AccountRecord["accessLevel"])}
                    >
                      <option value="read-only">Read Only</option>
                      <option value="read-draft">Read + Draft</option>
                      <option value="read-write">Read + Write</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                  <div className="rounded-lg border border-border/80 bg-muted p-3 text-sm text-fg-secondary dark:border-border dark:bg-background dark:text-muted-foreground">
                    {connectAccessLevel === "read-only" && "The assistant can look things up, but cannot send or change anything."}
                    {connectAccessLevel === "read-draft" && "The assistant can read and prepare drafts, but you keep control before anything is sent."}
                    {connectAccessLevel === "read-write" && "The assistant can read and take approved actions like replying or creating events."}
                    {connectAccessLevel === "custom" && "Custom mode lets you turn specific capabilities on or off after the account is connected."}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      onClick={() =>
                        void runAction("start-connect", {
                          email: connectEmail,
                          accessLevel: connectAccessLevel,
                        })
                      }
                      disabled={!connectEmail.trim() || actionBusy !== null}
                    >
                      {actionBusy === "start-connect" ? <InlineSpinner className="mr-2 h-4 w-4" /> : <Sparkles className="mr-2 h-4 w-4" />}
                      Start Browser-Safe Connect
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() =>
                        void runAction("import-existing-account", {
                          email: connectEmail,
                          accessLevel: connectAccessLevel,
                        })
                      }
                      disabled={!connectEmail.trim() || actionBusy !== null}
                    >
                      Import Existing gog Account
                    </Button>
                  </div>
                  {data?.runtime.storedAccounts.length ? (
                    <div className="rounded-xl border border-border/80 p-3 dark:border-border">
                      <p className="text-sm font-medium text-foreground">
                        Detected existing Google accounts
                      </p>
                      <div className="mt-3 space-y-2">
                        {data.runtime.storedAccounts.map((account) => (
                          <div
                            key={account.email}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/80 px-3 py-2 dark:border-border"
                          >
                            <div>
                              <p className="text-sm font-medium text-foreground">
                                {account.email}
                              </p>
                              <p className="text-xs text-muted-foreground dark:text-fg-subtle">
                                {account.source === "keychain-fallback"
                                  ? "Found in macOS Keychain but needs re-authorization through gog."
                                  : "Available in gog. Import it to manage permissions here."}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() =>
                                account.source === "keychain-fallback"
                                  ? void runAction("start-connect", {
                                      email: account.email,
                                      accessLevel: connectAccessLevel,
                                    })
                                  : void runAction("import-existing-account", {
                                      email: account.email,
                                      accessLevel: connectAccessLevel,
                                    })
                              }
                              disabled={actionBusy !== null}
                            >
                              {account.source === "keychain-fallback" ? "Re-authorize" : "Import"}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="rounded-lg border border-dashed border-border-strong p-3 text-sm dark:border-border">
                    <p className="font-medium text-foreground">For non-technical users</p>
                    <ol className="mt-2 list-decimal space-y-1 pl-5 text-fg-secondary dark:text-muted-foreground">
                      <li>Click <strong>Start Browser-Safe Connect</strong>.</li>
                      <li>Sign in to Google in the new tab.</li>
                      <li>After Google redirects you, copy the full final browser URL.</li>
                      <li>Paste it into the “Finish connection” box below and click finish.</li>
                    </ol>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Accounts</CardTitle>
                  <CardDescription>
                    Connected Google accounts and their current safety level.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(data?.store.accounts || []).length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-fg-secondary dark:border-border dark:text-muted-foreground">
                      No Google accounts connected yet.
                    </div>
                  ) : null}
                  {(data?.store.accounts || []).map((account) => (
                    <button
                      key={account.id}
                      type="button"
                      onClick={() => setSelectedAccountId(account.id)}
                      className={cn(
                        "w-full rounded-xl border px-4 py-3 text-left transition-colors",
                        selectedAccountId === account.id
                          ? "border-info-border bg-info-bg"
                          : "border-border/80 hover:border-border-strong dark:border-border dark:hover:border-border",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-medium text-foreground">{account.label}</p>
                          <p className="text-sm text-muted-foreground">{account.email}</p>
                        </div>
                        <Badge className={cn("border", statusTone(account.status))}>
                          {account.status}
                        </Badge>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Badge variant="outline">Google</Badge>
                        <Badge variant="outline">{ACCESS_LEVEL_LABELS[account.accessLevel]}</Badge>
                        <Badge variant="outline">Gmail {account.serviceStates.gmail.scopeStatus}</Badge>
                        <Badge variant="outline">Calendar {account.serviceStates.calendar.scopeStatus}</Badge>
                        <Badge variant="outline">Drive {account.serviceStates.drive.scopeStatus}</Badge>
                        <Badge variant="outline">
                          Watch {account.watch.status}
                        </Badge>
                      </div>
                      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground dark:text-fg-subtle">
                        <span>Last checked {formatAgo(account.lastCheckedAt)}</span>
                        <span>Manage Access</span>
                      </div>
                    </button>
                  ))}
                </CardContent>
              </Card>
            </div>

            <div className="space-y-6">
              {!selectedAccount ? (
                <Card>
                  <CardHeader>
                    <CardTitle>Select an account</CardTitle>
                    <CardDescription>
                      Once you connect Google, Mission Control will show access, approvals, inbox actions, calendar actions, and troubleshooting here.
                    </CardDescription>
                  </CardHeader>
                </Card>
              ) : (
                <>
                  {selectedAccount.pendingAuthUrl ? (
                    <Card className="border-info-border bg-info-bg">
                      <CardHeader>
                        <CardTitle className="text-info-fg">
                          Waiting for Google sign-in
                        </CardTitle>
                        <CardDescription>
                          Started {formatAgo(selectedAccount.pendingAuthStartedAt)}.
                          Open the link below on this machine and sign in. The connection will complete automatically.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="flex items-center gap-3">
                          <a
                            href={selectedAccount.pendingAuthUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-2 rounded-lg border border-info-border bg-info-bg px-4 py-2 text-sm font-medium text-info-fg transition-colors hover:bg-info-bg"
                          >
                            Open Google Sign-In <ExternalLink className="h-4 w-4" />
                          </a>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <RefreshCw className="h-3 w-3 animate-spin" />
                            Waiting for callback...
                          </div>
                        </div>

                        <details className="group text-sm">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-fg-secondary">
                            Accessing remotely? Use manual mode instead
                          </summary>
                          <div className="mt-3 space-y-3 rounded-lg border border-border/80 p-3 dark:border-border">
                            <p className="text-xs text-fg-secondary dark:text-muted-foreground">
                              If you are accessing this machine remotely (SSH, VNC, etc.), the automatic
                              callback won&apos;t work from your local browser. Instead:
                            </p>
                            <ol className="list-decimal space-y-1 pl-5 text-xs text-fg-secondary dark:text-muted-foreground">
                              <li>Open the sign-in link above and log in with Google.</li>
                              <li>
                                You&apos;ll see <strong>&quot;This site can&apos;t be reached&quot;</strong> — that&apos;s normal.
                              </li>
                              <li>Copy the <strong>full URL</strong> from the address bar and paste it below.</li>
                            </ol>
                            <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                              <Input
                                value={redirectUrl}
                                onChange={(event) => setRedirectUrl(event.target.value)}
                                placeholder="http://127.0.0.1:…/oauth2/callback?code=…"
                                className="text-xs"
                              />
                              <Button
                                type="button"
                                size="sm"
                                onClick={() =>
                                  void runAction("finish-connect", {
                                    accountId: selectedAccount.id,
                                    authUrl: redirectUrl,
                                  }).then(() => setRedirectUrl(""))
                                }
                                disabled={!redirectUrl.trim() || actionBusy !== null}
                              >
                                Finish
                              </Button>
                            </div>
                          </div>
                        </details>
                      </CardContent>
                    </Card>
                  ) : null}

                  <div className="space-y-6">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Button
                        type="button"
                        variant="ghost"
                        className="justify-start px-0 text-fg-secondary hover:bg-transparent hover:text-foreground dark:text-muted-foreground"
                        onClick={() => setSelectedAccountId("")}
                      >
                        Back
                      </Button>
                      <div className="flex flex-wrap gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={() => setShowGuide((current) => !current)}
                        >
                          Setup Guide
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="border-danger-border bg-danger-bg text-danger-fg hover:bg-danger-bg"
                          onClick={() =>
                            void runAction("disconnect-account", { accountId: selectedAccount.id })
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    </div>

                    <Card className="border-dashed border-border-strong/80 dark:border-border">
                      <CardContent className="space-y-6 p-5">
                        <section className="space-y-2">
                          <p className="text-[10px] uppercase tracking-widest text-fg-subtle">
                            Agent Identity
                          </p>
                          <h2 className="text-sm font-semibold text-foreground">
                            {selectedAgent?.name || "Selected Agent"}
                          </h2>
                          <p className="text-xs text-muted-foreground">
                            Manage tool access, scopes, and approval policies for this agent.
                          </p>
                          <div className="max-w-xs pt-1">
                            <label className="text-[10px] uppercase tracking-widest text-fg-subtle">
                              Acting agent
                            </label>
                            <select
                              className="mt-1 flex h-8 w-full rounded-lg border border-border bg-card px-2 text-xs dark:bg-background dark:text-fg-secondary"
                              value={selectedAgentId}
                              onChange={(event) => void syncAgentSelection(event.target.value)}
                            >
                              {(data?.agents || []).map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {agent.name}
                                  {agent.isDefault ? " (default)" : ""}
                                </option>
                              ))}
                            </select>
                          </div>
                        </section>

                        <section className="space-y-4">
                          {serviceSummaries.map((service) => {
                            const ServiceIcon = service.service === "gmail" ? Mail : service.service === "calendar" ? CalendarDays : HardDrive;
                            return (
                              <div
                                key={service.service}
                                className="rounded-xl border border-border/80 bg-card p-4 dark:border-border"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-3">
                                  <div className="flex items-center gap-3">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted dark:bg-background">
                                      <ServiceIcon className="h-4 w-4 text-fg-secondary" />
                                    </div>
                                    <div>
                                      <div className="flex items-center gap-2">
                                        <h3 className="text-sm font-semibold text-foreground">
                                          {service.label}
                                        </h3>
                                        <Badge className={cn("border text-[10px]", serviceStatusTone(service.serviceState.apiStatus))}>
                                          {service.serviceState.apiStatus}
                                        </Badge>
                                      </div>
                                      <p className="text-xs text-muted-foreground">
                                        {service.description}
                                      </p>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    {service.serviceState.lastError && (
                                      <span className="text-xs text-danger-fg">API error</span>
                                    )}
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="h-7 px-2 text-xs"
                                      onClick={() =>
                                        void runAction("check-access", { accountId: selectedAccount.id })
                                      }
                                      disabled={actionBusy !== null}
                                    >
                                      Check APIs
                                    </Button>
                                  </div>
                                </div>

                                <div className="mt-3 flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => void handleServiceAccess(service.service, "read")}
                                    disabled={actionBusy !== null}
                                    className={cn(
                                      "rounded-lg border px-3 py-1 text-xs font-medium transition-colors",
                                      service.readEnabled && !service.writeEnabled
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border-strong bg-card text-fg-secondary hover:bg-muted dark:border-border dark:bg-transparent dark:hover:bg-background",
                                    )}
                                  >
                                    Read
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => void handleServiceAccess(service.service, "write")}
                                    disabled={actionBusy !== null}
                                    className={cn(
                                      "rounded-lg border px-3 py-1 text-xs font-medium transition-colors",
                                      service.writeEnabled
                                        ? "border-primary bg-primary text-primary-foreground"
                                        : "border-border-strong bg-card text-fg-secondary hover:bg-muted dark:border-border dark:bg-transparent dark:hover:bg-background",
                                    )}
                                  >
                                    Write
                                  </button>
                                </div>

                                <div className="mt-4 space-y-2">
                                  <p className="text-[10px] uppercase tracking-widest text-fg-subtle">
                                    Access Scopes
                                  </p>
                                  {service.capabilities.map((capability) => (
                                    <div
                                      key={capability.key}
                                      className="flex items-center justify-between gap-3 rounded-lg border border-border/80 px-3 py-2 dark:border-border dark:bg-background"
                                    >
                                      <div className="flex items-center gap-2.5 overflow-hidden">
                                        {(() => {
                                          const Icon = capabilityIcon(capability.key);
                                          return <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
                                        })()}
                                        <div className="min-w-0">
                                          <div className="flex items-center gap-1.5">
                                            <span className="truncate text-xs font-medium text-foreground">
                                              {capability.label}
                                            </span>
                                            {!capability.enabled && (
                                              <Badge variant="outline" className="text-[10px] px-1 py-0">Blocked</Badge>
                                            )}
                                          </div>
                                          <p className="truncate text-[11px] text-muted-foreground">
                                            {capability.description}
                                          </p>
                                        </div>
                                      </div>
                                      <select
                                        className="h-7 shrink-0 rounded-md border border-border bg-card px-2 text-xs dark:bg-background dark:text-fg-secondary"
                                        value={capability.policy || "allow"}
                                        onChange={(event) => void handlePolicyChange(capability.key, event.target.value)}
                                      >
                                        {POLICY_OPTIONS.map((option) => (
                                          <option key={option.value} value={option.value}>
                                            {option.label}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            );
                          })}
                        </section>

                        <section id="incoming-events" className="space-y-4 pt-2">
                          <div className="flex items-center justify-between gap-3">
                            <p className="text-[10px] uppercase tracking-widest text-fg-subtle">
                              Incoming Events
                            </p>
                            <span className="text-xs text-muted-foreground dark:text-fg-subtle">
                              Configure
                            </span>
                          </div>
                          <div className="rounded-xl border border-border/80 bg-card p-4 dark:border-border">
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex items-center gap-3">
                                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-muted dark:bg-background">
                                  <Inbox className="h-4 w-4 text-fg-secondary" />
                                </div>
                                <div>
                                  <p className="text-sm font-semibold text-foreground">
                                    Gmail Watch
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {selectedAccount.watch.enabled ? "Watching for new mail" : "Not watching"}
                                  </p>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Badge className={cn("border text-[10px]", selectedAccount.watch.enabled ? "border-success-border bg-success-bg text-success-fg" : "border-border-strong dark:border-border")}>
                                  {selectedAccount.watch.enabled ? "Active" : "Inactive"}
                                </Badge>
                                <Switch
                                  checked={selectedAccount.watch.enabled}
                                  onCheckedChange={(checked) =>
                                    void runAction("set-watch-config", {
                                      accountId: selectedAccount.id,
                                      watch: {
                                        ...selectedAccount.watch,
                                        enabled: checked,
                                      },
                                    })
                                  }
                                />
                              </div>
                            </div>
                          </div>
                        </section>

                        <div className="flex flex-wrap gap-3 pt-2">
                          <Button
                            type="button"
                            onClick={() => focusSection("agent-permissions")}
                          >
                            Update Permissions
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() =>
                              void runAction("start-connect", {
                                email: selectedAccount.email,
                                accessLevel: selectedAccount.accessLevel,
                              })
                            }
                          >
                            Edit Credentials
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            className="border-danger-border bg-danger-bg text-danger-fg hover:bg-danger-bg"
                            onClick={() =>
                              void runAction("disconnect-account", { accountId: selectedAccount.id })
                            }
                          >
                            Disconnect
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <CardTitle>Advanced workspace</CardTitle>
                          <CardDescription>
                            Inbox actions, calendar editing, watch configuration, approvals, and audit history.
                          </CardDescription>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setShowAdvancedTools((current) => !current)}
                        >
                          {showAdvancedTools ? "Hide Advanced Tools" : "Show Advanced Tools"}
                        </Button>
                      </div>
                    </CardHeader>
                  </Card>

                  {showAdvancedTools ? (
                  <>
                  {selectedAccount.diagnostics ? (
                    <Card>
                      <CardHeader>
                        <CardTitle>Check Access</CardTitle>
                        <CardDescription>
                          Plain-language health checklist for this account and the selected agent.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {selectedAccount.diagnostics.checks.map((check) => (
                          <div
                            key={check.key}
                            className="flex items-start gap-3 rounded-xl border border-border/80 p-4 dark:border-border"
                          >
                            {check.ok ? (
                              <CheckCircle2 className="mt-0.5 h-5 w-5 text-success-fg" />
                            ) : (
                              <AlertCircle className="mt-0.5 h-5 w-5 text-danger-fg" />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-medium text-foreground">{check.label}</p>
                                <Badge variant="outline">{check.ok ? "OK" : "Needs attention"}</Badge>
                              </div>
                              <p className="mt-1 text-sm text-fg-secondary dark:text-muted-foreground">{check.detail}</p>
                            </div>
                            {check.fixAction ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => void handleDiagnosticFixAction(check.fixAction!)}
                                disabled={actionBusy !== null}
                              >
                                {check.fixAction}
                              </Button>
                            ) : null}
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  ) : null}
                  <div className="grid gap-6 xl:grid-cols-2">
                    <Card id="advanced-gmail-workspace">
                      <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                          <Inbox className="h-5 w-5" />
                          Gmail workspace
                        </CardTitle>
                        <CardDescription>
                          Search the inbox, read threads, create draft replies, or send new messages using the current agent policy.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
                          <Input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder='in:inbox newer_than:14d'
                          />
                          <Button type="button" onClick={() => void handleSearch()} disabled={!canAct || actionBusy !== null}>
                            {actionBusy === "gmail-search" ? <InlineSpinner className="mr-2 h-4 w-4" /> : <Search className="mr-2 h-4 w-4" />}
                            Search Inbox
                          </Button>
                        </div>
                        <div className="grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
                          <div className="space-y-2">
                            {threads.length === 0 ? (
                              <div className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-muted-foreground dark:border-border">
                                No thread results yet.
                              </div>
                            ) : null}
                            {threads.map((thread) => (
                              <button
                                key={thread.id}
                                type="button"
                                onClick={() => void handleThreadOpen(thread.id)}
                                className="w-full rounded-lg border border-border/80 p-3 text-left hover:border-border-strong dark:border-border dark:hover:border-border"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div>
                                    <p className="font-medium text-foreground">{thread.subject}</p>
                                    <p className="text-xs text-muted-foreground dark:text-fg-subtle">{thread.from}</p>
                                  </div>
                                  {threadBusy === thread.id ? <InlineSpinner className="h-4 w-4" /> : null}
                                </div>
                                <p className="mt-2 line-clamp-2 text-sm text-fg-secondary dark:text-muted-foreground">
                                  {thread.snippet}
                                </p>
                              </button>
                            ))}
                          </div>
                          <div className="space-y-4 rounded-xl border border-border/80 p-4 dark:border-border">
                            {threadDetails ? (
                              <>
                                <div>
                                  <p className="font-medium text-foreground">{threadDetails.subject}</p>
                                  <p className="text-sm text-muted-foreground">{threadDetails.snippet}</p>
                                </div>
                                <div className="max-h-72 space-y-3 overflow-auto pr-1">
                                  {threadDetails.messages.map((message) => (
                                    <div key={message.id} className="rounded-lg border border-border/80 p-3 dark:border-border">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-medium text-foreground">{message.from || "Unknown sender"}</span>
                                        <span className="text-xs text-muted-foreground dark:text-fg-subtle">{message.date || ""}</span>
                                      </div>
                                      <p className="mt-2 whitespace-pre-wrap text-sm text-fg-secondary dark:text-muted-foreground">
                                        {message.bodyText || message.snippet || "(No readable body returned.)"}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                                <div className="space-y-2">
                                  <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground dark:text-fg-subtle">
                                    Reply body
                                  </label>
                                  <textarea
                                    className="min-h-28 w-full rounded-md border border-border bg-card px-3 py-2 text-sm dark:bg-background"
                                    value={replyBody}
                                    onChange={(event) => setReplyBody(event.target.value)}
                                    placeholder="Write the reply you want this agent to send."
                                  />
                                  <div className="flex flex-wrap gap-2">
                                    <Button
                                      type="button"
                                      variant="outline"
                                      onClick={() =>
                                        void runAction("gmail-draft", {
                                          accountId: selectedAccount.id,
                                          agentId: selectedAgentId,
                                          to: [],
                                          subject: threadDetails.subject.startsWith("Re:")
                                            ? threadDetails.subject
                                            : `Re: ${threadDetails.subject}`,
                                          body: replyBody,
                                          threadId: threadDetails.id,
                                          replyToMessageId: threadDetails.messages[threadDetails.messages.length - 1]?.id,
                                          quote: true,
                                        })
                                      }
                                      disabled={!replyBody.trim() || actionBusy !== null}
                                    >
                                      <MailCheck className="mr-2 h-4 w-4" />
                                      Draft Reply
                                    </Button>
                                    <Button
                                      type="button"
                                      onClick={() =>
                                        void runAction("gmail-reply", {
                                          accountId: selectedAccount.id,
                                          agentId: selectedAgentId,
                                          to: [],
                                          subject: threadDetails.subject.startsWith("Re:")
                                            ? threadDetails.subject
                                            : `Re: ${threadDetails.subject}`,
                                          body: replyBody,
                                          threadId: threadDetails.id,
                                          replyToMessageId: threadDetails.messages[threadDetails.messages.length - 1]?.id,
                                          quote: true,
                                        })
                                      }
                                      disabled={!replyBody.trim() || actionBusy !== null}
                                    >
                                      <Send className="mr-2 h-4 w-4" />
                                      Reply &amp; Send
                                    </Button>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <div className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-muted-foreground dark:border-border">
                                Select a thread to inspect it and reply.
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="space-y-3 rounded-xl border border-border/80 p-4 dark:border-border">
                          <div>
                            <p className="font-medium text-foreground">New email</p>
                            <p className="text-sm text-muted-foreground">
                              This uses the same per-agent permission flow as replies.
                            </p>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <Input value={composeTo} onChange={(event) => setComposeTo(event.target.value)} placeholder="To: person@company.com" />
                            <Input value={composeSubject} onChange={(event) => setComposeSubject(event.target.value)} placeholder="Subject" />
                          </div>
                          <textarea
                            className="min-h-28 w-full rounded-md border border-border bg-card px-3 py-2 text-sm dark:bg-background"
                            value={composeBody}
                            onChange={(event) => setComposeBody(event.target.value)}
                            placeholder="Write the email body."
                          />
                          <Button
                            type="button"
                            onClick={() =>
                              void runAction("gmail-send", {
                                accountId: selectedAccount.id,
                                agentId: selectedAgentId,
                                to: composeTo
                                  .split(",")
                                  .map((entry) => entry.trim())
                                  .filter(Boolean),
                                subject: composeSubject,
                                body: composeBody,
                              })
                            }
                            disabled={!composeTo.trim() || !composeSubject.trim() || !composeBody.trim() || actionBusy !== null}
                          >
                            <MailPlus className="mr-2 h-4 w-4" />
                            Send New Email
                          </Button>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>Calendar workspace</CardTitle>
                        <CardDescription>
                          Review upcoming events or let an agent create and update calendar items with the same approval rules.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <Button type="button" variant="outline" onClick={() => void loadCalendar()} disabled={!canAct || actionBusy !== null}>
                          {actionBusy === "calendar-list" ? <InlineSpinner className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                          Load Next 7 Days
                        </Button>
                        <div className="space-y-2">
                          {calendarEvents.length === 0 ? (
                            <div className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-muted-foreground dark:border-border">
                              No calendar results loaded yet.
                            </div>
                          ) : null}
                          {calendarEvents.map((event) => (
                            <button
                              key={event.id}
                              type="button"
                              onClick={() => {
                                setCalendarEventId(event.id);
                                setCalendarTitle(event.title);
                                setCalendarFrom(new Date(event.startMs).toISOString().slice(0, 16));
                                setCalendarTo(new Date(event.endMs).toISOString().slice(0, 16));
                                setCalendarLocation(event.location || "");
                                setCalendarDescription(event.notes || "");
                              }}
                              className="w-full rounded-lg border border-border/80 p-3 text-left hover:border-border-strong dark:border-border dark:hover:border-border"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-medium text-foreground">{event.title}</p>
                                  <p className="text-sm text-muted-foreground">
                                    {formatDateTime(event.startMs)} → {formatDateTime(event.endMs)}
                                  </p>
                                </div>
                                <Badge variant="outline">{event.calendarName}</Badge>
                              </div>
                            </button>
                          ))}
                        </div>
                        <div className="space-y-3 rounded-xl border border-border/80 p-4 dark:border-border">
                          <div>
                            <p className="font-medium text-foreground">Create or update event</p>
                            <p className="text-sm text-muted-foreground">
                              Leave Event ID empty to create a new event. Fill it from the list above to update an existing one.
                            </p>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            <Input value={calendarTitle} onChange={(event) => setCalendarTitle(event.target.value)} placeholder="Event title" />
                            <Input value={calendarEventId} onChange={(event) => setCalendarEventId(event.target.value)} placeholder="Existing event ID (optional)" />
                            <Input type="datetime-local" value={calendarFrom} onChange={(event) => setCalendarFrom(event.target.value)} />
                            <Input type="datetime-local" value={calendarTo} onChange={(event) => setCalendarTo(event.target.value)} />
                            <Input value={calendarLocation} onChange={(event) => setCalendarLocation(event.target.value)} placeholder="Location" />
                          </div>
                          <textarea
                            className="min-h-24 w-full rounded-md border border-border bg-card px-3 py-2 text-sm dark:bg-background"
                            value={calendarDescription}
                            onChange={(event) => setCalendarDescription(event.target.value)}
                            placeholder="Description"
                          />
                          <div className="flex flex-wrap gap-2">
                            <Button
                              type="button"
                              onClick={() =>
                                void runAction(calendarEventId ? "calendar-update" : "calendar-create", {
                                  accountId: selectedAccount.id,
                                  agentId: selectedAgentId,
                                  calendarId: "primary",
                                  eventId: calendarEventId,
                                  summary: calendarTitle,
                                  from: new Date(calendarFrom).toISOString(),
                                  to: new Date(calendarTo).toISOString(),
                                  location: calendarLocation,
                                  description: calendarDescription,
                                })
                              }
                              disabled={!calendarTitle.trim() || !calendarFrom || !calendarTo || actionBusy !== null}
                            >
                              {calendarEventId ? "Update Event" : "Create Event"}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
                    <Card>
                      <CardHeader>
                        <CardTitle>Incoming events</CardTitle>
                        <CardDescription>
                          Gmail watch configuration is managed here so a non-technical user can set it up without terminal access.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <div className="flex items-center justify-between rounded-xl border border-border/80 px-4 py-3 dark:border-border">
                          <div>
                            <p className="font-medium text-foreground">Enable Gmail watch</p>
                            <p className="text-sm text-muted-foreground">
                              Gateway-owned watcher for inbox events and renewals.
                            </p>
                          </div>
                          <Switch
                            checked={selectedAccount.watch.enabled}
                            onCheckedChange={(checked) =>
                              void runAction("set-watch-config", {
                                accountId: selectedAccount.id,
                                watch: {
                                  ...selectedAccount.watch,
                                  enabled: checked,
                                },
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground dark:text-fg-subtle">Target agent</label>
                            <select
                              className="flex h-10 w-full rounded-md border border-border bg-card px-3 text-sm dark:bg-background"
                              value={selectedAccount.watch.targetAgentId || selectedAgentId}
                              onChange={(event) =>
                                void runAction("set-watch-config", {
                                  accountId: selectedAccount.id,
                                  watch: {
                                    ...selectedAccount.watch,
                                    targetAgentId: event.target.value,
                                  },
                                })
                              }
                            >
                              {(data?.agents || []).map((agent) => (
                                <option key={agent.id} value={agent.id}>
                                  {agent.name}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="space-y-2">
                            <label className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground dark:text-fg-subtle">Google Cloud project ID</label>
                            <Input
                              value={selectedAccount.watch.projectId}
                              onChange={(event) =>
                                void runAction("set-watch-config", {
                                  accountId: selectedAccount.id,
                                  watch: {
                                    ...selectedAccount.watch,
                                    projectId: event.target.value,
                                  },
                                })
                              }
                              placeholder="my-google-project"
                            />
                          </div>
                          <Input
                            value={selectedAccount.watch.label}
                            onChange={(event) =>
                              void runAction("set-watch-config", {
                                accountId: selectedAccount.id,
                                watch: {
                                  ...selectedAccount.watch,
                                  label: event.target.value,
                                },
                              })
                            }
                            placeholder="Label to watch"
                          />
                          <Input
                            value={selectedAccount.watch.topic}
                            onChange={(event) =>
                              void runAction("set-watch-config", {
                                accountId: selectedAccount.id,
                                watch: {
                                  ...selectedAccount.watch,
                                  topic: event.target.value,
                                },
                              })
                            }
                            placeholder="Pub/Sub topic"
                          />
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          <Input
                            value={selectedAccount.watch.subscription}
                            onChange={(event) =>
                              void runAction("set-watch-config", {
                                accountId: selectedAccount.id,
                                watch: {
                                  ...selectedAccount.watch,
                                  subscription: event.target.value,
                                },
                              })
                            }
                            placeholder="Subscription"
                          />
                          <Input
                            value={selectedAccount.watch.hookUrl}
                            onChange={(event) =>
                              void runAction("set-watch-config", {
                                accountId: selectedAccount.id,
                                watch: {
                                  ...selectedAccount.watch,
                                  hookUrl: event.target.value,
                                },
                              })
                            }
                            placeholder="Hook URL (optional)"
                          />
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <Badge className={cn("border", serviceStatusTone(selectedAccount.watch.status === "error" ? "error" : selectedAccount.watch.status === "configured" || selectedAccount.watch.status === "watching" ? "ready" : "unverified"))}>
                            {selectedAccount.watch.status}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            Last configured {formatAgo(selectedAccount.watch.lastConfiguredAt)}
                          </span>
                          <Button
                            type="button"
                            onClick={() => void runAction("setup-watch", { accountId: selectedAccount.id })}
                            disabled={actionBusy !== null || !selectedAccount.watch.projectId.trim()}
                          >
                            Configure Gmail Watch
                          </Button>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>Approval queue</CardTitle>
                        <CardDescription>
                          Risky actions land here when the current policy is “Requires Approval”.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {pendingApprovals.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-border-strong p-4 text-sm text-muted-foreground dark:border-border">
                            No approvals are waiting right now.
                          </div>
                        ) : null}
                        {pendingApprovals.map((approval) => (
                          <div key={approval.id} className="rounded-xl border border-border/80 p-4 dark:border-border">
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <p className="font-medium text-foreground">{approval.summary}</p>
                                <p className="text-sm text-muted-foreground">
                                  {approval.actionLabel} · requested {formatAgo(approval.createdAt)}
                                </p>
                              </div>
                              <Badge className="border border-warning-border bg-warning-bg text-warning-fg">
                                pending
                              </Badge>
                            </div>
                            <div className="mt-3 flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                onClick={() => void runAction("approve-request", { approvalId: approval.id })}
                              >
                                Approve
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => void runAction("deny-request", { approvalId: approval.id })}
                              >
                                Deny
                              </Button>
                            </div>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  </div>

                  <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
                    <Card>
                      <CardHeader>
                        <CardTitle>Recent activity</CardTitle>
                        <CardDescription>
                          Every read, write, approval, and error is recorded here.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        {(data?.store.audit || []).slice(0, 12).map((entry) => (
                          <div key={entry.id} className="rounded-lg border border-border/80 px-3 py-2 dark:border-border">
                            <div className="flex items-center justify-between gap-3">
                              <p className="font-medium text-foreground">{entry.summary}</p>
                              <Badge variant="outline">{entry.status}</Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground dark:text-fg-subtle">
                              {entry.action} · {formatDateTime(entry.createdAt)}
                            </p>
                            {entry.detail ? (
                              <p className="mt-1 text-sm text-fg-secondary dark:text-muted-foreground">{entry.detail}</p>
                            ) : null}
                          </div>
                        ))}
                      </CardContent>
                    </Card>

                    <Card>
                      <CardHeader>
                        <CardTitle>Setup guide & troubleshooting</CardTitle>
                        <CardDescription>
                          The important instructions are kept inside the product for non-technical users.
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4 text-sm">
                        <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                          <div className="flex items-start gap-3">
                            <CheckCircle2 className="mt-0.5 h-5 w-5 text-success-fg" />
                            <div>
                              <p className="font-medium text-foreground">What “Read Only” means</p>
                              <p className="mt-1 text-fg-secondary dark:text-muted-foreground">
                                The assistant can look up emails and calendar information, but it cannot send, reply, or change anything.
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                          <div className="flex items-start gap-3">
                            <ShieldAlert className="mt-0.5 h-5 w-5 text-warning-fg" />
                            <div>
                              <p className="font-medium text-foreground">If sending or replying fails</p>
                              <p className="mt-1 text-fg-secondary dark:text-muted-foreground">
                                Check the connection access level first. If the account is still Read Only, sending is blocked even before the agent policy is checked.
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                          <div className="flex items-start gap-3">
                            <AlertCircle className="mt-0.5 h-5 w-5 text-danger-fg" />
                            <div>
                              <p className="font-medium text-foreground">If connection finish fails</p>
                              <p className="mt-1 text-fg-secondary dark:text-muted-foreground">
                                Paste the complete final Google redirect URL, not just the code fragment. Then run “Check Access” after finishing.
                              </p>
                            </div>
                          </div>
                        </div>
                        <div className="rounded-xl border border-border/80 p-4 dark:border-border">
                          <div className="flex items-start gap-3">
                            <MailCheck className="mt-0.5 h-5 w-5 text-info-fg" />
                            <div>
                              <p className="font-medium text-foreground">If Gmail watch setup fails</p>
                              <p className="mt-1 text-fg-secondary dark:text-muted-foreground">
                                The most common issue is a missing Google Cloud project ID or missing webhook information. Save the watch fields first, then click Configure Gmail Watch again.
                              </p>
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>
                  </>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </SectionBody>
    </SectionLayout>
  );
}
