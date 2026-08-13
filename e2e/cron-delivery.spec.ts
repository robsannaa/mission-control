import { expect, test } from "@playwright/test";
import { buildCronDeliveryConfig } from "../src/lib/cron-delivery";

test.describe("cron delivery configuration", () => {
  test("rejects announced delivery without a concrete recipient", () => {
    expect(() =>
      buildCronDeliveryConfig({ deliveryMode: "announce", channel: "last" }),
    ).toThrow(/requires a recipient/i);
  });

  test("accepts an explicit Telegram chat ID", () => {
    expect(
      buildCronDeliveryConfig({
        deliveryMode: "announce",
        channel: "telegram",
        to: "1386366527",
        bestEffort: true,
      }),
    ).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "1386366527",
      bestEffort: true,
    });
  });

  test("preserves an existing recipient when editing another delivery field", () => {
    expect(
      buildCronDeliveryConfig(
        { deliveryMode: "announce", bestEffort: false },
        { mode: "announce", channel: "telegram", to: "1386366527", bestEffort: true },
      ),
    ).toEqual({ mode: "announce", channel: "telegram", to: "1386366527" });
  });

  test("keeps no-delivery jobs recipient-free", () => {
    expect(buildCronDeliveryConfig({ deliveryMode: "none" })).toEqual({ mode: "none" });
  });
});
