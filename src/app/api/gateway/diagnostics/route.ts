import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { gatewayCall } from "@/lib/openclaw";
import { getOpenClawBin } from "@/lib/paths";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

const exec = promisify(execFile);
const ANSI_RE = /\u001B\[[0-9;]*m/g;
const BOX_LINE_RE = /^[\s|│┌┐└┘├┤╭╮╯╰─━]+$/;
const BLOCK_ART_RE = /^[\s▀▄█░]+$/;
const MAX_DOCTOR_RAW = 30000;
const MAX_DOCTOR_LINES = 160;
const MAX_HIGHLIGHTS = 60;

type Severity = "error" | "warning" | "info";
type Source = "gateway-status" | "doctor";

type Highlight = {
  source: Source;
  severity: Severity;
  text: string;
};

type GatewayStatusPayload = {
  service?: {
    loaded?: boolean;
    runtime?: {
      status?: string;
      state?: string;
      pid?: number;
    };
    configAudit?: {
      ok?: boolean;
      issues?: unknown[];
    };
  };
  config?: {
    cli?: { exists?: boolean; valid?: boolean; path?: string };
    daemon?: { exists?: boolean; valid?: boolean; path?: string };
  };
  gateway?: {
    bindMode?: string;
    bindHost?: string;
    port?: number;
  };
  port?: {
    port?: number;
    status?: string;
    hints?: unknown[];
    listeners?: Array<{ commandLine?: string; command?: string; pid?: number }>;
  };
  rpc?: {
    ok?: boolean;
    url?: string;
  };
  extraServices?: unknown[];
};

type DoctorResult = {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  timedOut: boolean;
};

function formatErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function runDoctor(): Promise<DoctorResult> {
  const bin = await getOpenClawBin();
  const args = ["doctor", "--non-interactive"];
  try {
    const { stdout, stderr } = await exec(bin, args, {
      timeout: 45000,
      env: { ...process.env, NO_COLOR: "1", OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: "1" },
    });
    return {
      ok: true,
      exitCode: 0,
      stdout: stdout || "",
      stderr: stderr || "",
      command: `openclaw ${args.join(" ")}`,
      timedOut: false,
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: NodeJS.Signals | null;
    };
    const maybeExitCode =
      typeof e.code === "number" ? e.code : e.code === "ETIMEDOUT" ? 124 : 1;
    return {
      ok: false,
      exitCode: maybeExitCode,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      command: `openclaw ${args.join(" ")}`,
      timedOut: Boolean(e.killed || e.signal === "SIGTERM" || e.code === "ETIMEDOUT"),
    };
  }
}

function classifySeverity(text: string): Severity | null {
  const line = text.toLowerCase();
  if (/^\s*$/.test(line)) return null;
  if (/no\s+.*warnings?/.test(line) || /no\s+.*errors?/.test(line)) return "info";
  if (
    /\b(error|failed|failure|offline|unhealthy|not running|cannot|invalid|denied|refused)\b/.test(
      line
    )
  ) {
    return "error";
  }
  if (
    /\b(warn|warning|missing|blocked|stale|legacy|repair|restart|collision|not loaded|expired)\b/.test(
      line
    )
  ) {
    return "warning";
  }
  if (/\b(ok|healthy|complete|running)\b/.test(line)) return "info";
  return null;
}

function normalizeDoctorLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(ANSI_RE, ""))
    .map((line) => line.replace(/^\s*[|│┌┐└┘├┤╭╮╯╰]+\s*/, "").trim())
    .filter((line) => line.length > 0)
    .filter((line) => !BOX_LINE_RE.test(line))
    .filter((line) => !BLOCK_ART_RE.test(line))
    .slice(0, MAX_DOCTOR_LINES);
}

function dedupeHighlights(items: Highlight[]): Highlight[] {
  const seen = new Set<string>();
  const out: Highlight[] = [];
  for (const item of items) {
    const key = `${item.source}:${item.severity}:${item.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function summarize(items: Highlight[]) {
  return items.reduce(
    (acc, item) => {
      acc[item.severity] += 1;
      return acc;
    },
    { error: 0, warning: 0, info: 0 }
  );
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function buildStatusHighlights(status: GatewayStatusPayload): Highlight[] {
  const out: Highlight[] = [];
  const loaded = status.service?.loaded;
  const runtimeStatus = (status.service?.runtime?.status || "").toLowerCase();
  const runtimeState = status.service?.runtime?.state;
  const pid = status.service?.runtime?.pid;
  const rpcOk = Boolean(status.rpc?.ok);

  if (loaded === false) {
    out.push({
      source: "gateway-status",
      severity: "warning",
      text: "Gateway service is not loaded in the supervisor.",
    });
  }

  if (runtimeStatus && runtimeStatus !== "running") {
    out.push({
      source: "gateway-status",
      severity: "error",
      text: `Gateway runtime is ${runtimeStatus}${runtimeState ? ` (${runtimeState})` : ""}.`,
    });
  }

  if (pid && runtimeStatus === "running") {
    out.push({
      source: "gateway-status",
      severity: "info",
      text: `Gateway process is running (pid ${pid}).`,
    });
  }

  if (!status.config?.cli?.exists || status.config?.cli?.valid === false) {
    out.push({
      source: "gateway-status",
      severity: "error",
      text: "CLI config is missing or invalid.",
    });
  }

  if (!status.config?.daemon?.exists || status.config?.daemon?.valid === false) {
    out.push({
      source: "gateway-status",
      severity: "error",
      text: "Daemon config is missing or invalid.",
    });
  }

  const configAuditIssues = status.service?.configAudit?.issues || [];
  for (const issue of configAuditIssues) {
    const text = asText(issue);
    if (!text) continue;
    out.push({
      source: "gateway-status",
      severity: "warning",
      text: `Config audit: ${text}`,
    });
  }

  if (!rpcOk) {
    out.push({
      source: "gateway-status",
      severity: "error",
      text: "RPC probe failed; clients may not be able to connect.",
    });
  }

  const listeners = status.port?.listeners || [];
  if (status.port?.status === "busy" && listeners.length > 0) {
    const looksLikeGateway = listeners.some((l) =>
      `${l.commandLine || ""} ${l.command || ""}`.toLowerCase().includes("openclaw-gateway")
    );
    if (!looksLikeGateway) {
      out.push({
        source: "gateway-status",
        severity: "warning",
        text: `Gateway port ${status.port?.port || status.gateway?.port || ""} is busy by another process.`,
      });
    }
  }

  for (const hint of status.port?.hints || []) {
    const text = asText(hint).trim();
    if (!text) continue;
    const sev = classifySeverity(text) || "info";
    out.push({ source: "gateway-status", severity: sev, text });
  }

  if ((status.extraServices || []).length > 0) {
    out.push({
      source: "gateway-status",
      severity: "warning",
      text: `Detected ${(status.extraServices || []).length} extra gateway-like service(s).`,
    });
  }

  if (out.length === 0) {
    out.push({
      source: "gateway-status",
      severity: "info",
      text: "Gateway status checks look healthy.",
    });
  }

  return out;
}

export const GET = withRoute({ name: "/api/gateway/diagnostics" }, async () => {
  let status: GatewayStatusPayload | null = null;
  let statusErr: string | null = null;

  try {
    status = await gatewayCall<GatewayStatusPayload>("status", {}, 30000);
  } catch (err) {
    statusErr = formatErr(err);
  }

  const doctorResult = await runDoctor();
  const doctorRaw = `${doctorResult.stdout}${doctorResult.stderr ? `\n${doctorResult.stderr}` : ""}`
    .trim()
    .slice(0, MAX_DOCTOR_RAW);
  const doctorLines = normalizeDoctorLines(doctorRaw);

  const doctorHighlights: Highlight[] = [];
  for (const line of doctorLines) {
    const severity = classifySeverity(line);
    if (!severity) continue;
    doctorHighlights.push({ source: "doctor", severity, text: line });
  }
  if (!doctorResult.ok) {
    doctorHighlights.push({
      source: "doctor",
      severity: "error",
      text: doctorResult.timedOut
        ? "Doctor timed out while running diagnostics."
        : `Doctor exited with code ${doctorResult.exitCode}.`,
    });
  }

  const statusHighlights = status
    ? buildStatusHighlights(status)
    : [
        {
          source: "gateway-status" as const,
          severity: "error" as const,
          text: `Failed to load gateway status: ${statusErr || "unknown error"}`,
        },
      ];

  const highlights = dedupeHighlights(
    [...statusHighlights, ...doctorHighlights].sort((a, b) => {
      const rank: Record<Severity, number> = { error: 0, warning: 1, info: 2 };
      return rank[a.severity] - rank[b.severity];
    })
  ).slice(0, MAX_HIGHLIGHTS);

  return NextResponse.json({
    ts: Date.now(),
    status,
    statusError: statusErr,
    doctor: {
      command: doctorResult.command,
      ok: doctorResult.ok,
      exitCode: doctorResult.exitCode,
      summary: summarize(doctorHighlights),
      highlights: dedupeHighlights(doctorHighlights).slice(0, MAX_HIGHLIGHTS),
      lines: doctorLines,
      raw: doctorRaw,
    },
    summary: summarize(highlights),
    highlights,
  });
});
