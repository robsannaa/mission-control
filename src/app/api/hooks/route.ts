import { NextResponse } from "next/server";
import { runCliJson } from "@/lib/openclaw";
import { patchConfig, fetchConfig } from "@/lib/gateway-config";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { hooksGetQuerySchema, hooksPostSchema } from "@/lib/schemas/automation";

export const dynamic = "force-dynamic";

/* ── Types ────────────────────────────────────────── */

type Hook = {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  enabled: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  events: string[];
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
};

type HooksList = {
  hooks: Hook[];
};

type HooksCheck = {
  summary: {
    total: number;
    eligible: number;
    enabled: number;
    disabled: number;
    missingRequirements: number;
  };
};

type HookDetail = {
  name: string;
  description: string;
  source: string;
  bundled: boolean;
  filePath: string;
  baseDir: string;
  emoji?: string;
  homepage?: string;
  events: string[];
  enabled: boolean;
  eligible: boolean;
  always: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
};

/* ── GET ──────────────────────────────────────────── */

export const GET = withRoute(
  { name: "/api/hooks", querySchema: hooksGetQuerySchema },
  async (request, ctx) => {
  const action = ctx.query.action || "list";

  try {
    if (action === "check") {
      const data = await runCliJson<HooksCheck>(["hooks", "check"]);
      return NextResponse.json(data);
    }

    if (action === "info") {
      const name = ctx.query.name;
      if (!name) return badRequest("name required");
      const data = await runCliJson<HookDetail>(["hooks", "info", name]);
      return NextResponse.json(data);
    }

    // Also fetch the hooks.internal config to know if the system is enabled
    let hooksInternalEnabled = false;
    try {
      const configData = await fetchConfig(8000);
      const hooks = (configData.parsed.hooks || {}) as Record<string, unknown>;
      const internal = (hooks.internal || {}) as Record<string, unknown>;
      hooksInternalEnabled = internal.enabled === true;
    } catch {
      // config not available — assume enabled
      hooksInternalEnabled = true;
    }

    // Default: list all hooks
    const data = await runCliJson<HooksList>(["hooks", "list"]);
    return NextResponse.json({ ...data, hooksInternalEnabled });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Hooks API error");
    if (action === "list") {
      return NextResponse.json({
        hooks: [],
        hooksInternalEnabled: false,
        warning: String(err),
        degraded: true,
      });
    }
    return serverError(String(err));
  }
  },
);

/* ── POST: enable / disable / toggle-system ──── */

export const POST = withRoute(
  { name: "/api/hooks", bodySchema: hooksPostSchema },
  async (request, ctx) => {
  try {
    const body = ctx.body as Record<string, unknown> & { action: string };
    const action = body.action;

    switch (action) {
      case "enable-hook":
      case "disable-hook": {
        const name = body.name as string;
        if (!name) return badRequest("name required");

        const enabling = action === "enable-hook";

        try {
          await patchConfig({
            hooks: {
              internal: {
                entries: {
                  [name]: { enabled: enabling },
                },
              },
            },
          }, { restartDelayMs: 2000 });
          return NextResponse.json({ ok: true, action, name });
        } catch (err) {
          return serverError(String(err));
        }
      }

      case "enable-all": {
        // Enable all hooks: first ensure hooks.internal.enabled = true,
        // then enable each hook by name
        const names = body.names as string[];
        if (!names?.length) return badRequest("names required");

        try {
          const entries: Record<string, { enabled: boolean }> = {};
          for (const name of names) {
            entries[name] = { enabled: true };
          }
          await patchConfig({
            hooks: {
              internal: {
                enabled: true,
                entries,
              },
            },
          }, { restartDelayMs: 2000 });
          return NextResponse.json({ ok: true, action, count: names.length });
        } catch (err) {
          return serverError(String(err));
        }
      }

      case "toggle-system": {
        // Toggle hooks.internal.enabled
        const enabled = body.enabled as boolean;

        try {
          await patchConfig({
            hooks: {
              internal: {
                enabled,
              },
            },
          }, { restartDelayMs: 2000 });
          return NextResponse.json({ ok: true, action, enabled });
        } catch (err) {
          return serverError(String(err));
        }
      }

      case "update-hook-env": {
        // Set per-hook env vars via hooks.internal.entries.<name>.env
        const name = body.name as string;
        const env = body.env as Record<string, string>;
        if (!name || !env) return badRequest("name and env required");

        try {
          await patchConfig({
            hooks: {
              internal: {
                entries: {
                  [name]: { env },
                },
              },
            },
          }, { restartDelayMs: 2000 });
          return NextResponse.json({ ok: true, action, name });
        } catch (err) {
          return serverError(String(err));
        }
      }

      default:
        // Unreachable in practice — hooksPostSchema's discriminated union
        // already rejects any action outside the literal set above.
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, "Hooks POST error");
    return serverError(String(err));
  }
  },
);
