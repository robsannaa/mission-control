import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { withRoute } from "@/lib/api-route";
import { tailscalePostSchema, type TailscalePostInput } from "@/lib/schemas/updates";
import { requireCapability } from "@/lib/capability-probes";

const exec = promisify(execFile);

export const dynamic = "force-dynamic";

type TailscaleStatusJson = {
  Version?: string;
  BackendState?: string;
  Self?: {
    DNSName?: string;
    TailscaleIPs?: string[];
    Online?: boolean;
  };
  Health?: string[];
};

const RUNTIME_ACTIONS: Record<string, string[]> = {
  up: ["up"],
  down: ["down"],
  logout: ["logout"],
  "serve-reset": ["serve", "reset"],
  "funnel-reset": ["funnel", "reset"],
  "serve-status": ["serve", "status"],
  "funnel-status": ["funnel", "status"],
  ip: ["ip"],
  netcheck: ["netcheck"],
  status: ["status"],
};

function parseJsonLoose<T>(text: string): T | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

function normalizeCliText(stdout: string, stderr: string): string {
  const merged = `${stdout || ""}\n${stderr || ""}`;
  return merged
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0 && !line.trim().startsWith("Warning:"))
    .join("\n")
    .trim();
}

function parseUrlsFromStatusText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("http://") || line.startsWith("https://"))
    .map((line) => line.split(" ")[0]);
}

/**
 * Typed error thrown when the `tailscale` binary is not on PATH. Distinguishes
 * "feature unavailable on this host" from generic subprocess failures, so route
 * handlers can return 503 (Service Unavailable) instead of a generic 500.
 *
 * The class lives in src/lib/tailscale.ts (not here) because Next.js typed
 * routes reject any non-handler export from route files.
 */
import { TailscaleNotInstalledError } from "@/lib/tailscale";

async function runTailscale(args: string[], timeout = 12000): Promise<{ stdout: string; stderr: string }> {
  try {
    return await exec("tailscale", args, {
      timeout,
      env: { ...process.env, NO_COLOR: "1" },
    });
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "ENOENT") {
      throw new TailscaleNotInstalledError();
    }
    throw err;
  }
}

function normalizeRunArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0);
}

function formatExecError(err: unknown): string {
  if (err && typeof err === "object") {
    const asRecord = err as { stderr?: string; stdout?: string; message?: string };
    const details = normalizeCliText(asRecord.stdout || "", asRecord.stderr || "");
    if (details) return details;
    if (asRecord.message) return asRecord.message;
  }
  return String(err);
}

export const GET = withRoute({ name: "/api/tailscale" }, async () => {
  const refusal = await requireCapability("tailscaleNetworking");
  if (refusal) return refusal;
  try {
    const ver = await runTailscale(["version"], 6000).catch(() => null);
    if (!ver) {
      return NextResponse.json({
        ok: false,
        installed: false,
        error: "tailscale CLI not found or not runnable",
      });
    }

    const versionText = normalizeCliText(ver.stdout, ver.stderr).split("\n")[0] || null;

    const [statusRaw, serveJsonRaw, serveTextRaw, funnelTextRaw] = await Promise.all([
      runTailscale(["status", "--json"]).catch(() => null),
      runTailscale(["serve", "status", "--json"]).catch(() => null),
      runTailscale(["serve", "status"]).catch(() => null),
      runTailscale(["funnel", "status"]).catch(() => null),
    ]);

    const statusText = statusRaw ? normalizeCliText(statusRaw.stdout, statusRaw.stderr) : "";
    const serveJsonText = serveJsonRaw ? normalizeCliText(serveJsonRaw.stdout, serveJsonRaw.stderr) : "";
    const serveText = serveTextRaw ? normalizeCliText(serveTextRaw.stdout, serveTextRaw.stderr) : "";
    const funnelText = funnelTextRaw ? normalizeCliText(funnelTextRaw.stdout, funnelTextRaw.stderr) : "";

    const status = parseJsonLoose<TailscaleStatusJson>(statusText);
    const serveJson = parseJsonLoose<Record<string, unknown>>(serveJsonText) || {};

    const backendState = status?.BackendState || null;
    const connected = backendState === "Running";
    const dnsName = status?.Self?.DNSName?.replace(/\.$/, "") || null;
    const tailscaleIps = Array.isArray(status?.Self?.TailscaleIPs)
      ? (status?.Self?.TailscaleIPs as string[])
      : [];

    const web = serveJson.Web && typeof serveJson.Web === "object"
      ? (serveJson.Web as Record<string, unknown>)
      : {};
    const tcp = serveJson.TCP && typeof serveJson.TCP === "object"
      ? (serveJson.TCP as Record<string, unknown>)
      : {};

    const urls = Array.from(new Set([
      ...parseUrlsFromStatusText(serveText),
      ...parseUrlsFromStatusText(funnelText),
    ]));

    const serveConfigured =
      Object.keys(web).length > 0 ||
      Object.keys(tcp).length > 0 ||
      serveText.includes("|--") ||
      urls.length > 0;

    const funnelPublic = funnelText.includes("(public)");
    const tailnetOnly = serveText.includes("(tailnet only)") || funnelText.includes("(tailnet only)");

    return NextResponse.json({
      ok: true,
      installed: true,
      version: versionText,
      connected,
      backendState,
      dnsName,
      tailscaleIps,
      health: Array.isArray(status?.Health) ? status?.Health : [],
      serveConfigured,
      funnelPublic,
      tailnetOnly,
      urls,
      hasServeWebHandlers: Object.keys(web).length > 0,
      hasServeTcpHandlers: Object.keys(tcp).length > 0,
    });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      installed: true,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Schema-enumerated (T-02-57): `action` is validated against the exact set
 * of runtime actions this route recognizes (plus the free-form "run"
 * action) before this handler runs, so the route's former "Action is
 * required" / `Unknown action: <value>` fallback branches are unreachable
 * and have been removed — an unrecognized action can no longer fall through
 * to a branch that changes how reachable the instance is.
 */
export const POST = withRoute<TailscalePostInput>(
  { name: "/api/tailscale", bodySchema: tailscalePostSchema },
  async (_request, ctx) => {
  const refusal = await requireCapability("tailscaleNetworking");
  if (refusal) return refusal;
  try {
    const { action } = ctx.body;

    if (action === "run") {
      const args = normalizeRunArgs(ctx.body.args);
      if (args.length === 0) {
        return NextResponse.json(
          { ok: false, error: "args[] is required for action=run" },
          { status: 400 }
        );
      }
      if (args.some((arg) => arg.length > 160 || /[\0\r\n]/.test(arg))) {
        return NextResponse.json(
          { ok: false, error: "Invalid tailscale args" },
          { status: 400 }
        );
      }
      try {
        const out = await runTailscale(args, 30000);
        return NextResponse.json({
          ok: true,
          action,
          args,
          output: normalizeCliText(out.stdout, out.stderr),
        });
      } catch (err) {
        return NextResponse.json(
          {
            ok: false,
            action,
            args,
            error: formatExecError(err),
          },
          { status: 500 }
        );
      }
    }

    const args = RUNTIME_ACTIONS[action];

    try {
      const timeout = action === "netcheck" ? 25000 : 15000;
      const out = await runTailscale(args, timeout);
      return NextResponse.json({
        ok: true,
        action,
        args,
        output: normalizeCliText(out.stdout, out.stderr),
      });
    } catch (err) {
      // Bug fix 2026-08-16: distinguish "tailscale not installed" (503) from
      // other subprocess failures (500).
      const status = err instanceof TailscaleNotInstalledError ? 503 : 500;
      return NextResponse.json(
        {
          ok: false,
          action,
          args,
          error: formatExecError(err),
        },
        { status }
      );
    }
  } catch (err) {
    const status = err instanceof TailscaleNotInstalledError ? 503 : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status }
    );
  }
  },
);
