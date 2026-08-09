import { NextRequest, NextResponse } from "next/server";
import { runCliCaptureBoth, gatewayCall, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import { gatewayConfigPatch } from "@/lib/gateway-config";

export const dynamic = "force-dynamic";

/* ── GET: read current settings ───────────────── */

export async function GET() {
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

      // Timezone lives at `agents.defaults.envelopeTimezone`. Neither `settings`
      // nor a root `heartbeat` is a valid config key — `settings` is not in the
      // schema at all, and heartbeat is nested under `agents.defaults` — so the
      // old lookups could never match anything a gateway would accept.
      const agents = (parsed.agents || {}) as Record<string, unknown>;
      const defaults = (agents.defaults || {}) as Record<string, unknown>;
      timezone = (defaults.envelopeTimezone as string) || "";

      if (!timezone) {
        const heartbeat = (defaults.heartbeat || {}) as Record<string, unknown>;
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
    console.error("Settings GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

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

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      /* ── Set timezone ───────────────────────────── */
      case "set-timezone": {
        const tz = body.timezone as string;
        if (!tz || typeof tz !== "string") {
          return NextResponse.json({ error: "timezone required" }, { status: 400 });
        }

        // Validate timezone is a plausible IANA string
        try {
          Intl.DateTimeFormat(undefined, { timeZone: tz });
        } catch {
          return NextResponse.json({ error: `Invalid timezone: ${tz}` }, { status: 400 });
        }

        try {
          const configData = await gatewayCall<Record<string, unknown>>(
            "config.get",
            undefined,
            8000,
          );
          const hash = configData.hash as string;

          const patch = {
            agents: { defaults: { envelopeTimezone: tz } },
          };

          await gatewayConfigPatch(
            {
              raw: JSON.stringify(patch),
              baseHash: hash,
            },
            CONFIG_WRITE_TIMEOUT_MS,
          );
          return NextResponse.json({ ok: true, action, timezone: tz });
        } catch (err) {
          return NextResponse.json({ error: String(err) }, { status: 500 });
        }
      }

      /* ── Reset preview (dry-run) ────────────────── */
      case "reset-preview": {
        const scope = body.scope as ResetScope;
        if (!scope || !VALID_SCOPES.includes(scope)) {
          return NextResponse.json(
            { error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(", ")}` },
            { status: 400 },
          );
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
        const scope = body.scope as ResetScope;
        if (!scope || !VALID_SCOPES.includes(scope)) {
          return NextResponse.json(
            { error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(", ")}` },
            { status: 400 },
          );
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
          const res = await fetch(
            `${process.env.NEXT_PUBLIC_GATEWAY_URL || "http://localhost:18789"}/api/gateway`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "restart" }),
            },
          );
          if (!res.ok) throw new Error(`Gateway restart returned ${res.status}`);
          return NextResponse.json({ ok: true, action });
        } catch {
          // Fallback: try via internal API
          try {
            await gatewayCall("gateway.restart", undefined, 15000);
            return NextResponse.json({ ok: true, action, viaCli: true });
          } catch (err) {
            return NextResponse.json({ error: String(err) }, { status: 500 });
          }
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 },
        );
    }
  } catch (err) {
    console.error("Settings POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
