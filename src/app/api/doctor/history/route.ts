/**
 * `/api/doctor/history` — the time dimension.
 *
 * `GET` → `{ runs, total, discardedLegacyRuns, trend }`
 *
 * - `runs[]` are full `DoctorRunRecord`s, newest first, each carrying the whole
 *   snapshot so a client can diff any two runs without another round trip.
 *   Pass `summary=1` to strip `snapshot` and `rawOutput`, which is what a list
 *   view wants — the full payload is tens of kilobytes per run.
 * - `discardedLegacyRuns` is how many pre-v2 records were dropped on upgrade.
 *   Those were produced by the old regex classifier and diffing against them
 *   would manufacture a fake "everything got better" on first load. Show it as
 *   "history starts here", not as an improvement.
 * - `trend[]` is `{ ts, score, errors, warnings, infos }`, oldest first.
 *
 * `DELETE /api/doctor/history?id=…` removes one run.
 */

import { NextRequest, NextResponse } from "next/server";
import { listDoctorRuns, deleteDoctorRun, getTrend } from "@/lib/doctor-history";
import { withRoute } from "@/lib/api-route";
import { badRequest, notFound } from "@/lib/api-errors";
import {
  doctorHistoryGetQuerySchema,
  doctorHistoryDeleteQuerySchema,
  type DoctorHistoryGetQuery,
  type DoctorHistoryDeleteQuery,
} from "@/lib/schemas/workspace";

export const dynamic = "force-dynamic";

export const GET = withRoute<unknown, DoctorHistoryGetQuery>(
  { name: "/api/doctor/history", querySchema: doctorHistoryGetQuerySchema },
  async (_request: NextRequest, ctx) => {
  const limit = Math.min(Math.max(parseInt(ctx.query.limit || "20", 10) || 20, 1), 50);
  const offset = Math.max(parseInt(ctx.query.offset || "0", 10) || 0, 0);
  const summaryOnly = ctx.query.summary === "1";

  const [result, trend] = await Promise.all([
    listDoctorRuns(limit, offset),
    getTrend(50).catch(() => []),
  ]);

  const runs = summaryOnly
    ? result.runs.map(({ snapshot, rawOutput, ...rest }) => ({
        ...rest,
        // Keep just enough of the snapshot for a list row to be useful.
        findingCount: snapshot?.findings.length ?? 0,
        healthState: snapshot?.health.state ?? null,
        transcriptBytes: rawOutput?.length ?? 0,
      }))
    : result.runs;

  return NextResponse.json({ ...result, runs, trend });
  },
);

export const DELETE = withRoute<unknown, DoctorHistoryDeleteQuery>(
  { name: "/api/doctor/history", querySchema: doctorHistoryDeleteQuerySchema },
  async (_request: NextRequest, ctx) => {
  const id = ctx.query.id;
  if (!id) return badRequest("id parameter required");

  const deleted = await deleteDoctorRun(id);
  if (!deleted) return notFound("Run not found");
  return NextResponse.json({ ok: true });
  },
);
