import { NextResponse } from "next/server";
import { runDoctorReport, type DoctorReport } from "@/lib/doctor-report";
import { withRoute } from "@/lib/api-route";

/**
 * POST /api/config/doctor — verify a config change actually landed well.
 *
 * The config editor calls this right after a save so the user gets a real
 * answer ("saved, and the gateway is still healthy") instead of a toast that
 * only proves the HTTP request returned 200. It is also the standing-rule
 * "always run `openclaw doctor` after editing config", wired into the UI so
 * nobody has to remember it.
 *
 * Request body (all optional):
 *   { fast?: boolean }   default true — the default lint check set.
 *                        false runs `--all`, the full check inventory.
 *
 * Response 200: the normalized DoctorReport (see src/lib/doctor-report.ts),
 * plus `cached: boolean`. The report is returned with 200 even when it
 * describes a failure — a health check that found problems is a successful
 * request, and folding it into a 5xx would hide the findings from the client.
 *
 * ## Rate limiting
 *
 * This endpoint spawns `openclaw doctor`, a several-second, plugin-loading
 * subprocess, and any authenticated operator can reach it — on a shared
 * gateway that is a trivial way to pin a CPU. Two in-process guards, both
 * deliberately simple because this only needs to bound one Node process:
 *
 *   1. Single-flight: at most one doctor subprocess at a time. Concurrent
 *      callers await the in-flight run and receive its report with
 *      `cached: true` rather than queueing another subprocess.
 *   2. Minimum interval: for {@link MIN_INTERVAL_MS} after a run completes,
 *      callers get that stored report back with `cached: true`.
 *
 * The window is global rather than per-mode, so a `fast: false` request inside
 * the window can be answered by a `fast: true` report; the report echoes which
 * set actually ran in its own `fast` field, and `ranAt` says how old it is, so
 * a caller can always tell what it is looking at. `retryAfterMs` says how long
 * until a fresh run is allowed.
 *
 * These are per-process counters. Mission Control runs as a single launchd
 * service, so that is the whole surface; a multi-replica deployment would need
 * a shared limiter.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * How long a completed report is reused. A run costs ~4s, so this bounds the
 * endpoint to roughly one subprocess per 10s while staying short enough that
 * a user who saves, reads the result, and saves again gets a fresh check.
 */
// Not exported: Next.js route modules may only export route handlers and a
// fixed set of config keys.
const MIN_INTERVAL_MS = 10_000;

let inFlight: Promise<DoctorReport> | null = null;
let lastReport: DoctorReport | null = null;

type DoctorResponse = DoctorReport & { cached: boolean; retryAfterMs: number };

function respond(report: DoctorReport, cached: boolean): NextResponse {
  const age = Date.now() - report.ranAt;
  const body: DoctorResponse = {
    ...report,
    cached,
    retryAfterMs: Math.max(0, MIN_INTERVAL_MS - age),
  };
  return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
}

export const POST = withRoute({ name: "/api/config/doctor" }, async (request) => {
  // A missing or malformed body is not an error: the defaults are the point.
  let fast = true;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && typeof (body as { fast?: unknown }).fast === "boolean") {
      fast = (body as { fast: boolean }).fast;
    }
  } catch {
    // No body — keep the defaults.
  }

  // 2. Minimum interval.
  if (!inFlight && lastReport && Date.now() - lastReport.ranAt < MIN_INTERVAL_MS) {
    return respond(lastReport, true);
  }

  // 1. Single-flight.
  if (inFlight) {
    try {
      return respond(await inFlight, true);
    } catch {
      // runDoctorReport does not throw, but if the shared promise somehow
      // rejects, fall through and run our own rather than failing the caller.
    }
  }

  const run = runDoctorReport({ fast })
    .then((report) => {
      lastReport = report;
      return report;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = run;

  return respond(await run, false);
});
