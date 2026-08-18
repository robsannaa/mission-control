import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound } from "@/lib/api-errors";
import {
  agentIdQuerySchema,
  integrationsPostSchema,
  type AgentIdQuery,
  type IntegrationsPostInput,
} from "@/lib/schemas/integrations";
import {
  cleanupGogAuthSession,
  createCalendarEventForAccount,
  finishGogRemoteAuth,
  getGmailThread,
  getGogAuthSessionStatus,
  listCalendarEventsForAccount,
  listDriveFiles,
  listGogStoredAccounts,
  searchGmailInbox,
  sendOrDraftGmail,
  setupOpenClawGmailWatch,
  startGogLiveAuth,
  startGogRemoteAuth,
  updateCalendarEventForAccount,
} from "@/lib/gog-google";
import { buildGoogleIntegrationsSnapshot } from "@/lib/google-integrations-api";
import {
  appendGoogleApproval,
  appendGoogleAuditEntry,
  createDefaultGoogleAccount,
  GOOGLE_CAPABILITY_DEFINITIONS,
  GOOGLE_CAPABILITY_MAP,
  getGoogleAgentPolicy,
  isCapabilityEnabledForAccount,
  isGoogleAccessLevel,
  isGoogleAgentPolicy,
  isGoogleCapabilityKey,
  readGoogleIntegrationsStore,
  removeGoogleAccount,
  saveGoogleIntegrationsStore,
  setGoogleAgentPolicyRecord,
  type GoogleAccountRecord,
  type GoogleCapabilityKey,
  type GoogleIntegrationsStore,
  type GoogleServiceKey,
  type GoogleWatchConfig,
  updateGoogleApproval,
  upsertGoogleAccount,
} from "@/lib/google-integrations-store";
import { runGogCaptureBoth } from "@/lib/gog-cli";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function getAccountOrThrow(store: GoogleIntegrationsStore, accountId: string): GoogleAccountRecord {
  const account = store.accounts.find((entry) => entry.id === accountId);
  if (!account) throw new Error(`Google account not found: ${accountId}`);
  return account;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
}

function isGoogleService(value: unknown): value is GoogleServiceKey {
  return value === "gmail" || value === "calendar";
}

async function disconnectGogAccount(email: string): Promise<string | null> {
  const { stdout, stderr, code } = await runGogCaptureBoth(
    ["auth", "remove", email, "--force", "--no-input"],
    20000,
    {
      envOverrides: {},
    },
  );
  if (code !== 0) {
    const message = stderr.trim() || stdout.trim();
    if (
      message.includes("refresh token missing") ||
      message.includes("Secret not found in keyring") ||
      message.includes("not found")
    ) {
      return "No stored gog token was found for this account.";
    }
    throw new Error(message || "Unable to disconnect Google account");
  }
  return null;
}

async function checkAccountAccess(account: GoogleAccountRecord): Promise<GoogleAccountRecord> {
  const next: GoogleAccountRecord = {
    ...account,
    serviceStates: {
      gmail: { ...account.serviceStates.gmail },
      calendar: { ...account.serviceStates.calendar },
      drive: { ...account.serviceStates.drive },
    },
    lastCheckedAt: Date.now(),
    updatedAt: Date.now(),
  };

  let gmailError: string | null = null;
  let calendarError: string | null = null;
  let driveError: string | null = null;

  try {
    await searchGmailInbox({
      account: account.email,
      query: "in:inbox",
      max: 1,
    });
    next.serviceStates.gmail.apiStatus = "ready";
    next.serviceStates.gmail.scopeStatus =
      account.accessLevel === "read-only" ? "readonly" : "full";
    next.serviceStates.gmail.lastCheckedAt = Date.now();
    next.serviceStates.gmail.lastError = null;
  } catch (error) {
    gmailError = error instanceof Error ? error.message : String(error);
    next.serviceStates.gmail.apiStatus = "error";
    next.serviceStates.gmail.lastCheckedAt = Date.now();
    next.serviceStates.gmail.lastError = gmailError;
  }

  try {
    await listCalendarEventsForAccount({
      account: account.email,
      days: 3,
    });
    next.serviceStates.calendar.apiStatus = "ready";
    next.serviceStates.calendar.scopeStatus =
      account.accessLevel === "read-only" ? "readonly" : "full";
    next.serviceStates.calendar.lastCheckedAt = Date.now();
    next.serviceStates.calendar.lastError = null;
  } catch (error) {
    calendarError = error instanceof Error ? error.message : String(error);
    next.serviceStates.calendar.apiStatus = "error";
    next.serviceStates.calendar.lastCheckedAt = Date.now();
    next.serviceStates.calendar.lastError = calendarError;
  }

  try {
    await listDriveFiles({
      account: account.email,
      max: 1,
    });
    next.serviceStates.drive.apiStatus = "ready";
    next.serviceStates.drive.scopeStatus =
      account.accessLevel === "read-only" ? "readonly" : "full";
    next.serviceStates.drive.lastCheckedAt = Date.now();
    next.serviceStates.drive.lastError = null;
  } catch (error) {
    driveError = error instanceof Error ? error.message : String(error);
    next.serviceStates.drive.apiStatus = "error";
    next.serviceStates.drive.lastCheckedAt = Date.now();
    next.serviceStates.drive.lastError = driveError;
  }

  const errors = [gmailError, calendarError, driveError].filter(Boolean);
  if (errors.length > 0) {
    next.status = errors.length === 3 ? "error" : "limited-access";
    next.lastError = errors.join(" | ");
  } else {
    next.status = "connected";
    next.lastError = null;
  }

  return next;
}

function ensureCapabilityAllowed(
  store: GoogleIntegrationsStore,
  account: GoogleAccountRecord,
  agentId: string,
  capability: GoogleCapabilityKey,
) {
  if (!isCapabilityEnabledForAccount(account, capability)) {
    throw new Error(
      `${GOOGLE_CAPABILITY_MAP[capability].label} is not available under the current connection access level.`,
    );
  }
  const policy = getGoogleAgentPolicy(store, account.id, agentId, capability);
  if (policy === "deny") {
    throw new Error(
      `${GOOGLE_CAPABILITY_MAP[capability].label} is denied for agent ${agentId}.`,
    );
  }
  return policy;
}

async function executeApprovedPayload(payload: Record<string, unknown>) {
  const action = String(payload.action || "");
  switch (action) {
    case "gmail-draft":
      return sendOrDraftGmail({
        account: requireString(payload.account, "account"),
        to: sanitizeStringList(payload.to),
        cc: sanitizeStringList(payload.cc),
        bcc: sanitizeStringList(payload.bcc),
        subject: requireString(payload.subject, "subject"),
        body: requireString(payload.body, "body"),
        threadId:
          typeof payload.threadId === "string" ? payload.threadId : undefined,
        replyToMessageId:
          typeof payload.replyToMessageId === "string"
            ? payload.replyToMessageId
            : undefined,
        quote: payload.quote === true,
        draftOnly: true,
      });
    case "gmail-reply":
      return sendOrDraftGmail({
        account: requireString(payload.account, "account"),
        to: sanitizeStringList(payload.to),
        cc: sanitizeStringList(payload.cc),
        bcc: sanitizeStringList(payload.bcc),
        subject: requireString(payload.subject, "subject"),
        body: requireString(payload.body, "body"),
        threadId:
          typeof payload.threadId === "string" ? payload.threadId : undefined,
        replyToMessageId:
          typeof payload.replyToMessageId === "string"
            ? payload.replyToMessageId
            : undefined,
        replyAll: payload.replyAll === true,
        quote: payload.quote !== false,
      });
    case "gmail-send":
      return sendOrDraftGmail({
        account: requireString(payload.account, "account"),
        to: sanitizeStringList(payload.to),
        cc: sanitizeStringList(payload.cc),
        bcc: sanitizeStringList(payload.bcc),
        subject: requireString(payload.subject, "subject"),
        body: requireString(payload.body, "body"),
      });
    case "calendar-create":
      return createCalendarEventForAccount({
        account: requireString(payload.account, "account"),
        calendarId: requireString(payload.calendarId, "calendarId"),
        summary: requireString(payload.summary, "summary"),
        from: requireString(payload.from, "from"),
        to: requireString(payload.to, "to"),
        description:
          typeof payload.description === "string"
            ? payload.description
            : undefined,
        location:
          typeof payload.location === "string" ? payload.location : undefined,
        attendees: sanitizeStringList(payload.attendees),
        allDay: payload.allDay === true,
      });
    case "calendar-update":
      return updateCalendarEventForAccount({
        account: requireString(payload.account, "account"),
        calendarId: requireString(payload.calendarId, "calendarId"),
        eventId: requireString(payload.eventId, "eventId"),
        summary: requireString(payload.summary, "summary"),
        from: requireString(payload.from, "from"),
        to: requireString(payload.to, "to"),
        description:
          typeof payload.description === "string"
            ? payload.description
            : undefined,
        location:
          typeof payload.location === "string" ? payload.location : undefined,
        attendees: sanitizeStringList(payload.attendees),
        allDay: payload.allDay === true,
      });
    default:
      throw new Error(`Unsupported approval action: ${action}`);
  }
}

async function queueOrExecuteAction(params: {
  store: GoogleIntegrationsStore;
  account: GoogleAccountRecord;
  agentId: string;
  capability: GoogleCapabilityKey;
  actionLabel: string;
  summary: string;
  payload: Record<string, unknown>;
  execute: () => Promise<unknown>;
}) {
  const policy = ensureCapabilityAllowed(
    params.store,
    params.account,
    params.agentId,
    params.capability,
  );

  if (policy === "ask") {
    const { store: nextStore, approval } = appendGoogleApproval(params.store, {
      accountId: params.account.id,
      agentId: params.agentId,
      capability: params.capability,
      actionLabel: params.actionLabel,
      summary: params.summary,
      payload: params.payload,
      resultSummary: null,
      error: null,
    });
    const audited = appendGoogleAuditEntry(nextStore, {
      accountId: params.account.id,
      agentId: params.agentId,
      capability: params.capability,
      action: params.actionLabel,
      summary: `Approval queued: ${params.summary}`,
      status: "queued",
      detail: null,
    });
    await saveGoogleIntegrationsStore(audited);
    return {
      queued: true,
      approval,
      result: null,
    };
  }

  try {
    const result = await params.execute();
    const audited = appendGoogleAuditEntry(params.store, {
      accountId: params.account.id,
      agentId: params.agentId,
      capability: params.capability,
      action: params.actionLabel,
      summary: params.summary,
      status: "success",
      detail: null,
    });
    await saveGoogleIntegrationsStore(audited);
    return {
      queued: false,
      approval: null,
      result,
    };
  } catch (error) {
    const audited = appendGoogleAuditEntry(params.store, {
      accountId: params.account.id,
      agentId: params.agentId,
      capability: params.capability,
      action: params.actionLabel,
      summary: params.summary,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    });
    await saveGoogleIntegrationsStore(audited);
    throw error;
  }
}

export const GET = withRoute<unknown, AgentIdQuery>(
  { name: "/api/integrations", querySchema: agentIdQuerySchema },
  async (_request, ctx) => {
    const snapshot = await buildGoogleIntegrationsSnapshot(ctx.query.agentId || null);
    return NextResponse.json(snapshot, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);

export const POST = withRoute<IntegrationsPostInput>(
  { name: "/api/integrations", bodySchema: integrationsPostSchema },
  async (_request, ctx) => {
    const body = ctx.body as Record<string, unknown> & IntegrationsPostInput;
    const action = String(body.action || "");
    let store = await readGoogleIntegrationsStore();

    switch (action) {
      case "start-connect": {
        const email = requireString(body.email, "email").toLowerCase();
        const accessLevel = requireString(body.accessLevel, "accessLevel");
        if (!isGoogleAccessLevel(accessLevel)) {
          return badRequest("Invalid access level");
        }
        const existing =
          store.accounts.find((entry) => entry.email === email) ||
          createDefaultGoogleAccount({ email, accessLevel });

        // Use live auth (gog starts its own callback server) with remote fallback
        let authUrl: string;
        let authMode: "live" | "remote" = "live";
        try {
          const auth = await startGogLiveAuth({
            email,
            services: ["gmail", "calendar", "drive"],
            readonly: accessLevel === "read-only",
          });
          authUrl = auth.authUrl;
        } catch {
          // Fallback to remote auth (e.g. file keyring not available)
          const auth = await startGogRemoteAuth({
            email,
            services: ["gmail", "calendar", "drive"],
            readonly: accessLevel === "read-only",
          });
          authUrl = auth.authUrl;
          authMode = "remote";
        }

        const nextAccount: GoogleAccountRecord = {
          ...existing,
          accessLevel,
          pendingAuthUrl: authUrl,
          pendingAuthStartedAt: Date.now(),
          status: "pending",
          lastError: null,
          connectionNotes: authMode === "live"
            ? [
                "Click the sign-in link and log in with your Google account.",
                "After signing in, the connection completes automatically.",
              ]
            : [
                "Click the sign-in link and log in with your Google account.",
                "After signing in, copy the URL from your browser and paste it below.",
              ],
          updatedAt: Date.now(),
        };
        store = upsertGoogleAccount(store, nextAccount);
        store = appendGoogleAuditEntry(store, {
          accountId: nextAccount.id,
          agentId: null,
          capability: "integration.info",
          action: "start-connect",
          summary: `Started Google sign-in for ${email} (${authMode} mode)`,
          status: "info",
          detail: null,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          authUrl,
          authMode,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "poll-auth-status": {
        const email = requireString(body.email, "email").toLowerCase();
        const session = getGogAuthSessionStatus(email);

        const isCompleted = session.status === "completed";

        // Also detect if user authed manually (e.g., via terminal) while we were waiting
        let manuallyAuthed = false;
        if (session.status === "waiting") {
          try {
            const accounts = await listGogStoredAccounts();
            manuallyAuthed = accounts.some(
              (a) => a.email.toLowerCase() === email && a.source === "gog",
            );
          } catch { /* ignore */ }
        }

        if (isCompleted || manuallyAuthed) {
          cleanupGogAuthSession(email);
          const account = store.accounts.find((entry) => entry.email === email);
          if (account) {
            const checked = await checkAccountAccess({
              ...account,
              pendingAuthUrl: null,
              pendingAuthStartedAt: null,
              connectionNotes: [],
            });
            store = upsertGoogleAccount(store, checked);
            store = appendGoogleAuditEntry(store, {
              accountId: account.id,
              agentId: null,
              capability: "integration.info",
              action: manuallyAuthed ? "manual-auth-detected" : "live-auth-completed",
              summary: `Google account ${email} connected${manuallyAuthed ? " (detected from terminal)" : " automatically"}`,
              status: "success",
              detail: null,
            });
            await saveGoogleIntegrationsStore(store);
          }
          return NextResponse.json({
            ok: true,
            authStatus: "completed",
            snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
          });
        }

        return NextResponse.json({
          ok: true,
          authStatus: session.status,
          error: session.error,
        });
      }

      case "finish-connect": {
        const accountId = requireString(body.accountId, "accountId");
        const authUrl = requireString(body.authUrl, "authUrl");
        const account = getAccountOrThrow(store, accountId);
        // Clean up any live session first
        cleanupGogAuthSession(account.email);
        await finishGogRemoteAuth({
          email: account.email,
          services: ["gmail", "calendar", "drive"],
          readonly: account.accessLevel === "read-only",
          authUrl,
        });
        const checked = await checkAccountAccess({
          ...account,
          pendingAuthUrl: null,
          pendingAuthStartedAt: null,
          connectionNotes: [],
        });
        store = upsertGoogleAccount(store, checked);
        store = appendGoogleAuditEntry(store, {
          accountId,
          agentId: null,
          capability: "integration.info",
          action: "finish-connect",
          summary: `Connected Google account ${account.email}`,
          status: "success",
          detail: null,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "import-existing-account": {
        const email = requireString(body.email, "email").toLowerCase();
        const accessLevel = requireString(body.accessLevel, "accessLevel");
        if (!isGoogleAccessLevel(accessLevel)) {
          return badRequest("Invalid access level");
        }
        const base =
          store.accounts.find((entry) => entry.email === email) ||
          createDefaultGoogleAccount({ email, accessLevel });
        const checked = await checkAccountAccess({
          ...base,
          accessLevel,
          status: "connected",
          pendingAuthUrl: null,
          pendingAuthStartedAt: null,
          connectionNotes: [],
        });
        store = upsertGoogleAccount(store, checked);
        store = appendGoogleAuditEntry(store, {
          accountId: checked.id,
          agentId: null,
          capability: "integration.info",
          action: "import-existing-account",
          summary: `Imported existing gog account ${email}`,
          status: "success",
          detail: null,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "disconnect-account": {
        const accountId = requireString(body.accountId, "accountId");
        const account = getAccountOrThrow(store, accountId);
        const warning = await disconnectGogAccount(account.email);
        store = removeGoogleAccount(store, accountId);
        store = appendGoogleAuditEntry(store, {
          accountId,
          agentId: null,
          capability: "integration.info",
          action: "disconnect-account",
          summary: `Disconnected ${account.email}`,
          status: "info",
          detail: warning,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          warning,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "set-access-level": {
        const accountId = requireString(body.accountId, "accountId");
        const accessLevel = requireString(body.accessLevel, "accessLevel");
        if (!isGoogleAccessLevel(accessLevel)) {
          return badRequest("Invalid access level");
        }
        const account = getAccountOrThrow(store, accountId);
        store = upsertGoogleAccount(store, {
          ...account,
          accessLevel,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "set-custom-capability": {
        const accountId = requireString(body.accountId, "accountId");
        const capability = requireString(body.capability, "capability");
        if (!isGoogleCapabilityKey(capability)) {
          return badRequest("Invalid capability");
        }
        const enabled = body.enabled === true;
        const account = getAccountOrThrow(store, accountId);
        store = upsertGoogleAccount(store, {
          ...account,
          customCapabilityAccess: {
            ...account.customCapabilityAccess,
            [capability]: enabled,
          },
          accessLevel: "custom",
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "set-service-access": {
        const accountId = requireString(body.accountId, "accountId");
        const service = body.service;
        const mode = String(body.mode || "");
        if (!isGoogleService(service) || (mode !== "read" && mode !== "write")) {
          return badRequest("Invalid service or mode");
        }
        const account = getAccountOrThrow(store, accountId);
        const serviceCapabilities = GOOGLE_CAPABILITY_DEFINITIONS.filter(
          (entry) => entry.service === service,
        );
        const nextCustom = { ...account.customCapabilityAccess };
        for (const capability of serviceCapabilities) {
          nextCustom[capability.key] =
            mode === "write" ? true : capability.category === "read";
        }
        store = upsertGoogleAccount(store, {
          ...account,
          accessLevel: "custom",
          customCapabilityAccess: nextCustom,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "set-agent-policy": {
        const accountId = requireString(body.accountId, "accountId");
        const agentId = requireString(body.agentId, "agentId");
        const capability = requireString(body.capability, "capability");
        const policy = requireString(body.policy, "policy");
        if (!isGoogleCapabilityKey(capability) || !isGoogleAgentPolicy(policy)) {
          return badRequest("Invalid capability or policy");
        }
        store = setGoogleAgentPolicyRecord(store, {
          accountId,
          agentId,
          capability,
          policy,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(agentId),
        });
      }

      case "set-watch-config": {
        const accountId = requireString(body.accountId, "accountId");
        const account = getAccountOrThrow(store, accountId);
        const watchPatch = (body.watch || {}) as Partial<GoogleWatchConfig>;
        store = upsertGoogleAccount(store, {
          ...account,
          watch: {
            ...account.watch,
            enabled: watchPatch.enabled === true,
            targetAgentId:
              typeof watchPatch.targetAgentId === "string"
                ? watchPatch.targetAgentId
                : account.watch.targetAgentId,
            label:
              typeof watchPatch.label === "string" ? watchPatch.label : account.watch.label,
            projectId:
              typeof watchPatch.projectId === "string"
                ? watchPatch.projectId
                : account.watch.projectId,
            topic:
              typeof watchPatch.topic === "string" ? watchPatch.topic : account.watch.topic,
            subscription:
              typeof watchPatch.subscription === "string"
                ? watchPatch.subscription
                : account.watch.subscription,
            hookUrl:
              typeof watchPatch.hookUrl === "string"
                ? watchPatch.hookUrl
                : account.watch.hookUrl,
            hookToken:
              typeof watchPatch.hookToken === "string"
                ? watchPatch.hookToken
                : account.watch.hookToken,
            pushEndpoint:
              typeof watchPatch.pushEndpoint === "string"
                ? watchPatch.pushEndpoint
                : account.watch.pushEndpoint,
            pushToken:
              typeof watchPatch.pushToken === "string"
                ? watchPatch.pushToken
                : account.watch.pushToken,
            port:
              typeof watchPatch.port === "string" ? watchPatch.port : account.watch.port,
            path:
              typeof watchPatch.path === "string" ? watchPatch.path : account.watch.path,
            tailscaleMode:
              watchPatch.tailscaleMode === "serve" || watchPatch.tailscaleMode === "off"
                ? watchPatch.tailscaleMode
                : account.watch.tailscaleMode,
            includeBody:
              typeof watchPatch.includeBody === "boolean"
                ? watchPatch.includeBody
                : account.watch.includeBody,
            maxBytes:
              typeof watchPatch.maxBytes === "number"
                ? watchPatch.maxBytes
                : account.watch.maxBytes,
            lastCheckedAt: Date.now(),
          },
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "setup-watch": {
        const accountId = requireString(body.accountId, "accountId");
        const account = getAccountOrThrow(store, accountId);
        if (!account.watch.projectId.trim()) {
          return badRequest("Project ID is required before Gmail watch setup.");
        }
        const result = await setupOpenClawGmailWatch({
          account: account.email,
          projectId: account.watch.projectId,
          label: account.watch.label,
          hookUrl: account.watch.hookUrl || undefined,
          hookToken: account.watch.hookToken || undefined,
          topic: account.watch.topic,
          subscription: account.watch.subscription,
          pushEndpoint: account.watch.pushEndpoint || undefined,
          pushToken: account.watch.pushToken || undefined,
          port: account.watch.port,
          path: account.watch.path,
          tailscaleMode: account.watch.tailscaleMode,
          includeBody: account.watch.includeBody,
          maxBytes: account.watch.maxBytes,
        });
        store = upsertGoogleAccount(store, {
          ...account,
          watch: {
            ...account.watch,
            status: "configured",
            enabled: true,
            lastConfiguredAt: Date.now(),
            lastCheckedAt: Date.now(),
            lastError: null,
          },
        });
        store = appendGoogleAuditEntry(store, {
          accountId,
          agentId: account.watch.targetAgentId,
          capability: "integration.info",
          action: "setup-watch",
          summary: `Configured Gmail watch for ${account.email}`,
          status: "success",
          detail: null,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          result,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "check-access": {
        const accountId = requireString(body.accountId, "accountId");
        const account = getAccountOrThrow(store, accountId);
        const checked = await checkAccountAccess(account);
        store = upsertGoogleAccount(store, checked);
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      case "gmail-search": {
        const accountId = requireString(body.accountId, "accountId");
        const agentId = requireString(body.agentId, "agentId");
        const account = getAccountOrThrow(store, accountId);
        const result = await queueOrExecuteAction({
          store,
          account,
          agentId,
          capability: "gmail.search-inbox",
          actionLabel: "gmail-search",
          summary: `Search inbox for "${String(body.query || "in:inbox")}"`,
          payload: {
            action: "gmail-search",
            account: account.email,
            query: String(body.query || "in:inbox"),
          },
          execute: () =>
            searchGmailInbox({
              account: account.email,
              query: String(body.query || "in:inbox"),
              max: typeof body.max === "number" ? body.max : 20,
            }),
        });
        return NextResponse.json({
          ok: true,
          ...result,
          snapshot: await buildGoogleIntegrationsSnapshot(agentId),
        });
      }

      case "gmail-read-thread": {
        const accountId = requireString(body.accountId, "accountId");
        const agentId = requireString(body.agentId, "agentId");
        const threadId = requireString(body.threadId, "threadId");
        const account = getAccountOrThrow(store, accountId);
        const result = await queueOrExecuteAction({
          store,
          account,
          agentId,
          capability: "gmail.read-thread",
          actionLabel: "gmail-read-thread",
          summary: `Read Gmail thread ${threadId}`,
          payload: {
            action: "gmail-read-thread",
            account: account.email,
            threadId,
          },
          execute: () =>
            getGmailThread({
              account: account.email,
              threadId,
            }),
        });
        return NextResponse.json({
          ok: true,
          ...result,
          snapshot: await buildGoogleIntegrationsSnapshot(agentId),
        });
      }

      case "gmail-draft":
      case "gmail-reply":
      case "gmail-send": {
        const accountId = requireString(body.accountId, "accountId");
        const agentId = requireString(body.agentId, "agentId");
        const account = getAccountOrThrow(store, accountId);
        const capability =
          action === "gmail-draft"
            ? "gmail.draft-reply"
            : action === "gmail-reply"
              ? "gmail.reply-email"
              : "gmail.send-email";
        const to = sanitizeStringList(body.to);
        const payload = {
          action,
          account: account.email,
          to,
          cc: sanitizeStringList(body.cc),
          bcc: sanitizeStringList(body.bcc),
          subject: requireString(body.subject, "subject"),
          body: requireString(body.body, "body"),
          threadId: typeof body.threadId === "string" ? body.threadId : "",
          replyToMessageId:
            typeof body.replyToMessageId === "string" ? body.replyToMessageId : "",
          replyAll: body.replyAll === true,
          quote: body.quote !== false,
        };
        const summary =
          action === "gmail-send"
            ? `Send email "${payload.subject}" to ${to.join(", ") || "recipient"}`
            : action === "gmail-reply"
              ? `Reply to Gmail thread "${payload.subject}"`
              : `Create Gmail draft "${payload.subject}"`;
        const result = await queueOrExecuteAction({
          store,
          account,
          agentId,
          capability,
          actionLabel: action,
          summary,
          payload,
          execute: () => executeApprovedPayload(payload),
        });
        return NextResponse.json({
          ok: true,
          ...result,
          snapshot: await buildGoogleIntegrationsSnapshot(agentId),
        });
      }

      case "calendar-list": {
        const accountId = requireString(body.accountId, "accountId");
        const agentId = requireString(body.agentId, "agentId");
        const account = getAccountOrThrow(store, accountId);
        const result = await queueOrExecuteAction({
          store,
          account,
          agentId,
          capability: "calendar.list-events",
          actionLabel: "calendar-list",
          summary: `List calendar events for ${account.email}`,
          payload: {
            action: "calendar-list",
            account: account.email,
            days: typeof body.days === "number" ? body.days : 7,
          },
          execute: () =>
            listCalendarEventsForAccount({
              account: account.email,
              days: typeof body.days === "number" ? body.days : 7,
            }),
        });
        return NextResponse.json({
          ok: true,
          ...result,
          snapshot: await buildGoogleIntegrationsSnapshot(agentId),
        });
      }

      case "calendar-create":
      case "calendar-update": {
        const accountId = requireString(body.accountId, "accountId");
        const agentId = requireString(body.agentId, "agentId");
        const account = getAccountOrThrow(store, accountId);
        const capability =
          action === "calendar-create"
            ? "calendar.create-event"
            : "calendar.update-event";
        const payload = {
          action,
          account: account.email,
          calendarId:
            typeof body.calendarId === "string" && body.calendarId.trim()
              ? body.calendarId.trim()
              : "primary",
          eventId:
            typeof body.eventId === "string" ? body.eventId.trim() : "",
          summary: requireString(body.summary, "summary"),
          from: requireString(body.from, "from"),
          to: requireString(body.to, "to"),
          description:
            typeof body.description === "string" ? body.description : "",
          location: typeof body.location === "string" ? body.location : "",
          attendees: sanitizeStringList(body.attendees),
          allDay: body.allDay === true,
        };
        const result = await queueOrExecuteAction({
          store,
          account,
          agentId,
          capability,
          actionLabel: action,
          summary:
            action === "calendar-create"
              ? `Create calendar event "${payload.summary}"`
              : `Update calendar event "${payload.summary}"`,
          payload,
          execute: () => executeApprovedPayload(payload),
        });
        return NextResponse.json({
          ok: true,
          ...result,
          snapshot: await buildGoogleIntegrationsSnapshot(agentId),
        });
      }

      case "approve-request": {
        const approvalId = requireString(body.approvalId, "approvalId");
        const approval = store.approvals.find((entry) => entry.id === approvalId);
        if (!approval) {
          return notFound("Approval request not found");
        }
        if (approval.status !== "pending") {
          return badRequest("Approval request is no longer pending");
        }
        try {
          const result = await executeApprovedPayload(approval.payload);
          store = updateGoogleApproval(store, approvalId, {
            status: "completed",
            resolvedAt: Date.now(),
            executedAt: Date.now(),
            resultSummary: "Executed successfully",
            error: null,
          });
          store = appendGoogleAuditEntry(store, {
            accountId: approval.accountId,
            agentId: approval.agentId,
            capability: approval.capability,
            action: "approval-approved",
            summary: approval.summary,
            status: "success",
            detail: null,
          });
          await saveGoogleIntegrationsStore(store);
          return NextResponse.json({
            ok: true,
            result,
            snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
          });
        } catch (error) {
          store = updateGoogleApproval(store, approvalId, {
            status: "failed",
            resolvedAt: Date.now(),
            resultSummary: null,
            error: error instanceof Error ? error.message : String(error),
          });
          store = appendGoogleAuditEntry(store, {
            accountId: approval.accountId,
            agentId: approval.agentId,
            capability: approval.capability,
            action: "approval-failed",
            summary: approval.summary,
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
          await saveGoogleIntegrationsStore(store);
          throw error;
        }
      }

      case "deny-request": {
        const approvalId = requireString(body.approvalId, "approvalId");
        const approval = store.approvals.find((entry) => entry.id === approvalId);
        if (!approval) {
          return notFound("Approval request not found");
        }
        store = updateGoogleApproval(store, approvalId, {
          status: "denied",
          resolvedAt: Date.now(),
          resultSummary: "Denied by user",
          error: null,
        });
        store = appendGoogleAuditEntry(store, {
          accountId: approval.accountId,
          agentId: approval.agentId,
          capability: approval.capability,
          action: "approval-denied",
          summary: approval.summary,
          status: "denied",
          detail: null,
        });
        await saveGoogleIntegrationsStore(store);
        return NextResponse.json({
          ok: true,
          snapshot: await buildGoogleIntegrationsSnapshot(String(body.agentId || "") || null),
        });
      }

      default:
        // Unreachable: integrationsPostSchema's discriminated union already
        // rejects any `action` outside the literals above before this
        // handler runs (T-02-27). Kept as a defensive fallback, matching the
        // `terminalPostSchema` exhaustiveness guard in
        // src/app/api/terminal/route.ts.
        return badRequest(`Unknown action: ${action}`);
    }
  },
);
