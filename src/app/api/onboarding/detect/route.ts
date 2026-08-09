import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { gatewayCall } from "@/lib/openclaw";
import { getOpenClawBin, getGatewayUrl } from "@/lib/paths";
import { probeGatewayLiveness } from "@/lib/gateway-liveness";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

/* ── Detect payload ── */

type DetectPayload = {
  installed: boolean;
  binPath: string | null;
  cliVersion: string | null;
  running: boolean;
  healthy: boolean;
  url: string;
  port: number;
  checkedAt: string;
};

// CLI version is stable for the lifetime of the server process — cache it so
// the auto-refreshing detect poll doesn't spawn a subprocess every few seconds.
let cliVersionCache: { binPath: string; version: string | null } | null = null;

async function readCliVersion(binPath: string): Promise<string | null> {
  if (cliVersionCache && cliVersionCache.binPath === binPath) {
    return cliVersionCache.version;
  }
  try {
    const { stdout } = await exec(binPath, ["--version"], {
      timeout: 10000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    // Output looks like: "OpenClaw 2026.7.1-2 (0790d9f)"
    const match = stdout.match(/(\d{4}\.\d+\.\d+(?:-\d+)?)/);
    const version = match ? match[1] : stdout.trim().split("\n").pop()?.trim() || null;
    cliVersionCache = { binPath, version };
    return version;
  } catch {
    return null;
  }
}

async function buildDetectPayload(): Promise<DetectPayload> {
  let binPath: string | null = null;
  try {
    binPath = await getOpenClawBin();
  } catch {
    binPath = null;
  }

  const url = await getGatewayUrl();
  const port = parseInt(new URL(url).port, 10) || 18789;

  const [cliVersion, running] = await Promise.all([
    binPath ? readCliVersion(binPath) : Promise.resolve(null),
    probeGatewayLiveness(url),
  ]);

  // When the HTTP endpoint is up, confirm the RPC layer answers too.
  let healthy = false;
  if (running) {
    try {
      const health = await gatewayCall<{ ok?: boolean }>("health", {}, 8000);
      healthy = health?.ok === true;
    } catch {
      healthy = false;
    }
  }

  return {
    installed: Boolean(binPath),
    binPath,
    cliVersion,
    running,
    healthy,
    url,
    port,
    checkedAt: new Date().toISOString(),
  };
}

/* ── GET /api/onboarding/detect ── */

export async function GET() {
  try {
    const payload = await buildDetectPayload();
    return json(payload);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}

/* ── POST /api/onboarding/detect ──
 * Actions:
 *   start — start the gateway via the service manager (openclaw gateway start).
 *           Pass dryRun: true to preview the command without executing it. */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = String(body.action || "").trim();

    if (action !== "start") {
      return json({ error: `Unknown action: ${action}` }, 400);
    }

    let binPath: string | null = null;
    try {
      binPath = await getOpenClawBin();
    } catch {
      binPath = null;
    }
    if (!binPath) {
      return json({ error: "OpenClaw CLI not found on this machine" }, 409);
    }

    if (body.dryRun === true) {
      return json({
        ok: true,
        dryRun: true,
        action: "start",
        command: `${binPath} gateway start`,
      });
    }

    try {
      const { stdout, stderr } = await exec(binPath, ["gateway", "start"], {
        timeout: 30000,
        env: { ...process.env, NO_COLOR: "1", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
      });

      // Poll for liveness so the caller gets a definitive answer.
      const url = await getGatewayUrl();
      let running = false;
      for (let i = 0; i < 10 && !running; i++) {
        running = await probeGatewayLiveness(url);
        if (!running) await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      return json({
        ok: true,
        action: "start",
        running,
        output: `${stdout}\n${stderr}`.trim(),
      });
    } catch (err) {
      return json({ ok: false, error: `Gateway start failed: ${String(err)}` }, 500);
    }
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
}
