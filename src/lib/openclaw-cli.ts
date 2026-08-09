import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { getOpenClawBin } from "./paths";

const exec = promisify(execFile);

/** Env vars for all CLI subprocesses. Mission Control is always a trusted local process. */
const CLI_ENV = {
  ...process.env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  TERM: "dumb",
  OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
};

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
        env: CLI_ENV,
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
          env: CLI_ENV,
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
      env: CLI_ENV,
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

/**
 * Run a command with `--json` and parse its payload.
 *
 * Both streams are captured and searched, and the exit code is not used to
 * decide where to look. Some commands print their JSON payload to stderr even
 * on success — `browser extension path` and `browser extension pair` do, for
 * instance — so reading stdout alone silently yields nothing for them. Others
 * exit non-zero while still reporting a usable payload. Preferring stdout and
 * falling back to stderr covers all four combinations.
 */
export async function runCliJson<T>(
  args: string[],
  timeout = 15000
): Promise<T> {
  const context = `openclaw ${args.join(" ")} --json`;
  const { stdout, stderr, code } = await runCliCaptureBoth(
    [...args, "--json"],
    timeout
  );

  for (const output of [stdout, stderr]) {
    if (!output.trim()) continue;
    try {
      return parseJsonFromCliOutput<T>(output, context);
    } catch {
      // Not valid JSON in this stream — try the next one.
    }
  }

  const detail = stripAnsi(stderr || stdout)
    .replace(/\r/g, "")
    .trim()
    .slice(0, 400);
  throw new Error(
    code === 0
      ? `Failed to parse JSON from ${context}${detail ? `. Output: ${detail}` : ": empty output"}`
      : `Command failed (exit ${code}): ${detail || `no output from ${context}`}`
  );
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
