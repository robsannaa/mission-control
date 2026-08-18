import { NextResponse } from "next/server";
import { gatewayCall, parseJsonFromCliOutput, runCli, runCliCaptureBoth } from "@/lib/openclaw";
import { getOpenClawHome } from "@/lib/paths";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { withRoute } from "@/lib/api-route";
import { pairingPostSchema } from "@/lib/schemas/onboarding";
import { badRequest, serverError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/* ── Types ────────────────────────────────────────── */

type DmRequest = {
  channel: string;
  code: string;
  account?: string;
  senderId?: string;
  senderName?: string;
  message?: string;
  createdAt?: string;
  expiresAt?: string;
  [key: string]: unknown;
};

type DeviceRequest = {
  requestId: string;
  deviceId?: string;
  displayName?: string;
  platform?: string;
  clientId?: string;
  clientMode?: string;
  role?: string;
  roles?: string[];
  createdAtMs?: number;
  [key: string]: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toIsoString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function normalizeDmRequests(raw: unknown, fallbackChannel?: string): DmRequest[] {
  const out: DmRequest[] = [];
  const topLevelChannel =
    isRecord(raw) && typeof raw.channel === "string" && raw.channel.trim()
      ? raw.channel.trim()
      : undefined;
  const pushRequest = (entry: unknown, localFallbackChannel?: string) => {
    if (!isRecord(entry)) return;
    const codeRaw = entry.code ?? entry.pairingCode;
    const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
    if (!code) return;

    const channelRaw =
      entry.channel ??
      entry.transport ??
      localFallbackChannel ??
      fallbackChannel ??
      topLevelChannel;
    const channel = typeof channelRaw === "string" ? channelRaw.trim() : "";
    if (!channel) return;

    const meta = isRecord(entry.meta) ? entry.meta : {};
    const senderName =
      (typeof entry.senderName === "string" && entry.senderName.trim()) ||
      [meta.firstName, meta.lastName].filter((v): v is string => typeof v === "string" && v.trim().length > 0).join(" ") ||
      (typeof meta.username === "string" ? meta.username : undefined);
    const senderId =
      (typeof entry.senderId === "string" && entry.senderId.trim()) ||
      (typeof entry.id === "string" && entry.id.trim()) ||
      (typeof meta.username === "string" ? meta.username : undefined);
    const account =
      (typeof entry.accountId === "string" && entry.accountId.trim()) ||
      (typeof entry.account === "string" && entry.account.trim()) ||
      (typeof meta.accountId === "string" && meta.accountId.trim()) ||
      undefined;

    out.push({
      ...entry,
      channel,
      code,
      account,
      senderName,
      senderId,
      message: typeof entry.message === "string" ? entry.message : undefined,
      createdAt: toIsoString(entry.createdAt) ?? toIsoString(entry.createdAtMs),
      expiresAt: toIsoString(entry.expiresAt) ?? toIsoString(entry.expiresAtMs),
    });
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) pushRequest(entry);
    return out;
  }

  if (!isRecord(raw)) return out;

  // Common payload shapes across OpenClaw versions.
  const listCandidates: unknown[] = [
    raw.requests,
    raw.pending,
    raw.dm,
    raw.items,
  ];
  for (const candidate of listCandidates) {
    for (const entry of asArray(candidate)) pushRequest(entry, topLevelChannel);
  }

  // Nested buckets: { pending: { dm: [...] } } etc.
  for (const bucketKey of ["pending", "result", "data"] as const) {
    const bucket = raw[bucketKey];
    if (!isRecord(bucket)) continue;
    const bucketChannel =
      typeof bucket.channel === "string" && bucket.channel.trim()
        ? bucket.channel.trim()
        : topLevelChannel;
    for (const nestedKey of ["requests", "dm", "items"] as const) {
      for (const entry of asArray(bucket[nestedKey])) pushRequest(entry, bucketChannel);
    }
  }

  // Single request object fallback.
  pushRequest(raw);

  return out;
}

function dedupeDmRequests(requests: DmRequest[]): DmRequest[] {
  const seen = new Set<string>();
  const out: DmRequest[] = [];
  for (const req of requests) {
    const key = `${req.channel}::${req.account || "default"}::${req.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  return out;
}

/**
 * Channels that can hold pairing requests, with their account ids.
 *
 * `openclaw pairing list` requires a channel: called without one it exits with
 * "Channel required. Use --channel <channel> ...", which every poll wrote to the
 * gateway log as a stack trace. Ask the gateway which channels exist and query
 * each one; multi-account channels are queried per account so the results stay
 * account-aware.
 */
async function listPairingTargets(): Promise<Array<{ channel: string; account?: string }>> {
  const status = await gatewayCall<{
    channels?: Record<string, unknown>;
    channelOrder?: unknown;
    channelAccounts?: Record<string, unknown>;
  }>("channels.status", {}, 8000);

  const channels = new Set<string>();
  for (const key of Object.keys(status?.channels || {})) {
    if (key.trim()) channels.add(key.trim());
  }
  for (const entry of asArray(status?.channelOrder)) {
    if (typeof entry === "string" && entry.trim()) channels.add(entry.trim());
  }

  const targets: Array<{ channel: string; account?: string }> = [];
  for (const channel of channels) {
    const accounts = asArray(status?.channelAccounts?.[channel])
      .map((account) => {
        if (typeof account === "string") return account;
        if (isRecord(account) && typeof account.id === "string") return account.id;
        return "";
      })
      .filter((id) => id.trim().length > 0);
    if (accounts.length > 1) {
      for (const account of accounts) targets.push({ channel, account });
    } else {
      targets.push({ channel });
    }
  }
  return targets;
}

async function listDmRequestsFromCli(): Promise<DmRequest[]> {
  const targets = await listPairingTargets();
  // No channels configured means there is nothing to pair and no valid value
  // for --channel; the filesystem scan still covers leftover pairing files.
  if (targets.length === 0) return [];

  const collected: DmRequest[] = [];
  const failures: string[] = [];

  await Promise.all(
    targets.map(async ({ channel, account }) => {
      const args = ["pairing", "list", "--channel", channel, "--json"];
      if (account) args.push("--account", account);
      const result = await runCliCaptureBoth(args, 10000);
      if (result.code !== 0) {
        failures.push(
          `${channel}${account ? `/${account}` : ""}: ${String(result.stderr || result.stdout || "").trim() || `exit ${result.code}`}`,
        );
        return;
      }
      try {
        const payload = parseJsonFromCliOutput<unknown>(
          result.stdout,
          `openclaw pairing list --channel ${channel} --json`,
        );
        collected.push(...normalizeDmRequests(payload, channel));
      } catch (err) {
        failures.push(`${channel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  // Only fail outright when no channel answered, so one broken channel does not
  // hide pairing requests from the others.
  if (collected.length === 0 && failures.length === targets.length) {
    throw new Error(`pairing list failed for all channels — ${failures.join("; ")}`);
  }
  return dedupeDmRequests(collected);
}

/* ── GET: list all pending requests ──────────────── */

export const GET = withRoute({ name: "/api/pairing" }, async () => {
  const home = getOpenClawHome();
  let dmRequests: DmRequest[] = [];
  const deviceRequests: DeviceRequest[] = [];

  // 1) Preferred: ask OpenClaw CLI directly (supports account-aware pairing).
  try {
    dmRequests = await listDmRequestsFromCli();
  } catch {
    // 2) Fallback: scan credentials pairing files for older/limited environments.
    const scanned: DmRequest[] = [];
    const credDirs = [join(home, "credentials")];
    for (const credDir of credDirs) {
      try {
        const files = await readdir(credDir);
        const pairingFiles = files.filter((f) => f.endsWith("-pairing.json"));
        for (const file of pairingFiles) {
          const channel = file.replace("-pairing.json", "");
          try {
            const raw = await readFile(join(credDir, file), "utf-8");
            const data = JSON.parse(raw) as unknown;
            scanned.push(...normalizeDmRequests(data, channel));
          } catch {
            // File may be empty or malformed
          }
        }
      } catch {
        // credentials dir may not exist
      }
    }
    dmRequests = dedupeDmRequests(scanned);
  }

  // 2. Device pairing requests
  try {
    const data = await gatewayCall<{
      pending: DeviceRequest[];
      paired: unknown[];
    }>("device.pair.list", {}, 8000);
    deviceRequests.push(...(data.pending || []));
  } catch {
    // gateway may be unavailable
  }

  const body = {
    dm: dmRequests,
    devices: deviceRequests,
    total: dmRequests.length + deviceRequests.length,
  };
  return NextResponse.json(body, {
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      Pragma: "no-cache",
    },
  });
});

/* ── POST: approve / reject ──────────────────────── */

export const POST = withRoute(
  { name: "/api/pairing", bodySchema: pairingPostSchema },
  async (_request, ctx) => {
  try {
    const body = ctx.body;
    const action = body.action as string;

    switch (action) {
      case "approve-dm": {
        const channel = body.channel as string;
        const code = body.code as string;
        const account = body.account as string | undefined;
        if (!channel || !code) {
          return badRequest("channel and code required");
        }
        const args = ["pairing", "approve", channel, code];
        if (account && account.trim()) args.push("--account", account.trim());
        args.push("--notify");
        const output = await runCli(
          args,
          10000
        );
        return NextResponse.json({ ok: true, action, channel, code, account, output });
      }

      case "approve-device": {
        const requestId = body.requestId as string;
        if (!requestId) {
          return badRequest("requestId required");
        }
        const result = await gatewayCall<Record<string, unknown>>(
          "device.pair.approve",
          { requestId },
          10000,
        );
        return NextResponse.json({ ok: true, action, requestId, result });
      }

      case "reject-device": {
        const requestId = body.requestId as string;
        if (!requestId) {
          return badRequest("requestId required");
        }
        const result = await gatewayCall<Record<string, unknown>>(
          "device.pair.reject",
          { requestId },
          10000,
        );
        return NextResponse.json({ ok: true, action, requestId, result });
      }

      default:
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err: message }, "Pairing API POST error");
    return serverError(message);
  }
  },
);
