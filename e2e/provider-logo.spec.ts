import { expect, test } from "@playwright/test";
import { getProviderLogoKey } from "../src/components/ui/provider-logo";

test.describe("provider logo identity", () => {
  test("normalizes gateway and model-family aliases", () => {
    expect(getProviderLogoKey("anthropic")).toBe("anthropic");
    expect(getProviderLogoKey("ollama-cloud")).toBe("ollama");
    expect(getProviderLogoKey("google-vertex")).toBe("gemini");
    expect(getProviderLogoKey("moonshotai")).toBe("kimi");
    expect(getProviderLogoKey("kimi-coding")).toBe("kimi");
    expect(getProviderLogoKey("mistralai")).toBe("mistral");
    expect(getProviderLogoKey("grok-4")).toBe("xai");
  });

  test("can infer a known mark from a gateway display name", () => {
    expect(getProviderLogoKey("custom-provider", "Groq Cloud")).toBe("groq");
    expect(getProviderLogoKey("custom-provider", "Kimi / Moonshot AI")).toBe("kimi");
  });

  test("leaves unknown plugins on the accessible initial fallback", () => {
    expect(getProviderLogoKey("company-internal-router")).toBeNull();
  });
});
