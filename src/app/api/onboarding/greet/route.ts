import { NextResponse } from "next/server";
import { triggerProactiveGreeting } from "@/lib/proactive-greeting";

export const dynamic = "force-dynamic";

/**
 * Wake the agent to greet its operator (the proactive "hello" after a model is
 * connected). Best-effort: never blocks onboarding, so a failure returns 200
 * with ok:false rather than an error status.
 */
export async function POST() {
  const result = await triggerProactiveGreeting();
  return NextResponse.json(result);
}
