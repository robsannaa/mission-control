import { NextRequest, NextResponse } from "next/server";
import { readFile, writeFile, mkdir, rm } from "fs/promises";
import { join, dirname } from "path";
import { getOpenClawHome } from "@/lib/paths";

export const dynamic = "force-dynamic";

/* ── Persisted onboarding progress ──
 * Stored in Mission Control's own data dir (~/.openclaw/mission-control/) so
 * the wizard is resumable across browsers/devices and never touches the
 * gateway config. */

const ONBOARDING_STEP_IDS = ["gateway", "model", "channel", "chat"] as const;
type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

type OnboardingStepState = {
  status: "pending" | "done" | "skipped";
  completedAt?: string | null;
  meta?: Record<string, unknown>;
};

type OnboardingState = {
  version: 1;
  startedAt: string | null;
  completedAt: string | null;
  currentStep: OnboardingStepId;
  steps: Record<OnboardingStepId, OnboardingStepState>;
  updatedAt: string;
};

const STEP_STATUSES = new Set(["pending", "done", "skipped"]);

function statePath(): string {
  return join(getOpenClawHome(), "mission-control", "onboarding.json");
}

function defaultState(): OnboardingState {
  return {
    version: 1,
    startedAt: null,
    completedAt: null,
    currentStep: "gateway",
    steps: {
      gateway: { status: "pending" },
      model: { status: "pending" },
      channel: { status: "pending" },
      chat: { status: "pending" },
    },
    updatedAt: new Date().toISOString(),
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

async function readState(): Promise<OnboardingState> {
  try {
    const raw = JSON.parse(await readFile(statePath(), "utf-8"));
    if (!isRecord(raw) || raw.version !== 1) return defaultState();
    const base = defaultState();
    const steps = isRecord(raw.steps) ? raw.steps : {};
    for (const id of ONBOARDING_STEP_IDS) {
      const step = steps[id];
      if (isRecord(step) && STEP_STATUSES.has(String(step.status))) {
        base.steps[id] = {
          status: step.status as OnboardingStepState["status"],
          completedAt: typeof step.completedAt === "string" ? step.completedAt : null,
          meta: isRecord(step.meta) ? step.meta : undefined,
        };
      }
    }
    if (ONBOARDING_STEP_IDS.includes(raw.currentStep as OnboardingStepId)) {
      base.currentStep = raw.currentStep as OnboardingStepId;
    }
    base.startedAt = typeof raw.startedAt === "string" ? raw.startedAt : null;
    base.completedAt = typeof raw.completedAt === "string" ? raw.completedAt : null;
    base.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : base.updatedAt;
    return base;
  } catch {
    return defaultState();
  }
}

async function writeState(state: OnboardingState): Promise<void> {
  const path = statePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/* ── GET /api/onboarding/state ── */

export async function GET() {
  try {
    const state = await readState();
    return NextResponse.json(
      { ok: true, state },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST /api/onboarding/state ──
 * Body: { patch: Partial<OnboardingState> } — merged onto the stored state.
 * Step entries are merged individually; unknown step ids are rejected. */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const patch = body?.patch;
    if (!isRecord(patch)) {
      return NextResponse.json({ error: "patch object is required" }, { status: 400 });
    }

    const state = await readState();

    if (patch.currentStep !== undefined) {
      if (!ONBOARDING_STEP_IDS.includes(patch.currentStep as OnboardingStepId)) {
        return NextResponse.json(
          { error: `Invalid currentStep. Must be one of: ${ONBOARDING_STEP_IDS.join(", ")}` },
          { status: 400 },
        );
      }
      state.currentStep = patch.currentStep as OnboardingStepId;
    }

    if (patch.startedAt !== undefined) {
      state.startedAt = typeof patch.startedAt === "string" ? patch.startedAt : null;
    }
    if (patch.completedAt !== undefined) {
      state.completedAt = typeof patch.completedAt === "string" ? patch.completedAt : null;
    }

    if (patch.steps !== undefined) {
      if (!isRecord(patch.steps)) {
        return NextResponse.json({ error: "steps must be an object" }, { status: 400 });
      }
      for (const [id, step] of Object.entries(patch.steps)) {
        if (!ONBOARDING_STEP_IDS.includes(id as OnboardingStepId)) {
          return NextResponse.json({ error: `Unknown step: ${id}` }, { status: 400 });
        }
        if (!isRecord(step)) {
          return NextResponse.json({ error: `Step ${id} must be an object` }, { status: 400 });
        }
        const target = state.steps[id as OnboardingStepId];
        if (step.status !== undefined) {
          if (!STEP_STATUSES.has(String(step.status))) {
            return NextResponse.json(
              { error: `Invalid status for step ${id}. Must be one of: pending, done, skipped` },
              { status: 400 },
            );
          }
          target.status = step.status as OnboardingStepState["status"];
        }
        if (step.completedAt !== undefined) {
          target.completedAt = typeof step.completedAt === "string" ? step.completedAt : null;
        }
        if (step.meta !== undefined && isRecord(step.meta)) {
          target.meta = { ...(target.meta || {}), ...step.meta };
        }
      }
    }

    if (!state.startedAt) state.startedAt = new Date().toISOString();
    state.updatedAt = new Date().toISOString();
    await writeState(state);

    return NextResponse.json(
      { ok: true, state },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── DELETE /api/onboarding/state — reset progress (safe to re-run wizard) ── */

export async function DELETE() {
  try {
    await rm(statePath(), { force: true });
    return NextResponse.json({ ok: true, state: defaultState() });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
