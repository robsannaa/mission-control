import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import "@xyflow/react/dist/style.css";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { Header, AgentChatPanel } from "@/components/header";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { ThemeProvider } from "@/components/theme-provider";
import { CapabilityProvider } from "@/components/capability-provider";
import { ChatNotificationToast } from "@/components/chat-notification-toast";

import { SetupGate } from "@/components/setup-gate";
import { UsageAlertMonitor } from "@/components/usage-alert-monitor";
import { CommitmentNotifier } from "@/components/commitment-notifier";
import { OpenClawUpdateBanner } from "@/components/openclaw-update-banner";
import { MissionControlUpdateBanner } from "@/components/mission-control-update-banner";
import { ToastRenderer } from "@/components/toast-renderer";
import { PairingBanner } from "@/components/pairing-banner";
import { VersionSkewBanner } from "@/components/version-skew-banner";
import { DashboardTourGate } from "@/components/dashboard-tour-gate";
import { readHostedFlag, getCapabilitySnapshot } from "@/lib/capability-probes";

// The capability snapshot is resolved per request (below, inside
// `RootLayout`) — this route must never be statically prerendered, or
// CAP-04 (probe results reflect the running instance, not the build) is
// defeated by Next's static optimization.
export const dynamic = "force-dynamic";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// `metadata` is evaluated at module scope and cannot await the async
// capability snapshot below — branding/copy is a deployment fact, not a
// feature gate, so the sync `readHostedFlag()` read is correct here. Do not
// re-derive the env-flag OR expression at this call site (D-07); this and
// `RootLayout`'s `getCapabilitySnapshot()` call are the only two facts read
// in this file, and they resolve through the same probe module.
const isHosted = readHostedFlag();

export const metadata: Metadata = {
  title: isHosted
    ? "Your AI Agent — AgentBay"
    : "Mission Control — OpenClaw GUI Dashboard for Local AI Agents",
  description: isHosted
    ? "Chat with and manage your AI agent from one dashboard in AgentBay."
    : "Mission Control is the open-source OpenClaw GUI and AI agent dashboard. " +
      "Monitor, chat with, and manage your local AI agents, models, cron jobs, " +
      "vector memory, and skills — all from a single local AI management tool " +
      "that runs entirely on your machine.",
  keywords: [
    "OpenClaw GUI",
    "AI agent dashboard",
    "local AI management tool",
    "OpenClaw dashboard",
    "AI agent manager",
    "local AI assistant",
    "OpenClaw Mission Control",
    "self-hosted AI dashboard",
    "AI agent monitoring",
    "open source AI GUI",
    "AI model management",
    "AI cron jobs",
    "vector memory dashboard",
    "LLM management tool",
    "private AI",
  ],
  manifest: isHosted ? undefined : "/manifest.json",
  applicationName: isHosted ? "AgentBay" : "Mission Control",
  authors: [{ name: "OpenClaw" }],
  creator: "OpenClaw",
  publisher: "OpenClaw",
  category: "technology",
  openGraph: {
    type: "website",
    siteName: isHosted ? "AgentBay" : "Mission Control — OpenClaw GUI",
    title: isHosted
      ? "Your AI Agent — AgentBay"
      : "Mission Control — The AI Agent Dashboard for OpenClaw",
    description: isHosted
      ? "Chat with and manage your AI agent from one dashboard in AgentBay."
      : "Monitor, chat with, and manage your local AI agents from one sleek dashboard. " +
        "Open-source, self-hosted, zero cloud. The ultimate OpenClaw GUI.",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: isHosted
      ? "Your AI Agent — AgentBay"
      : "Mission Control — OpenClaw GUI & AI Agent Dashboard",
    description: isHosted
      ? "Chat with and manage your AI agent from one dashboard in AgentBay."
      : "Open-source local AI management tool. Monitor agents, models, cron jobs, " +
        "vector memory and more — entirely on your machine.",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Mission Control",
  },
  other: {
    "mobile-web-app-capable": "yes",
  },
};

export const viewport: Viewport = {
  themeColor: "#131211",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Resolved once per request (per the dynamic-render export above) and
  // passed down as a prop — the SSR bootstrap point for every client
  // capability decision (sidebar nav, quick actions, settings hub, and
  // these two banners).
  const snapshot = await getCapabilitySnapshot();
  const canManageHostInfrastructure = snapshot.capabilities.hostInfrastructure;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/icons/icon-192.svg" type="image/svg+xml" />
        <link rel="apple-touch-icon" href="/icons/icon-192.svg" />
      </head>
      <body
        className={`${inter.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <CapabilityProvider snapshot={snapshot}>
            <SetupGate>
              <KeyboardShortcuts />
              <div className="flex h-screen overflow-hidden bg-muted text-foreground dark:bg-background dark:text-foreground">
                <Sidebar />
                <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
                  <Header />
                  <main
                    data-tour="main-content"
                    className="flex flex-1 overflow-hidden bg-muted dark:bg-background"
                  >
                    {children}
                  </main>
                </div>
              </div>
              <DashboardTourGate />
              <AgentChatPanel />
              <ChatNotificationToast />
              {/* These offer to update software running on the user's own
                  machine — they compose with hostInfrastructure, not the
                  raw `isHosted` branding flag (T-03-07). */}
              {canManageHostInfrastructure && <OpenClawUpdateBanner />}
              {canManageHostInfrastructure && <MissionControlUpdateBanner />}
              <PairingBanner />
              <VersionSkewBanner />
              <UsageAlertMonitor />
              <CommitmentNotifier />
              <ToastRenderer />
            </SetupGate>
          </CapabilityProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
