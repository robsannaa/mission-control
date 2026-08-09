/**
 * Self-discovering path resolution for OpenClaw.
 *
 * OPENCLAW_HOME priority:
 *   1. OPENCLAW_HOME env var
 *   2. OPENCLAW_STATE_DIR env var (alias)
 *   3. $HOME/.openclaw
 *
 * Binary path priority:
 *   1. OPENCLAW_BIN env var
 *   2. `which openclaw`
 *   3. Common install locations
 *
 * System skills dir priority:
 *   1. OPENCLAW_SKILLS_DIR env var
 *   2. `npm root -g` + /openclaw/skills
 *   3. Common npm global paths
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { access } from "fs/promises";
import { homedir } from "os";

const exec = promisify(execFile);

// ── OpenClaw home directory ──────────────────────

let _home: string | null = null;

export function getOpenClawHome(): string {
  if (_home) return _home;
  const explicit = process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR;
  if (explicit) {
    // OPENCLAW_HOME points to the user's home (e.g. /root). The actual state
    // directory is $OPENCLAW_HOME/.openclaw/ — append it if not already there.
    _home = explicit.endsWith(".openclaw") ? explicit : join(explicit, ".openclaw");
  } else {
    _home = join(homedir(), ".openclaw");
  }
  return _home;
}

/**
 * Returns the path to openclaw.json config file.
 * Canonical location: $OPENCLAW_HOME/openclaw.json
 */
let _configPath: string | null = null;
export function getConfigPath(): string {
  if (_configPath) return _configPath;
  _configPath = join(getOpenClawHome(), "openclaw.json");
  return _configPath;
}

/**
 * Read the openclaw.json config file.
 */
export async function readConfigFile(): Promise<Record<string, unknown>> {
  const { readFile } = await import("fs/promises");
  const configPath = join(getOpenClawHome(), "openclaw.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return {};
  }
}

// ── Default workspace directory ──────────────────

let _workspace: string | null = null;

let _defaultAgent: { id: string; workspace: string | null } | null = null;

/**
 * Ask the gateway which agent is the default, and where its workspace is.
 *
 * This is the only authoritative source for either. OpenClaw gives each agent
 * its own directory named after the agent id — a stock install's default agent
 * `dev` lives in `$OPENCLAW_HOME/workspace-dev`, not
 * `$OPENCLAW_HOME/workspace` — and the id is not derivable from the path.
 *
 * There is no safe default for the id either. `agents.list` reports `mainKey:
 * "main"` alongside a sole agent whose id is `dev`, and the two behave
 * differently: the RPC rejects `agentId: "main"` as unknown, while the CLI
 * accepts `--agent main` and silently resolves it to a workspace *inside* the
 * real one (`workspace-dev/main`). So assuming "main" does not fail loudly, it
 * targets the wrong place.
 *
 * Imported lazily because `openclaw.ts` pulls in the transports, which import
 * this module; a top-level import would be a cycle.
 */
export async function getDefaultAgent(): Promise<{
  id: string;
  workspace: string | null;
} | null> {
  if (_defaultAgent) return _defaultAgent;
  try {
    const { gatewayCall } = await import("./openclaw");
    const payload = await gatewayCall<{
      defaultId?: string;
      agents?: { id?: string; workspace?: string; isDefault?: boolean }[];
    }>("agents.list", {}, 8000);

    const agents = Array.isArray(payload?.agents) ? payload.agents : [];
    const preferred =
      agents.find((agent) => agent?.id && agent.id === payload?.defaultId) ??
      agents.find((agent) => agent?.isDefault) ??
      agents[0];
    if (!preferred?.id) return null;

    const workspace =
      typeof preferred.workspace === "string" && preferred.workspace.trim()
        ? preferred.workspace
        : null;
    _defaultAgent = { id: preferred.id, workspace };
    return _defaultAgent;
  } catch {
    return null;
  }
}

/**
 * Id of the default agent, or null when the gateway cannot be reached. Callers
 * should omit the agent argument rather than substituting a guess — OpenClaw
 * resolves the default itself, and a wrong id is worse than none.
 */
export async function getDefaultAgentId(): Promise<string | null> {
  return (await getDefaultAgent())?.id ?? null;
}

/**
 * Resolve the default agent workspace path.
 * Priority:
 *   1. OPENCLAW_WORKSPACE env var
 *   2. The default agent's workspace, per the gateway
 *   3. agents.defaults.workspace from openclaw.json
 *   4. $OPENCLAW_HOME/workspace
 */
export async function getDefaultWorkspace(): Promise<string> {
  if (_workspace) return _workspace;

  // 1. Env var
  if (process.env.OPENCLAW_WORKSPACE) {
    _workspace = process.env.OPENCLAW_WORKSPACE;
    return _workspace;
  }

  // 2. The running gateway
  const fromGateway = (await getDefaultAgent())?.workspace;
  if (fromGateway) {
    _workspace = fromGateway;
    return _workspace;
  }

  // 3. Read from config
  try {
    const { readFile } = await import("fs/promises");
    const configPath = join(getOpenClawHome(), "openclaw.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    const ws = config?.agents?.defaults?.workspace;
    if (ws && typeof ws === "string") {
      _workspace = ws;
      return _workspace;
    }
  } catch {
    // Config doesn't exist or is invalid — fall through
  }

  // 4. Conventional default. Note this misses the per-agent suffix, so it is a
  // guess of last resort rather than the expected outcome.
  return join(getOpenClawHome(), "workspace");
}

/** Synchronous accessor — uses cached value or falls back to convention. */
export function getDefaultWorkspaceSync(): string {
  return (
    _workspace ||
    process.env.OPENCLAW_WORKSPACE ||
    join(getOpenClawHome(), "workspace")
  );
}

// ── OpenClaw binary path ─────────────────────────

let _bin: string | null = null;
let _binDone = false;

const BIN_CANDIDATES = [
  "/opt/homebrew/bin/openclaw",
  "/usr/local/bin/openclaw",
  "/usr/bin/openclaw",
  join(homedir(), ".local/bin/openclaw"),
  join(homedir(), ".npm-global/bin/openclaw"),
];

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function getOpenClawBin(): Promise<string> {
  if (_binDone && _bin) return _bin;

  // 1. Env var
  if (process.env.OPENCLAW_BIN) {
    _bin = process.env.OPENCLAW_BIN;
    _binDone = true;
    return _bin;
  }

  // 2. which
  try {
    const { stdout } = await exec("which", ["openclaw"], { timeout: 3000 });
    const resolved = stdout.trim();
    if (resolved) {
      _bin = resolved;
      _binDone = true;
      return _bin;
    }
  } catch {
    // continue
  }

  // 3. Probe common locations
  for (const c of BIN_CANDIDATES) {
    if (await fileExists(c)) {
      _bin = c;
      _binDone = true;
      return _bin;
    }
  }

  // 4. Fall back to bare name (hope PATH has it)
  _bin = "openclaw";
  _binDone = true;
  return _bin;
}

/** Synchronous accessor — uses cached value or env. */
export function getOpenClawBinSync(): string {
  return _bin || process.env.OPENCLAW_BIN || "openclaw";
}

// ── gog binary path (same pattern as openclaw: env → which → candidates) ──

let _gogBin: string | null = null;
let _gogBinDone = false;

const GOG_BIN_CANDIDATES = [
  "/opt/homebrew/bin/gog",
  "/usr/local/bin/gog",
  "/usr/bin/gog",
  "/snap/bin/gog",
  join(homedir(), ".local/bin/gog"),
  join(homedir(), "bin/gog"),
];

export async function getGogBin(): Promise<string> {
  if (_gogBinDone && _gogBin) return _gogBin;

  if (process.env.GOG_PATH) {
    _gogBin = process.env.GOG_PATH;
    _gogBinDone = true;
    return _gogBin;
  }

  try {
    const { stdout } = await exec("which", ["gog"], { timeout: 3000 });
    const resolved = stdout.trim();
    if (resolved) {
      _gogBin = resolved;
      _gogBinDone = true;
      return _gogBin;
    }
  } catch {
    // continue
  }

  for (const c of GOG_BIN_CANDIDATES) {
    if (await fileExists(c)) {
      _gogBin = c;
      _gogBinDone = true;
      return _gogBin;
    }
  }

  _gogBin = "gog";
  _gogBinDone = true;
  return _gogBin;
}

// ── gog keyring env ──

/**
 * Environment variables for gog keyring access.
 * Uses file-based keyring to avoid macOS Keychain lock issues on headless machines.
 * Note: gog always stores tokens in ~/Library/Application Support/gogcli/keyring/
 * regardless of env vars. The config file controls the backend (already set to "file").
 * GOG_KEYRING_PASSWORD is required for the file backend encryption.
 */
export function getGogKeyringEnv(): Record<string, string> {
  return {
    GOG_KEYRING_PASSWORD:
      process.env.GOG_KEYRING_PASSWORD || "openclaw:file-keyring",
  };
}

// ── Gateway URL ─────────────────────────────────

let _gatewayUrl: string | null = null;

/**
 * Resolve the gateway URL.
 * Priority:
 *   1. OPENCLAW_GATEWAY_URL env var
 *   2. gateway.port from openclaw.json → http://127.0.0.1:{port}
 *   3. http://127.0.0.1:18789
 */
export async function getGatewayUrl(): Promise<string> {
  if (_gatewayUrl) return _gatewayUrl;

  // 1. Env var
  if (process.env.OPENCLAW_GATEWAY_URL) {
    _gatewayUrl = process.env.OPENCLAW_GATEWAY_URL;
    return _gatewayUrl;
  }

  // 2. Read from config
  try {
    const { readFile } = await import("fs/promises");
    const configPath = join(getOpenClawHome(), "openclaw.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);
    const port = config?.gateway?.port;
    if (port && typeof port === "number") {
      _gatewayUrl = `http://127.0.0.1:${port}`;
      return _gatewayUrl;
    }
  } catch {
    // Config doesn't exist or is invalid — fall through
  }

  // 3. Conventional default
  _gatewayUrl = "http://127.0.0.1:18789";
  return _gatewayUrl;
}

/** Extract the port number from the resolved gateway URL. */
export async function getGatewayPort(): Promise<number> {
  const url = await getGatewayUrl();
  try {
    const parsed = new URL(url);
    const port = parseInt(parsed.port, 10);
    return isNaN(port) ? 18789 : port;
  } catch {
    return 18789;
  }
}

// ── System skills directory ──────────────────────

let _skills: string | null = null;
let _skillsDone = false;

export async function getSystemSkillsDir(): Promise<string> {
  if (_skillsDone && _skills) return _skills;

  // 1. Env var
  if (process.env.OPENCLAW_SKILLS_DIR) {
    _skills = process.env.OPENCLAW_SKILLS_DIR;
    _skillsDone = true;
    return _skills;
  }

  // 2. npm root -g
  try {
    const { stdout } = await exec("npm", ["root", "-g"], { timeout: 5000 });
    const root = stdout.trim();
    if (root) {
      _skills = join(root, "openclaw", "skills");
      _skillsDone = true;
      return _skills;
    }
  } catch {
    // continue
  }

  // 3. Common fallbacks
  const candidates = [
    "/opt/homebrew/lib/node_modules/openclaw/skills",
    "/usr/local/lib/node_modules/openclaw/skills",
    "/usr/lib/node_modules/openclaw/skills",
  ];

  for (const c of candidates) {
    if (await fileExists(c)) {
      _skills = c;
      _skillsDone = true;
      return _skills;
    }
  }

  _skills = "/usr/local/lib/node_modules/openclaw/skills";
  _skillsDone = true;
  return _skills;
}

// ── Gateway auth token ──────────────────────────

let _gatewayToken: string | null = null;

/**
 * Resolve the Gateway auth token for HTTP transport.
 * Used by HttpTransport for Authorization: Bearer headers.
 *
 * Priority: env var → openclaw.json gateway.auth.token → empty string.
 */
/** Read a dot path out of openclaw.json synchronously, tolerating any failure. */
function readConfigValueSync(path: string[]): unknown {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readFileSync } = require("fs") as typeof import("fs");
    const raw = readFileSync(join(getOpenClawHome(), "openclaw.json"), "utf-8");
    let node: unknown = JSON.parse(raw);
    for (const key of path) {
      if (!node || typeof node !== "object") return undefined;
      node = (node as Record<string, unknown>)[key];
    }
    return node;
  } catch {
    return undefined;
  }
}

export function getGatewayToken(): string {
  if (_gatewayToken !== null) return _gatewayToken;

  // 1. Env var
  if (process.env.OPENCLAW_GATEWAY_TOKEN) {
    _gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
    return _gatewayToken;
  }

  // 2. Read from config (sync — token is needed synchronously by callers).
  // `gateway.token` is a legacy key the gateway no longer honors, so only
  // `gateway.auth.token` is read here.
  const token = readConfigValueSync(["gateway", "auth", "token"]);
  _gatewayToken = typeof token === "string" && token ? token : "";
  return _gatewayToken;
}

/**
 * Drop the memoized gateway auth credentials so the next read comes from disk.
 *
 * Called by the RPC layer when the gateway rejects the shared secret: the user
 * may have rotated `gateway.auth.token` (or `gateway.auth.password`) since
 * this process cached it, and re-reading is the only way to recover without a
 * restart. Both halves of the shared-secret cache drop together because a
 * rotation can switch the auth mode as well as the value.
 */
export function invalidateGatewayToken(): void {
  _gatewayToken = null;
  _gatewayPassword = null;
}

// ── Gateway auth password ───────────────────────

let _gatewayPassword: string | null = null;

/**
 * Resolve the Gateway password used when `gateway.auth.mode` is `"password"`.
 *
 * Shared-secret auth is what lets a loopback backend client authenticate as a
 * local operator, and installs that chose password mode have no token at all.
 *
 * Priority: env var → openclaw.json gateway.auth.password → empty string.
 */
export function getGatewayPassword(): string {
  if (_gatewayPassword !== null) return _gatewayPassword;

  if (process.env.OPENCLAW_GATEWAY_PASSWORD) {
    _gatewayPassword = process.env.OPENCLAW_GATEWAY_PASSWORD;
    return _gatewayPassword;
  }

  const password = readConfigValueSync(["gateway", "auth", "password"]);
  _gatewayPassword = typeof password === "string" && password ? password : "";
  return _gatewayPassword;
}

/** Resolve `gateway.auth.mode` ("none" | "token" | "password" | "trusted-proxy"). */
export function getGatewayAuthMode(): string {
  const mode = readConfigValueSync(["gateway", "auth", "mode"]);
  return typeof mode === "string" && mode ? mode : "none";
}
