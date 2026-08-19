import { redirect } from "next/navigation";
import { RouteSectionView } from "@/components/route-section-view";
import { getCapabilitySnapshot } from "@/lib/capability-probes";
import type { CapabilityKey } from "@/lib/capabilities";

type SearchParams = Record<string, string | string[] | undefined>;

const SECTION_TO_PATH: Record<string, string> = {
  dashboard: "/dashboard",
  chat: "/chat",
  agents: "/agents",
  tasks: "/tasks",
  cron: "/cron",
  heartbeat: "/heartbeat",
  sessions: "/sessions",
  system: "/dashboard",
  memory: "/memory",
  memories: "/memory",
  docs: "/documents",
  documents: "/documents",
  config: "/config",
  settings: "/config",
  skills: "/skills",
  models: "/agents?tab=models",
  accounts: "/accounts",
  channels: "/channels",
  audio: "/audio",
  vectors: "/vectors",
  logs: "/logs",
  usage: "/usage",
  terminal: "/terminal",
  security: "/security",
  permissions: "/permissions",
  tailscale: "/tailscale",
  browser: "/browser",
  calendar: "/calendar",
  integrations: "/integrations",
  search: "/search",
  help: "/help",
};

// The two sections /calendar and /tailscale gate on directly (their own
// dedicated pages carry the identical check) — kept as a map, not two
// separate `if`s, so this router and the dedicated pages can never drift
// out of sync on which capability key backs which section.
const SECTION_CAPABILITY: Partial<Record<string, CapabilityKey>> = {
  tailscale: "tailscaleNetworking",
  calendar: "calendarWorkspace",
};

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] || null;
  return typeof value === "string" ? value : null;
}

function appendParam(
  out: URLSearchParams,
  key: string,
  value: string | string[] | undefined
) {
  if (Array.isArray(value)) {
    for (const v of value) out.append(key, v);
    return;
  }
  if (typeof value === "string") out.set(key, value);
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const paramsObj = (searchParams ? await searchParams : {}) || {};

  const section = firstParam(paramsObj.section);
  if (section) {
    const normalizedSection = section.toLowerCase();
    const requiredCapability = SECTION_CAPABILITY[normalizedSection];
    let targetPath = SECTION_TO_PATH[normalizedSection] || "/dashboard";
    if (requiredCapability) {
      const { capabilities } = await getCapabilitySnapshot();
      if (!capabilities[requiredCapability]) {
        targetPath = "/dashboard";
      }
    }
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(paramsObj)) {
      if (key === "section") continue;
      appendParam(query, key, value);
    }
    const suffix = query.toString();
    redirect(suffix ? `${targetPath}?${suffix}` : targetPath);
  }

  return <RouteSectionView section="chat" />;
}
