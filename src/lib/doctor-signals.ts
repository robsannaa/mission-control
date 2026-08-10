/**
 * Live signals the CLI's doctor never looks at.
 *
 * `openclaw doctor` inspects configuration and state on disk. The gateway knows
 * things about *right now* that no config file can tell you — and several of
 * them are real, currently-true problems this page has never shown:
 *
 *   - `status.queuedSystemEvents` holds "Gateway restart required (config.patch)".
 *     A pending change is sitting there waiting for a restart nobody was told
 *     about.
 *   - `models.authStatus` reports token expiry with a remaining-time label and
 *     usage windows with a percentage. That is prevention with no invention:
 *     the numbers are the provider's own.
 *   - `health.plugins.errors` and `health.eventLoop.degraded` are boolean facts
 *     about the running process.
 *   - `system.info` reports disk headroom and the Node version the *daemon* is
 *     on — which corroborates the unsupported-Node finding from a second,
 *     independent source.
 *
 * Everything here is read-only. Nothing is derived from liveness alone: the
 * gateway answering a ping is not evidence that anything is healthy, and this
 * module never treats it as such.
 */

import { gatewayCall } from "./openclaw";
import { redact } from "./doctor-redact";
import { nodeRuntimeFacts } from "./doctor-exec";
import type { DoctorFinding, DoctorSourceRun, DoctorVital } from "./doctor-types";

// ── RPC payload shapes (only the fields we actually read) ───────────────────

type StatusPayload = {
  runtimeVersion?: string;
  queuedSystemEvents?: string[];
  taskAudit?: { total?: number; warnings?: number; errors?: number; byCode?: Record<string, number> };
  tasks?: { total?: number; active?: number; failures?: number };
  sessions?: { count?: number };
};

type HealthPayload = {
  ok?: boolean;
  eventLoop?: { degraded?: boolean; reasons?: string[]; delayP99Ms?: number; utilization?: number };
  plugins?: { loaded?: unknown[]; errors?: { id?: string; error?: string }[] };
  configReload?: { hotReloadStatus?: string };
};

type SystemInfoPayload = {
  nodeVersion?: string;
  uptimeMs?: number;
  cpuCount?: number;
  loadAverage?: number[];
  memoryTotalBytes?: number;
  memoryFreeBytes?: number;
  diskTotalBytes?: number;
  diskAvailableBytes?: number;
  platform?: string;
  port?: number;
};

type AuthStatusPayload = {
  providers?: {
    provider?: string;
    displayName?: string;
    status?: string;
    expiry?: { at?: number; remainingMs?: number; label?: string };
    usage?: { windows?: { label?: string; usedPercent?: number; resetAt?: number }[]; plan?: string };
  }[];
};

export type RuntimeSignals = {
  run: DoctorSourceRun;
  reachable: boolean;
  findings: DoctorFinding[];
  prevention: DoctorFinding[];
  vitals: DoctorVital[];
  gateway: {
    runtimeVersion: string | null;
    nodeVersion: string | null;
    uptimeMs: number | null;
    port: number;
  };
  /** Hard inputs the score uses directly. */
  score: {
    pluginErrors: number;
    eventLoopDegraded: boolean;
    queuedSystemEvents: number;
    taskAuditErrors: number;
    taskAuditWarnings: number;
    diskFreeRatio: number | null;
  };
};

function finding(partial: Partial<DoctorFinding> & Pick<DoctorFinding, "id" | "title">): DoctorFinding {
  return {
    checkId: partial.id,
    source: "runtime",
    confidence: "structured",
    severity: "warning",
    family: "Live status",
    explanation: "",
    impact: "",
    evidence: [],
    paths: [],
    causedBy: null,
    causes: [],
    informational: false,
    fix: null,
    guide: [],
    docs: null,
    mergedFrom: [],
    ...partial,
  };
}

/**
 * Decimal GB, matching what macOS and the OpenClaw CLI report. Using binary
 * units while writing "GB" would make our disk figure disagree with every other
 * number the user can see, for no benefit.
 */
function formatBytes(bytes: number): string {
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
}

function formatDuration(ms: number): string {
  const days = Math.floor(ms / 86_400_000);
  const hours = Math.floor((ms % 86_400_000) / 3_600_000);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

const DAY = 86_400_000;

export async function collectRuntimeSignals(timeoutMs = 8000): Promise<RuntimeSignals> {
  const startedAt = Date.now();
  const [status, health, systemInfo, authStatus] = await Promise.all([
    gatewayCall<StatusPayload>("status", {}, timeoutMs).catch(() => null),
    gatewayCall<HealthPayload>("health", {}, timeoutMs).catch(() => null),
    gatewayCall<SystemInfoPayload>("system.info", {}, timeoutMs).catch(() => null),
    gatewayCall<AuthStatusPayload>("models.authStatus", {}, timeoutMs).catch(() => null),
  ]);

  const reachable = Boolean(status || health || systemInfo);
  const findings: DoctorFinding[] = [];
  const prevention: DoctorFinding[] = [];
  const vitals: DoctorVital[] = [];

  const run: DoctorSourceRun = {
    ran: true,
    ok: reachable,
    ts: Date.now(),
    durationMs: Date.now() - startedAt,
    error: reachable ? null : "The gateway did not answer.",
    invocation: "gateway: status, health, system.info, models.authStatus",
  };

  if (!reachable) {
    findings.push(
      finding({
        id: "runtime:gateway-unreachable",
        severity: "error",
        family: "Live status",
        title: "The background service is not answering",
        explanation:
          "OpenClaw's gateway is the process everything else talks to. Mission Control cannot reach it, so nothing on this page reflects what is actually happening right now.",
        impact:
          "Chat channels, scheduled jobs and the assistant itself are all down until it comes back.",
        fix: null,
        guide: [
          {
            title: "Start the background service",
            detail: "Starts the service that runs OpenClaw in the background.",
            command: "openclaw gateway start",
            verify: "This page starts showing live data again.",
          },
        ],
      }),
    );
    return {
      run,
      reachable,
      findings,
      prevention,
      vitals,
      gateway: { runtimeVersion: null, nodeVersion: null, uptimeMs: null, port: 18789 },
      score: {
        pluginErrors: 0,
        eventLoopDegraded: false,
        queuedSystemEvents: 0,
        taskAuditErrors: 0,
        taskAuditWarnings: 0,
        diskFreeRatio: null,
      },
    };
  }

  // ── Pending system events ─────────────────────────────────────────────────
  // A real, currently-queued problem the old page never surfaced.
  const queued = status?.queuedSystemEvents ?? [];
  for (const [index, event] of queued.entries()) {
    const restartRequired = /restart required/i.test(event);
    findings.push(
      finding({
        id: restartRequired ? "runtime:restart-required" : `runtime:queued-event-${index}`,
        checkId: "runtime/queued-system-event",
        severity: "warning",
        family: "Live status",
        title: restartRequired
          ? "A settings change is waiting for a restart"
          : "OpenClaw has a message waiting for you",
        explanation: restartRequired
          ? "Something changed in your settings that the running service cannot pick up on the fly. It is holding the change until the service restarts."
          : redact(event.split("\n")[0]),
        impact: restartRequired
          ? "Until you restart, the running service is using the previous settings — so a change you made is not actually in effect."
          : "",
        evidence: [redact(event)],
        fix: restartRequired
          ? {
              id: "gateway-restart",
              label: "Restart the background service",
              safety: "caution",
              whatItDoes:
                "Stops and starts the OpenClaw background service so the pending change takes effect.",
              sideEffects: [
                "Anything the assistant is running right now is interrupted.",
                "Connected chat channels reconnect; messages sent during the restart may be delayed.",
              ],
              requiresRestart: false,
              requiresConfirmation: true,
              previewAvailable: true,
              blocked: null,
              command: "openclaw gateway restart",
              alsoResolves: [],
            }
          : null,
      }),
    );
  }

  // ── Add-ons that failed to load ───────────────────────────────────────────
  const pluginErrors = health?.plugins?.errors ?? [];
  if (pluginErrors.length) {
    findings.push(
      finding({
        id: "runtime:plugin-errors",
        checkId: "runtime/plugin-errors",
        severity: "error",
        family: "Add-ons",
        title: `${pluginErrors.length} add-on${pluginErrors.length === 1 ? "" : "s"} failed to start`,
        explanation:
          "These add-ons errored while loading, so whatever they provide is missing right now.",
        impact: "Channels, tools or providers you expect to be there simply will not appear.",
        evidence: pluginErrors.map((e) => redact(`${e.id ?? "unknown"}: ${e.error ?? ""}`)),
      }),
    );
  }

  // ── Responsiveness ────────────────────────────────────────────────────────
  const eventLoop = health?.eventLoop;
  if (eventLoop?.degraded) {
    findings.push(
      finding({
        id: "runtime:event-loop-degraded",
        checkId: "runtime/event-loop",
        severity: "warning",
        family: "Live status",
        title: "OpenClaw is struggling to keep up",
        explanation:
          "The service is taking noticeably long to get round to queued work. Replies will feel slow and scheduled jobs may run late.",
        impact: "Usually a sign of heavy load or a runaway task rather than a broken install.",
        evidence: (eventLoop.reasons ?? []).map(redact),
      }),
    );
  } else if (typeof eventLoop?.delayP99Ms === "number") {
    vitals.push({
      id: "responsiveness",
      label: "Responsiveness",
      value: `${eventLoop.delayP99Ms.toFixed(0)} ms`,
      detail:
        typeof eventLoop.utilization === "number"
          ? `${Math.round(eventLoop.utilization * 100)}% busy`
          : undefined,
      status: "ok",
      source: "runtime",
    });
  }

  // ── Task delivery ─────────────────────────────────────────────────────────
  const audit = status?.taskAudit;
  if (audit && ((audit.errors ?? 0) > 0 || (audit.warnings ?? 0) > 0)) {
    const codes = Object.entries(audit.byCode ?? {})
      .filter(([, n]) => n > 0)
      .map(([code, n]) => `${code.replace(/_/g, " ")}: ${n}`);
    findings.push(
      finding({
        id: "runtime:task-audit",
        checkId: "runtime/task-audit",
        severity: (audit.errors ?? 0) > 0 ? "error" : "warning",
        family: "Background work",
        title: `${(audit.errors ?? 0) + (audit.warnings ?? 0)} background job${
          (audit.errors ?? 0) + (audit.warnings ?? 0) === 1 ? "" : "s"
        } did not finish cleanly`,
        explanation:
          "OpenClaw audits its own job records and found some that ended in a state it did not expect — a result that was never delivered, or a job that vanished mid-run.",
        impact:
          "Something you asked for may not have happened, and nothing would have told you.",
        evidence: codes,
      }),
    );
  }

  // ── Disk headroom ─────────────────────────────────────────────────────────
  let diskFreeRatio: number | null = null;
  if (systemInfo?.diskTotalBytes && systemInfo.diskAvailableBytes != null) {
    diskFreeRatio = systemInfo.diskAvailableBytes / systemInfo.diskTotalBytes;
    const detail = `${formatBytes(systemInfo.diskAvailableBytes)} free of ${formatBytes(systemInfo.diskTotalBytes)}`;
    if (diskFreeRatio < 0.05) {
      prevention.push(
        finding({
          id: "runtime:disk-critical",
          checkId: "runtime/disk-space",
          severity: "error",
          family: "Storage",
          title: "This machine is almost out of disk space",
          explanation: `Only ${detail} remains. OpenClaw writes conversation transcripts and logs continuously and will start failing to save them.`,
          impact: "Conversations, logs and scheduled job results will be lost as they happen.",
          evidence: [detail],
        }),
      );
    } else if (diskFreeRatio < 0.1) {
      prevention.push(
        finding({
          id: "runtime:disk-low",
          checkId: "runtime/disk-space",
          severity: "warning",
          family: "Storage",
          title: "Disk space is getting low",
          explanation: `${detail} remains. Nothing is failing yet.`,
          impact: "Once it runs out, OpenClaw stops being able to save conversations and logs.",
          evidence: [detail],
        }),
      );
    } else {
      vitals.push({
        id: "disk",
        label: "Disk space",
        value: `${Math.round(diskFreeRatio * 100)}% free`,
        detail,
        status: "ok",
        source: "runtime",
      });
    }
  }

  // Memory is deliberately *not* a warning source on macOS: the kernel keeps
  // free memory near zero by design (it caches aggressively and reclaims on
  // demand), so "922 MB free of 17 GB" is normal, not a problem. Reporting it
  // as one would be exactly the kind of invented alarm this page exists to
  // avoid. Shown as a neutral vital instead.
  if (systemInfo?.memoryTotalBytes && systemInfo.memoryFreeBytes != null) {
    vitals.push({
      id: "memory",
      label: "Memory",
      value: formatBytes(systemInfo.memoryTotalBytes),
      detail:
        systemInfo.platform === "darwin"
          ? `${formatBytes(systemInfo.memoryFreeBytes)} unallocated (macOS caches the rest)`
          : `${formatBytes(systemInfo.memoryFreeBytes)} free`,
      status: "ok",
      source: "runtime",
    });
  }

  if (typeof systemInfo?.uptimeMs === "number") {
    vitals.push({
      id: "uptime",
      label: "Running for",
      value: formatDuration(systemInfo.uptimeMs),
      status: "ok",
      source: "runtime",
    });
  }

  // ── Credential expiry and quota (prevention) ──────────────────────────────
  for (const provider of authStatus?.providers ?? []) {
    const name = provider.displayName || provider.provider || "a provider";
    const remaining = provider.expiry?.remainingMs;
    if (typeof remaining === "number" && remaining > 0 && remaining < 3 * DAY) {
      prevention.push(
        finding({
          id: `runtime:auth-expiry-${provider.provider}`,
          checkId: "runtime/auth-expiry",
          severity: remaining < DAY ? "error" : "warning",
          family: "Sign-ins",
          title: `Your ${name} sign-in expires in ${provider.expiry?.label ?? "under 3 days"}`,
          explanation:
            "OpenClaw signs in to this provider on your behalf. When the sign-in expires it stops being able to, and requests start failing.",
          impact: "Sign in again before it lapses and nothing breaks.",
          evidence: [`expires ${new Date(provider.expiry?.at ?? 0).toISOString()}`],
        }),
      );
    } else if (typeof remaining === "number" && remaining > 0) {
      vitals.push({
        id: `auth-${provider.provider}`,
        label: `${name} sign-in`,
        value: `valid for ${provider.expiry?.label ?? formatDuration(remaining)}`,
        status: "ok",
        source: "runtime",
      });
    }

    for (const window of provider.usage?.windows ?? []) {
      if (typeof window.usedPercent !== "number") continue;
      if (window.usedPercent >= 85) {
        prevention.push(
          finding({
            id: `runtime:usage-${provider.provider}-${window.label}`,
            checkId: "runtime/usage-window",
            severity: window.usedPercent >= 95 ? "error" : "warning",
            family: "Usage limits",
            title: `You have used ${window.usedPercent}% of your ${name} allowance`,
            explanation: `This is the rolling ${window.label} window. When it reaches 100% requests are refused until it resets.`,
            impact: window.resetAt
              ? `It resets at ${new Date(window.resetAt).toISOString()}.`
              : "",
            evidence: [`${window.label}: ${window.usedPercent}%`],
          }),
        );
      } else {
        vitals.push({
          id: `usage-${provider.provider}-${window.label}`,
          label: `${name} allowance`,
          value: `${window.usedPercent}% used`,
          detail: `rolling ${window.label} window`,
          status: "ok",
          source: "runtime",
        });
      }
    }
  }

  // ── Node corroboration ────────────────────────────────────────────────────
  // A second, independent source for the unsupported-Node finding: the daemon
  // reports the version it is actually running on, and Mission Control knows
  // whether it had to borrow one to talk to the CLI at all.
  const node = nodeRuntimeFacts();
  if (!node.serverNodeSupported) {
    findings.push(
      finding({
        id: "runtime:mission-control-node",
        checkId: "runtime/node-version",
        severity: "warning",
        family: "Runtime",
        title: `Mission Control itself is running on Node ${node.serverNode}, which OpenClaw does not support`,
        explanation: node.borrowed
          ? `To talk to OpenClaw at all, this page has to borrow Node ${node.borrowed.version} from elsewhere on the machine. That works, but only while that copy stays where it is.`
          : "This page could not find a supported Node version to fall back on, so commands that shell out to OpenClaw may fail outright.",
        impact:
          "If the borrowed version is removed or upgraded, the Doctor and Security pages stop working with a confusing runtime error.",
        evidence: [
          `Mission Control node ${node.serverNode}`,
          node.borrowed ? `borrowed ${node.borrowed.version} from ${redact(node.borrowed.path)}` : "no compatible fallback found",
          systemInfo?.nodeVersion ? `gateway node ${systemInfo.nodeVersion}` : "",
        ].filter(Boolean),
        // Same underlying problem the CLI reports; the chain is wired up in the
        // snapshot once both sources are present.
        causedBy: "legacy:node-unsupported",
      }),
    );
  }

  return {
    run,
    reachable,
    findings,
    prevention,
    vitals,
    gateway: {
      runtimeVersion: status?.runtimeVersion ?? null,
      nodeVersion: systemInfo?.nodeVersion ?? null,
      uptimeMs: systemInfo?.uptimeMs ?? null,
      port: systemInfo?.port ?? 18789,
    },
    score: {
      pluginErrors: pluginErrors.length,
      eventLoopDegraded: Boolean(eventLoop?.degraded),
      queuedSystemEvents: queued.length,
      taskAuditErrors: audit?.errors ?? 0,
      taskAuditWarnings: audit?.warnings ?? 0,
      diskFreeRatio,
    },
  };
}
