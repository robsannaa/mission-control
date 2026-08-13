import { NextRequest, NextResponse } from "next/server";
import {
  addMemory,
  deleteMemory,
  explainCandidate,
  getMemorySnapshot,
  promoteCandidates,
  reindexMemory,
  updateMemory,
} from "@/lib/memory-native";

export const dynamic = "force-dynamic";

/** GET — the whole memory snapshot: entries, reflections, promotion candidates, index status. */
export async function GET() {
  try {
    return NextResponse.json(await getMemorySnapshot());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

/** POST — mutate memory: add / edit / delete an entry, promote candidates, reindex, explain. */
export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
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
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, ...(await getMemorySnapshot()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /required|empty|no longer exists/i.test(message) ? 400 : 500;
    return NextResponse.json({ ok: false, error: message }, { status });
  }
}
