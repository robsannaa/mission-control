/**
 * The agent's first move — it reaches out to the operator instead of waiting.
 *
 * When onboarding connects a model, Mission Control wakes the agent with a
 * one-time briefing: it tells the agent it now runs inside Mission Control and
 * what that gives it, and asks it to greet its operator and ask a couple of
 * setup questions. The reply lands in a session that the activity/notification
 * bridge surfaces, so the operator's very first experience is the agent saying
 * hello — not an empty chat box.
 *
 * This is the "message the user first" half of proactivity; the reminder path
 * (cron → notification) is the other half, already proven.
 */

import { gatewayWakeAgent } from "./gateway-tools";

const GREETING_BRIEFING = `[Mission Control — first run]
You have just been connected to a model and are now running inside Mission Control, a dashboard your operator uses to manage you. Through it you have: a Tasks board (Kanban cards that become live agent runs you can watch), cron schedules for recurring or one-off reminders, installable skills, a memory/vector brain, and chat channels (Telegram, Discord, and more).

Reach out to your operator first — do not wait to be prompted. Send ONE short, warm message: say hello, tell them in a sentence what you can now help with, and ask one or two quick questions to get set up (for example their name, their timezone, and what they'd most like your help with). Keep it brief and friendly.`;

export type GreetingResult = {
  ok: boolean;
  output?: string;
  error?: string;
};

/**
 * Wake the agent to greet the operator. Best-effort: a failure here must never
 * block onboarding, so callers should treat a non-ok result as "skip", not
 * "fail".
 */
export async function triggerProactiveGreeting(): Promise<GreetingResult> {
  try {
    const output = await gatewayWakeAgent({ text: GREETING_BRIEFING, mode: "now" });
    return { ok: true, output };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
