import { NextRequest, NextResponse } from "next/server";
import { readFile } from "fs/promises";
import { join } from "path";
import { gatewayCall } from "@/lib/openclaw";
import { patchConfig } from "@/lib/gateway-config";
import { getOpenClawHome } from "@/lib/paths";

export const dynamic = "force-dynamic";

/* ── Helpers ── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function toStr(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/* ── Channel setup enrichment (static metadata only — the channel LIST comes
      from the gateway + config; this map only decorates known channels with
      setup instructions. Channels the gateway reports that are missing here
      still render as a generic config card, never hidden). ── */

type ChannelSetupMeta = {
  label: string;
  icon: string;
  setup: "token" | "qr" | "cli";
  /** openclaw.json key that stores the credential for token channels. */
  tokenKey?: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  hint: string;
  docsUrl: string;
};

const CHANNEL_SETUP: Record<string, ChannelSetupMeta> = {
  telegram: {
    label: "Telegram",
    icon: "✈️",
    setup: "token",
    tokenKey: "botToken",
    tokenLabel: "Bot Token",
    tokenPlaceholder: "123456:ABC-DEF1234ghIkl...",
    hint: "Create a bot with @BotFather in Telegram, then paste the token here.",
    docsUrl: "https://docs.openclaw.ai/channels/telegram",
  },
  discord: {
    label: "Discord",
    icon: "💬",
    setup: "token",
    tokenKey: "token",
    tokenLabel: "Bot Token",
    tokenPlaceholder: "MTIzNDU2Nzg5MDEyMzQ1...",
    hint: "Create a bot in the Discord Developer Portal, enable Message Content Intent, then paste the token.",
    docsUrl: "https://docs.openclaw.ai/channels/discord",
  },
  whatsapp: {
    label: "WhatsApp",
    icon: "📱",
    setup: "qr",
    hint: "WhatsApp links via QR code — start the login flow and scan the code from WhatsApp > Linked devices.",
    docsUrl: "https://docs.openclaw.ai/channels/whatsapp",
  },
  signal: {
    label: "Signal",
    icon: "🔒",
    setup: "cli",
    hint: "Signal runs through signal-cli. Link an existing account by scanning a QR, or register a dedicated bot number.",
    docsUrl: "https://docs.openclaw.ai/channels/signal",
  },
  slack: {
    label: "Slack",
    icon: "💼",
    setup: "token",
    tokenKey: "botToken",
    tokenLabel: "Bot Token (xoxb-...)",
    tokenPlaceholder: "xoxb-...",
    hint: "Create a Slack app in Socket Mode, then paste the bot token (an app token xapp-... is also required in config).",
    docsUrl: "https://docs.openclaw.ai/channels/slack",
  },
};

function genericSetupMeta(id: string, label?: string): ChannelSetupMeta {
  const display = label || id.charAt(0).toUpperCase() + id.slice(1);
  return {
    label: display,
    icon: "🔌",
    setup: "token",
    tokenKey: "token",
    tokenLabel: "Token",
    tokenPlaceholder: "Paste the channel credential",
    hint: `${display} was reported by the gateway. Configure it under channels.${id} in openclaw.json or via the setup command below.`,
    docsUrl: `https://docs.openclaw.ai/channels/${id}`,
  };
}

const VALID_CHANNEL_ID = /^[a-z][a-z0-9_-]*$/;

/* ── Read config from disk (fallback when gateway RPC unavailable) ── */

async function readChannelsConfig(): Promise<Record<string, unknown>> {
  const home = getOpenClawHome();
  try {
    const raw = await readFile(join(home, "openclaw.json"), "utf-8");
    const parsed = JSON.parse(raw);
    if (isRecord(parsed) && isRecord(parsed.channels)) return parsed.channels;
  } catch { /* */ }
  return {};
}

/* ── Build channel status from gateway + config ── */

type ChannelStatus = {
  id: string;
  channel: string;
  label: string;
  icon: string;
  setup: "token" | "qr" | "cli";
  setupType: "qr" | "token" | "cli" | "auto";
  setupCommand: string;
  setupHint: string;
  configHint: string;
  tokenLabel?: string;
  tokenPlaceholder?: string;
  hint: string;
  docsUrl: string;
  managed: boolean;
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  error?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  accounts: string[];
  botUsername?: string;
  statuses: {
    channel: string;
    account: string;
    status: string;
    linked?: boolean;
    connected?: boolean;
    error?: string;
  }[];
};

type ChannelsPayload = {
  channels: ChannelStatus[];
  gatewayOffline: boolean;
  gatewayError?: string;
};

async function buildChannelStatuses(): Promise<ChannelsPayload> {
  // Fetch gateway status + config in parallel (5s timeout — keep UI snappy).
  // Failures are captured, not swallowed: a dead gateway must surface as
  // gatewayOffline, never masquerade as "nothing is configured".
  let statusError: unknown = null;
  let configError: unknown = null;
  const [statusResult, configResult, diskConfig] = await Promise.all([
    gatewayCall<Record<string, unknown>>("channels.status", {}, 5000).catch((err) => {
      statusError = err;
      return null;
    }),
    gatewayCall<Record<string, unknown>>("config.get", undefined, 5000).catch((err) => {
      configError = err;
      return null;
    }),
    readChannelsConfig(),
  ]);

  const gatewayOffline = statusResult === null && configResult === null;

  // Extract channel config from gateway or disk
  const resolved = isRecord(configResult?.resolved) ? configResult.resolved : {};
  const channelsConfig = isRecord(resolved.channels)
    ? resolved.channels
    : diskConfig;

  // Extract runtime status
  const statusAccounts = isRecord(statusResult)
    ? (isRecord(statusResult.channelAccounts) ? statusResult.channelAccounts : {})
    : {};
  const statusChannels = isRecord(statusResult)
    ? (isRecord(statusResult.channels) ? statusResult.channels : {})
    : {};
  const channelMeta = isRecord(statusResult) && Array.isArray(statusResult.channelMeta)
    ? statusResult.channelMeta.filter(isRecord)
    : [];
  const gatewayLabels = new Map<string, string>();
  for (const meta of channelMeta) {
    const id = toStr(meta.id);
    const label = toStr(meta.label);
    if (id && label) gatewayLabels.set(id, label);
  }

  // The channel list is derived, not hardcoded: everything the gateway reports
  // (channelMeta + runtime status), everything present in config, plus the
  // channels Mission Control ships setup metadata for.
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (raw: unknown) => {
    const id = toStr(raw)?.trim().toLowerCase();
    if (!id || !VALID_CHANNEL_ID.test(id) || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of Object.keys(CHANNEL_SETUP)) push(id);
  for (const meta of channelMeta) push(meta.id);
  for (const id of Object.keys(statusChannels)) push(id);
  for (const id of Object.keys(statusAccounts)) push(id);
  for (const id of Object.keys(channelsConfig)) {
    if (isRecord(channelsConfig[id])) push(id);
  }

  const channels = ids.map((id) => {
    const managed = id in CHANNEL_SETUP;
    const ch = CHANNEL_SETUP[id] ?? genericSetupMeta(id, gatewayLabels.get(id));
    const conf = isRecord(channelsConfig[id]) ? (channelsConfig[id] as Record<string, unknown>) : null;
    const accountRows = Array.isArray(statusAccounts[id])
      ? (statusAccounts[id] as unknown[]).filter(isRecord)
      : [];
    const chStatus = isRecord(statusChannels[id]) ? (statusChannels[id] as Record<string, unknown>) : null;

    const statuses = accountRows.map((r) => {
      const account = toStr(r.accountId) || "default";
      const connected = r.running === true || r.connected === true || r.linked === true;
      const status =
        toStr(r.status) ||
        (connected ? "connected" : r.configured === true ? "configured" : "stopped");
      const error = toStr(r.lastError);
      return {
        channel: id,
        account,
        status,
        linked: r.linked === true ? true : undefined,
        connected: connected ? true : undefined,
        error,
      };
    });

    if (statuses.length === 0 && isRecord(chStatus)) {
      const connected = chStatus.running === true || chStatus.connected === true;
      statuses.push({
        channel: id,
        account: "default",
        status: connected ? "connected" : chStatus.configured === true ? "configured" : "stopped",
        linked: undefined,
        connected: connected ? true : undefined,
        error: toStr(chStatus.lastError),
      });
    }

    const connected = statuses.some((row) => row.connected === true) || chStatus?.running === true;
    const hasToken = conf ? Boolean(conf.botToken || conf.token) : false;
    const enabled = conf ? conf.enabled !== false : false;
    const configured = enabled && (
      hasToken ||
      connected ||
      accountRows.some((r) => r.configured === true) ||
      chStatus?.configured === true ||
      statuses.length > 0
    );
    const error = statuses.find((r) => typeof r.error === "string" && r.error.trim())?.error;
    const accounts = accountRows.map((r) => toStr(r.accountId) || "default");
    const botUsername =
      accountRows
        .map((r) => toStr(r.botUsername) || toStr(r.username))
        .find((value) => Boolean(value && value.trim())) ||
      undefined;

    const setupCommand = ch.setup === "token"
      ? `openclaw channels add --channel ${id} --token <TOKEN>`
      : `openclaw channels login --channel ${id}`;

    return {
      id,
      channel: id,
      label: gatewayLabels.get(id) || ch.label,
      icon: ch.icon,
      setup: ch.setup,
      setupType: ch.setup,
      setupCommand,
      setupHint: ch.hint,
      configHint: "You can reconnect, disconnect, or delete this channel anytime from the Channels page.",
      tokenLabel: ch.tokenLabel,
      tokenPlaceholder: ch.tokenPlaceholder,
      hint: ch.hint,
      docsUrl: ch.docsUrl,
      managed,
      enabled,
      configured,
      connected,
      error,
      dmPolicy: toStr(conf?.dmPolicy),
      groupPolicy: toStr(conf?.groupPolicy),
      accounts: accounts.length > 0 ? accounts : configured ? ["default"] : [],
      botUsername,
      statuses,
    } satisfies ChannelStatus;
  });

  const payload: ChannelsPayload = { channels, gatewayOffline };
  if (gatewayOffline) {
    payload.gatewayError = String(statusError || configError || "Gateway unreachable");
  }
  return payload;
}

/* ── GET /api/channels ── */

export async function GET() {
  try {
    const payload = await buildChannelStatuses();
    return NextResponse.json(payload);
  } catch (err) {
    console.error("Channels GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST /api/channels ── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = String(body.action || "").trim();
    const channel = String(body.channel || "").trim().toLowerCase();

    if (!channel) {
      return NextResponse.json({ error: "channel is required" }, { status: 400 });
    }
    if (!VALID_CHANNEL_ID.test(channel)) {
      return NextResponse.json({ error: `Invalid channel id: ${channel}` }, { status: 400 });
    }

    const meta = CHANNEL_SETUP[channel];
    const tokenKey = meta?.tokenKey || "token";

    switch (action) {
      /* ── Connect (add token) ── */
      case "add":
      case "connect": {
        if (meta && meta.setup !== "token") {
          return NextResponse.json(
            { error: `${meta.label} does not use token setup — follow the ${meta.setup === "qr" ? "QR link" : "CLI"} flow instead.` },
            { status: 400 },
          );
        }
        const token = (body.token as string || "").trim();
        if (!token) {
          return NextResponse.json({ error: "token is required" }, { status: 400 });
        }

        await patchConfig(
          {
            channels: {
              [channel]: {
                enabled: true,
                [tokenKey]: token,
                dmPolicy: (body.dmPolicy as string) || "pairing",
                groupPolicy: (body.groupPolicy as string) || "disabled",
              },
            },
          },
          { restartDelayMs: 2000 },
        );

        return NextResponse.json({ ok: true, message: `${channel} connected.` });
      }

      /* ── Disconnect (remove channel) ── */
      case "disconnect": {
        // Disable and clear credentials
        const clearPatch: Record<string, unknown> = { enabled: false, dmPolicy: "", groupPolicy: "" };
        if (!meta || meta.setup === "token") clearPatch[tokenKey] = "";

        await patchConfig(
          { channels: { [channel]: clearPatch } },
          { restartDelayMs: 2000 },
        );

        return NextResponse.json({ ok: true, message: `${channel} disconnected.` });
      }

      /* ── Delete (fully remove channel from config) ── */
      case "delete": {
        // Remove the entire channel config section
        await patchConfig(
          { channels: { [channel]: null } },
          { restartDelayMs: 2000 },
        );

        return NextResponse.json({ ok: true, message: `${channel} removed from configuration.` });
      }

      /* ── Update policy ── */
      case "set-policy": {
        const patch: Record<string, unknown> = {};
        if (body.dmPolicy) patch.dmPolicy = body.dmPolicy;
        if (body.groupPolicy) patch.groupPolicy = body.groupPolicy;
        if (Object.keys(patch).length === 0) {
          return NextResponse.json({ error: "dmPolicy or groupPolicy required" }, { status: 400 });
        }
        await patchConfig(
          { channels: { [channel]: patch } },
        );
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err) {
    console.error("Channels POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
