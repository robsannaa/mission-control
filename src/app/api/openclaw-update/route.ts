import { NextResponse } from "next/server";
import { CONFIG_WRITE_TIMEOUT_MS, runCli, runCliJson } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { openclawUpdatePostSchema, type OpenClawUpdatePostInput } from "@/lib/schemas/updates";

const GITHUB_RELEASES_URL =
  "https://api.github.com/repos/openclaw/openclaw/releases/latest";

/** Normalize version string for comparison (e.g. "v2026.2.19" or "2026.2.19" -> "2026.2.19"). */
function normalizeVersion(v: string): string {
  const raw = String(v || "").trim().replace(/^openclaw\s+/i, "");
  const noPrefix = raw.replace(/^v/i, "").trim();
  const calendarMatch = noPrefix.match(/\d+(?:\.\d+){1,3}/);
  if (calendarMatch?.[0]) return calendarMatch[0];
  const firstToken = noPrefix.split(/\s+/)[0];
  return firstToken || "";
}

/**
 * Compare two calendar-style versions (e.g. 2026.2.19).
 * Returns: 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(".").map(Number);
  const pb = normalizeVersion(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export const dynamic = "force-dynamic";

type UpdateStatusJson = {
  availability?: {
    available?: boolean;
    latestVersion?: string | null;
  };
  channel?: {
    value?: string | null;
    source?: string | null;
    label?: string | null;
  };
  update?: {
    installKind?: string | null;
    packageManager?: string | null;
  };
};

type UpdateRunJson = {
  mode?: string;
  restart?: boolean;
  effectiveChannel?: string | null;
  currentVersion?: string | null;
  targetVersion?: string | null;
  actions?: string[];
  notes?: string[];
};

/**
 * GET /api/openclaw-update
 * Returns current OpenClaw version, latest release from GitHub, and whether an update is available.
 * Optionally includes changelog (release body) for the latest release.
 */
export const GET = withRoute({ name: "/api/openclaw-update" }, async (_request, ctx) => {
  try {
    let currentVersion = "";
    let statusInfo: UpdateStatusJson | null = null;
    try {
      const out = await runCli(["--version"], 5000);
      currentVersion = (out || "").trim().replace(/^openclaw\s+/i, "").trim();
    } catch {
      // Fallback: might be in config; leave currentVersion empty and we'll still show latest
    }
    try {
      statusInfo = await runCliJson<UpdateStatusJson>(["update", "status"], 10000);
    } catch {
      statusInfo = null;
    }

    const res = await fetch(GITHUB_RELEASES_URL, {
      next: { revalidate: 3600 },
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return NextResponse.json({
        currentVersion: currentVersion || null,
        latestVersion: normalizeVersion(statusInfo?.availability?.latestVersion || "") || null,
        updateAvailable: false,
        channel: statusInfo?.channel?.value || null,
        channelLabel: statusInfo?.channel?.label || null,
        installKind: statusInfo?.update?.installKind || null,
        error: "Could not fetch latest release",
      });
    }

    const release = (await res.json()) as {
      tag_name?: string;
      name?: string;
      body?: string | null;
      html_url?: string;
    };
    const latestFromRelease = normalizeVersion(release.tag_name || release.name || "");
    const latestFromCli = normalizeVersion(statusInfo?.availability?.latestVersion || "");
    const latestVersion = latestFromCli || latestFromRelease;
    const updateAvailable = Boolean(statusInfo?.availability?.available) || (
      !!currentVersion &&
      !!latestVersion &&
      compareVersions(latestVersion, currentVersion) > 0
    );

    return NextResponse.json({
      currentVersion: currentVersion || null,
      latestVersion: latestVersion || null,
      updateAvailable,
      channel: statusInfo?.channel?.value || null,
      channelLabel: statusInfo?.channel?.label || null,
      installKind: statusInfo?.update?.installKind || null,
      changelog: release.body?.trim() || null,
      releaseUrl: release.html_url || `https://github.com/openclaw/openclaw/releases/tag/${release.tag_name || "latest"}`,
    });
  } catch (err) {
    ctx.log.error({ err: err instanceof Error ? { message: err.message } : String(err) }, "OpenClaw update check error");
    return NextResponse.json({
      currentVersion: null,
      latestVersion: null,
      updateAvailable: false,
      error: String(err),
    });
  }
});

/**
 * POST /api/openclaw-update
 * Runs `openclaw update --yes` (optionally channel/no-restart) directly from the browser.
 *
 * Schema-enumerated (T-02-58): `action` is validated to `"status" |
 * "run-update"` (or omitted, defaulting to "run-update") before this handler
 * runs, so the route's former `Unknown action: <value>` fallback branch is
 * unreachable and has been removed.
 */
export const POST = withRoute<OpenClawUpdatePostInput>(
  { name: "/api/openclaw-update", bodySchema: openclawUpdatePostSchema },
  async (_request, ctx) => {
  try {
    const action = ctx.body.action ?? "run-update";

    if (action === "status") {
      const status = await runCliJson<UpdateStatusJson>(["update", "status"], 10000);
      return NextResponse.json({ ok: true, status });
    }

    const requestedChannel = String(ctx.body.channel || "").trim().toLowerCase();
    const noRestart = ctx.body.noRestart === true;
    const dryRun = ctx.body.dryRun === true;
    if (requestedChannel && !["stable", "beta", "dev"].includes(requestedChannel)) {
      return badRequest("Invalid channel. Use stable, beta, or dev.");
    }

    const args = ["update", "--yes", "--timeout", "1200"];
    if (requestedChannel) args.push("--channel", requestedChannel);
    if (dryRun) args.push("--dry-run");
    if (noRestart) args.push("--no-restart");

    const result = await runCliJson<UpdateRunJson>(args, 1_260_000);

    let versionAfter: string | null = null;
    try {
      const out = await runCli(["--version"], 5000);
      versionAfter = (out || "").trim().replace(/^openclaw\s+/i, "").trim() || null;
    } catch {
      versionAfter = null;
    }

    let wizardLastRunVersionSynced = false;
    let wizardLastRunVersionSyncError: string | null = null;
    if (!dryRun && versionAfter) {
      const normalizedInstalledVersion = normalizeVersion(versionAfter);
      if (normalizedInstalledVersion) {
        try {
          await runCli(
            // Runs right after an update, when the new version still has to
            // rebuild its plugin cache — the slowest `config set` there is.
            ["config", "set", "wizard.lastRunVersion", normalizedInstalledVersion],
            CONFIG_WRITE_TIMEOUT_MS,
          );
          wizardLastRunVersionSynced = true;
        } catch (err) {
          wizardLastRunVersionSyncError = err instanceof Error ? err.message : String(err);
        }
      }
    }

    return NextResponse.json({
      ok: true,
      result,
      dryRun,
      currentVersionAfter: versionAfter,
      wizardLastRunVersionSynced,
      ...(wizardLastRunVersionSyncError
        ? { wizardLastRunVersionSyncError }
        : {}),
    });
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);
