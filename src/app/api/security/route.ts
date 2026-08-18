import { NextResponse } from "next/server";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { getOpenClawHome } from "@/lib/paths";
import { runCliJson, runCliCaptureBoth } from "@/lib/openclaw";
import { buildModelsSummary } from "@/lib/models-summary";
import { withRoute } from "@/lib/api-route";
import { securityGetQuerySchema, securityPostSchema } from "@/lib/schemas/system";

export const dynamic = "force-dynamic";

const DOCS_URL = "https://docs.openclaw.ai/cli/security";
const CACHE_PATH = join(getOpenClawHome(), "mission-control", "security-audit-cache.json");

type SecuritySeverity = "critical" | "warn" | "info";

type SecurityFinding = {
  checkId: string;
  severity: SecuritySeverity;
  title: string;
  detail?: string;
  remediation?: string;
};

type SecuritySummary = {
  critical: number;
  warn: number;
  info: number;
};

type SecurityAuditReport = {
  ts: number;
  mode: "quick" | "deep" | "fix";
  summary: SecuritySummary;
  findings: SecurityFinding[];
  deep?: unknown;
};

type SecurityFixAction = {
  kind: string;
  path?: string;
  mode?: number;
  ok?: boolean;
  skipped?: string;
  error?: string;
};

type SecurityFixResult = {
  ok: boolean;
  stateDir?: string;
  configPath?: string;
  configWritten?: boolean;
  changes: string[];
  actions: SecurityFixAction[];
  errors: string[];
};

type SecurityFixHistory = {
  ts: number;
  fix: SecurityFixResult;
  report: SecurityAuditReport;
};

type SecurityCache = {
  updatedAt?: number;
  lastAudit?: SecurityAuditReport;
  lastFix?: SecurityFixHistory;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeSeverity(value: unknown): SecuritySeverity {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "critical") return "critical";
  if (raw === "warn" || raw === "warning") return "warn";
  return "info";
}

function normalizeFinding(raw: unknown): SecurityFinding | null {
  if (!isRecord(raw)) return null;
  const checkId = String(raw.checkId || raw.id || "").trim();
  const title = String(raw.title || raw.checkId || "Security finding").trim();
  if (!checkId || !title) return null;
  const detail = typeof raw.detail === "string" ? raw.detail.trim() : "";
  const remediation = typeof raw.remediation === "string" ? raw.remediation.trim() : "";
  return {
    checkId,
    severity: normalizeSeverity(raw.severity),
    title,
    detail: detail || undefined,
    remediation: remediation || undefined,
  };
}

function normalizeSummary(rawSummary: unknown, findings: SecurityFinding[]): SecuritySummary {
  const fromRaw = isRecord(rawSummary)
    ? {
        critical: asNumber(rawSummary.critical, NaN),
        warn: asNumber(rawSummary.warn, NaN),
        info: asNumber(rawSummary.info, NaN),
      }
    : null;

  const hasAll =
    fromRaw &&
    Number.isFinite(fromRaw.critical) &&
    Number.isFinite(fromRaw.warn) &&
    Number.isFinite(fromRaw.info);

  if (hasAll) {
    return {
      critical: Math.max(0, Math.floor(fromRaw.critical)),
      warn: Math.max(0, Math.floor(fromRaw.warn)),
      info: Math.max(0, Math.floor(fromRaw.info)),
    };
  }

  const summary: SecuritySummary = { critical: 0, warn: 0, info: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

function normalizeAuditReport(raw: unknown, mode: "quick" | "deep" | "fix"): SecurityAuditReport {
  const obj = isRecord(raw) ? raw : {};
  const findings = (Array.isArray(obj.findings) ? obj.findings : [])
    .map(normalizeFinding)
    .filter((v): v is SecurityFinding => Boolean(v));

  const report: SecurityAuditReport = {
    ts: asNumber(obj.ts, Date.now()),
    mode,
    summary: normalizeSummary(obj.summary, findings),
    findings,
  };

  if (obj.deep !== undefined) {
    report.deep = obj.deep;
  }
  return report;
}

function normalizeFixAction(raw: unknown): SecurityFixAction | null {
  if (!isRecord(raw)) return null;
  const kind = String(raw.kind || "").trim();
  if (!kind) return null;
  const path = typeof raw.path === "string" ? raw.path : undefined;
  const mode = Number.isFinite(Number(raw.mode)) ? Number(raw.mode) : undefined;
  const ok = typeof raw.ok === "boolean" ? raw.ok : undefined;
  const skipped = typeof raw.skipped === "string" ? raw.skipped : undefined;
  const error = typeof raw.error === "string" ? raw.error : undefined;
  return { kind, path, mode, ok, skipped, error };
}

function normalizeFixResult(raw: unknown): SecurityFixResult {
  const obj = isRecord(raw) ? raw : {};
  const changes = (Array.isArray(obj.changes) ? obj.changes : [])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const actions = (Array.isArray(obj.actions) ? obj.actions : [])
    .map(normalizeFixAction)
    .filter((v): v is SecurityFixAction => Boolean(v));
  const errors = (Array.isArray(obj.errors) ? obj.errors : [])
    .map((v) => (typeof v === "string" ? v.trim() : JSON.stringify(v)))
    .filter(Boolean);

  return {
    ok: Boolean(obj.ok),
    stateDir: typeof obj.stateDir === "string" ? obj.stateDir : undefined,
    configPath: typeof obj.configPath === "string" ? obj.configPath : undefined,
    configWritten: typeof obj.configWritten === "boolean" ? obj.configWritten : undefined,
    changes,
    actions,
    errors,
  };
}

async function readCache(): Promise<{ cache: SecurityCache; warning?: string }> {
  try {
    const raw = await readFile(CACHE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed)) return { cache: {}, warning: "Security cache file is invalid; using defaults." };
    return { cache: parsed as SecurityCache };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes("no such file")) {
      return { cache: {} };
    }
    return { cache: {}, warning: `Failed to read security cache: ${message}` };
  }
}

async function writeCache(cache: SecurityCache): Promise<void> {
  await mkdir(dirname(CACHE_PATH), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");
}

function cliError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function runAudit(mode: "quick" | "deep"): Promise<SecurityAuditReport> {
  const args = ["security", "audit"];
  if (mode === "deep") args.push("--deep");
  const raw = await runCliJson<unknown>(args, 30000);
  return normalizeAuditReport(raw, mode);
}

async function runFix(): Promise<{ fix: SecurityFixResult; report: SecurityAuditReport }> {
  const raw = await runCliJson<unknown>(["security", "audit", "--fix"], 40000);
  if (!isRecord(raw)) {
    return {
      fix: normalizeFixResult({ ok: false, errors: ["Malformed --fix response"] }),
      report: normalizeAuditReport({}, "fix"),
    };
  }
  const fix = normalizeFixResult(raw.fix);
  const report = normalizeAuditReport(isRecord(raw.report) ? raw.report : raw, "fix");
  return { fix, report };
}

/**
 * GET /api/security — security audit dashboard read.
 *
 * Deliberately never returns an error status: on a CLI failure it serves a
 * minimal, explicitly-degraded payload (`degraded: true`) instead. Kept as
 * an internal try/catch (not thrown) so `withRoute`'s own catch never sees
 * this failure and never converts it into a 500 (T-02-46).
 */
export const GET = withRoute(
  { name: "/api/security", querySchema: securityGetQuerySchema },
  async (_request, { query, log }) => {
    const shouldRun = query.run === "1";
    const mode = query.mode === "deep" ? "deep" : "quick";

    try {
      const { cache, warning } = await readCache();
      let report: SecurityAuditReport | null = null;

      if (shouldRun) {
        report = await runAudit(mode);
        cache.lastAudit = report;
        cache.updatedAt = Date.now();
        await writeCache(cache);
      }

      return NextResponse.json({
        ts: Date.now(),
        docsUrl: DOCS_URL,
        cache,
        report,
        warning: warning || undefined,
        degraded: false,
      });
    } catch (err) {
      log.warn({ err: cliError(err) }, "Security audit unavailable — returning degraded payload");
      return NextResponse.json({
        ts: Date.now(),
        docsUrl: DOCS_URL,
        cache: {},
        error: cliError(err),
        warning: "Security checks are unavailable right now.",
        degraded: true,
      });
    }
  },
);

/**
 * POST /api/security — security audit/fix actions writing instance-level
 * security state. `securityPostSchema` rejects an unrecognized `action`
 * before this handler runs, so no write (`security audit --fix`) is ever
 * reached on a bad payload (T-02-44). A thrown error from any action's
 * gateway/CLI call is left to `withRoute`'s own catch, which produces the
 * same 500 + message text this route always returned.
 */
export const POST = withRoute(
  { name: "/api/security", bodySchema: securityPostSchema },
  async (_request, { body }) => {
    if (body.action === "audit") {
      const mode = (body.mode || "quick").toLowerCase() === "deep" ? "deep" : "quick";
      const report = await runAudit(mode);
      const { cache, warning } = await readCache();
      cache.lastAudit = report;
      cache.updatedAt = Date.now();
      await writeCache(cache);
      return NextResponse.json({
        ok: true,
        action: body.action,
        mode,
        report,
        cache,
        warning: warning || undefined,
      });
    }

    if (body.action === "fix") {
      const { fix, report } = await runFix();
      const { cache, warning } = await readCache();
      cache.lastFix = { ts: Date.now(), fix, report };
      cache.lastAudit = report;
      cache.updatedAt = Date.now();
      await writeCache(cache);
      return NextResponse.json({
        ok: true,
        action: body.action,
        fix,
        report,
        cache,
        warning: warning || undefined,
      });
    }

    if (body.action === "check-secrets") {
      const { stdout, stderr } = await runCliCaptureBoth(["secrets", "audit", "--check"], 15000);
      return NextResponse.json({ ok: true, action: body.action, output: stdout || stderr || "No output." });
    }

    // body.action === "check-models" — the only remaining variant of
    // `securityPostSchema`'s discriminated union.
    try {
      const summary = await buildModelsSummary();
      return NextResponse.json({ ok: true, action: body.action, models: summary.status });
    } catch (err) {
      return NextResponse.json({ ok: true, action: body.action, output: String(err) });
    }
  },
);
