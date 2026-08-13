/**
 * MCP (Model Context Protocol) types + secret redaction — CLIENT-SAFE.
 *
 * This module has NO server imports (no child_process, no @/lib/openclaw), so
 * it can be pulled into a client component without leaking the CLI into the
 * browser bundle. The server module `@/lib/mcp` re-exports everything here.
 *
 * SECURITY INVARIANT: the shapes a browser is allowed to see (`McpServerView`)
 * never carry a secret VALUE. Bearer tokens, other request headers, stdio env
 * values, and TLS key/cert contents are reduced to "present or not" + the key
 * name. `openclaw mcp show --json` returns them in the clear; the redaction in
 * `toServerView` is the wall between that and the API response.
 */

export type McpTransport = "stdio" | "streamable-http" | "sse";

/** Raw per-server value from `openclaw mcp show --json` (mcp.servers[name]). */
export interface McpServerConfig {
  // stdio
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  // http
  url?: string;
  transport?: "streamable-http" | "sse";
  headers?: Record<string, string>;
  auth?: string; // "oauth"
  oauthClientMetadataUrl?: string;
  oauthRedirectUrl?: string;
  oauthScope?: string;
  sslVerify?: boolean;
  clientCert?: string;
  clientKey?: string;
  // operator controls
  timeout?: number;
  connectTimeout?: number;
  parallel?: boolean;
  disabled?: boolean;
  include?: string[] | string;
  exclude?: string[] | string;
  [k: string]: unknown;
}

/** One row of `openclaw mcp status --json --verbose`. */
export interface McpStatusRow {
  name: string;
  configured: boolean;
  enabled: boolean;
  ok: boolean;
  transport: string;
  launch: string;
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  supportsParallelToolCalls?: boolean;
}

export interface McpStatusResult {
  path: string;
  servers: McpStatusRow[];
}

export type McpIssueLevel = "error" | "warning" | "info";
export interface McpDoctorIssue {
  level: McpIssueLevel | string;
  message: string;
}
export interface McpDoctorRow {
  name: string;
  ok: boolean;
  issues: McpDoctorIssue[];
}
export interface McpDoctorResult {
  path: string;
  ok: boolean;
  servers: McpDoctorRow[];
}

/** `openclaw mcp probe <name> --json`. */
export interface McpProbeSummary {
  launch: string;
  tools: number;
  requestTimeoutMs?: number;
  resources?: boolean;
  prompts?: boolean;
}
export interface McpProbeResult {
  generatedAt?: string;
  servers: Record<string, McpProbeSummary>;
  tools: string[];
  diagnostics: unknown[];
}

/**
 * The redacted server shape the API returns to the browser. Secrets are
 * reduced to presence + key names; no value ever crosses this boundary.
 */
export interface McpServerView {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** Live health from `status`; undefined when status is unavailable. */
  ok: boolean | null;
  launch: string;
  // stdio (non-secret)
  command?: string;
  args?: string[];
  cwd?: string;
  envKeys?: string[]; // keys only — values redacted
  // http (non-secret)
  url?: string;
  headerKeys?: string[]; // keys only — values redacted
  hasAuthHeader?: boolean;
  auth?: string | null; // "oauth" | null
  sslVerify?: boolean;
  hasClientCert?: boolean;
  hasClientKey?: boolean;
  oauthScope?: string;
  // operator controls
  requestTimeoutMs?: number;
  connectionTimeoutMs?: number;
  parallel?: boolean;
  include?: string[];
  exclude?: string[];
  // governance
  issues: McpDoctorIssue[];
}

const AUTH_HEADER_RE = /^authorization$/i;

function asList(v: string[] | string | undefined): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  const parts = String(v)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? parts : undefined;
}

function transportOf(config: McpServerConfig): McpTransport {
  if (config.url) return config.transport === "sse" ? "sse" : "streamable-http";
  return "stdio";
}

/**
 * Merge the raw config with live status + doctor into the redacted view.
 * The ONLY place secrets are stripped — call this before anything reaches an
 * API response or the browser.
 */
export function toServerView(
  name: string,
  config: McpServerConfig,
  status?: McpStatusRow,
  issues: McpDoctorIssue[] = [],
): McpServerView {
  const transport = transportOf(config);
  const enabled = status?.enabled ?? config.disabled !== true;
  const headerKeys = config.headers ? Object.keys(config.headers) : undefined;
  const view: McpServerView = {
    name,
    transport,
    enabled,
    ok: status ? status.ok : null,
    launch: status?.launch ?? summariseLaunch(config),
    requestTimeoutMs: status?.requestTimeoutMs ?? config.timeout,
    connectionTimeoutMs: status?.connectionTimeoutMs ?? config.connectTimeout,
    parallel: status?.supportsParallelToolCalls ?? config.parallel ?? false,
    include: asList(config.include),
    exclude: asList(config.exclude),
    issues,
  };
  if (transport === "stdio") {
    view.command = config.command;
    view.args = Array.isArray(config.args) ? config.args : undefined;
    view.cwd = config.cwd;
    view.envKeys = config.env ? Object.keys(config.env) : undefined;
  } else {
    view.url = config.url;
    view.headerKeys = headerKeys;
    view.hasAuthHeader = headerKeys?.some((k) => AUTH_HEADER_RE.test(k)) ?? false;
    view.auth = typeof config.auth === "string" ? config.auth : null;
    view.sslVerify = config.sslVerify;
    view.hasClientCert = Boolean(config.clientCert);
    view.hasClientKey = Boolean(config.clientKey);
    view.oauthScope = config.oauthScope;
  }
  return view;
}

function summariseLaunch(config: McpServerConfig): string {
  if (config.url) return config.url;
  const cmd = [config.command, ...(config.args ?? [])].filter(Boolean).join(" ");
  return config.cwd ? `${cmd} (cwd=${config.cwd})` : cmd;
}

/** Split a fully-qualified probe tool id "server__tool" into its tool name. */
export function shortToolName(qualified: string, server: string): string {
  const prefix = `${server}__`;
  return qualified.startsWith(prefix) ? qualified.slice(prefix.length) : qualified;
}

/** True when a tool passes the server's include/exclude filter. */
export function toolMatchesFilter(
  tool: string,
  include?: string[],
  exclude?: string[],
): boolean {
  const globMatch = (pat: string) =>
    new RegExp(`^${pat.split("*").map(escapeRegExp).join(".*")}$`).test(tool);
  if (exclude?.some(globMatch)) return false;
  if (include && include.length > 0) return include.some(globMatch);
  return true;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
