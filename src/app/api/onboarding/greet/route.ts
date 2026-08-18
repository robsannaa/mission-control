import { NextResponse } from "next/server";
import { triggerProactiveGreeting } from "@/lib/proactive-greeting";
import { withRoute } from "@/lib/api-route";

export const dynamic = "force-dynamic";

/**
 * Wake the agent to greet its operator (the proactive "hello" after a model is
 * connected). Best-effort: never blocks onboarding, so a failure returns 200
 * with ok:false rather than an error status. `triggerProactiveGreeting`
 * already answers `{ ok, output?, error? }` — envelope-conformant as-is, no
 * builder needed for its (always-200) failure case.
 */
export const POST = withRoute({ name: "/api/onboarding/greet" }, async () => {
  const result = await triggerProactiveGreeting();
  return NextResponse.json(result);
});
