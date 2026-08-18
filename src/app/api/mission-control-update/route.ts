import { NextResponse } from "next/server";
import { access, readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { withRoute } from "@/lib/api-route";
import { apiError, conflict } from "@/lib/api-errors";
import { missionControlUpdatePostSchema, type MissionControlUpdatePostInput } from "@/lib/schemas/updates";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

type UpdateStatus = {
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  installMode: "git" | "unknown";
  supported: boolean;
  unsupportedReason: string | null;
  branch: string | null;
  upstream: string | null;
  cleanWorkingTree: boolean;
  behind: number | null;
  ahead: number | null;
  releaseUrl: string | null;
  restartHint: string | null;
};

let updateInProgress = false;

function normalizeSemver(input: string | null | undefined): string {
  const value = String(input || "").trim();
  const match = value.match(/\d+\.\d+\.\d+/);
  return match?.[0] || "";
}

function compareSemver(a: string, b: string): number {
  const pa = normalizeSemver(a).split(".").map(Number);
  const pb = normalizeSemver(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

async function readCurrentVersion(): Promise<string | null> {
  try {
    const pkgPath = join(process.cwd(), "package.json");
    const raw = await readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    const v = String(pkg.version || "").trim();
    return v || null;
  } catch {
    return null;
  }
}

async function run(
  cmd: string,
  args: string[],
  timeout = 15000,
  cwd = process.cwd(),
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }> {
  try {
    const out = await execFileAsync(cmd, args, {
      cwd,
      timeout,
      env: process.env,
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      ok: true,
      stdout: String(out.stdout || ""),
      stderr: String(out.stderr || ""),
      code: 0,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      stdout: String(e?.stdout || ""),
      stderr: String(e?.stderr || ""),
      code: Number.isFinite(e?.code) ? Number(e.code) : 1,
    };
  }
}

function parseRemoteAndBranch(upstream: string): { remote: string; branch: string } | null {
  const idx = upstream.indexOf("/");
  if (idx <= 0 || idx >= upstream.length - 1) return null;
  return {
    remote: upstream.slice(0, idx),
    branch: upstream.slice(idx + 1),
  };
}

async function remoteRefExists(ref: string): Promise<boolean> {
  const probe = await run("git", ["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`], 6000);
  return probe.ok;
}

async function resolveUpstream(branch: string): Promise<string | null> {
  const tracked = await run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    6000
  );
  if (tracked.ok) {
    const upstream = tracked.stdout.trim();
    if (upstream) return upstream;
  }

  const candidates = [`origin/${branch}`, "origin/main", "origin/master"];
  for (const c of candidates) {
    if (await remoteRefExists(c)) return c;
  }
  return null;
}

function buildRestartHint(): string | null {
  const home = homedir();
  if (process.platform === "darwin") {
    const plist = join(home, "Library", "LaunchAgents", "com.openclaw.dashboard.plist");
    if (existsSync(plist)) {
      return "Restart service: launchctl kickstart -k gui/$(id -u)/com.openclaw.dashboard";
    }
  }

  if (process.platform === "linux") {
    const systemdService = join(home, ".config", "systemd", "user", "openclaw-dashboard.service");
    if (existsSync(systemdService)) {
      return "Restart service: systemctl --user restart openclaw-dashboard.service";
    }
  }

  return "Restart the Mission Control process to apply the new build.";
}

async function readLatestVersionFromNpm(): Promise<{ latestVersion: string | null; releaseUrl: string | null }> {
  try {
    const res = await fetch("https://registry.npmjs.org/@openclaw%2Fdashboard/latest", {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!res.ok) return { latestVersion: null, releaseUrl: null };
    const data = (await res.json()) as { version?: string; homepage?: string };
    const latestVersion = String(data.version || "").trim() || null;
    return {
      latestVersion,
      releaseUrl:
        data.homepage ||
        (latestVersion ? `https://www.npmjs.com/package/@openclaw/dashboard/v/${latestVersion}` : "https://www.npmjs.com/package/@openclaw/dashboard"),
    };
  } catch {
    return { latestVersion: null, releaseUrl: null };
  }
}

async function inspectInstallMode(refreshRemote: boolean): Promise<{
  installMode: "git" | "unknown";
  supported: boolean;
  unsupportedReason: string | null;
  branch: string | null;
  upstream: string | null;
  cleanWorkingTree: boolean;
  behind: number | null;
  ahead: number | null;
}> {
  const inGitRepo = await run("git", ["rev-parse", "--is-inside-work-tree"], 5000);
  if (!inGitRepo.ok || inGitRepo.stdout.trim() !== "true") {
    return {
      installMode: "unknown",
      supported: false,
      unsupportedReason: "Mission Control is not running from a git checkout.",
      branch: null,
      upstream: null,
      cleanWorkingTree: false,
      behind: null,
      ahead: null,
    };
  }

  if (refreshRemote) {
    await run("git", ["fetch", "--prune", "--tags", "origin"], 30000);
  }

  const branchRes = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], 6000);
  const branch = branchRes.ok ? branchRes.stdout.trim() : "";
  if (!branch) {
    return {
      installMode: "git",
      supported: false,
      unsupportedReason: "Could not resolve current git branch.",
      branch: null,
      upstream: null,
      cleanWorkingTree: false,
      behind: null,
      ahead: null,
    };
  }

  const upstream = await resolveUpstream(branch);
  if (!upstream) {
    return {
      installMode: "git",
      supported: false,
      unsupportedReason: "No upstream branch found for this checkout.",
      branch,
      upstream: null,
      cleanWorkingTree: false,
      behind: null,
      ahead: null,
    };
  }

  const status = await run("git", ["status", "--porcelain", "--untracked-files=no"], 6000);
  const cleanWorkingTree = status.ok && status.stdout.trim().length === 0;

  const behindRes = await run("git", ["rev-list", "--count", `HEAD..${upstream}`], 6000);
  const aheadRes = await run("git", ["rev-list", "--count", `${upstream}..HEAD`], 6000);
  const behind = behindRes.ok ? Number.parseInt(behindRes.stdout.trim(), 10) : NaN;
  const ahead = aheadRes.ok ? Number.parseInt(aheadRes.stdout.trim(), 10) : NaN;

  const supported = cleanWorkingTree;
  const unsupportedReason = supported
    ? null
    : "Local git changes detected. Commit or stash changes before updating.";

  return {
    installMode: "git",
    supported,
    unsupportedReason,
    branch,
    upstream,
    cleanWorkingTree,
    behind: Number.isFinite(behind) ? behind : null,
    ahead: Number.isFinite(ahead) ? ahead : null,
  };
}

async function buildStatus(refreshRemote = false): Promise<UpdateStatus> {
  const [currentVersion, latest, install] = await Promise.all([
    readCurrentVersion(),
    readLatestVersionFromNpm(),
    inspectInstallMode(refreshRemote),
  ]);

  const updateFromGit =
    install.installMode === "git" &&
    typeof install.behind === "number" &&
    install.behind > 0;

  const updateFromRegistry = Boolean(
    currentVersion &&
    latest.latestVersion &&
    compareSemver(latest.latestVersion, currentVersion) > 0
  );

  const updateAvailable = updateFromGit || updateFromRegistry;

  return {
    currentVersion,
    latestVersion: latest.latestVersion,
    updateAvailable,
    installMode: install.installMode,
    supported: install.supported,
    unsupportedReason: install.unsupportedReason,
    branch: install.branch,
    upstream: install.upstream,
    cleanWorkingTree: install.cleanWorkingTree,
    behind: install.behind,
    ahead: install.ahead,
    releaseUrl: latest.releaseUrl,
    restartHint: buildRestartHint(),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export const GET = withRoute({ name: "/api/mission-control-update" }, async () => {
  try {
    const status = await buildStatus(true);
    return NextResponse.json(status);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  }
});

export const POST = withRoute<MissionControlUpdatePostInput>(
  { name: "/api/mission-control-update", bodySchema: missionControlUpdatePostSchema },
  async (_request) => {
  try {
    if (updateInProgress) {
      return conflict("An update is already in progress.");
    }

    // Schema-enumerated (T-02-58): the body schema only accepts an omitted
    // action or the literal "run-update" — any other value was already
    // rejected before this handler ran, so there is no action to switch on.
    updateInProgress = true;
    const before = await buildStatus(true);
    if (before.installMode !== "git") {
      return NextResponse.json(
        {
          ok: false,
          error: before.unsupportedReason || "This install mode is not supported for in-dashboard updates.",
          status: before,
        },
        { status: 400 }
      );
    }
    if (!before.supported || !before.cleanWorkingTree) {
      return NextResponse.json(
        {
          ok: false,
          error: before.unsupportedReason || "Working tree must be clean before updating.",
          status: before,
        },
        { status: 409 }
      );
    }
    if (!before.upstream) {
      return NextResponse.json(
        {
          ok: false,
          error: "No upstream branch found for current checkout.",
          status: before,
        },
        { status: 400 }
      );
    }

    const upstreamInfo = parseRemoteAndBranch(before.upstream);
    if (!upstreamInfo) {
      return NextResponse.json(
        {
          ok: false,
          error: `Unsupported upstream format: ${before.upstream}`,
          status: before,
        },
        { status: 400 }
      );
    }

    const steps: Array<{ step: string; ok: boolean; detail?: string }> = [];
    const pullRes = await run(
      "git",
      ["pull", "--ff-only", upstreamInfo.remote, upstreamInfo.branch],
      120000
    );
    steps.push({
      step: `git pull --ff-only ${upstreamInfo.remote} ${upstreamInfo.branch}`,
      ok: pullRes.ok,
      detail: (pullRes.stderr || pullRes.stdout || "").trim() || undefined,
    });
    if (!pullRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Git pull failed.",
          steps,
          status: before,
        },
        { status: 500 }
      );
    }

    const hasLock = await pathExists(join(process.cwd(), "package-lock.json"));
    const installCmd = hasLock
      ? ["ci", "--include=optional", "--no-audit", "--no-fund"]
      : ["install", "--include=optional", "--no-audit", "--no-fund"];
    const installRes = await run("npm", installCmd, 600000);
    steps.push({
      step: `npm ${installCmd.join(" ")}`,
      ok: installRes.ok,
      detail: (installRes.stderr || installRes.stdout || "").trim().slice(-2000) || undefined,
    });
    if (!installRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Dependency install failed.",
          steps,
        },
        { status: 500 }
      );
    }

    const buildRes = await run("npm", ["run", "build"], 900000);
    steps.push({
      step: "npm run build",
      ok: buildRes.ok,
      detail: (buildRes.stderr || buildRes.stdout || "").trim().slice(-2000) || undefined,
    });
    if (!buildRes.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Build failed after update.",
          steps,
        },
        { status: 500 }
      );
    }

    const after = await buildStatus(false);
    return NextResponse.json({
      ok: true,
      steps,
      before,
      after,
      restartRequired: true,
      restartHint: after.restartHint || "Restart Mission Control to apply the updated build.",
    });
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err), 500);
  } finally {
    updateInProgress = false;
  }
  },
);
