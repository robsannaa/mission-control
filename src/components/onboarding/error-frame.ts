/**
 * Wire format for the wizard's "first chat" step.
 *
 * `src/app/api/onboarding/chat/route.ts` streams plain assistant text, with
 * exactly one exception: if the turn failed — before the first byte or
 * mid-stream — the response ends with this marker followed by a
 * plain-language remediation message. Everything before the marker is real
 * assistant content that already streamed and should stay visible;
 * everything from the marker onward is never shown as if the agent said it.
 *
 * Pure and dependency-free so it can be unit tested without a server and
 * shared between the server route and the client step (both in-scope for
 * onboarding).
 */
// Built from a char code (rather than an inline literal) so the zero-width
// space marker can't accidentally get "fixed" into a visible character by an
// editor or formatter — it must never collide with real assistant prose.
const ZWSP = String.fromCharCode(0x200b);
export const ONBOARD_ERROR_MARKER = `${ZWSP}[[MC_ONBOARD_ERROR]]${ZWSP}`;

export type OnboardChatFrame = {
  /** Assistant text preceding an error marker (the whole text when there's no error). */
  content: string;
  /** Plain-language remediation message, or null when the turn is a genuine reply. */
  error: string | null;
};

const FALLBACK_ERROR = "The agent hit a problem answering. Try again in a moment.";

/** Split an accumulated raw chat stream into displayable content and an optional error. */
export function splitOnboardChatFrame(raw: string): OnboardChatFrame {
  const idx = raw.indexOf(ONBOARD_ERROR_MARKER);
  if (idx === -1) return { content: raw, error: null };
  const message = raw.slice(idx + ONBOARD_ERROR_MARKER.length).trim();
  return { content: raw.slice(0, idx), error: message || FALLBACK_ERROR };
}

/** Build the terminal chunk a failed turn ends with. */
export function buildOnboardErrorFrame(message: string): string {
  return `${ONBOARD_ERROR_MARKER}${message.trim() || FALLBACK_ERROR}`;
}

/**
 * Translate a raw gateway/agent failure into plain language, no CLI jargon or
 * paths. Order matters: more specific matches must come first.
 */
export function friendlyOnboardChatError(detail: string, status?: number): string {
  const text = String(detail || "").toLowerCase();
  if (
    status === 401 ||
    status === 403 ||
    /unauthor|forbidden|invalid.*key|missing.*credential|no api key found|no.*provider configured|no model|model not configured|unknown model/.test(
      text,
    )
  ) {
    return "Your model isn't connected yet — go back to the Model step and reconnect it.";
  }
  if (status === 404 || /gateway.*unreachable|econnrefused|not reachable/.test(text)) {
    return "The agent isn't reachable right now. Go back to the Gateway step and make sure it's running.";
  }
  if (!text.trim()) {
    return FALLBACK_ERROR;
  }
  return "The agent hit a problem answering. Check the Model and Gateway steps, then try again.";
}
