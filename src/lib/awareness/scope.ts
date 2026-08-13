import { PROXY_USER_HEADER } from "@/lib/auth";

export interface InteractionScope {
  tenantId: string;
  userId: string;
}

/**
 * Resolve the tenant/user for interaction storage from the SERVER's own
 * identity — never from the request body. (B2)
 *
 * In Mission Control's single-tenant local/hosted-container model, tenant and
 * user come from server env (or the trusted-proxy user header), so every
 * path — create, read, answer, complete — agrees on the same scope. Deriving it
 * here (instead of trusting `tenantId` in an intake body guarded only by a
 * single install-wide token) closes both the cross-tenant write and the
 * "hosted interactions are invisible / stuck in resuming" bugs, because the
 * create side and the read/complete side can no longer disagree.
 */
export function resolveInteractionScope(request?: {
  headers: { get(name: string): string | null };
}): InteractionScope {
  const tenantId = process.env.MISSION_CONTROL_TENANT_ID?.trim() || "local";
  const proxyUser = request?.headers.get(PROXY_USER_HEADER)?.trim() || "";
  const userId = proxyUser || process.env.MISSION_CONTROL_USER_ID?.trim() || "owner";
  return { tenantId, userId };
}
