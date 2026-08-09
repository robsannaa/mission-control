"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Cloud,
  CloudOff,
  Link2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";
import { cn } from "@/lib/utils";

type CalendarProvider = "local" | "google" | "apple" | "zoho";
type ExternalCalendarProvider = Exclude<CalendarProvider, "local">;
type CalendarAccountConnection = "gog" | "oauth" | "caldav" | "api" | "manual";

type CalendarConnectorStatus = {
  provider: CalendarProvider;
  label: string;
  connectorImplemented: boolean;
  multiAccount: boolean;
  supportedConnections: CalendarAccountConnection[];
  note: string;
  detection: {
    gogAvailable?: boolean;
    oauthConfigured?: boolean;
    storedAuth?: boolean;
  };
};

type CalendarProviderSettings = {
  provider: CalendarProvider;
  enabled: boolean;
  importEvents: boolean;
  importReminders: boolean;
  writeBack: boolean;
  readOnlyByDefault: boolean;
  connectorStatus: "ready" | "planned" | "local";
};

type CalendarAccountRecord = {
  id: string;
  provider: ExternalCalendarProvider;
  label: string;
  providerAccountId: string;
  connection: CalendarAccountConnection;
  enabled: boolean;
  readOnly: boolean;
  importEvents: boolean;
  importReminders: boolean;
  writeBack: boolean;
  lastSyncedAt: number | null;
  lastSyncStatus: "idle" | "success" | "error";
  lastSyncError: string | null;
};

type CalendarEventRecord = {
  id: string;
  title: string;
  startMs: number;
  endMs: number;
  allDay: boolean;
  source: "local" | "imported";
  provider: CalendarProvider;
  accountId: string | null;
  calendarName: string;
  location: string | null;
  notes: string | null;
  readOnly: boolean;
};

type CalendarApiResponse = {
  store: {
    updatedAt: number;
    providerSettings: Record<CalendarProvider, CalendarProviderSettings>;
    accounts: CalendarAccountRecord[];
    events: CalendarEventRecord[];
  };
  summary: {
    totalEvents: number;
    importedEvents: number;
    localEvents: number;
    accountCount: number;
    activeAccountCount: number;
    providerCount: number;
    nextSevenDaysCount: number;
  };
  upcomingEvents: CalendarEventRecord[];
  connectors: CalendarConnectorStatus[];
};

const PROVIDER_OPTIONS: ExternalCalendarProvider[] = ["google", "apple", "zoho"];

function formatAgo(ts: number | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function formatEventTime(event: CalendarEventRecord): string {
  if (event.allDay) return "All day";
  const start = new Date(event.startMs);
  const end = new Date(event.endMs);
  const formatter = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatter.format(start)} - ${formatter.format(end)}`;
}

function formatEventDayLabel(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(ts));
}

function providerTone(provider: CalendarProvider): string {
  switch (provider) {
    case "google":
      return "border-info-border bg-info-bg text-info-fg";
    case "apple":
      return "border-border-strong/20 bg-muted-foreground/10 text-fg-secondary dark:text-fg-subtle";
    case "zoho":
      return "border-success-border bg-success-bg text-success-fg";
    default:
      return "border-warning-border bg-warning-bg text-warning-fg";
  }
}

function nextConnection(provider: ExternalCalendarProvider): CalendarAccountConnection {
  switch (provider) {
    case "google":
      return "gog";
    case "apple":
      return "caldav";
    case "zoho":
      return "api";
    default:
      return "manual";
  }
}

export function CalendarView() {
  const [data, setData] = useState<CalendarApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);
  const [formProvider, setFormProvider] = useState<ExternalCalendarProvider>("google");
  const [formConnection, setFormConnection] = useState<CalendarAccountConnection>("gog");
  const [formLabel, setFormLabel] = useState("");
  const [formAccountId, setFormAccountId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/calendar?days=14", { cache: "no-store" });
      const json = (await response.json()) as CalendarApiResponse & { error?: string };
      if (!response.ok) {
        throw new Error(json.error || `Calendar request failed (${response.status})`);
      }
      setData(json);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const accountMap = useMemo(() => {
    const map = new Map<string, CalendarAccountRecord>();
    for (const account of data?.store.accounts || []) {
      map.set(account.id, account);
    }
    return map;
  }, [data]);

  const groupedEvents = useMemo(() => {
    const groups = new Map<string, { label: string; events: CalendarEventRecord[] }>();
    for (const event of data?.upcomingEvents || []) {
      const date = new Date(event.startMs);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      const existing = groups.get(key);
      if (existing) {
        existing.events.push(event);
      } else {
        groups.set(key, {
          label: formatEventDayLabel(event.startMs),
          events: [event],
        });
      }
    }
    return [...groups.entries()].map(([key, value]) => ({ key, ...value }));
  }, [data]);

  const submitProviderSetting = useCallback(
    async (
      provider: CalendarProvider,
      patch: Partial<Pick<CalendarProviderSettings, "enabled" | "importEvents" | "importReminders" | "writeBack">>
    ) => {
      const key = `${provider}:${Object.keys(patch).join(",")}`;
      setSavingKey(key);
      setError(null);
      try {
        const response = await fetch("/api/calendar", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "save-provider-settings", provider, ...patch }),
        });
        const json = (await response.json()) as CalendarApiResponse & { error?: string };
        if (!response.ok) {
          throw new Error(json.error || `Failed to update ${provider} settings`);
        }
        setData(json);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSavingKey(null);
      }
    },
    []
  );

  const addAccount = useCallback(async () => {
    if (!formLabel.trim() || !formAccountId.trim()) {
      setError("Account label and account id are required.");
      return;
    }
    setSavingKey("add-account");
    setError(null);
    try {
      const response = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "add-account",
          provider: formProvider,
          connection: formConnection,
          label: formLabel.trim(),
          providerAccountId: formAccountId.trim(),
        }),
      });
      const json = (await response.json()) as CalendarApiResponse & { error?: string };
      if (!response.ok) {
        throw new Error(json.error || "Failed to add calendar account");
      }
      setData(json);
      setFormLabel("");
      setFormAccountId("");
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setSavingKey(null);
    }
  }, [formAccountId, formConnection, formLabel, formProvider]);

  const removeAccount = useCallback(async (accountId: string) => {
    setSavingKey(`remove:${accountId}`);
    setError(null);
    try {
      const response = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "remove-account",
          accountId,
        }),
      });
      const json = (await response.json()) as CalendarApiResponse & { error?: string };
      if (!response.ok) {
        throw new Error(json.error || "Failed to remove calendar account");
      }
      setData(json);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSavingKey(null);
    }
  }, []);

  const syncAccount = useCallback(async (accountId: string) => {
    setSyncingAccountId(accountId);
    setError(null);
    try {
      const response = await fetch("/api/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "sync-account",
          accountId,
          days: 14,
        }),
      });
      const json = (await response.json()) as { error?: string; snapshot?: CalendarApiResponse };
      if (!response.ok || !json.snapshot) {
        throw new Error(json.error || "Failed to sync calendar account");
      }
      setData(json.snapshot);
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncingAccountId(null);
    }
  }, []);

  useEffect(() => {
    setFormConnection(nextConnection(formProvider));
  }, [formProvider]);

  return (
    <SectionLayout>
      <SectionHeader
        title="Calendar"
        description="Mission Control is the local canonical calendar layer. External providers sync into it with provider and account provenance."
        meta={data ? `Updated ${formatAgo(data.store.updatedAt)}` : undefined}
        actions={(
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            Refresh
          </Button>
        )}
      />
      <SectionBody className="pb-8" innerClassName="space-y-6">
        {error ? (
          <div className="flex items-center gap-2 rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger-fg">
            <AlertCircle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="grid gap-4 md:grid-cols-4">
          {[
            {
              label: "Upcoming events",
              value: data?.upcomingEvents.length ?? "—",
              hint: "Current timeline window",
              icon: CalendarDays,
            },
            {
              label: "Imported",
              value: data?.summary.importedEvents ?? "—",
              hint: "External provider copies",
              icon: Cloud,
            },
            {
              label: "Accounts",
              value: data?.summary.activeAccountCount ?? "—",
              hint: "Enabled sync accounts",
              icon: Link2,
            },
            {
              label: "Next 7 days",
              value: data?.summary.nextSevenDaysCount ?? "—",
              hint: "Timeline density",
              icon: CheckCircle2,
            },
          ].map((metric) => {
            const Icon = metric.icon;
            return (
              <Card key={metric.label} className="gap-0 border-border/70 bg-white/90 py-0 dark:border-border dark:bg-muted">
                <CardContent className="flex items-center justify-between px-5 py-4">
                  <div>
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
                      {metric.label}
                    </p>
                    <p className="mt-2 text-3xl font-semibold text-foreground">
                      {metric.value}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {metric.hint}
                    </p>
                  </div>
                  <div className="rounded-2xl border border-border bg-muted p-3">
                    <Icon className="h-5 w-5 text-fg-secondary" />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.3fr_0.9fr]">
          <Card className="gap-0 border-border/70 bg-white/90 py-0 dark:border-border dark:bg-muted">
            <CardHeader className="border-b border-border/80 px-5 py-4 dark:border-border">
              <CardTitle className="text-base text-foreground">
                Provider control plane
              </CardTitle>
              <CardDescription>
                Provider-agnostic settings are persisted now. Google sync is live; Apple and Zoho stay in metadata-ready mode until connectors land.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 px-5 py-5">
              {(data?.connectors || []).map((connector) => {
                const settings = data?.store.providerSettings[connector.provider];
                return (
                  <div
                    key={connector.provider}
                    className="rounded-2xl border border-border/80 bg-muted/80 p-4 dark:border-border dark:bg-muted"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-foreground">
                            {connector.label}
                          </p>
                          <Badge
                            variant="outline"
                            className={cn("capitalize", providerTone(connector.provider))}
                          >
                            {connector.connectorImplemented ? "ready" : "planned"}
                          </Badge>
                          {connector.multiAccount ? (
                            <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                              multi-account
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-2 text-sm text-fg-secondary dark:text-muted-foreground">
                          {connector.note}
                        </p>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {connector.detection.gogAvailable ? (
                            <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                              gog detected
                            </Badge>
                          ) : null}
                          {connector.detection.oauthConfigured ? (
                            <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                              OAuth app configured
                            </Badge>
                          ) : null}
                          {connector.detection.storedAuth ? (
                            <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                              stored auth found
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      {settings ? (
                        <div className="grid min-w-[250px] gap-3 text-sm">
                          {[
                            {
                              key: "enabled",
                              label: "Provider enabled",
                              checked: settings.enabled,
                            },
                            {
                              key: "importEvents",
                              label: "Import events",
                              checked: settings.importEvents,
                            },
                            {
                              key: "importReminders",
                              label: "Import reminders",
                              checked: settings.importReminders,
                            },
                            {
                              key: "writeBack",
                              label: "Write-back preference",
                              checked: settings.writeBack,
                            },
                          ].map((toggle) => (
                            <label
                              key={toggle.key}
                              className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card px-3 py-2 dark:bg-background"
                            >
                              <span className="text-fg-secondary">{toggle.label}</span>
                              <Switch
                                checked={toggle.checked}
                                onCheckedChange={(checked) =>
                                  void submitProviderSetting(connector.provider, {
                                    [toggle.key]: checked,
                                  } as Partial<Pick<CalendarProviderSettings, "enabled" | "importEvents" | "importReminders" | "writeBack">>)
                                }
                                disabled={savingKey === `${connector.provider}:${toggle.key}`}
                              />
                            </label>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card className="gap-0 border-border/70 bg-white/90 py-0 dark:border-border dark:bg-muted">
            <CardHeader className="border-b border-border/80 px-5 py-4 dark:border-border">
              <CardTitle className="text-base text-foreground">
                Add account
              </CardTitle>
              <CardDescription>
                Store sync metadata now, then import from supported providers without changing the local calendar model.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-5 py-5">
              <label className="grid gap-1.5 text-sm">
                <span className="text-fg-secondary dark:text-muted-foreground">Provider</span>
                <select
                  value={formProvider}
                  onChange={(event) => setFormProvider(event.target.value as ExternalCalendarProvider)}
                  className="h-9 rounded-md border border-border-strong bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-border dark:border-border dark:bg-background dark:focus:ring-border-strong"
                >
                  {PROVIDER_OPTIONS.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="text-fg-secondary dark:text-muted-foreground">Connection</span>
                <select
                  value={formConnection}
                  onChange={(event) => setFormConnection(event.target.value as CalendarAccountConnection)}
                  className="h-9 rounded-md border border-border-strong bg-card px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-border dark:border-border dark:bg-background dark:focus:ring-border-strong"
                >
                  {(data?.connectors.find((connector) => connector.provider === formProvider)?.supportedConnections || [formConnection]).map((connection) => (
                    <option key={connection} value={connection}>
                      {connection}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="text-fg-secondary dark:text-muted-foreground">Badge label</span>
                <Input
                  value={formLabel}
                  onChange={(event) => setFormLabel(event.target.value)}
                  placeholder="Work Google"
                />
              </label>
              <label className="grid gap-1.5 text-sm">
                <span className="text-fg-secondary dark:text-muted-foreground">Provider account id</span>
                <Input
                  value={formAccountId}
                  onChange={(event) => setFormAccountId(event.target.value)}
                  placeholder={formProvider === "google" ? "you@example.com or primary" : "account identifier"}
                />
              </label>
              <Button onClick={() => void addAccount()} disabled={savingKey === "add-account"}>
                <Plus className="h-4 w-4" />
                Add account
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_1.2fr]">
          <Card className="gap-0 border-border/70 bg-white/90 py-0 dark:border-border dark:bg-muted">
            <CardHeader className="border-b border-border/80 px-5 py-4 dark:border-border">
              <CardTitle className="text-base text-foreground">
                Sync accounts
              </CardTitle>
              <CardDescription>
                Imported events stay read-only by default. That prevents accidental destructive edits until write-back is explicitly implemented per provider.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 px-5 py-5">
              {(data?.store.accounts || []).length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
                  No calendar accounts configured yet.
                </div>
              ) : (
                data?.store.accounts.map((account) => (
                  <div
                    key={account.id}
                    className="rounded-2xl border border-border/80 bg-muted/80 p-4 dark:border-border dark:bg-muted"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-foreground">
                            {account.label}
                          </p>
                          <Badge variant="outline" className={cn("capitalize", providerTone(account.provider))}>
                            {account.provider}
                          </Badge>
                          <Badge variant="outline" className="capitalize border-border-strong text-fg-secondary dark:text-muted-foreground">
                            {account.connection}
                          </Badge>
                          {account.readOnly ? (
                            <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                              read-only
                            </Badge>
                          ) : null}
                        </div>
                        <p className="mt-1 text-sm text-fg-secondary dark:text-muted-foreground">
                          {account.providerAccountId}
                        </p>
                        <p className="mt-2 text-xs text-muted-foreground">
                          Last sync: {formatAgo(account.lastSyncedAt)}
                        </p>
                        {account.lastSyncError ? (
                          <p className="mt-2 text-xs text-danger-fg">
                            {account.lastSyncError}
                          </p>
                        ) : null}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void syncAccount(account.id)}
                          disabled={syncingAccountId === account.id}
                        >
                          {syncingAccountId === account.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="h-4 w-4" />
                          )}
                          Sync now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => void removeAccount(account.id)}
                          disabled={savingKey === `remove:${account.id}`}
                        >
                          <Trash2 className="h-4 w-4" />
                          Remove
                        </Button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card className="gap-0 border-border/70 bg-white/90 py-0 dark:border-border dark:bg-muted">
            <CardHeader className="border-b border-border/80 px-5 py-4 dark:border-border">
              <CardTitle className="text-base text-foreground">
                Upcoming timeline
              </CardTitle>
              <CardDescription>
                The merged timeline reflects the local canonical model, not direct live reads from providers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 px-5 py-5">
              {loading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, index) => (
                    <div
                      key={index}
                      className="h-16 animate-pulse rounded-2xl bg-muted"
                    />
                  ))}
                </div>
              ) : groupedEvents.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-border-strong px-4 py-8 text-center text-sm text-muted-foreground">
                  No upcoming events in the local store yet. Add an account and sync it, or seed local events later.
                </div>
              ) : (
                groupedEvents.map((group) => (
                  <div key={group.key}>
                    <div className="mb-3 flex items-center gap-2">
                      <div className="h-px flex-1 bg-secondary" />
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                        {group.label}
                      </p>
                      <div className="h-px flex-1 bg-secondary" />
                    </div>
                    <div className="space-y-3">
                      {group.events.map((event) => {
                        const account = event.accountId ? accountMap.get(event.accountId) : null;
                        return (
                          <div
                            key={event.id}
                            className="rounded-2xl border border-border/80 bg-muted/80 p-4 dark:border-border dark:bg-muted"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="truncate text-sm font-semibold text-foreground">
                                    {event.title}
                                  </p>
                                  <Badge variant="outline" className={cn("capitalize", providerTone(event.provider))}>
                                    {event.provider}
                                  </Badge>
                                  <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                                    {event.source === "imported" ? "imported" : "local"}
                                  </Badge>
                                  {account ? (
                                    <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                                      {account.label}
                                    </Badge>
                                  ) : null}
                                  {event.readOnly ? (
                                    <Badge variant="outline" className="border-border-strong text-fg-secondary dark:text-muted-foreground">
                                      read-only
                                    </Badge>
                                  ) : null}
                                </div>
                                <p className="mt-1 text-sm text-fg-secondary dark:text-muted-foreground">
                                  {formatEventTime(event)} · {event.calendarName}
                                </p>
                                {event.location ? (
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    {event.location}
                                  </p>
                                ) : null}
                              </div>
                              <div className="rounded-full border border-border bg-card px-2.5 py-1 text-xs text-fg-secondary dark:bg-background dark:text-muted-foreground">
                                {event.source === "imported" ? (
                                  <span className="inline-flex items-center gap-1">
                                    <Cloud className="h-3.5 w-3.5" />
                                    synced
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1">
                                    <CloudOff className="h-3.5 w-3.5" />
                                    local
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </SectionBody>
    </SectionLayout>
  );
}
