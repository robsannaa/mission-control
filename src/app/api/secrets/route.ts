import { NextResponse } from "next/server";
import { runCliJson, runCliCaptureBoth, type RunCliResult } from "@/lib/openclaw";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import { secretsPostSchema, type SecretsPostInput } from "@/lib/schemas/updates";

export const dynamic = "force-dynamic";

/* ── Types ───────────────────────────────────────── */

type AuditFinding = {
  code: string;
  severity: "warn" | "info" | "error";
  file: string;
  path: string;
  message: string;
  provider?: string;
  detail?: string;
};

type AuditResponse = {
  version: number;
  status: string;
  filesScanned: string[];
  summary: {
    plaintextCount: number;
    unresolvedRefCount: number;
    shadowedRefCount: number;
    legacyResidueCount: number;
  };
  findings: AuditFinding[];
};

function parseJsonFromStdout(stdout: string): Record<string, unknown> {
  try {
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch {
    return stdout.trim() ? { raw: stdout } : {};
  }
}

function deriveError(result: RunCliResult): string | undefined {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  if (result.code !== null && result.code !== 0) return `Command failed with exit code ${result.code}.`;
  return undefined;
}

function toCliResponse(result: RunCliResult): Record<string, unknown> {
  const parsed = parseJsonFromStdout(result.stdout);
  const response: Record<string, unknown> = {
    ok: result.code === 0,
    ...parsed,
    stderr: result.stderr || undefined,
    code: result.code,
  };

  if (result.code !== 0 && typeof response.error !== "string") {
    const fallback = deriveError(result);
    if (fallback) response.error = fallback;
  }

  return response;
}

function buildConfigureCommand(body: SecretsPostInput): string {
  const args = ["openclaw", "secrets", "configure"];
  if (body.providersOnly) args.push("--providers-only");
  if (body.skipProviderSetup) args.push("--skip-provider-setup");
  if (body.apply) args.push("--apply");
  args.push("--yes");
  return args.join(" ");
}

/* ── GET: run secrets audit ─────────────────────── */

export const GET = withRoute({ name: "/api/secrets" }, async () => {
  try {
    const audit = await runCliJson<AuditResponse>(
      ["secrets", "audit"],
      30000
    );
    return NextResponse.json(audit);
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
});

/**
 * POST: configure, apply, reload, audit.
 *
 * T-02-54 (Information Disclosure): `action` is a required, non-empty
 * string in `secretsPostSchema` — a missing action is now rejected with a
 * `details` tree naming `["action"]` before this handler runs. A *present*
 * but unrecognized action still falls through to the `default` branch below
 * with its original `Unknown action: <value>` message (D-06). `planPath` is
 * bounded/traversal-checked in the schema (T-02-54) before it is ever
 * appended to the `secrets apply --from` CLI argument list, and its
 * rejection message never echoes the submitted value.
 */
export const POST = withRoute<SecretsPostInput>(
  { name: "/api/secrets", bodySchema: secretsPostSchema },
  async (_request, ctx) => {
  try {
    const body = ctx.body;
    const action = body.action;
    const providersOnly = Boolean(body.providersOnly);
    const skipProviderSetup = Boolean(body.skipProviderSetup);
    const apply = Boolean(body.apply);
    const dryRun = Boolean(body.dryRun);
    const planPath = body.planPath?.trim() || "";

    switch (action) {
      case "configure": {
        // Run non-interactive configure with --providers-only or --skip-provider-setup
        // and --json to get the plan
        const args = ["secrets", "configure", "--json", "--yes"];
        if (providersOnly) args.push("--providers-only");
        if (skipProviderSetup) args.push("--skip-provider-setup");
        if (apply) args.push("--apply");

        const result = await runCliCaptureBoth(args, 60000);
        const response = toCliResponse(result);
        const combinedOutput = `${result.stderr}\n${result.stdout}`.toLowerCase();

        if (
          result.code !== 0 &&
          combinedOutput.includes("requires an interactive tty")
        ) {
          return NextResponse.json(
            {
              ...response,
              error:
                "This OpenClaw version requires an interactive terminal for `secrets configure`.",
              requiresInteractiveTty: true,
              recommendedCommand: buildConfigureCommand(body),
            },
            { status: 409 }
          );
        }

        return NextResponse.json(response, { status: result.code === 0 ? 200 : 500 });
      }

      case "apply": {
        // Apply a previously generated plan
        const args = ["secrets", "apply", "--json"];
        if (dryRun) args.push("--dry-run");
        if (planPath) args.push("--from", planPath);

        const result = await runCliCaptureBoth(args, 60000);
        return NextResponse.json(toCliResponse(result), { status: result.code === 0 ? 200 : 500 });
      }

      case "reload": {
        const args = ["secrets", "reload", "--json"];
        const result = await runCliCaptureBoth(args, 30000);
        return NextResponse.json(toCliResponse(result), { status: result.code === 0 ? 200 : 500 });
      }

      case "audit": {
        // Allow POST-based audit too for consistency
        const audit = await runCliJson<AuditResponse>(
          ["secrets", "audit"],
          30000
        );
        return NextResponse.json(audit);
      }

      default:
        return badRequest(`Unknown action: ${action}`);
    }
  } catch (err) {
    return serverError(err instanceof Error ? err.message : String(err));
  }
  },
);
