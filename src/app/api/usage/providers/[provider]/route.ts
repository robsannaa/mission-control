import { NextRequest, NextResponse } from "next/server";
import { getProviderSnapshot, maybeCollectProvider } from "@/lib/provider-billing/shared";
import { patchConfig } from "@/lib/gateway-config";

export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ provider: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { provider } = await context.params;
    const supportedProviders = ["openrouter", "openai", "anthropic"] as const;
    type SupportedProvider = (typeof supportedProviders)[number];
    if (!supportedProviders.includes(provider as SupportedProvider)) {
      return NextResponse.json(
        { ok: false, error: `${provider} usage tracking not yet supported` },
        { status: 501 },
      );
    }
    if (request.nextUrl.searchParams.get("refresh") === "1") {
      await maybeCollectProvider(provider as SupportedProvider);
    }
    const snapshot = await getProviderSnapshot(provider);
    return NextResponse.json({ ok: true, provider, snapshot });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

const PROVIDER_CREDENTIAL_KEYS: Record<string, string[]> = {
  openrouter: ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_MGMT_KEY"],
  openai: ["OPENAI_ADMIN_API_KEY"],
  anthropic: ["ANTHROPIC_ADMIN_API_KEY"],
};

async function saveEnvCredentials(values: Record<string, string>) {
  await patchConfig({ env: values });
  return { method: "gateway" as const };
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { provider } = await context.params;
    const supportedProviders = ["openrouter", "openai", "anthropic"] as const;
    type SupportedProvider = (typeof supportedProviders)[number];
    if (!supportedProviders.includes(provider as SupportedProvider)) {
      return NextResponse.json(
        { ok: false, error: `${provider} usage tracking not yet supported` },
        { status: 501 },
      );
    }

    const body = await request.json();
    const action = String(body.action || "");
    if (action !== "save-credentials") {
      return NextResponse.json({ ok: false, error: "Unknown action" }, { status: 400 });
    }

    const allowedKeys = PROVIDER_CREDENTIAL_KEYS[provider] || [];
    const incoming = (body.values || {}) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const key of allowedKeys) {
      const raw = incoming[key];
      if (typeof raw === "string" && raw.trim()) {
        values[key] = raw.trim();
      }
    }
    if (Object.keys(values).length === 0) {
      return NextResponse.json(
        { ok: false, error: "No valid credential values provided." },
        { status: 400 },
      );
    }

    const save = await saveEnvCredentials(values);
    // Ensure immediate same-request collector access to newly saved credentials.
    // This avoids timing gaps where config persistence is accepted but not yet
    // visible to downstream credential resolution.
    for (const [key, value] of Object.entries(values)) {
      process.env[key] = value;
    }
    await maybeCollectProvider(provider as SupportedProvider);
    const snapshot = await getProviderSnapshot(provider);
    return NextResponse.json({
      ok: true,
      provider,
      savedKeys: Object.keys(values),
      method: save.method,
      snapshot,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
