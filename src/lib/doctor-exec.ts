/**
 * The one place the Doctor surface launches `openclaw`.
 *
 * Two things make this non-trivial enough to centralise:
 *
 * 1. **Node resolution.** The CLI refuses to start outside its supported engine
 *    ranges, and Mission Control's own server is frequently on a version it
 *    rejects — this machine runs Node 25.6.1, which sits in the gap between
 *    OpenClaw's 24.x and 25.9+ windows. That is finding #7 on the Doctor page
 *    *and* the reason the page could not run doctor at all. We prepend a
 *    compatible Node to the subprocess PATH, mirroring `openclaw-cli.ts`.
 *
 * 2. **Exit codes are not errors.** `doctor --lint` exits 1 whenever it finds
 *    anything at or above the severity threshold. Treating that as a failure
 *    would report "the check failed" on every machine that has something to
 *    report — which is every machine worth checking. Only exit 2 (or
 *    unparseable output) is a real failure.
 *
 * Callers get both stdout and stderr and decide for themselves.
 */

import { spawn } from "child_process";
import { existsSync, readdirSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";
import { join } from "path";
import { getOpenClawBin } from "./paths";

/** Mirrors the openclaw CLI's own engine check (see `openclaw-cli.ts`). */
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
  for (const [dir, suffix] of [
    [join(home, ".nvm", "versions", "node"), ["bin", "node"]],
    [join(home, ".fnm", "node-versions"), ["installation", "bin", "node"]],
  ] as const) {
    try {
      for (const v of readdirSync(dir).sort().reverse()) out.push(join(dir, v, ...suffix));
    } catch {
      /* version manager not installed */
    }
  }
  out.push(
    join(home, ".volta", "bin", "node"),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  );
  return out.filter((p) => existsSync(p));
}

let cachedPath: string | null | undefined;

/**
 * A PATH the CLI will start under, or undefined when our own runtime is fine.
 *
 * Also reports *which* Node we had to borrow, because that is evidence for the
 * unsupported-Node finding rather than an implementation detail: if this
 * returns a workaround path, the user really is relying on one.
 */
let borrowedNode: { path: string; version: string } | null = null;

function resolvePath(): string | undefined {
  if (cachedPath !== undefined) return cachedPath ?? undefined;

  if (openclawSupportsNode(process.versions.node)) {
    cachedPath = null;
    return undefined;
  }
  for (const candidate of nodeCandidates()) {
    let version: string | null = null;
    try {
      version = execFileSync(candidate, ["-v"], { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {
      continue;
    }
    if (version && openclawSupportsNode(version)) {
      borrowedNode = { path: candidate, version };
      cachedPath = `${candidate.slice(0, candidate.lastIndexOf("/"))}:${process.env.PATH ?? ""}`;
      return cachedPath;
    }
  }
  // Nothing compatible is installed. Fall through with the inherited PATH so
  // the CLI's own engine error reaches the user instead of a silent failure.
  cachedPath = null;
  return undefined;
}

/**
 * The Node Mission Control itself runs on, and the one it had to borrow to talk
 * to OpenClaw. Both are real, locally observed facts — the Doctor page uses
 * them to corroborate the CLI's unsupported-Node finding from a second source.
 */
export function nodeRuntimeFacts(): {
  serverNode: string;
  serverNodeSupported: boolean;
  borrowed: { path: string; version: string } | null;
} {
  resolvePath();
  return {
    serverNode: process.versions.node,
    serverNodeSupported: openclawSupportsNode(process.versions.node),
    borrowed: borrowedNode,
  };
}

function execEnv(): NodeJS.ProcessEnv {
  const path = resolvePath();
  return {
    ...process.env,
    ...(path ? { PATH: path } : {}),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    TERM: "dumb",
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1",
  };
}

export type OpenClawResult = {
  argv: string[];
  stdout: string;
  stderr: string;
  code: number | null;
  durationMs: number;
  /** True when the process was killed for exceeding its budget. */
  timedOut: boolean;
  spawnError: string | null;
};

/** Human-readable invocation, for provenance and the shareable report. */
export function invocationOf(args: readonly string[]): string {
  return `openclaw ${args.join(" ")}`;
}

/**
 * Run `openclaw` to completion. Never throws: a command that could not run is
 * itself a reportable state, and the Doctor page must be able to say "we could
 * not check this" rather than collapsing.
 */
export async function runOpenClaw(
  args: string[],
  timeoutMs: number,
  onChunk?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<OpenClawResult> {
  const bin = await getOpenClawBin();
  const startedAt = Date.now();

  return new Promise<OpenClawResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null, spawnError: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        argv: args,
        stdout,
        stderr,
        code,
        durationMs: Date.now() - startedAt,
        timedOut,
        spawnError,
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { env: execEnv(), stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      finish(null, String(err));
      return;
    }

    // Our own timer rather than spawn's `timeout` option, so we can report
    // *that* it timed out instead of an indistinguishable null exit code.
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    /*
     * Emit whole lines, not raw chunks. Consumers redact credentials out of
     * this text before streaming it to a browser, and a token split across two
     * `data` events would slip through that pass in two harmless-looking
     * halves. A secret does not span a newline, so lines are a safe unit.
     */
    const pending: Record<"stdout" | "stderr", string> = { stdout: "", stderr: "" };

    const emitLines = (stream: "stdout" | "stderr", text: string) => {
      if (!onChunk) return;
      pending[stream] += text;
      const parts = pending[stream].split("\n");
      pending[stream] = parts.pop() ?? "";
      for (const line of parts) onChunk(stream, `${line}\n`);
    };

    const flushPending = () => {
      if (!onChunk) return;
      for (const stream of ["stdout", "stderr"] as const) {
        if (pending[stream]) {
          onChunk(stream, pending[stream]);
          pending[stream] = "";
        }
      }
    };

    child.stdout?.on("data", (d: Buffer) => {
      const text = d.toString();
      stdout += text;
      emitLines("stdout", text);
    });
    child.stderr?.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr += text;
      emitLines("stderr", text);
    });
    child.on("error", (err) => {
      flushPending();
      finish(null, String(err));
    });
    child.on("close", (code, signal) => {
      flushPending();
      finish(code ?? (signal ? -1 : 0), null);
    });
  });
}

/**
 * Pull the first balanced JSON object out of CLI stdout.
 *
 * Necessary because several commands print doctor's box-drawing notices to
 * stdout ahead of their `--json` payload — `config set --dry-run --json` does
 * this on every invocation on this machine. A naive `JSON.parse(stdout)` fails
 * there, and slicing from the first `{` is not enough either, because the
 * banner itself contains braces in some locales.
 */
export function extractJson<T>(stdout: string): T | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stdout.length; i++) {
    const ch = stdout[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stdout.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
