export type CronDeliveryMode = "announce" | "webhook" | "none";

export type CronDeliveryConfig = {
  mode: string;
  channel?: string;
  to?: string;
  accountId?: string;
  bestEffort?: boolean;
};

function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeDeliveryMode(value: unknown): CronDeliveryMode | null {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "announce" || mode === "webhook" || mode === "none") return mode;
  return null;
}

export function isValidWebhookUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Build the delivery payload accepted by OpenClaw cron.add/cron.update.
 *
 * Mission Control requires an explicit recipient for announced automation output.
 * A UI-created cron job has no stable inbound chat context, so relying on OpenClaw's
 * `last` route without `to` can resolve a provider (for example Telegram) while still
 * leaving it without the required chat ID.
 */
export function buildCronDeliveryConfig(
  params: Record<string, unknown>,
  current?: CronDeliveryConfig,
): CronDeliveryConfig {
  const deliveryMode =
    normalizeDeliveryMode(params.deliveryMode) ??
    (params.announce === true
      ? "announce"
      : params.announce === false
        ? "none"
        : normalizeDeliveryMode(current?.mode) ?? "none");

  if (deliveryMode === "none") return { mode: "none" };

  const rawTo = hasOwn(params, "to")
    ? String(params.to || "").trim()
    : String(current?.to || "").trim();
  const bestEffort = hasOwn(params, "bestEffort")
    ? Boolean(params.bestEffort)
    : Boolean(current?.bestEffort);

  if (deliveryMode === "webhook") {
    if (!rawTo) throw new Error('Webhook delivery requires a target URL in "to".');
    if (!isValidWebhookUrl(rawTo)) {
      throw new Error("Webhook delivery URL must start with http:// or https://");
    }
    return {
      mode: "webhook",
      to: rawTo,
      ...(bestEffort ? { bestEffort: true } : {}),
    };
  }

  if (!rawTo) {
    throw new Error(
      "Announced cron delivery requires a recipient. For Telegram, select or enter the numeric chat ID.",
    );
  }

  const rawChannel = hasOwn(params, "channel")
    ? String(params.channel || "").trim()
    : String(current?.channel || "").trim();

  return {
    mode: "announce",
    ...(rawChannel ? { channel: rawChannel } : {}),
    to: rawTo,
    ...(bestEffort ? { bestEffort: true } : {}),
  };
}
