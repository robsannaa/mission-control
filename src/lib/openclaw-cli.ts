import { execFile, execFileSync, spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { promisify } from "util";
import { getOpenClawBin } from "./paths";

const exec = promisify(execFile);

// ── Node runtime resolution ────────────────────────────────────────────────
// The openclaw CLI refuses to start on a Node version outside its supported
// ranges. Mission Control's own server can easily be running on such a version
// — Homebrew's 25.6.x sits in the gap between OpenClaw's 24.x and 25.9+ windows
// — so inheriting our PATH blindly makes every CLI-backed page (Doctor,
// Security, ...) fail with a raw "Node.js >=22.22.3 <23, ..." error.
// Resolve a Node the CLI accepts once, and prepend it to the subprocess PATH.

/** Mirrors the openclaw CLI's own engine check. */
function openclawSupportsNode(version: string): boolean {
  const [maj, min, pat] = version.replace(/^v/, "").split(".").map(Number);
  if (!Number.isFinite(maj)) return false;
  const atLeast = (a: number, b: number, c: number) =>
    maj > a || (maj === a && (min > b || (min === b && pat >= c)));
  if (maj === 22) return atLeast(22, 22, 3);
  if (maj === 24) return atLeast(24, 15, 0);
  if (maj === 25) return atLeast(25, 9, 0);
  return maj >= 26;
}

function nodeCandidates(): string[] {
  const home = homedir();
  const out: string[] = [];
  const versionsDir = join(home, ".nvm", "versions", "node");
  try {
    for (const v of readdirSync(versionsDir).sort().reverse()) {
      out.push(join(versionsDir, v, "bin", "node"));
    }
  } catch { /* no nvm */ }
  const fnmDir = join(home, ".fnm", "node-versions");
  try {
    for (const v of readdirSync(fnmDir).sort().reverse()) {
      out.push(join(fnmDir, v, "installation", "bin", "node"));
    }
  } catch { /* no fnm */ }
  out.push(
    join(home, ".volta", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  );
  return out.filter((p) => existsSync(p));
}

function nodeVersionOf(binary: string): string | null {
  try {
    return execFileSync(binary, ["-v"], { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

/** Resolved once per server process — the scan spawns a few short-lived `node -v`. */
let cachedCliPath: string | null | undefined;

function resolveCliPath(): string | undefined {
  if (cachedCliPath !== undefined) return cachedCliPath ?? undefined;

  // Our own runtime is fine? Then the inherited PATH already works.
  if (openclawSupportsNode(process.versions.node)) {
    cachedCliPath = null;
    return undefined;
  }

  for (const candidate of nodeCandidates()) {
    const version = nodeVersionOf(candidate);
    if (version && openclawSupportsNode(version)) {
      const dir = candidate.slice(0, candidate.lastIndexOf("/"));
      cachedCliPath = `${dir}:${process.env.PATH ?? ""}`;
      return cachedCliPath;
    }
  }

  // Nothing compatible installed. Fall through with the inherited PATH so the
  // CLI's own message reaches the user rather than a silent failure here.
  cachedCliPath = null;
  return undefined;
}

/** Env vars for all CLI subprocesses. Mission Control is always a trusted local process. */
function cliEnv(): NodeJS.ProcessEnv {
  const resolvedPath = resolveCliPath();
  return {
    ...process.env,
    ...(resolvedPath ? { PATH: resolvedPath } : {}),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
  };
}

// ── Concurrency semaphore ──────────────────────────────────────────────────
// Caps the number of simultaneously live CLI subprocesses. Callers that
// exceed the limit are queued and resume in FIFO order as slots free up.

const CLI_MAX_CONCURRENT = 6;
const CLI_MAX_QUEUED = 20;
let cliInFlight = 0;
const cliQueue: Array<() => void> = [];

function acquireCliSlot(): Promise<void> {
  if (cliInFlight < CLI_MAX_CONCURRENT) {
    cliInFlight++;
    return Promise.resolve();
  }
  if (cliQueue.length >= CLI_MAX_QUEUED) {
    return Promise.reject(
      new Error(
        `CLI backpressure: ${cliInFlight} running, ${cliQueue.length} queued (limit ${CLI_MAX_QUEUED}). Rejecting to prevent OOM.`,
      ),
    );
  }
  return new Promise((resolve) => {
    cliQueue.push(() => {
      cliInFlight++;
      resolve();
    });
  });
}

function releaseCliSlot(): void {
  cliInFlight--;
  const next = cliQueue.shift();
  if (next) next();
}

/** Result of a CLI run when both stdout and stderr are captured. */
export type RunCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
};

/**
 * Run CLI and capture both stdout and stderr. Use for cron run and other
 * commands where we need to show full output on failure.
 */
export async function runCliCaptureBoth(
  args: string[],
  timeout = 15000
): Promise<RunCliResult> {
  await acquireCliSlot();
  try {
    const bin = await getOpenClawBin();
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, args, {
        env: cliEnv(),
        timeout,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString();
      });
      child.on("close", (code, signal) => {
        resolve({
          stdout,
          stderr,
          code: code ?? (signal ? -1 : 0),
        });
      });
      child.on("error", reject);
    });
  } finally {
    releaseCliSlot();
  }
}

export async function runCli(
  args: string[],
  timeout = 15000,
  stdin?: string
): Promise<string> {
  await acquireCliSlot();
  try {
    const bin = await getOpenClawBin();
    if (stdin !== undefined) {
      // Use spawn for stdin piping
      return await new Promise((resolve, reject) => {
        const child = spawn(bin, args, {
          env: cliEnv(),
          timeout,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        child.on("close", (code) => {
          if (code === 0) resolve(stdout);
          else reject(new Error(`Command failed (exit ${code}): ${stderr || stdout}`));
        });
        child.on("error", reject);
        child.stdin.write(stdin);
        child.stdin.end();
      });
    }
    const { stdout } = await exec(bin, args, {
      timeout,
      env: cliEnv(),
    });
    return stdout;
  } finally {
    releaseCliSlot();
  }
}

const ANSI_ESCAPE_PATTERN =
  // Matches CSI and related ANSI escape sequences.
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function parseJsonCandidate<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function findJsonSuffix(rawOutput: string): string | null {
  const cleaned = stripAnsi(rawOutput).replace(/\r/g, "").trim();
  if (!cleaned) return null;
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) {
    return cleaned;
  }

  const starts: number[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (ch === "{" || ch === "[") starts.push(i);
  }

  for (let i = starts.length - 1; i >= 0; i -= 1) {
    const candidate = cleaned.slice(starts[i]).trim();
    if (!candidate) continue;
    if (!candidate.startsWith("{") && !candidate.startsWith("[")) continue;
    if (parseJsonCandidate(candidate) !== null) {
      return candidate;
    }
  }

  return null;
}

export function parseJsonFromCliOutput<T>(
  rawOutput: string,
  context = "CLI output"
): T {
  const candidate = findJsonSuffix(rawOutput);
  if (!candidate) {
    const snippet = stripAnsi(rawOutput).replace(/\r/g, "").trim().slice(0, 400);
    throw new Error(
      snippet
        ? `Failed to parse JSON from ${context}. Output: ${snippet}`
        : `Failed to parse JSON from ${context}: empty output`
    );
  }
  return JSON.parse(candidate) as T;
}

export async function runCliJson<T>(
  args: string[],
  timeout = 15000
): Promise<T> {
  try {
    const stdout = await runCli([...args, "--json"], timeout);
    return parseJsonFromCliOutput<T>(stdout, `openclaw ${args.join(" ")} --json`);
  } catch (err) {
    // On non-zero exit, try to recover JSON from stdout or stderr.
    // Some OpenClaw versions write JSON to stderr when there's no TTY.
    const errObj = err as { stdout?: unknown; stderr?: unknown };
    const stdout = typeof errObj?.stdout === "string" ? String(errObj.stdout) : "";
    const stderr = typeof errObj?.stderr === "string" ? String(errObj.stderr) : "";
    for (const output of [stdout, stderr]) {
      if (output.trim()) {
        try {
          return parseJsonFromCliOutput<T>(output, `openclaw ${args.join(" ")} --json`);
        } catch {
          // Not valid JSON in this stream — try the next one.
        }
      }
    }
    throw err;
  }
}

export async function gatewayCall<T>(
  method: string,
  params?: Record<string, unknown>,
  timeout = 15000
): Promise<T> {
  const args = ["gateway", "call", method, "--json"];
  if (params) args.push("--params", JSON.stringify(params));
  if (timeout > 10000) args.push("--timeout", String(timeout));
  const stdout = await runCli(args, timeout + 5000);
  return parseJsonFromCliOutput<T>(stdout, `openclaw gateway call ${method}`);
}
