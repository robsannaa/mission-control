import { NextRequest, NextResponse } from "next/server";
import { getProviderSnapshot, maybeCollectProvider } from "@/lib/provider-billing/shared";
import { patchConfig } from "@/lib/gateway-config";
import { withRoute } from "@/lib/api-route";
import { badRequest, serverError } from "@/lib/api-errors";
import {
  usageProviderPostSchema,
  usageProviderRefreshQuerySchema,
  usageProviderRouteParamsSchema,
} from "@/lib/schemas/usage";

export const dynamic = "force-dynamic";

export const GET = withRoute(
  {
    name: "/api/usage/providers/[provider]",
    routeSchema: usageProviderRouteParamsSchema,
    querySchema: usageProviderRefreshQuerySchema,
  },
  async (_request: NextRequest, ctx) => {
    try {
      const { provider } = ctx.params;
      if (ctx.query.refresh === "1") {
        await maybeCollectProvider(provider);
      }
      const snapshot = await getProviderSnapshot(provider);
      return NextResponse.json({ ok: true, provider, snapshot });
    } catch (err) {
      return serverError(err instanceof Error ? err.message : String(err));
    }
  },
);

const PROVIDER_CREDENTIAL_KEYS: Record<string, string[]> = {
  openrouter: ["OPENROUTER_MANAGEMENT_KEY", "OPENROUTER_MGMT_KEY"],
  openai: ["OPENAI_ADMIN_API_KEY"],
  anthropic: ["ANTHROPIC_ADMIN_API_KEY"],
};

async function saveEnvCredentials(values: Record<string, string>) {
  await patchConfig({ env: values });
  return { method: "gateway" as const };
}

export const POST = withRoute(
  {
    name: "/api/usage/providers/[provider]",
    routeSchema: usageProviderRouteParamsSchema,
    bodySchema: usageProviderPostSchema,
  },
  async (_request: NextRequest, ctx) => {
    try {
      const { provider } = ctx.params;
      const action = String(ctx.body.action || "");
      if (action !== "save-credentials") {
        return badRequest("Unknown action");
      }

      const allowedKeys = PROVIDER_CREDENTIAL_KEYS[provider] || [];
      const incoming = (ctx.body.values || {}) as Record<string, unknown>;
      const values: Record<string, string> = {};
      for (const key of allowedKeys) {
        const raw = incoming[key];
        if (typeof raw === "string" && raw.trim()) {
          values[key] = raw.trim();
        }
      }
      if (Object.keys(values).length === 0) {
        return badRequest("No valid credential values provided.");
      }

      const save = await saveEnvCredentials(values);
      // Ensure immediate same-request collector access to newly saved credentials.
      // This avoids timing gaps where config persistence is accepted but not yet
      // visible to downstream credential resolution.
      for (const [key, value] of Object.entries(values)) {
        process.env[key] = value;
      }
      await maybeCollectProvider(provider);
      const snapshot = await getProviderSnapshot(provider);
      return NextResponse.json({
        ok: true,
        provider,
        savedKeys: Object.keys(values),
        method: save.method,
        snapshot,
      });
    } catch (err) {
      return serverError(err instanceof Error ? err.message : String(err));
    }
  },
);
