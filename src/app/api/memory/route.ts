import { NextResponse } from "next/server";
import {
  addMemory,
  deleteMemory,
  explainCandidate,
  getMemorySnapshot,
  promoteCandidates,
  reindexMemory,
  updateMemory,
} from "@/lib/memory-native";
import { withRoute } from "@/lib/api-route";
import { memoryPostSchema } from "@/lib/schemas/knowledge";
import { apiError, badRequest, serverError } from "@/lib/api-errors";

export const dynamic = "force-dynamic";

/** GET — the whole memory snapshot: entries, reflections, promotion candidates, index status. */
export const GET = withRoute({ name: "/api/memory" }, async (_request, ctx) => {
  try {
    return NextResponse.json(await getMemorySnapshot());
  } catch (error) {
    ctx.log.error(
      { err: error instanceof Error ? error.message : String(error) },
      "Memory GET error",
    );
    return serverError(error instanceof Error ? error.message : String(error));
  }
});

/** POST — mutate memory: add / edit / delete an entry, promote candidates, reindex, explain. */
export const POST = withRoute(
  { name: "/api/memory", bodySchema: memoryPostSchema },
  async (_request, ctx) => {
  const body = ctx.body;
  const action = String(body.action || "");
  try {
    switch (action) {
      case "add":
        await addMemory(String(body.heading || ""), String(body.body || ""));
        break;
      case "update":
        await updateMemory(String(body.id || ""), String(body.heading || ""), String(body.body || ""));
        break;
      case "delete":
        await deleteMemory(String(body.id || ""));
        break;
      case "promote":
        await promoteCandidates();
        break;
      case "reindex":
        await reindexMemory(Boolean(body.force));
        break;
      case "explain": {
        const explanation = await explainCandidate(String(body.selector || ""));
        return NextResponse.json({ ok: true, explanation });
      }
      default:
        return badRequest(`Unknown action: ${action}`);
    }
    return NextResponse.json({ ok: true, ...(await getMemorySnapshot()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|empty|no longer exists/i.test(message) ? 400 : 500;
    return apiError(message, status);
  }
  },
);
