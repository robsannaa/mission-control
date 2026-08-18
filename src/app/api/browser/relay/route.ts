import { NextRequest, NextResponse } from "next/server";
import { access, readFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getGatewayPort, getOpenClawHome } from "@/lib/paths";
import { runCliJson } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { apiError, badRequest } from "@/lib/api-errors";
import {
  BROWSER_RELAY_DEFAULT_TEST_URL,
  browserRelayGetQuerySchema,
  browserRelayPostSchema,
} from "@/lib/schemas/system";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// Simple in-memory rate limiter: max 30 requests per 10 seconds per IP
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 10_000;
const RATE_LIMIT_MAX = 30;

function checkRateLimit(request: NextRequest): NextResponse | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return null;
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    const response = apiError("Too many requests. Please wait a moment and try again.", 429);
    response.headers.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
    return response;
  }
  return null;
}

// Clean up stale entries every 60 seconds
if (typeof globalThis !== "undefined") {
  const cleanup = () => {
    const now = Date.now();
    rateLimitMap.forEach((entry, key) => {
      if (now > entry.resetAt) rateLimitMap.delete(key);
    });
  };
  setInterval(cleanup, 60_000);
}

type BrowserStatus = {
  enabled?: boolean;
  profile?: string;
  running?: boolean;
  cdpReady?: boolean;
  cdpHttp?: boolean;
  pid?: number | null;
  cdpPort?: number;
  cdpUrl?: string;
  chosenBrowser?: string | null;
  detectedBrowser?: string | null;
  detectedExecutablePath?: string | null;
  detectError?: string | null;
  userDataDir?: string | null;
  color?: string;
  headless?: boolean;
  noSandbox?: boolean;
  executablePath?: string | null;
  attachOnly?: boolean;
};

type BrowserProfiles = {
  profiles?: Array<{
    name: string;
    cdpPort?: number;
    cdpUrl?: string;
    color?: string;
    running?: boolean;
    tabCount?: number;
    isDefault?: boolean;
    isRemote?: boolean;
  }>;
};

type BrowserTabs = {
  tabs?: Array<Record<string, unknown>>;
};

type RelaySnapshot = {
  status: BrowserStatus | null;
  profiles: BrowserProfiles["profiles"];
  tabs: BrowserTabs["tabs"];
  extension: {
    path: string | null;
    resolvedPath: string | null;
    manifestPath: string | null;
    installed: boolean;
    manifestName: string | null;
    manifestVersion: string | null;
    error: string | null;
  };
  health: {
    installed: boolean;
    running: boolean;
    cdpReady: boolean;
    tabConnected: boolean;
    relayReady: boolean;
  };
  errors: {
    status: string | null;
    profiles: string | null;
    tabs: string | null;
  };
};

function parseError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseExtensionPath(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("~") || line.startsWith("/") || /^[A-Za-z]:\\/.test(line)) {
      return line;
    }
  }
  return lines[0] || null;
}

function expandHome(pathValue: string | null): string | null {
  if (!pathValue) return null;
  if (pathValue === "~") return homedir();
  if (pathValue.startsWith("~/")) return join(homedir(), pathValue.slice(2));
  return pathValue;
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the browser control server URL.
 * The browser control HTTP API runs on gateway port + 2 (e.g. 18789 → 18791).
 */
let _browserControlUrl: string | null = null;
async function getBrowserControlUrl(): Promise<string> {
  if (_browserControlUrl) return _browserControlUrl;
  const gwPort = await getGatewayPort();
  _browserControlUrl = `http://127.0.0.1:${gwPort + 2}`;
  return _browserControlUrl;
}

async function getBrowserAuthHeaders(): Promise<Record<string, string>> {
  try {
    const configPath = join(getOpenClawHome(), "openclaw.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as { gateway?: { auth?: { token?: string } } };
    const token = config?.gateway?.auth?.token;
    if (token) return { Authorization: `Bearer ${token}` };
  } catch {
    // no config or no token
  }
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (envToken) return { Authorization: `Bearer ${envToken}` };
  return {};
}

/**
 * Map route.ts paths to browser control server paths.
 * The browser control server has its own path layout:
 * - /browser/status  → /           (root returns status)
 * - /browser/profiles → /profiles
 * - /browser/tabs    → /tabs
 * - /browser/start   → POST /start
 * - /browser/stop    → POST /stop
 * - /browser/snapshot → /snapshot
 * - /browser/screenshot → POST /screenshot
 * - /browser/extension/* → not available on browser control server
 */
function toBrowserControlPath(path: string): string {
  const stripped = path.replace(/^\/browser/, "");
  if (stripped === "/status" || stripped === "") return "/";
  return stripped;
}

async function browserGet<T>(path: string, profile: string | null, timeout = 12000): Promise<T> {
  const baseUrl = await getBrowserControlUrl();
  const authHeaders = await getBrowserAuthHeaders();
  const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
  const controlPath = toBrowserControlPath(path);
  const res = await fetch(`${baseUrl}${controlPath}${qs}`, {
    headers: { ...authHeaders },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

async function browserPost<T>(path: string, body: Record<string, unknown>, timeout = 15000): Promise<T> {
  const baseUrl = await getBrowserControlUrl();
  const authHeaders = await getBrowserAuthHeaders();
  const controlPath = toBrowserControlPath(path);
  const res = await fetch(`${baseUrl}${controlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`POST ${path} ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json() as Promise<T>;
}

function sanitizeProfile(value: string | null): string | null {
  const v = (value || "").trim();
  if (!v) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v)) return null;
  return v;
}

type ExtensionPathResponse = {
  path?: string;
  installed?: boolean;
  manifestName?: string;
  manifestVersion?: string;
};

async function buildSnapshot(profile: string | null): Promise<RelaySnapshot> {
  const statusP = browserGet<BrowserStatus>("/browser/status", profile)
    .then((value) => ({ value, error: null as string | null }))
    .catch((err) => ({ value: null, error: parseError(err) }));
  const profilesP = browserGet<BrowserProfiles>("/browser/profiles", null)
    .then((value) => ({ value, error: null as string | null }))
    .catch((err) => ({ value: null, error: parseError(err) }));
  const tabsP = browserGet<BrowserTabs>("/browser/tabs", profile)
    .then((value) => ({ value, error: null as string | null }))
    .catch((err) => ({ value: null, error: parseError(err) }));
  // Extension path is CLI-only (not on browser control server)
  const extensionPathP = runCliJson<ExtensionPathResponse>(["browser", "extension", "path"], 10000)
    .then((value) => ({ value: value as ExtensionPathResponse | string, error: null as string | null }))
    .catch((err) => ({ value: null, error: parseError(err) }));

  const [statusR, profilesR, tabsR, extensionPathR] = await Promise.all([
    statusP,
    profilesP,
    tabsP,
    extensionPathP,
  ]);

  let extensionPath: string | null = null;
  let resolvedPath: string | null = null;
  let manifestPath: string | null = null;
  let installed = false;
  let manifestName: string | null = null;
  let manifestVersion: string | null = null;
  let extensionError: string | null = extensionPathR.error;

  const extData = extensionPathR.value;
  if (extData && typeof extData === "object" && "path" in extData) {
    // Structured response from gateway
    extensionPath = extData.path || null;
    installed = Boolean(extData.installed);
    manifestName = extData.manifestName || null;
    manifestVersion = extData.manifestVersion || null;
    resolvedPath = expandHome(extensionPath);
    manifestPath = resolvedPath ? join(resolvedPath, "manifest.json") : null;
  } else {
    // Fallback: plain text response (self-hosted backward compat)
    const raw = typeof extData === "string" ? extData : "";
    extensionPath = parseExtensionPath(raw);
    resolvedPath = expandHome(extensionPath);
    manifestPath = resolvedPath ? join(resolvedPath, "manifest.json") : null;

    if (resolvedPath) {
      installed = await pathExists(resolvedPath);
    }

    if (installed && manifestPath) {
      try {
        const raw = await readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw) as { name?: string; version?: string };
        manifestName = manifest.name || null;
        manifestVersion = manifest.version || null;
      } catch (err) {
        extensionError = extensionError || parseError(err);
      }
    }
  }

  const status = statusR.value;
  const tabs = tabsR.value?.tabs || [];
  const running = Boolean(status?.running);
  const cdpReady = Boolean(status?.cdpReady && status?.cdpHttp);
  const tabConnected = tabs.length > 0;

  return {
    status,
    profiles: profilesR.value?.profiles || [],
    tabs,
    extension: {
      path: extensionPath,
      resolvedPath,
      manifestPath,
      installed,
      manifestName,
      manifestVersion,
      error: extensionError,
    },
    health: {
      installed,
      running,
      cdpReady,
      tabConnected,
      relayReady: installed && running && cdpReady && tabConnected,
    },
    errors: {
      status: statusR.error,
      profiles: profilesR.error,
      tabs: tabsR.error,
    },
  };
}

export const GET = withRoute(
  { name: "/api/browser/relay", querySchema: browserRelayGetQuerySchema },
  async (request, { query }) => {
    const rateLimited = checkRateLimit(request);
    if (rateLimited) return rateLimited;
    const profile = sanitizeProfile(query.profile ?? null);
    const snapshot = await buildSnapshot(profile);
    return NextResponse.json({
      ok: true,
      profile,
      snapshot,
      docsUrl: "https://docs.openclaw.ai/tools/browser#chrome-extension-relay-use-your-existing-chrome",
    });
  },
);

/**
 * POST /api/browser/relay — browser control actions (start/stop/restart,
 * extension install, test navigation, screenshot).
 *
 * `browserRelayPostSchema` rejects a caller-supplied "open-test-tab"
 * forwarding target that isn't an absolute http(s) URL before this handler
 * ever runs (T-02-45), so no outbound request is attempted for a bad
 * target — the format/protocol checks that used to live inline in that case
 * arm now live in the schema (byte-identical messages).
 *
 * The generic catch below builds its error body by hand (not through an
 * `@/lib/api-errors` builder) because it enriches the response with a
 * best-effort `snapshot` alongside `error` — the same extra-top-level-field
 * exception already accepted in this phase for response shapes the builders
 * have no slot for (see 02-04-SUMMARY.md). The body still carries
 * `ok: false`, satisfying D-01.
 */
export const POST = withRoute(
  { name: "/api/browser/relay", bodySchema: browserRelayPostSchema },
  async (request, { body }) => {
    const rateLimited = checkRateLimit(request);
    if (rateLimited) return rateLimited;

    const action = String(body.action || "").trim();
    const profile = sanitizeProfile(body.profile || null);
    if (!action) {
      return badRequest("Action is required");
    }

    try {
      let result: Record<string, unknown> = {};
      switch (action) {
        case "start": {
          result = await browserPost<Record<string, unknown>>("/browser/start", { profile });
          break;
        }
        case "stop": {
          result = await browserPost<Record<string, unknown>>("/browser/stop", { profile });
          break;
        }
        case "restart": {
          await browserPost("/browser/stop", { profile }).catch(() => ({}));
          result = await browserPost<Record<string, unknown>>("/browser/start", { profile }, 20000);
          break;
        }
        case "install-extension": {
          // Extension install is CLI-only (not on browser control server)
          const installArgs = ["browser", "extension", "install"];
          result = await runCliJson<Record<string, unknown>>(installArgs, 15000);
          break;
        }
        case "open-test-tab": {
          // URL format/protocol already validated by browserRelayPostSchema.
          const targetUrl = (body.url || "").trim() || BROWSER_RELAY_DEFAULT_TEST_URL;
          // 'open' is CLI-only (not on browser control server)
          const openArgs = ["browser", "open", targetUrl];
          if (profile) openArgs.push("--browser-profile", profile);
          result = await runCliJson<Record<string, unknown>>(openArgs, 20000);
          break;
        }
        case "snapshot-test": {
          // Snapshot is GET-only on the browser control server
          result = await browserGet<Record<string, unknown>>(
            "/browser/snapshot",
            profile,
            25000
          );
          break;
        }
        case "screenshot": {
          const baseUrl = await getBrowserControlUrl();
          const authHeaders = await getBrowserAuthHeaders();
          const screenshotRes = await fetch(`${baseUrl}/screenshot`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ profile, format: "png", fullPage: false }),
            signal: AbortSignal.timeout(15000),
          });
          if (!screenshotRes.ok) {
            throw new Error(`Screenshot failed: ${screenshotRes.status}`);
          }
          const contentType = screenshotRes.headers.get("content-type") || "";
          if (contentType.includes("image/")) {
            const buffer = Buffer.from(await screenshotRes.arrayBuffer());
            const base64 = buffer.toString("base64");
            result = { image: `data:image/png;base64,${base64}` };
          } else {
            const data = await screenshotRes.json() as Record<string, unknown>;
            if (data.image && typeof data.image === "string") {
              result = { image: data.image.startsWith("data:") ? data.image : `data:image/png;base64,${data.image}` };
            } else {
              // Gateway returns {ok, path, targetId, url} — read the image from disk
              const imgPath = typeof data.path === "string" ? data.path : null;
              if (imgPath) {
                try {
                  const imgBuffer = await readFile(imgPath);
                  result = { image: `data:image/png;base64,${imgBuffer.toString("base64")}` };
                } catch {
                  result = data;
                }
              } else {
                result = data;
              }
            }
          }
          break;
        }
        default:
          return badRequest(`Unknown action: ${action}`);
      }

      const snapshot = await buildSnapshot(profile);
      return NextResponse.json({ ok: true, action, result, snapshot });
    } catch (err) {
      const snapshot = await buildSnapshot(profile).catch(() => null);
      return NextResponse.json(
        { ok: false, error: parseError(err), snapshot },
        { status: 500 }
      );
    }
  },
);

