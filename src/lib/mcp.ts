/**
 * MCP server management — SERVER-ONLY.
 *
 * Thin, typed wrappers over the `openclaw mcp` CLI (there is no gateway RPC for
 * MCP — it is config-file driven at ~/.openclaw/openclaw.json → mcp.servers).
 * Reads use `runCliJson` (which appends `--json` and strips CLI preamble
 * noise); writes use `runCli` with the longer config-write budget because the
 * subprocess boots the full plugin loader before it saves.
 *
 * Everything that leaves this module for the browser goes through
 * `toServerView` first (see ./mcp-types) so no secret value is ever exposed.
 */

import { runCli, runCliJson, CONFIG_WRITE_TIMEOUT_MS } from "@/lib/openclaw";
import {
  toServerView,
  type McpDoctorResult,
  type McpDoctorRow,
  type McpProbeResult,
  type McpServerConfig,
  type McpServerView,
  type McpStatusResult,
  type McpStatusRow,
  type McpTransport,
} from "./mcp-types";

export * from "./mcp-types";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertValidName(name: string): string {
  const n = String(name || "").trim();
  if (!NAME_RE.test(n)) {
    throw new Error(
      "Invalid server name. Use letters, numbers, dot, dash, or underscore (no spaces).",
    );
  }
  return n;
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function readServers(): Promise<Record<string, McpServerConfig>> {
  const raw = await runCliJson<Record<string, McpServerConfig>>(["mcp", "show"], 20_000);
  return raw && typeof raw === "object" ? raw : {};
}

export async function readStatus(): Promise<McpStatusResult> {
  try {
    const raw = await runCliJson<McpStatusResult>(["mcp", "status", "--verbose"], 20_000);
    if (raw && Array.isArray(raw.servers)) return raw;
  } catch {
    /* status is best-effort; config is the source of truth */
  }
  return { path: "", servers: [] };
}

export async function readDoctor(): Promise<McpDoctorResult> {
  try {
    const raw = await runCliJson<McpDoctorResult>(["mcp", "doctor"], 30_000);
    if (raw && Array.isArray(raw.servers)) return raw;
  } catch {
    /* doctor is best-effort */
  }
  return { path: "", ok: true, servers: [] };
}

export async function probeServer(name: string): Promise<McpProbeResult> {
  return runCliJson<McpProbeResult>(["mcp", "probe", assertValidName(name)], 45_000);
}

/** Merge config + live status + doctor issues into the redacted view list. */
export async function getServerViews(): Promise<{
  servers: McpServerView[];
  ok: boolean;
  path: string;
}> {
  const [config, status, doctor] = await Promise.all([
    readServers(),
    readStatus(),
    readDoctor(),
  ]);
  const statusByName = new Map<string, McpStatusRow>(status.servers.map((s) => [s.name, s]));
  const issuesByName = new Map<string, McpDoctorRow>(doctor.servers.map((d) => [d.name, d]));
  const names = Object.keys(config).sort((a, b) => a.localeCompare(b));
  const servers = names.map((name) =>
    toServerView(name, config[name] ?? {}, statusByName.get(name), issuesByName.get(name)?.issues ?? []),
  );
  return { servers, ok: doctor.ok !== false, path: status.path || doctor.path || "" };
}

// ── Writes ───────────────────────────────────────────────────────────────

export interface SaveServerInput {
  name: string;
  transport: McpTransport;
  // stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Array<{ key: string; value: string }>;
  // http
  url?: string;
  headers?: Array<{ key: string; value: string }>;
  auth?: "oauth" | null;
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
  oauthClientMetadataUrl?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
  // controls
  timeout?: number | null;
  connectTimeout?: number | null;
  parallel?: boolean;
  include?: string[];
  exclude?: string[];
}

/**
 * Merge a form payload into an MCP config object. When editing, secret fields
 * left blank fall back to the stored value so a save never silently wipes a
 * token, env value, or key the browser was never shown.
 */
function buildConfig(input: SaveServerInput, existing?: McpServerConfig): McpServerConfig {
  const prev = existing ?? {};
  const cfg: McpServerConfig = {};

  if (input.transport === "stdio") {
    if (!input.command?.trim()) throw new Error("A stdio server needs a command.");
    cfg.command = input.command.trim();
    if (input.args?.length) cfg.args = input.args.map((a) => String(a));
    if (input.cwd?.trim()) cfg.cwd = input.cwd.trim();
    const env = mergeSecrets(input.env, prev.env);
    if (env && Object.keys(env).length) cfg.env = env;
  } else {
    if (!input.url?.trim()) throw new Error("An HTTP server needs a URL.");
    cfg.url = input.url.trim();
    cfg.transport = input.transport === "sse" ? "sse" : "streamable-http";
    const headers = mergeSecrets(input.headers, prev.headers);
    if (headers && Object.keys(headers).length) cfg.headers = headers;
    if (input.auth === "oauth") {
      cfg.auth = "oauth";
      if (input.oauthClientMetadataUrl?.trim()) cfg.oauthClientMetadataUrl = input.oauthClientMetadataUrl.trim();
      if (input.oauthRedirectUrl?.trim()) cfg.oauthRedirectUrl = input.oauthRedirectUrl.trim();
      if (input.oauthScope?.trim()) cfg.oauthScope = input.oauthScope.trim();
    }
    if (typeof input.sslVerify === "boolean") cfg.sslVerify = input.sslVerify;
    // TLS material: keep existing when the form leaves it blank on edit.
    cfg.clientCert = input.clientCert?.trim() || prev.clientCert;
    cfg.clientKey = input.clientKey?.trim() || prev.clientKey;
    if (!cfg.clientCert) delete cfg.clientCert;
    if (!cfg.clientKey) delete cfg.clientKey;
  }

  // Operator controls (shared)
  if (input.timeout != null) cfg.timeout = input.timeout;
  if (input.connectTimeout != null) cfg.connectTimeout = input.connectTimeout;
  if (input.parallel) cfg.parallel = true;
  if (input.include?.length) cfg.include = input.include;
  if (input.exclude?.length) cfg.exclude = input.exclude;
  // Preserve disabled state across an edit (enable/disable has its own path).
  if (prev.disabled === true) cfg.disabled = true;

  return cfg;
}

/**
 * Merge {key,value}[] entries into a record, preserving a prior value when the
 * submitted value is blank (the "unchanged secret" case).
 */
function mergeSecrets(
  entries: Array<{ key: string; value: string }> | undefined,
  prev: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!entries) return prev;
  const out: Record<string, string> = {};
  for (const { key, value } of entries) {
    const k = String(key || "").trim();
    if (!k) continue;
    const v = String(value ?? "");
    out[k] = v !== "" ? v : (prev?.[k] ?? "");
  }
  return out;
}

/** Create or replace a server (full config), then optionally probe it. */
export async function saveServer(input: SaveServerInput, isEdit: boolean): Promise<void> {
  const name = assertValidName(input.name);
  const existing = isEdit ? (await readServers())[name] : undefined;
  const cfg = buildConfig(input, existing);
  await runCli(["mcp", "set", name, JSON.stringify(cfg)], CONFIG_WRITE_TIMEOUT_MS);
  await reload();
}

export async function setEnabled(name: string, enabled: boolean): Promise<void> {
  await runCli(
    ["mcp", "configure", assertValidName(name), enabled ? "--enable" : "--disable"],
    CONFIG_WRITE_TIMEOUT_MS,
  );
  await reload();
}

export async function setToolFilter(
  name: string,
  include: string[],
  exclude: string[],
): Promise<void> {
  const n = assertValidName(name);
  if (include.length === 0 && exclude.length === 0) {
    await runCli(["mcp", "tools", n, "--clear"], CONFIG_WRITE_TIMEOUT_MS);
  } else {
    const args = ["mcp", "tools", n];
    if (include.length) args.push("--include", include.join(","));
    if (exclude.length) args.push("--exclude", exclude.join(","));
    await runCli(args, CONFIG_WRITE_TIMEOUT_MS);
  }
  await reload();
}

export async function removeServer(name: string): Promise<void> {
  await runCli(["mcp", "unset", assertValidName(name)], CONFIG_WRITE_TIMEOUT_MS);
  await reload();
}

/**
 * Begin (or complete) an OAuth login. Without a code the CLI prints an
 * authorization URL to visit; with a code it finalises the grant.
 */
export async function oauthLogin(name: string, code?: string): Promise<{ output: string; authUrl: string | null }> {
  const args = ["mcp", "login", assertValidName(name)];
  if (code?.trim()) args.push("--code", code.trim());
  const output = await runCli(args, CONFIG_WRITE_TIMEOUT_MS);
  const authUrl = extractUrl(output);
  return { output, authUrl };
}

export async function oauthLogout(name: string): Promise<void> {
  await runCli(["mcp", "logout", assertValidName(name)], CONFIG_WRITE_TIMEOUT_MS);
  await reload();
}

/** Dispose cached MCP runtimes so new config is used on the next turn. */
export async function reload(): Promise<void> {
  try {
    await runCli(["mcp", "reload"], 20_000);
  } catch {
    /* reload is best-effort; config is already saved */
  }
}

function extractUrl(text: string): string | null {
  const m = String(text || "").match(/https?:\/\/[^\s'"]+/);
  return m ? m[0] : null;
}
