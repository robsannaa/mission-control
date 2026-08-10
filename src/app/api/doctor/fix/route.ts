/**
 * `/api/doctor/fix` — preview a repair, then apply exactly one.
 *
 * ## Why one repair at a time
 *
 * The old surface had a `repair` mode and a `repair-force` mode, and the caller
 * chose. Nothing on the server distinguished "reinstall an add-on" from
 * "overwrite the owner's launchd definition" — both were a string in a POST
 * body. Here, safety is a property of the repair itself:
 *
 *   - `safe`        — applies without confirmation.
 *   - `caution`     — requires `confirm: true`.
 *   - `destructive` — requires `confirm: true`, and is never one click in the UI.
 *
 * The server enforces this. A stray `POST {"fixId":"doctor-fix-force"}` is
 * refused, not executed.
 *
 * ## GET — list repairs
 *
 * `GET /api/doctor/fix` → `{ fixes: FixPlanSummary[] }`, every repair the page
 * knows how to run, with its safety class and side effects.
 *
 * ## GET — preview one
 *
 * `GET /api/doctor/fix?fixId=sessions-prune-missing` → `FixPreview`:
 *
 * ```json
 * {
 *   "fixId": "sessions-prune-missing",
 *   "label": "Remove conversations whose files are gone",
 *   "safety": "safe",
 *   "kind": "dry-run",
 *   "simulated": true,
 *   "changes": ["6 conversation entries whose transcript file is gone will be removed.",
 *               "Your conversation list goes from 106 to 100 entries."],
 *   "sideEffects": ["…"],
 *   "requiresConfirmation": false,
 *   "requiresRestart": false,
 *   "affects": [{"id":"legacy:sessions-missing-transcripts","title":"…"}],
 *   "blockers": [],
 *   "command": "openclaw sessions cleanup --enforce --fix-missing --json",
 *   "raw": { … the actual dry-run payload … },
 *   "error": null
 * }
 * ```
 *
 * `simulated: true` means the numbers came from really running the command's
 * own dry run. `simulated: false` with `kind: "impact-list"` means no dry run
 * exists and we are listing what the command claims it will fix — the
 * difference is in the response so the UI never implies a simulation it did not
 * get.
 *
 * ## POST — apply one
 *
 * Request: `{ "fixId": "…", "confirm": true }`
 *
 * Response: `text/event-stream`
 *
 * ```
 * {"type":"start","fixId":"…","label":"…","safety":"safe","command":"openclaw …"}
 * {"type":"stage","stage":"apply","label":"Running openclaw …"}
 * {"type":"output","stream":"stdout","text":"…"}
 * {"type":"stage","stage":"verify","label":"Checking whether the problem is actually gone"}
 * {"type":"outcome","outcome":{…FixOutcome…}}
 * {"type":"done"}
 * ```
 *
 * `outcome.status` is the thing to render: `verified-fixed`,
 * `applied-unverified`, `still-present`, `failed`, or `refused`. A repair that
 * reports success while the problem remains comes back as `still-present`, not
 * as a green tick.
 */

import { NextRequest } from "next/server";
import { FIX_PLANS, fixCommand } from "@/lib/doctor-fix-catalog";
import { previewFix, applyFix, isFixInFlight } from "@/lib/doctor-fix-runner";
import { sseResponse, jsonError } from "@/lib/doctor-sse";
import { redact } from "@/lib/doctor-redact";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const fixId = new URL(request.url).searchParams.get("fixId");

  if (!fixId) {
    return NextResponse.json({
      fixes: Object.values(FIX_PLANS).map((plan) => ({
        id: plan.id,
        label: plan.label,
        safety: plan.safety,
        whatItDoes: plan.whatItDoes,
        sideEffects: plan.sideEffects,
        requiresRestart: plan.requiresRestart,
        requiresConfirmation: plan.safety !== "safe",
        previewKind: plan.previewKind,
        command: fixCommand(plan),
      })),
    });
  }

  const preview = await previewFix(fixId);
  if (!preview) return jsonError(`There is no repair called "${fixId}".`, 404);
  return NextResponse.json(preview);
}

export async function POST(request: NextRequest) {
  let body: { fixId?: string; confirm?: boolean };
  try {
    body = await request.json();
  } catch {
    return jsonError("Expected a JSON body.", 400);
  }

  const fixId = body.fixId;
  if (!fixId) return jsonError("fixId is required.", 400, { available: Object.keys(FIX_PLANS) });

  const plan = FIX_PLANS[fixId];
  if (!plan) return jsonError(`There is no repair called "${fixId}".`, 404);

  if (plan.safety !== "safe" && body.confirm !== true) {
    return jsonError(
      "This repair changes things that are hard or impossible to undo. Send confirm: true to proceed.",
      400,
      {
        fixId,
        safety: plan.safety,
        whatItDoes: plan.whatItDoes,
        sideEffects: plan.sideEffects,
        previewUrl: `/api/doctor/fix?fixId=${encodeURIComponent(fixId)}`,
      },
    );
  }

  if (process.env.OPENCLAW_READ_ONLY === "true") {
    return jsonError("This deployment is read-only, so repairs are disabled.", 403);
  }

  if (isFixInFlight()) return jsonError("Another repair is already running.", 409);

  return sseResponse(async (writer) => {
    writer.send({
      type: "start",
      fixId,
      label: plan.label,
      safety: plan.safety,
      command: fixCommand(plan),
      requiresRestart: plan.requiresRestart,
    });

    const outcome = await applyFix(fixId, {
      confirm: body.confirm === true,
      // `generate-gateway-token` prints a fresh token on stdout, so the live
      // stream is scrubbed before it leaves the server — not only the stored
      // transcript.
      onOutput: (stream, text) => writer.send({ type: "output", stream, text: redact(text) }),
      onStage: (stage, label) => writer.send({ type: "stage", stage, label }),
    });

    writer.send({ type: "outcome", outcome });
    writer.send({ type: "done" });
  });
}
