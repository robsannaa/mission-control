import { NextRequest, NextResponse } from "next/server";
import { fetchConfig, patchConfig } from "@/lib/gateway-config";
import { gatewayCall } from "@/lib/openclaw";
import { readFile, readdir } from "fs/promises";
import { join } from "path";
import { getDefaultWorkspaceSync, getSystemSkillsDir } from "@/lib/paths";
import {
  deriveSkillsCheck,
  findSkillRow,
  loadSkillsInventory,
  type SkillsStatus,
  type SkillStatusRow,
} from "@/lib/skills-status";

export const dynamic = "force-dynamic";

/* ── Types ────────────────────────────────────────── */

type Skill = {
  name: string;
  description: string;
  emoji: string;
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  source: string;
  bundled: boolean;
  homepage?: string;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
};

type SkillsList = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: Skill[];
};

/* ── Filesystem fallback for when neither gateway nor CLI answers ────── */

/**
 * Parse SKILL.md frontmatter to extract metadata.
 * Handles both YAML-style and JSON-in-YAML metadata blocks.
 */
function parseSkillFrontmatter(raw: string): {
  name?: string;
  description?: string;
  emoji?: string;
  requires?: { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[]; os?: string[] };
} {
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return {};
  const fm = fmMatch[1];

  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  const description = fm.match(/^description:\s*["']?([\s\S]*?)["']?\s*$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");

  // Extract emoji from metadata.openclaw.emoji
  const emoji = fm.match(/"emoji":\s*"([^"]+)"/)?.[1];

  // Extract requires from metadata.openclaw.requires
  let requires: { bins?: string[]; anyBins?: string[]; env?: string[]; config?: string[]; os?: string[] } | undefined;
  const reqMatch = fm.match(/"requires":\s*(\{[^}]*\})/);
  if (reqMatch) {
    try { requires = JSON.parse(reqMatch[1]); } catch { /* skip */ }
  }

  return { name, description, emoji, requires };
}

/**
 * Read skills directly from the filesystem when the CLI is unavailable.
 * Returns a degraded SkillsList with basic metadata parsed from SKILL.md files.
 */
async function readSkillsFromFilesystem(): Promise<SkillsList> {
  const skills: Skill[] = [];
  const seen = new Set<string>();

  const scanDir = async (dir: string, source: string) => {
    let entries: import("fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" }) as import("fs").Dirent[];
    } catch { return; }

    for (const entry of entries) {
      if (!entry.isDirectory() || seen.has(entry.name)) continue;
      seen.add(entry.name);

      const skillPath = join(dir, entry.name, "SKILL.md");
      let fm: ReturnType<typeof parseSkillFrontmatter> = {};
      try {
        const raw = await readFile(skillPath, "utf-8");
        fm = parseSkillFrontmatter(raw);
      } catch { /* SKILL.md may not exist */ }

      const bins = fm.requires?.bins || [];
      const anyBins = fm.requires?.anyBins || [];
      const env = fm.requires?.env || [];
      const config = fm.requires?.config || [];
      const os = fm.requires?.os || [];

      skills.push({
        name: fm.name || entry.name,
        description: fm.description || "",
        emoji: fm.emoji || "",
        eligible: false, // Can't determine without CLI
        disabled: false,
        blockedByAllowlist: false,
        source,
        bundled: source !== "workspace",
        homepage: undefined,
        missing: { bins, anyBins, env, config, os },
      });
    }
  };

  // Scan workspace skills first, then system skills
  await scanDir(join(getDefaultWorkspaceSync(), "skills"), "workspace");
  try {
    const sysDir = await getSystemSkillsDir();
    await scanDir(sysDir, "openclaw-bundled");
  } catch { /* system skills dir may not exist */ }

  return {
    workspaceDir: getDefaultWorkspaceSync(),
    managedSkillsDir: "",
    skills,
  };
}

/* ── GET ──────────────────────────────────────────── */

/** Project one inventory row onto the list shape the UI consumes. */
function toListSkill(row: SkillStatusRow): Skill {
  return {
    name: row.name,
    description: row.description,
    emoji: row.emoji || "",
    eligible: row.eligible,
    disabled: row.disabled,
    blockedByAllowlist: row.blockedByAllowlist,
    source: row.source,
    bundled: row.bundled,
    homepage: row.homepage,
    missing: row.missing ?? { bins: [], anyBins: [], env: [], config: [], os: [] },
  };
}

function toListPayload(status: SkillsStatus): SkillsList {
  return {
    workspaceDir: status.workspaceDir,
    managedSkillsDir: status.managedSkillsDir,
    skills: status.skills.map(toListSkill),
  };
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const action = searchParams.get("action") || "list";
  // Must be a real id from agents.list; the gateway rejects an unknown one
  // rather than falling back to the default agent.
  const agentId = searchParams.get("agent")?.trim() || undefined;

  try {
    if (action === "config") {
      // Get the full config to see skills/tools section
      try {
        const configData = await fetchConfig(8000);

        return NextResponse.json({
          tools: {
            resolved: configData.resolved.tools || {},
            parsed: configData.parsed.tools || {},
          },
          skills: {
            resolved: configData.resolved.skills || {},
            parsed: configData.parsed.skills || {},
          },
          hash: configData.hash,
        });
      } catch (err) {
        return NextResponse.json({
          tools: { resolved: {}, parsed: {} },
          skills: { resolved: {}, parsed: {} },
          hash: null,
          warning: String(err),
          degraded: true,
        });
      }
    }

    if (action === "info" && !searchParams.get("name")) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }

    // One inventory snapshot answers list, check and info alike: every row
    // carries the full `skills info` field set, so opening a skill costs no
    // extra call.
    const { status, warning } = await loadSkillsInventory(agentId);

    if (action === "check") {
      return NextResponse.json({ ...deriveSkillsCheck(status), warning });
    }

    if (action === "info") {
      const name = searchParams.get("name") as string;
      const row = findSkillRow(status, name);
      if (!row) {
        return NextResponse.json(
          { error: `Unknown skill: ${name}` },
          { status: 404 },
        );
      }

      // Read SKILL.md for display. The list-only CLI fallback has no filePath,
      // so this is best-effort.
      let skillMd: string | null = null;
      if (row.filePath) {
        try {
          const raw = await readFile(row.filePath, "utf-8");
          skillMd = raw.length > 10000 ? raw.slice(0, 10000) + "\n\n...(truncated)" : raw;
        } catch {
          // File may live outside this host, or be unreadable.
        }
      }

      let skillConfig: Record<string, unknown> | null = null;
      try {
        const configData = await fetchConfig(8000);
        const tools = (configData.resolved.tools || {}) as Record<string, unknown>;
        const key = row.skillKey || row.name;
        if (tools[key]) skillConfig = tools[key] as Record<string, unknown>;
      } catch {
        // Config is optional context for the detail view.
      }

      return NextResponse.json({ ...row, skillMd, skillConfig, warning });
    }

    return NextResponse.json({ ...toListPayload(status), warning });
  } catch (err) {
    console.error("Skills API error:", err);

    // Last resort: read SKILL.md files off disk. Loses eligibility and
    // requirement state, but beats showing an empty Skills page when neither
    // the gateway nor the CLI can be reached.
    if (action === "list" || action === "check") {
      try {
        const fsSkills = await readSkillsFromFilesystem();
        if (fsSkills.skills.length > 0) {
          if (action === "check") {
            return NextResponse.json({
              workspaceDir: fsSkills.workspaceDir,
              managedSkillsDir: fsSkills.managedSkillsDir,
              summary: {
                total: fsSkills.skills.length,
                eligible: 0,
                modelVisible: 0,
                commandVisible: 0,
                disabled: 0,
                blocked: 0,
                agentFiltered: 0,
                notInjected: 0,
                missingRequirements: 0,
              },
              eligible: [],
              modelVisible: [],
              commandVisible: [],
              disabled: [],
              blocked: [],
              agentFiltered: [],
              notInjected: [],
              missingRequirements: [],
              warning: "Loaded from filesystem — gateway and CLI both unreachable, so eligibility is unknown.",
              fromFilesystem: true,
            });
          }
          return NextResponse.json({
            ...fsSkills,
            warning: "Loaded from filesystem — gateway and CLI both unreachable, so eligibility is unknown.",
            fromFilesystem: true,
          });
        }
      } catch (fsErr) {
        console.error("Skills filesystem fallback error:", fsErr);
      }
    }

    if (action === "check") {
      return NextResponse.json({
        workspaceDir: "",
        managedSkillsDir: "",
        summary: {
          total: 0,
          eligible: 0,
          modelVisible: 0,
          commandVisible: 0,
          disabled: 0,
          blocked: 0,
          agentFiltered: 0,
          notInjected: 0,
          missingRequirements: 0,
        },
        eligible: [],
        modelVisible: [],
        commandVisible: [],
        disabled: [],
        blocked: [],
        agentFiltered: [],
        notInjected: [],
        missingRequirements: [],
        warning: String(err),
        degraded: true,
      });
    }
    if (action === "list") {
      return NextResponse.json({
        workspaceDir: "",
        managedSkillsDir: "",
        skills: [],
        warning: String(err),
        degraded: true,
      });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

/* ── POST: install / enable / disable / config ──── */

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action as string;

    switch (action) {
      // Non-streaming counterpart of POST /api/skills/install. Both go through
      // the gateway so OpenClaw resolves the package name and the installer for
      // its own host; see that route for why doing it here is wrong.
      case "install-requirement": {
        const name = body.name as string;
        const installId = body.installId as string;
        if (!name || !installId) {
          return NextResponse.json(
            { error: "name and installId required" },
            { status: 400 }
          );
        }
        try {
          const result = await gatewayCall<{
            ok?: boolean;
            message?: string;
            stdout?: string;
            stderr?: string;
          }>("skills.install", { name, installId }, 285_000);
          if (!result?.ok) {
            return NextResponse.json(
              { error: result?.message || "install failed", ...result },
              { status: 500 }
            );
          }
          return NextResponse.json({ ok: true, action, name, installId, ...result });
        } catch (err) {
          return NextResponse.json({ error: String(err) }, { status: 500 });
        }
      }

      case "enable-skill":
      case "disable-skill": {
        const name = body.name as string;
        if (!name)
          return NextResponse.json(
            { error: "name required" },
            { status: 400 }
          );

        const enabled = action === "enable-skill";

        // `skills.update` is the purpose-built toggle: it writes the same
        // `skills.entries.<key>.enabled` and takes effect immediately. Writing
        // that key through config.patch instead needed a gateway restart to be
        // picked up, which dropped every live session to flip one switch.
        try {
          await gatewayCall("skills.update", { skillKey: name, enabled }, 15_000);
          return NextResponse.json({ ok: true, action, name });
        } catch (rpcErr) {
          // Fall back to the config write for gateways without the method.
          try {
            await patchConfig({
              skills: { entries: { [name]: { enabled } } },
            }, { restartDelayMs: 2000 });
            return NextResponse.json({
              ok: true,
              action,
              name,
              warning: `skills.update unavailable (${rpcErr instanceof Error ? rpcErr.message : String(rpcErr)}); wrote the config and restarted the gateway instead.`,
            });
          } catch (err) {
            return NextResponse.json({ error: String(err) }, { status: 500 });
          }
        }
      }

      case "update-tool-config": {
        // Patch tools.<skillKey> config
        const skillKey = body.skillKey as string;
        const config = body.config as Record<string, unknown>;
        if (!skillKey || !config)
          return NextResponse.json(
            { error: "skillKey and config required" },
            { status: 400 }
          );

        try {
          await patchConfig({ tools: { [skillKey]: config } });
          return NextResponse.json({ ok: true, action, skillKey });
        } catch (err) {
          return NextResponse.json({ error: String(err) }, { status: 500 });
        }
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (err) {
    console.error("Skills POST error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
