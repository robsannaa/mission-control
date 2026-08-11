import { NextRequest, NextResponse } from "next/server";
import {
  detectGbrain,
  gbrainCommand,
  runGbrain,
  GBRAIN_COMMANDS,
} from "@/lib/gbrain";

export const dynamic = "force-dynamic";

/**
 * GET /api/g-brain
 *   ?scope=detect   → { installed, engine?, schemaPack? }        (cheap, for the sidebar)
 *   ?action=catalog → the full command catalog
 *   ?action=overview→ doctor + stats + jobs, aggregated for the tab's first screen
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const detection = detectGbrain();

  if (searchParams.get("scope") === "detect") {
    return NextResponse.json(detection);
  }
  if (!detection.installed) {
    return NextResponse.json({ installed: false });
  }

  const action = searchParams.get("action");

  if (action === "overview") {
    const [doctor, stats, jobs, health] = await Promise.all([
      runGbrain(["doctor", "--json", "--fast"], { json: true, timeoutMs: 25_000 }),
      runGbrain(["stats"], { timeoutMs: 15_000 }),
      runGbrain(["jobs", "stats"], { timeoutMs: 15_000 }),
      runGbrain(["health"], { timeoutMs: 15_000 }),
    ]);
    return NextResponse.json({
      installed: true,
      detection,
      doctor: doctor.json ?? null,
      doctorError: doctor.ok ? null : doctor.error,
      stats: stats.stdout,
      jobs: jobs.stdout,
      jobsError: jobs.ok ? null : jobs.error,
      health: health.stdout,
    });
  }

  // Default and ?action=catalog both return the catalog.
  return NextResponse.json({ installed: true, detection, commands: GBRAIN_COMMANDS });
}

/**
 * POST /api/g-brain — run one catalog command.
 * Body: { id, values?: {argName: string}, confirm?: boolean }
 *
 * argv is assembled ONLY from the catalog entry + the user's structured values,
 * and passed to execFile as an array (no shell), so nothing arbitrary can run.
 */
export async function POST(request: NextRequest) {
  const detection = detectGbrain();
  if (!detection.installed) {
    return NextResponse.json(
      { ok: false, error: "G-Brain is not installed on this machine." },
      { status: 400 },
    );
  }

  let body: { id?: string; values?: Record<string, string>; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const cmd = body.id ? gbrainCommand(body.id) : undefined;
  if (!cmd) {
    return NextResponse.json(
      { ok: false, error: `Unknown G-Brain command: ${body.id ?? "(none)"}` },
      { status: 400 },
    );
  }
  if (cmd.dangerous && !body.confirm) {
    return NextResponse.json(
      { ok: false, needsConfirm: true, error: "This command is destructive — confirm to run it." },
      { status: 400 },
    );
  }

  const values = body.values ?? {};
  const argv: string[] = [cmd.sub, ...(cmd.prefix ?? [])];
  for (const arg of cmd.args ?? []) {
    const v = String(values[arg.name] ?? "").trim();
    if (!v) {
      if (arg.required) {
        return NextResponse.json(
          { ok: false, error: `Missing required value: ${arg.name}` },
          { status: 400 },
        );
      }
      continue;
    }
    if (arg.flag) argv.push(arg.flag, v);
    else argv.push(v);
  }
  if (cmd.suffix) argv.push(...cmd.suffix);

  const result = await runGbrain(argv, {
    json: cmd.json,
    timeoutMs: cmd.mutates ? 180_000 : 30_000,
  });
  return NextResponse.json({ ...result, id: cmd.id, argv, mutates: Boolean(cmd.mutates) });
}
