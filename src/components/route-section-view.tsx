"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { DashboardView } from "@/components/dashboard-view";
import { ChatView } from "@/components/chat-view";
import { PanelErrorBoundary } from "@/components/panel-error-boundary";
import { GatewayOfflineBanner } from "@/components/gateway-offline-banner";
import { ContentLoadingState } from "@/components/ui/loading-state";
import { setChatActive } from "@/lib/chat-store";

function SectionLoading() {
  return <ContentLoadingState />;
}

const TasksView = dynamic(
  () => import("@/components/tasks-view").then((m) => m.TasksView),
  { loading: () => <SectionLoading /> }
);
const CronView = dynamic(
  () => import("@/components/cron-view").then((m) => m.CronView),
  { loading: () => <SectionLoading /> }
);
const HeartbeatView = dynamic(
  () => import("@/components/heartbeat-view").then((m) => m.HeartbeatView),
  { loading: () => <SectionLoading /> }
);
const SessionsView = dynamic(
  () => import("@/components/sessions-view").then((m) => m.SessionsView),
  { loading: () => <SectionLoading /> }
);
const MemoryView = dynamic(
  () => import("@/components/memory-view").then((m) => m.MemoryView),
  { loading: () => <SectionLoading /> }
);
const DocsView = dynamic(
  () => import("@/components/docs-view").then((m) => m.DocsView),
  { loading: () => <SectionLoading /> }
);
const ConfigEditor = dynamic(
  () => import("@/components/config-editor").then((m) => m.ConfigEditor),
  { loading: () => <SectionLoading /> }
);
const SkillsView = dynamic(
  () => import("@/components/skills-view").then((m) => m.SkillsView),
  { loading: () => <SectionLoading /> }
);
const LogsView = dynamic(
  () => import("@/components/logs-view").then((m) => m.LogsView),
  { loading: () => <SectionLoading /> }
);
const AudioView = dynamic(
  () => import("@/components/audio-view").then((m) => m.AudioView),
  { loading: () => <SectionLoading /> }
);
const VectorView = dynamic(
  () => import("@/components/vector-view").then((m) => m.VectorView),
  { loading: () => <SectionLoading /> }
);
const AgentsView = dynamic(
  () => import("@/components/agents-view").then((m) => m.AgentsView),
  { loading: () => <SectionLoading /> }
);
const UsageView = dynamic(
  () => import("@/components/usage-view").then((m) => m.UsageView),
  { loading: () => <SectionLoading /> }
);
const TerminalView = dynamic(
  () => import("@/components/terminal-view").then((m) => m.TerminalView),
  { loading: () => <SectionLoading /> }
);
const SecurityView = dynamic(
  () => import("@/components/security-view").then((m) => m.SecurityView),
  { loading: () => <SectionLoading /> }
);
const TailscaleView = dynamic(
  () => import("@/components/tailscale-view").then((m) => m.TailscaleView),
  { loading: () => <SectionLoading /> }
);
const BrowserRelayView = dynamic(
  () => import("@/components/browser-relay-view").then((m) => m.BrowserRelayView),
  { loading: () => <SectionLoading /> }
);
const AccountsKeysView = dynamic(
  () => import("@/components/accounts-keys-view").then((m) => m.AccountsKeysView),
  { loading: () => <SectionLoading /> }
);
const WebSearchView = dynamic(
  () => import("@/components/web-search-view").then((m) => m.WebSearchView),
  { loading: () => <SectionLoading /> }
);
const CalendarView = dynamic(
  () => import("@/components/calendar-view").then((m) => m.CalendarView),
  { loading: () => <SectionLoading /> }
);
const IntegrationsView = dynamic(
  () => import("@/components/integrations-view").then((m) => m.IntegrationsView),
  { loading: () => <SectionLoading /> }
);
const SettingsView = dynamic(
  () => import("@/components/settings-view").then((m) => m.SettingsView),
  { loading: () => <SectionLoading /> }
);
const HooksView = dynamic(
  () => import("@/components/hooks-view").then((m) => m.HooksView),
  { loading: () => <SectionLoading /> }
);
const DoctorView = dynamic(
  () => import("@/components/doctor-view").then((m) => m.DoctorView),
  { loading: () => <SectionLoading /> }
);
const ActivityView = dynamic(
  () => import("@/components/activity-view").then((m) => m.ActivityView),
  { loading: () => <SectionLoading /> }
);
const HelpView = dynamic(
  () => import("@/components/help-view").then((m) => m.HelpView),
  { loading: () => <SectionLoading /> }
);
const ChannelsView = dynamic(
  () => import("@/components/channels-view").then((m) => m.ChannelsView),
  { loading: () => <SectionLoading /> }
);
const GBrainView = dynamic(
  () => import("@/components/gbrain-view").then((m) => m.GBrainView),
  { loading: () => <SectionLoading /> }
);

const isAgentbayHosting = process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";

export type DashboardSection =
  | "dashboard"
  | "chat"
  | "agents"
  | "tasks"
  | "cron"
  | "heartbeat"
  | "sessions"
  | "memory"
  | "docs"
  | "config"
  | "skills"
  | "models"
  | "accounts"
  | "audio"
  | "vectors"
  | "logs"
  | "usage"
  | "terminal"
  | "security"
  | "permissions"
  | "tailscale"
  | "browser"
  | "calendar"
  | "integrations"
  | "search"
  | "settings"
  | "hooks"
  | "doctor"
  | "activity"
  | "help"
  | "g-brain"
  | "channels";

function SectionContent({ section }: { section: DashboardSection }) {
  if (isAgentbayHosting && section === "tailscale") {
    return <DashboardView />;
  }

  switch (section) {
    case "dashboard":
      return <DashboardView />;
    case "agents":
      return <AgentsView />;
    case "tasks":
      return <TasksView />;
    case "cron":
      return <CronView />;
    case "heartbeat":
      return <HeartbeatView />;
    case "sessions":
      return <SessionsView />;
    case "memory":
      return <MemoryView />;
    case "docs":
      return <DocsView />;
    case "config":
      return <ConfigEditor />;
    case "skills":
      return <SkillsView />;
    case "models":
      return <AgentsView />;
    case "accounts":
      return <AccountsKeysView />;
    case "audio":
      return <AudioView />;
    case "vectors":
      return <VectorView />;
    case "logs":
      return <LogsView />;
    case "usage":
      return <UsageView />;
    case "terminal":
      return <TerminalView />;
    case "security":
      return <SecurityView initialTab="health" />;
    case "permissions":
      return <SecurityView initialTab="permissions" />;
    case "tailscale":
      return <TailscaleView />;
    case "browser":
      return <BrowserRelayView isHosted={isAgentbayHosting} />;
    case "calendar":
      return <CalendarView />;
    case "integrations":
      return <IntegrationsView />;
    case "search":
      return <WebSearchView />;
    case "settings":
      return <SettingsView />;
    case "hooks":
      return <HooksView />;
    case "doctor":
      return <DoctorView />;
    case "activity":
      return <ActivityView />;
    case "help":
      return <HelpView />;
    case "channels":
      return <ChannelsView />;
    case "g-brain":
      return <GBrainView />;
    default:
      return <DashboardView />;
  }
}

export function RouteSectionView({ section }: { section: DashboardSection }) {
  const isChatSection = section === "chat";

  useEffect(() => {
    setChatActive(isChatSection);
    return () => setChatActive(false);
  }, [isChatSection]);

  return (
    <>
      <div
        className={isChatSection ? "flex flex-1 flex-col overflow-hidden" : "hidden"}
      >
        <PanelErrorBoundary key={isChatSection ? "chat-visible" : "chat-hidden"} section="chat">
          <ChatView isVisible={isChatSection} />
        </PanelErrorBoundary>
      </div>

      {!isChatSection && (
        <PanelErrorBoundary key={section} section={section}>
          {section !== "dashboard" && <GatewayOfflineBanner />}
          <SectionContent section={section} />
        </PanelErrorBoundary>
      )}
    </>
  );
}
