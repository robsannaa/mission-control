import { NextRequest, NextResponse } from "next/server";
import {
  DEFAULT_EXTRACTION_SETTINGS,
  extractKnowledge,
  findLegacyOpenAiKey,
  readExtractionSettings,
  writeExtractionSettings,
  type ExtractionMode,
} from "@/lib/memory-extraction";

export const dynamic = "force-dynamic";

const VALID_MODES: ExtractionMode[] = ["gateway", "openai", "off"];

/* ── GET: current extraction settings ─────────── */

export async function GET() {
  try {
    const settings = await readExtractionSettings();
    // Suggest (never auto-use) a key an older build left in ~/.openclaw/.env.
    const legacyKey = await findLegacyOpenAiKey();
    return NextResponse.json({
      settings,
      defaults: DEFAULT_EXTRACTION_SETTINGS,
      legacyOpenAiKeyDetected: Boolean(legacyKey) && !settings.openaiApiKey,
    });
  } catch (err) {
    console.error("Memory extraction GET error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST: save / import-legacy-key / test ────── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = String(body.action || "save");

    if (action === "save") {
      const raw = (body.settings || {}) as Record<string, unknown>;
      if (raw.mode !== undefined && !VALID_MODES.includes(raw.mode as ExtractionMode)) {
        return NextResponse.json(
          { error: `Invalid mode. Must be one of: ${VALID_MODES.join(", ")}` },
          { status: 400 }
        );
      }
      const settings = await writeExtractionSettings({
        ...(raw.mode !== undefined ? { mode: raw.mode as ExtractionMode } : {}),
        ...(raw.model !== undefined ? { model: String(raw.model) } : {}),
        ...(raw.openaiApiKey !== undefined
          ? { openaiApiKey: String(raw.openaiApiKey) }
          : {}),
      });
      return NextResponse.json({ ok: true, action, settings });
    }

    // Explicit, user-confirmed migration of a key found in ~/.openclaw/.env.
    if (action === "import-legacy-key") {
      const legacyKey = await findLegacyOpenAiKey();
      if (!legacyKey) {
        return NextResponse.json(
          { error: "No OPENAI_API_KEY found in ~/.openclaw/.env" },
          { status: 404 }
        );
      }
      const settings = await writeExtractionSettings({ openaiApiKey: legacyKey });
      return NextResponse.json({ ok: true, action, settings });
    }

    // Run a tiny extraction so the user (and tests) can verify the
    // configured mode/model works before rebuilding the whole graph.
    if (action === "test") {
      const settings = await readExtractionSettings();
      const content =
        typeof body.content === "string" && body.content.trim()
          ? body.content
          : "User prefers TypeScript. Mission Control uses Next.js.";
      if (settings.mode === "off") {
        return NextResponse.json(
          { error: "extraction is off — enable gateway or openai mode first" },
          { status: 400 }
        );
      }
      try {
        const result = await extractKnowledge(content, settings);
        return NextResponse.json({
          ok: true,
          action,
          mode: settings.mode,
          model: settings.model,
          entities: result.entities,
          relations: result.relations,
        });
      } catch (err) {
        return NextResponse.json(
          {
            error: `extraction failed: ${err instanceof Error ? err.message : String(err)}`,
            mode: settings.mode,
            model: settings.model,
          },
          { status: 502 }
        );
      }
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (err) {
    console.error("Memory extraction POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
