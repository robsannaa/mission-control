import { NextResponse } from "next/server";
import { gatewayWakeAgent } from "@/lib/gateway-tools";
import { gatewayCallWithRetry, patchConfig } from "@/lib/gateway-config";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound } from "@/lib/api-errors";
import { heartbeatPostSchema } from "@/lib/schemas/system";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

const NO_STORE_HEADERS = { "Cache-Control": "no-store" } as const;

function jsonNoStore(body: unknown, init?: ResponseInit) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      ...NO_STORE_HEADERS,
      ...(init?.headers || {}),
    },
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeJsonValue(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 12) return undefined;
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const next = sanitizeJsonValue(item, depth + 1);
      if (next !== undefined) out.push(next);
    }
    return out;
  }
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(value)) {
      const next = sanitizeJsonValue(v, depth + 1);
      if (next !== undefined) out[k] = next;
    }
    return out;
  }
  return undefined;
}

function sanitizeJsonObject(value: unknown): JsonObject | null {
  if (!isRecord(value)) return null;
  const sanitized = sanitizeJsonValue(value);
  if (!sanitized || Array.isArray(sanitized) || typeof sanitized !== "object") return null;
  return sanitized as JsonObject;
}

async function gatewayConfigGet(): Promise<Record<string, unknown>> {
  return gatewayCallWithRetry<Record<string, unknown>>(
    "config.get",
    undefined,
    12000,
    4
  );
}

type AgentHeartbeatRow = {
  id: string;
  name: string;
  heartbeat: JsonObject | null;
};

/**
 * Every field under `agents.defaults.heartbeat`, `agents.list[].heartbeat`, and
 * `channels.*.heartbeat` reports `reloadKind: "hot"` from
 * `config.schema.lookup` on this OpenClaw build (verified 2026-08-10 against a
 * live gateway at 127.0.0.1:18789, OpenClaw 2026.7.1-2). A saved heartbeat
 * change takes effect on the next tick with no gateway restart.
 */
const HEARTBEAT_RELOAD_KIND = "hot" as const;

type VisibilityShape = {
  defaults: JsonObject | null;
  channels: Record<string, { heartbeat: JsonObject | null; accounts: Record<string, JsonObject | null> }>;
};

function extractVisibility(parsedChannels: Record<string, unknown>): VisibilityShape {
  const defaultsBlock = isRecord(parsedChannels.defaults) ? parsedChannels.defaults : {};
  const defaultsHeartbeat = sanitizeJsonObject(defaultsBlock.heartbeat);

  const channels: Record<
    string,
    { heartbeat: JsonObject | null; accounts: Record<string, JsonObject | null> }
  > = {};

  for (const [channelName, channelValue] of Object.entries(parsedChannels)) {
    if (channelName === "defaults" || !isRecord(channelValue)) continue;

    const channelHeartbeat = sanitizeJsonObject(channelValue.heartbeat);
    const accountOverrides: Record<string, JsonObject | null> = {};
    const accountsBlock = isRecord(channelValue.accounts) ? channelValue.accounts : {};

    for (const [accountId, accountValue] of Object.entries(accountsBlock)) {
      if (!isRecord(accountValue)) continue;
      const accountHeartbeat = sanitizeJsonObject(accountValue.heartbeat);
      if (accountHeartbeat) {
        accountOverrides[accountId] = accountHeartbeat;
      }
    }

    if (channelHeartbeat || Object.keys(accountOverrides).length > 0) {
      channels[channelName] = {
        heartbeat: channelHeartbeat,
        accounts: accountOverrides,
      };
    }
  }

  return { defaults: defaultsHeartbeat, channels };
}

function buildHeartbeatResponse(configData: Record<string, unknown>) {
  const parsed = isRecord(configData.parsed) ? configData.parsed : {};
  const resolved = isRecord(configData.resolved) ? configData.resolved : {};

  const parsedAgents = isRecord(parsed.agents) ? parsed.agents : {};
  const resolvedAgents = isRecord(resolved.agents) ? resolved.agents : {};
  const parsedDefaults = isRecord(parsedAgents.defaults) ? parsedAgents.defaults : {};
  const resolvedDefaults = isRecord(resolvedAgents.defaults) ? resolvedAgents.defaults : {};

  const defaultsHeartbeat = sanitizeJsonObject(parsedDefaults.heartbeat);
  const effectiveDefaultsHeartbeat =
    sanitizeJsonObject(resolvedDefaults.heartbeat) || defaultsHeartbeat;

  const agentRows: AgentHeartbeatRow[] = [];
  const parsedList = Array.isArray(parsedAgents.list) ? parsedAgents.list : [];
  const resolvedList = Array.isArray(resolvedAgents.list) ? resolvedAgents.list : [];
  const list = parsedList.length > 0 ? parsedList : resolvedList;
  const parsedHeartbeatById = new Map<string, JsonObject | null>();
  for (const entry of parsedList) {
    if (!isRecord(entry)) continue;
    const id = String(entry.id || "");
    if (!id) continue;
    parsedHeartbeatById.set(id, sanitizeJsonObject(entry.heartbeat));
  }
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = String(entry.id || "");
    if (!id) continue;
    agentRows.push({
      id,
      name: String(entry.name || id),
      heartbeat: parsedHeartbeatById.get(id) || null,
    });
  }

  // A fresh OpenClaw install has no `agents.list` at all — there is still a
  // real, running "main" agent (OpenClaw creates it implicitly; confirmed
  // live via the `agents.list` RPC, which reports it with
  // `agentRuntime.source: "implicit"`). Without this fallback the page would
  // report zero agents while a "main" agent is actually running heartbeats,
  // which is exactly the state this machine was in before this fix.
  if (agentRows.length === 0) {
    agentRows.push({ id: "main", name: "Main agent", heartbeat: null });
  }

  const parsedChannels = isRecord(parsed.channels) ? parsed.channels : {};
  const visibility = extractVisibility(parsedChannels);

  return {
    docsUrl: "https://docs.openclaw.ai/gateway/heartbeat#heartbeat",
    reloadKind: HEARTBEAT_RELOAD_KIND,
    defaultsHeartbeat,
    effectiveDefaultsHeartbeat,
    agents: agentRows,
    visibility,
    stats: {
      agentsTotal: agentRows.length,
      agentsWithOverrides: agentRows.filter((a) => Boolean(a.heartbeat)).length,
      channelsWithOverrides: Object.keys(visibility.channels).length,
    },
  };
}

/**
 * GET /api/heartbeat — deliberately never returns an error status: on a
 * gateway failure it serves a minimal, explicitly-degraded payload
 * (`degraded: true`) instead. Kept as an internal try/catch (not thrown) so
 * `withRoute`'s own catch never sees this failure and never converts it
 * into a 500.
 */
export const GET = withRoute({ name: "/api/heartbeat" }, async (_request, { log }) => {
  try {
    const configData = await gatewayConfigGet();
    return jsonNoStore({
      ok: true,
      ...buildHeartbeatResponse(configData),
    });
  } catch (err) {
    log.warn({ err: String(err) }, "Heartbeat GET error — returning degraded payload");
    return jsonNoStore({
      ok: true,
      docsUrl: "https://docs.openclaw.ai/gateway/heartbeat#heartbeat",
      reloadKind: HEARTBEAT_RELOAD_KIND,
      defaultsHeartbeat: null,
      effectiveDefaultsHeartbeat: null,
      agents: [],
      visibility: { defaults: null, channels: {} },
      stats: {
        agentsTotal: 0,
        agentsWithOverrides: 0,
        channelsWithOverrides: 0,
      },
      warning: String(err),
      degraded: true,
    });
  }
});

type VisibilityPatch = {
  defaults?: JsonObject | null;
  channels?: Record<
    string,
    {
      heartbeat?: JsonObject | null;
      accounts?: Record<string, { heartbeat?: JsonObject | null }>;
    }
  >;
};

function parseVisibilityPatch(input: unknown): VisibilityPatch | null {
  if (!isRecord(input)) return null;

  const out: VisibilityPatch = {};

  if (Object.prototype.hasOwnProperty.call(input, "defaults")) {
    if (input.defaults === null) {
      out.defaults = null;
    } else {
      const defaults = sanitizeJsonObject(input.defaults);
      if (defaults) out.defaults = defaults;
      else return null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(input, "channels")) {
    if (!isRecord(input.channels)) return null;
    const channels: VisibilityPatch["channels"] = {};
    for (const [channel, channelPatch] of Object.entries(input.channels)) {
      if (!isRecord(channelPatch)) return null;
      const next: {
        heartbeat?: JsonObject | null;
        accounts?: Record<string, { heartbeat?: JsonObject | null }>;
      } = {};

      if (Object.prototype.hasOwnProperty.call(channelPatch, "heartbeat")) {
        if (channelPatch.heartbeat === null) {
          next.heartbeat = null;
        } else {
          const hb = sanitizeJsonObject(channelPatch.heartbeat);
          if (!hb) return null;
          next.heartbeat = hb;
        }
      }

      if (Object.prototype.hasOwnProperty.call(channelPatch, "accounts")) {
        if (!isRecord(channelPatch.accounts)) return null;
        const accounts: Record<string, { heartbeat?: JsonObject | null }> = {};
        for (const [accountId, accountPatch] of Object.entries(channelPatch.accounts)) {
          if (!isRecord(accountPatch)) return null;
          const accountNext: { heartbeat?: JsonObject | null } = {};
          if (Object.prototype.hasOwnProperty.call(accountPatch, "heartbeat")) {
            if (accountPatch.heartbeat === null) {
              accountNext.heartbeat = null;
            } else {
              const hb = sanitizeJsonObject(accountPatch.heartbeat);
              if (!hb) return null;
              accountNext.heartbeat = hb;
            }
          }
          accounts[accountId] = accountNext;
        }
        next.accounts = accounts;
      }

      channels[channel] = next;
    }
    out.channels = channels;
  }

  return out;
}

/**
 * POST /api/heartbeat — heartbeat configuration writes. Every error path
 * below returns through an `@/lib/api-errors` builder, so every error body
 * carries `ok: false` (D-01). Success payloads keep using `jsonNoStore` —
 * success shapes are out of scope for this phase (docs/API-CONTRACT.md §5).
 */
export const POST = withRoute(
  { name: "/api/heartbeat", bodySchema: heartbeatPostSchema },
  async (_request, { body }) => {
    const action = String(body.action || "");

    if (!action) {
      return badRequest("action required");
    }

    if (action === "wake-now") {
      const mode = body.mode === "next-heartbeat" ? "next-heartbeat" : "now";
      const text =
        typeof body.text === "string" && body.text.trim()
          ? body.text.trim()
          : "Check for urgent follow-ups";
      const output = await gatewayWakeAgent({ text, mode });
      return jsonNoStore({ ok: true, action, mode, text, output: output.trim() });
    }

    const configData = await gatewayConfigGet();
    const parsed = isRecord(configData.parsed) ? configData.parsed : {};

    if (action === "save-defaults") {
      const heartbeatRaw = body.heartbeat;
      const heartbeat =
        heartbeatRaw === null ? null : sanitizeJsonObject(heartbeatRaw);
      if (heartbeatRaw !== null && !heartbeat) {
        return badRequest("heartbeat must be an object or null");
      }

      const agentsBlock = isRecord(parsed.agents) ? { ...parsed.agents } : {};
      const defaultsBlock = isRecord(agentsBlock.defaults)
        ? { ...agentsBlock.defaults }
        : {};

      // config.patch merge semantics do not reliably remove missing keys;
      // use explicit null to clear heartbeat override.
      if (heartbeat === null) defaultsBlock.heartbeat = null;
      else defaultsBlock.heartbeat = heartbeat;

      await patchConfig({
        agents: {
          ...agentsBlock,
          defaults: defaultsBlock,
        },
      });

      const next = await gatewayConfigGet();
      return jsonNoStore({ ok: true, action, ...buildHeartbeatResponse(next) });
    }

    if (action === "save-agent") {
      const agentId = String(body.agentId || "").trim();
      if (!agentId) {
        return badRequest("agentId required");
      }
      const heartbeatRaw = body.heartbeat;
      const heartbeat =
        heartbeatRaw === null ? null : sanitizeJsonObject(heartbeatRaw);
      if (heartbeatRaw !== null && !heartbeat) {
        return badRequest("heartbeat must be an object or null");
      }

      const agentsBlock = isRecord(parsed.agents) ? { ...parsed.agents } : {};
      const list = Array.isArray(agentsBlock.list) ? agentsBlock.list : [];
      let found = false;
      const nextList = list.map((entry) => {
        if (!isRecord(entry)) return entry;
        if (String(entry.id || "") !== agentId) return entry;
        found = true;
        const nextEntry: Record<string, unknown> = { ...entry };
        // Use explicit null for reliable clear semantics.
        if (heartbeat === null) nextEntry.heartbeat = null;
        else nextEntry.heartbeat = heartbeat;
        return nextEntry;
      });

      if (!found) {
        return notFound(`Agent ${agentId} not found`);
      }

      await patchConfig({
        agents: {
          ...agentsBlock,
          list: nextList,
        },
      });

      const next = await gatewayConfigGet();
      return jsonNoStore({ ok: true, action, ...buildHeartbeatResponse(next) });
    }

    if (action === "save-visibility") {
      const patch = parseVisibilityPatch(body.visibility);
      if (!patch) {
        return badRequest("visibility payload is invalid");
      }

      const channelsBlock = isRecord(parsed.channels) ? { ...parsed.channels } : {};

      if (Object.prototype.hasOwnProperty.call(patch, "defaults")) {
        const defaults = isRecord(channelsBlock.defaults)
          ? { ...channelsBlock.defaults }
          : {};
        if (patch.defaults === null) delete defaults.heartbeat;
        else if (patch.defaults) defaults.heartbeat = patch.defaults;
        channelsBlock.defaults = defaults;
      }

      if (patch.channels) {
        for (const [channelName, channelPatch] of Object.entries(patch.channels)) {
          const existingChannel = isRecord(channelsBlock[channelName])
            ? { ...(channelsBlock[channelName] as Record<string, unknown>) }
            : {};

          if (Object.prototype.hasOwnProperty.call(channelPatch, "heartbeat")) {
            if (channelPatch.heartbeat === null) {
              existingChannel.heartbeat = null;
            } else if (channelPatch.heartbeat) {
              existingChannel.heartbeat = channelPatch.heartbeat;
            }
          }

          if (channelPatch.accounts) {
            const existingAccounts = isRecord(existingChannel.accounts)
              ? { ...(existingChannel.accounts as Record<string, unknown>) }
              : {};

            for (const [accountId, accountPatch] of Object.entries(channelPatch.accounts)) {
              const existingAccount = isRecord(existingAccounts[accountId])
                ? { ...(existingAccounts[accountId] as Record<string, unknown>) }
                : {};

              if (Object.prototype.hasOwnProperty.call(accountPatch, "heartbeat")) {
                if (accountPatch.heartbeat === null) {
                  existingAccount.heartbeat = null;
                } else if (accountPatch.heartbeat) {
                  existingAccount.heartbeat = accountPatch.heartbeat;
                }
              }

              existingAccounts[accountId] = existingAccount;
            }

            existingChannel.accounts = existingAccounts;
          }

          channelsBlock[channelName] = existingChannel;
        }
      }

      await patchConfig({ channels: channelsBlock });

      const next = await gatewayConfigGet();
      return jsonNoStore({ ok: true, action, ...buildHeartbeatResponse(next) });
    }

    return badRequest(`Unknown action: ${action}`);
  },
);
