import { NextRequest, NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { patchConfig } from "@/lib/gateway-config";
import { readConfigFile } from "@/lib/paths";

export const dynamic = "force-dynamic";

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/* ── Telegram bot token shape: "<numeric id>:<35-char secret>" ── */
const TELEGRAM_TOKEN_RE = /^\d{5,12}:[A-Za-z0-9_-]{30,64}$/;

type BotInfo = { username: string | null; name: string | null };

async function telegramGetMe(token: string): Promise<BotInfo | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const bot = data?.result;
    if (!bot) return null;
    return {
      username: typeof bot.username === "string" ? bot.username : null,
      name: typeof bot.first_name === "string" ? bot.first_name : null,
    };
  } catch {
    return null;
  }
}

// getMe is rate-limited and the bot identity is stable — cache per token.
let botInfoCache: { token: string; info: BotInfo; fetchedAt: number } | null = null;
const BOT_INFO_TTL_MS = 5 * 60 * 1000;

async function cachedBotInfo(token: string): Promise<BotInfo | null> {
  const now = Date.now();
  if (
    botInfoCache &&
    botInfoCache.token === token &&
    now - botInfoCache.fetchedAt < BOT_INFO_TTL_MS
  ) {
    return botInfoCache.info;
  }
  const info = await telegramGetMe(token);
  if (info) botInfoCache = { token, info, fetchedAt: now };
  return info;
}

async function readTelegramTokenFromConfig(): Promise<string | null> {
  try {
    const config = await readConfigFile();
    const channels = isRecord(config.channels) ? config.channels : {};
    const telegram = isRecord(channels.telegram) ? channels.telegram : {};
    const token = telegram.botToken;
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

/* ── GET /api/onboarding/channel ──
 * Live Telegram status for the wizard's polling loop:
 * configured / running / connected / lastInboundAt plus the bot identity
 * (username + t.me deep link) when a token is on disk. */

export async function GET() {
  try {
    let statusResult: Record<string, unknown> = {};
    try {
      statusResult = await gatewayCall<Record<string, unknown>>("channels.status", {}, 6000);
    } catch {
      // Gateway offline / restarting — report unconfigured rather than erroring
    }

    const channels = isRecord(statusResult.channels) ? statusResult.channels : {};
    const telegram = isRecord(channels.telegram) ? channels.telegram : {};
    const accountsByChannel = isRecord(statusResult.channelAccounts)
      ? statusResult.channelAccounts
      : {};
    const accounts = Array.isArray(accountsByChannel.telegram)
      ? (accountsByChannel.telegram as unknown[]).filter(isRecord)
      : [];
    const account = accounts[0] || null;

    const configured = telegram.configured === true || account?.configured === true;
    const running = telegram.running === true || account?.running === true;
    const connected = account?.connected === true || running;
    const lastInboundAt =
      typeof account?.lastInboundAt === "number" ? account.lastInboundAt : null;
    const lastError =
      typeof telegram.lastError === "string"
        ? telegram.lastError
        : typeof account?.lastError === "string"
          ? account.lastError
          : null;

    let botUsername: string | null = null;
    let botName: string | null = null;
    for (const row of accounts) {
      const candidate = row.botUsername || row.username;
      if (typeof candidate === "string" && candidate.trim()) {
        botUsername = candidate.replace(/^@/, "");
        break;
      }
    }
    if (!botUsername && configured) {
      const token = await readTelegramTokenFromConfig();
      if (token) {
        const info = await cachedBotInfo(token);
        botUsername = info?.username || null;
        botName = info?.name || null;
      }
    }

    return json({
      ok: true,
      channel: "telegram",
      configured,
      running,
      connected,
      lastInboundAt,
      lastError,
      botUsername,
      botName,
      deepLink: botUsername ? `https://t.me/${botUsername}` : null,
    });
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

/* ── POST /api/onboarding/channel ──
 * Actions (dryRun: true validates input shape only — no config writes, no
 * Telegram API calls):
 *   connect  { token }  — verify token via getMe, patch channels.telegram, restart
 *   bot-info { token }  — look up the bot identity for a pasted token */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = String(body.action || "").trim();
    const dryRun = body.dryRun === true;

    switch (action) {
      case "connect": {
        const token = String(body.token || "").trim();
        if (!token) {
          return json({ error: "Bot token is required" }, 400);
        }
        if (!TELEGRAM_TOKEN_RE.test(token)) {
          return json(
            { error: "That does not look like a Telegram bot token (expected 123456789:ABC...)" },
            400,
          );
        }
        if (dryRun) {
          return json({
            ok: true,
            dryRun: true,
            action,
            wouldPatch: {
              channels: { telegram: ["enabled", "botToken", "dmPolicy", "groupPolicy"] },
            },
          });
        }

        // Verify against Telegram before touching config — a bad token would
        // otherwise put the channel into a crash loop.
        const info = await telegramGetMe(token);
        if (!info) {
          return json(
            { ok: false, error: "Telegram rejected this token. Double-check it with @BotFather." },
            400,
          );
        }

        await patchConfig(
          {
            channels: {
              telegram: {
                enabled: true,
                botToken: token,
                dmPolicy: "pairing",
                groupPolicy: "disabled",
              },
            },
          },
          { restartDelayMs: 1500 },
        );

        botInfoCache = { token, info, fetchedAt: Date.now() };
        return json({
          ok: true,
          botUsername: info.username,
          botName: info.name,
          deepLink: info.username ? `https://t.me/${info.username}` : null,
        });
      }

      case "bot-info": {
        const token = String(body.token || "").trim();
        if (!token || !TELEGRAM_TOKEN_RE.test(token)) {
          return json({ error: "A valid bot token is required" }, 400);
        }
        if (dryRun) {
          return json({ ok: true, dryRun: true, action });
        }
        const info = await telegramGetMe(token);
        if (!info) {
          return json({ ok: false, error: "Telegram rejected this token" }, 400);
        }
        return json({
          ok: true,
          botUsername: info.username,
          botName: info.name,
          deepLink: info.username ? `https://t.me/${info.username}` : null,
        });
      }

      default:
        return json({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
