import { NextResponse } from "next/server";
import { runCliCaptureBoth, gatewayCall } from "@/lib/openclaw";
import { gatewayConfigPatch } from "@/lib/gateway-config";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { settingsPostSchema, type SettingsPostInput } from "@/lib/schemas/updates";

export const dynamic = "force-dynamic";

/* ── GET: read current settings ───────────────── */

export const GET = withRoute({ name: "/api/settings" }, async (_request, ctx) => {
  try {
    // Fetch the full config to extract settings-relevant fields
    let timezone = "";
    let configHash = "";

    try {
      const configData = await gatewayCall<Record<string, unknown>>(
        "config.get",
        undefined,
        8000,
      );
      configHash = (configData.hash as string) || "";
      const parsed = (configData.parsed || {}) as Record<string, unknown>;

      // Look for timezone in settings.timezone or heartbeat activeHours
      const settings = (parsed.settings || {}) as Record<string, unknown>;
      timezone = (settings.timezone as string) || "";

      if (!timezone) {
        const heartbeat = (parsed.heartbeat || {}) as Record<string, unknown>;
        const activeHours = (heartbeat.activeHours || {}) as Record<string, unknown>;
        timezone = (activeHours.timezone as string) || "";
      }
    } catch {
      // Config not available
    }

    return NextResponse.json({
      timezone,
      configHash,
    });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? { message: err.message } : String(err) }, "Settings GET error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
});

/* ── POST: perform settings actions ───────────── */

type ResetScope = "config" | "credentials" | "sessions" | "all";

const VALID_SCOPES: ResetScope[] = ["config", "credentials", "sessions", "all"];

const SCOPE_CLI_MAP: Record<ResetScope, string[]> = {
  config: ["reset", "--scope", "config", "--yes"],
  credentials: ["reset", "--scope", "creds", "--yes"],
  sessions: ["reset", "--scope", "sessions", "--yes"],
  all: ["reset", "--yes"],
};

const SCOPE_DRY_RUN_MAP: Record<ResetScope, string[]> = {
  config: ["reset", "--scope", "config", "--dry-run"],
  credentials: ["reset", "--scope", "creds", "--dry-run"],
  sessions: ["reset", "--scope", "sessions", "--dry-run"],
  all: ["reset", "--dry-run"],
};

export const POST = withRoute<SettingsPostInput>(
  { name: "/api/settings", bodySchema: settingsPostSchema },
  async (_request, ctx) => {
  try {
    const body = ctx.body;
    const action = body.action as string;

    switch (action) {
      /* ── Set timezone ───────────────────────────── */
      case "set-timezone": {
        const tz = (body as Record<string, unknown>).timezone as string;
        if (!tz || typeof tz !== "string") {
          return badRequest("timezone required");
        }

        // Validate timezone is a plausible IANA string
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
        } catch {
          return badRequest(`Invalid timezone: ${tz}`);
        }

        try {
          const configData = await gatewayCall<Record<string, unknown>>(
            "config.get",
            undefined,
            8000,
          );
          const hash = configData.hash as string;

          const patch = {
            settings: { timezone: tz },
          };

          await gatewayConfigPatch(
            {
              raw: JSON.stringify(patch),
              baseHash: hash,
            },
            10000,
          );
          return NextResponse.json({ ok: true, action, timezone: tz });
        } catch (err) {
          return serverError(err instanceof Error ? err.message : String(err));
        }
      }

      /* ── Reset preview (dry-run) ────────────────── */
      case "reset-preview": {
        const scope = (body as Record<string, unknown>).scope as ResetScope;
        if (!scope || !VALID_SCOPES.includes(scope)) {
          return badRequest(`Invalid scope. Must be one of: ${VALID_SCOPES.join(", ")}`);
        }

        try {
          const args = SCOPE_DRY_RUN_MAP[scope];
          const { stdout, stderr } = await runCliCaptureBoth(args, 15000);
          return NextResponse.json({
            ok: true,
            action,
            scope,
            dryRun: true,
            output: stdout || stderr || "No output (nothing to reset).",
          });
        } catch (err) {
          return NextResponse.json({
            ok: false,
            action,
            scope,
            dryRun: true,
            output: String(err),
          });
        }
      }

      /* ── Reset execute ──────────────────────────── */
      case "reset-execute": {
        const scope = (body as Record<string, unknown>).scope as ResetScope;
        if (!scope || !VALID_SCOPES.includes(scope)) {
          return badRequest(`Invalid scope. Must be one of: ${VALID_SCOPES.join(", ")}`);
        }

        try {
          const args = SCOPE_CLI_MAP[scope];
          const { stdout, stderr } = await runCliCaptureBoth(args, 30000);
          return NextResponse.json({
            ok: true,
            action,
            scope,
            output: stdout || stderr || "Reset complete.",
          });
        } catch (err) {
          return NextResponse.json({
            ok: false,
            action,
            scope,
            error: String(err),
          }, { status: 500 });
        }
      }

      /* ── Restart gateway ────────────────────────── */
      case "restart-gateway": {
        try {
          await gatewayCall("gateway.restart", undefined, 15000);
          return NextResponse.json({ ok: true, action });
        } catch (err) {
          return serverError(err instanceof Error ? err.message : String(err));
        }
      }

      default:
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? { message: err.message } : String(err) }, "Settings POST error");
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);
