import { NextResponse } from 'next/server';
import { getWorkspaceSnapshot } from "@/lib/workspace-snapshot";
import { withRoute } from "@/lib/api-route";
import { serverError } from "@/lib/api-errors";

export const GET = withRoute({ name: "/api/workspace" }, async () => {
  try {
    const snapshot = await getWorkspaceSnapshot();
    return NextResponse.json(snapshot);
  } catch (error) {
    return serverError(error instanceof Error ? error.message : String(error));
  }
});
