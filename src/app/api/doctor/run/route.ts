/**
 * `POST /api/doctor/run` — run a check and narrate it.
 *
 * ## What changed and why
 *
 * The old route exposed five *modes* and mapped `scan` to
 * `openclaw doctor --non-interactive`. That command applies safe migrations and
 * moves state on disk. Calling it "scan" meant the page's most innocuous-looking
 * button was quietly mutating the user's machine, and no mode used the
 * read-only `--lint` path at all.
 *
 * Now there are three depths, and the mutating ones say so and refuse to run
 * without acknowledgement:
 *
 *   - `quick` — **read-only.** Structured lint (all 51 checks), security audit,
 *     secrets audit, live gateway signals. Safe on anyone's machine, any time.
 *   - `full`  — quick, plus `openclaw doctor --non-interactive`. ⚠️ Applies
 *     OpenClaw's safe migrations and state moves. Requires
 *     `acknowledgeMutation: true`.
 *   - `deep`  — as `full`, with `--deep`, which additionally reports
 *     session-transcript gaps, the tool-result cap, and established gateway TCP
 *     clients. Also mutating; same acknowledgement.
 *
 * Repairs are **not** here. They live at `POST /api/doctor/fix`, one at a time,
 * by id, with a preview — see that route.
 *
 * ## Request
 *
 * ```json
 * { "mode": "quick" | "full" | "deep", "acknowledgeMutation": true }
 * ```
 *
 * ## Response — `text/event-stream`, one JSON object per `data:` line
 *
 * ```
 * {"type":"start","runId":"…","mode":"quick","readOnly":true,"phases":4}
 * {"type":"phase","phase":"lint","label":"…","index":1,"total":4}
 * {"type":"output","stream":"stdout","text":"…"}
 * {"type":"phase-done","phase":"lint","ok":true,"durationMs":5300,"detail":"51 checks, 3 reporting"}
 * {"type":"snapshot","snapshot":{…},"diff":{…}}
 * {"type":"done","runId":"…","durationMs":7100}
 * ```
 *
 * `error` events carry `{ "type":"error","message":"…" }` and are terminal.
 */

import { collectSnapshot, persistRun, primeCache } from "@/lib/doctor-snapshot";
import { diffAgainstHistory, createRunId } from "@/lib/doctor-history";
import { sseResponse, jsonError } from "@/lib/doctor-sse";
import { withPassthroughRoute } from "@/lib/api-route";
import { doctorRunPostSchema, type DoctorRunPostInput } from "@/lib/schemas/streaming";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MODES = {
  quick: { depth: "quick" as const, readOnly: true, phases: 4 },
  full: { depth: "full" as const, readOnly: false, phases: 5 },
  deep: { depth: "deep" as const, readOnly: false, phases: 5 },
};

/** One run at a time: concurrent doctor subprocesses fight over the same state. */
let running = false;

export const POST = withPassthroughRoute<DoctorRunPostInput>(
  { name: "/api/doctor/run", bodySchema: doctorRunPostSchema },
  async (_request, ctx) => {
    const body = ctx.body;
    const mode = body.mode ?? "quick";
    if (!Object.prototype.hasOwnProperty.call(MODES, mode)) {
      return jsonError(`Unknown mode "${mode}".`, 400, { details: { expected: Object.keys(MODES) } });
    }
    const config = MODES[mode as keyof typeof MODES];

    // The full pass writes to disk. Refusing without acknowledgement keeps the
    // distinction real rather than documentary.
    if (!config.readOnly && body.acknowledgeMutation !== true) {
      return jsonError(
        "The full check also applies OpenClaw's safe migrations, so it changes files on this machine. Send acknowledgeMutation: true to proceed, or use mode \"quick\" for a read-only check.",
        400,
        { details: { mutating: true, readOnlyAlternative: "quick" } },
      );
    }

    if (!config.readOnly && process.env.OPENCLAW_READ_ONLY === "true") {
      return jsonError("This deployment is read-only, so the full check is disabled.", 403);
    }

    if (running) {
      return jsonError("A check is already running.", 409);
    }

    running = true;
    const runId = createRunId();
    const startedAt = Date.now();

    return sseResponse(async (writer) => {
      try {
        writer.send({
          type: "start",
          runId,
          mode,
          readOnly: config.readOnly,
          phases: config.phases,
        });

        const result = await collectSnapshot({
          depth: config.depth,
          onProgress: (event) => writer.send(event),
        });

        // Diff before persisting, so the comparison is against the previous run.
        const diff = await diffAgainstHistory(result.snapshot).catch(() => null);
        await persistRun(result, mode).catch(() => {});
        // The run the user just watched must be what the next status read
        // returns, or the page appears to forget what it just showed them.
        primeCache(result);

        writer.send({ type: "snapshot", snapshot: result.snapshot, diff });
        writer.send({ type: "done", runId, durationMs: Date.now() - startedAt });
      } finally {
        running = false;
      }
    });
  },
);
