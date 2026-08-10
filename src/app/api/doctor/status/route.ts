/**
 * `GET /api/doctor/status` — the current, honest picture of the system.
 *
 * ## What changed and why
 *
 * This route used to probe gateway liveness and read `health.checks`,
 * `status.service.runtime.status`, `status.gateway.port` and `status.rpc.ok` —
 * **none of which exist** on this gateway. The issue set was therefore always
 * empty, and `100 − 20·errors − 5·warnings` always returned 100. The page told
 * the user everything was perfect while `openclaw doctor` on the same machine
 * reported an unsupported Node, a fragile service definition and three
 * plaintext credentials.
 *
 * It now serves a real snapshot, cached, with its true age attached. A liveness
 * ping is never mistaken for a health check again: if nothing has run, the
 * answer is `state: "never-checked"` and `score: null`.
 *
 * ## Query parameters
 *
 * - `maxAgeMs` (default 300000) — reuse a stored snapshot younger than this.
 *   Pass a large value from a polling UI; pass 0 with `refresh=1` to force.
 * - `refresh=1` — run a fresh read-only collection now.
 * - `peek=1` — never run anything; return the newest stored snapshot or a
 *   `never-checked` placeholder. This is the safe call for a background poll.
 * - `history=0` — skip the diff/trend lookup.
 *
 * The collection triggered here is **always read-only** (`depth: "quick"`).
 * The mutating full pass lives behind `POST /api/doctor/run`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSnapshot, peekSnapshot, DEFAULT_MAX_AGE_MS } from "@/lib/doctor-snapshot";
import { diffAgainstHistory, getTrend } from "@/lib/doctor-history";
import { REGISTERED_CHECK_COUNT } from "@/lib/doctor-score";
import type { DoctorSnapshot } from "@/lib/doctor-types";

export const dynamic = "force-dynamic";
export const maxDuration = 180;

/** What the UI gets when nothing has ever run. Deliberately not a zero score. */
function neverChecked(): DoctorSnapshot {
  const idle = {
    ran: false,
    ok: false,
    ts: null,
    durationMs: null,
    error: null,
    invocation: "",
  };
  return {
    version: 2,
    ts: Date.now(),
    cached: false,
    health: {
      state: "never-checked",
      score: null,
      grade: "unknown",
      checkedAt: null,
      ageMs: null,
      deductions: [],
      caveats: ["This system has never been checked."],
    },
    provenance: {
      lint: idle,
      legacy: idle,
      securityAudit: idle,
      secretsAudit: idle,
      runtime: idle,
    },
    coverage: {
      checksRegistered: REGISTERED_CHECK_COUNT,
      checksRun: null,
      checksSkipped: null,
      checksReporting: 0,
      unverifiedFamilies: [],
      statement: "Nothing has been checked yet.",
    },
    summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
    findings: [],
    vitals: [],
    prevention: [],
    gateway: {
      reachable: false,
      port: 18789,
      runtimeVersion: null,
      cliVersion: null,
      nodeVersion: null,
      uptimeMs: null,
    },
  };
}

export async function GET(request: NextRequest) {
  const params = new URL(request.url).searchParams;
  const peek = params.get("peek") === "1";
  const force = params.get("refresh") === "1";
  const withHistory = params.get("history") !== "0";
  // `Number(null)` is 0, not NaN — reading the parameter without checking for
  // its absence first made every unparameterised call look like `maxAgeMs=0`
  // and bypass the cache, which is precisely the "one subprocess per poll"
  // behaviour this route exists to avoid.
  const rawMaxAge = params.get("maxAgeMs");
  const parsedMaxAge = rawMaxAge === null ? NaN : Number(rawMaxAge);
  const maxAgeMs =
    Number.isFinite(parsedMaxAge) && parsedMaxAge >= 0 ? parsedMaxAge : DEFAULT_MAX_AGE_MS;

  let snapshot: DoctorSnapshot;
  try {
    snapshot = peek
      ? ((await peekSnapshot()) ?? neverChecked())
      : await getSnapshot({ maxAgeMs, force });
  } catch (err) {
    // A collection that throws is itself the answer — report it, do not 500
    // into a spinner that never resolves.
    const placeholder = neverChecked();
    placeholder.health.state = "run-failed";
    placeholder.health.caveats = [
      `The health check could not run: ${err instanceof Error ? err.message : String(err)}`,
    ];
    return NextResponse.json({ ...placeholder, diff: null, trend: [] }, { status: 200 });
  }

  if (!withHistory) return NextResponse.json({ ...snapshot, diff: null, trend: [] });

  const [diff, trend] = await Promise.all([
    diffAgainstHistory(snapshot).catch(() => null),
    getTrend(30).catch(() => []),
  ]);

  return NextResponse.json({ ...snapshot, diff, trend });
}
