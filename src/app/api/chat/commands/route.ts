import { NextResponse } from "next/server";
import { gatewayCall } from "@/lib/openclaw";
import { pairingRequiredResponse } from "@/lib/gateway-errors";
import { withRoute } from "@/lib/api-route";
import { apiError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/**
 * The `/` menu's catalogue.
 *
 * Verified live: `commands.list` returns 124 entries on this install, each with
 * `name`, `nativeName`, `textAliases` (["/help"]), `description`, `category`
 * (status | tools | management | media | session | options | docks, plus a few
 * with none), `source` (native | skill | plugin), `scope` (both | text) and
 * `acceptsArgs`, with an optional `args[]` carrying names, descriptions and
 * choices. The menu is built from this and nothing else — an invented command
 * is a command that silently goes to the model as prose.
 */

export type SlashCommandArg = {
  name: string;
  description?: string;
  type?: string;
  choices?: string[];
};

export type SlashCommand = {
  name: string;
  /** What the composer inserts, always including the leading slash. */
  trigger: string;
  aliases: string[];
  description: string;
  category: string;
  source: string;
  acceptsArgs: boolean;
  args: SlashCommandArg[];
};

type RawCommand = {
  name?: unknown;
  nativeName?: unknown;
  textAliases?: unknown;
  description?: unknown;
  category?: unknown;
  source?: unknown;
  scope?: unknown;
  acceptsArgs?: unknown;
  args?: unknown;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; commands: SlashCommand[] } | null = null;

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeArgs(value: unknown): SlashCommandArg[] {
  if (!Array.isArray(value)) return [];
  const out: SlashCommandArg[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const arg = raw as Record<string, unknown>;
    const name = str(arg.name);
    if (!name) continue;
    const choices = Array.isArray(arg.choices)
      ? arg.choices
          .map((choice) =>
            choice && typeof choice === "object"
              ? str((choice as Record<string, unknown>).value)
              : str(choice),
          )
          .filter(Boolean)
      : [];
    out.push({
      name,
      description: str(arg.description) || undefined,
      type: str(arg.type) || undefined,
      ...(choices.length ? { choices } : {}),
    });
  }
  return out;
}

function normalize(raw: RawCommand): SlashCommand | null {
  const name = str(raw.name) || str(raw.nativeName);
  if (!name) return null;
  const aliases = Array.isArray(raw.textAliases)
    ? raw.textAliases.map((alias) => str(alias)).filter(Boolean)
    : [];
  const trigger = aliases.find((alias) => alias.startsWith("/")) ?? `/${name}`;
  return {
    name,
    trigger,
    aliases,
    description: str(raw.description),
    // A handful of commands ship without a category; "other" keeps them
    // reachable instead of dropping them from the menu.
    category: str(raw.category, "other"),
    source: str(raw.source, "native"),
    acceptsArgs: raw.acceptsArgs === true,
    args: normalizeArgs(raw.args),
  };
}

export const GET = withRoute({ name: "/api/chat/commands" }, async (_request, ctx) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return NextResponse.json(
      { commands: cache.commands, cached: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const data = await gatewayCall<{ commands?: RawCommand[] }>(
      "commands.list",
      {},
      12_000,
    );
    const commands = (Array.isArray(data.commands) ? data.commands : [])
      .map(normalize)
      .filter((command): command is SlashCommand => command !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    cache = { at: Date.now(), commands };
    return NextResponse.json(
      { commands, cached: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    const pairing = pairingRequiredResponse(err);
    if (pairing) return pairing;
    ctx.log.error({ err }, "chat/commands failed");
    // Serve a stale catalogue rather than an empty menu when the gateway blips.
    if (cache) {
      return NextResponse.json(
        { commands: cache.commands, cached: true, stale: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return apiError("Could not load the command list from the gateway.", 502);
  }
});
