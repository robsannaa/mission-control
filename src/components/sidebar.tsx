"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, useCallback, useSyncExternalStore, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Activity,
  LayoutDashboard,
  ListChecks,
  Calendar,
  MessageSquare,
  Brain,
  FolderOpen,
  Settings,
  Wrench,
  MessageCircle,
  Terminal,
  SquareTerminal,
  Cpu,
  Volume2,
  Database,
  Users,
  Users2,
  BarChart3,
  Menu,
  X,
  ShieldCheck,
  Package,
  ChevronRight,
  ChevronLeft,
  Waypoints,
  Globe,
  KeyRound,
  Search,
  Heart,
  Settings2,
  Webhook,
  Stethoscope,
  HelpCircle,
  Puzzle,
  Radio,
} from "lucide-react";
import { getChatUnreadCount, subscribeChatStore } from "@/lib/chat-store";

function TickingClockIcon({ className }: { className?: string }) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const tick = () => setNow(new Date());
    tick();
    const interval = window.setInterval(tick, 1_000);
    return () => window.clearInterval(interval);
  }, []);

  const seconds = now?.getSeconds() ?? 0;
  const minutes = (now?.getMinutes() ?? 0) + seconds / 60;
  const hours = (now?.getHours() ?? 0) + minutes / 60;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      data-live-clock
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.75" />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="8.25"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        transform={`rotate(${hours * 30} 12 12)`}
      />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="6.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        transform={`rotate(${minutes * 6} 12 12)`}
      />
      <line
        x1="12"
        y1="13"
        x2="12"
        y2="5"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinecap="round"
        opacity="0.72"
        transform={`rotate(${seconds * 6} 12 12)`}
      />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}

type NavItem = {
  section: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  href?: string;
  tab?: string;
  isSubItem?: boolean;
  comingSoon?: boolean;
  beta?: boolean;
  group?: string;
};

const isAgentbayHosting = process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";

const defaultNavItems: NavItem[] = [
  // ── Overview ──
  { group: "Overview", section: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { section: "activity", label: "Activity", icon: Activity, href: "/activity" },
  { section: "usage", label: "Usage", icon: BarChart3, href: "/usage" },
  // ── Agents ──
  { group: "Agents", section: "agents", label: "Agents", icon: Users, href: "/agents" },
  { section: "agents", label: "Subagents", icon: Users2, href: "/agents?tab=subagents", tab: "subagents", isSubItem: true },
  { section: "agents", label: "Models", icon: Cpu, href: "/agents?tab=models", tab: "models", isSubItem: true },
  { section: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
  { section: "sessions", label: "Sessions", icon: MessageSquare, href: "/sessions" },
  // ── Work ──
  { group: "Work", section: "tasks", label: "Tasks", icon: ListChecks, href: "/tasks" },
  ...(!isAgentbayHosting ? [{ section: "calendar", label: "Calendar", icon: Calendar, href: "/calendar", beta: true } as NavItem] : []),
  ...(!isAgentbayHosting ? [{ section: "integrations", label: "Integrations", icon: Puzzle, href: "/integrations", beta: true } as NavItem] : []),
  { section: "cron", label: "Cron Jobs", icon: TickingClockIcon, href: "/cron" },
  { section: "cron", label: "Heartbeat", icon: Heart, href: "/heartbeat", tab: "heartbeat", isSubItem: true },
  { section: "skills", label: "Skills", icon: Wrench, href: "/skills" },
  { section: "skills", label: "ClawHub", icon: Package, href: "/skills?tab=clawhub", tab: "clawhub", isSubItem: true },
  // ── Knowledge ──
  { group: "Knowledge", section: "memory", label: "Memory", icon: Brain, href: "/memory" },
  { section: "docs", label: "Documents", icon: FolderOpen, href: "/documents" },
  { section: "vectors", label: "Vector DB", icon: Database, href: "/vectors" },
  // ── Configure ──
  { section: "accounts", label: "API Keys", icon: KeyRound, href: "/accounts" },
  { section: "channels", label: "Channels", icon: Radio, href: "/channels" },
  { section: "security", label: "Security", icon: ShieldCheck, href: "/security" },
  { section: "hooks", label: "Hooks", icon: Webhook, href: "/hooks" },
  { section: "settings", label: "Preferences", icon: Settings2, href: "/settings" },
  // ── System ──
  ...(!isAgentbayHosting ? [{ section: "doctor", label: "Doctor", icon: Stethoscope, href: "/doctor", group: "System" } as NavItem] : []),
  { group: isAgentbayHosting ? "System" : undefined, section: "terminal", label: "Terminal", icon: SquareTerminal, href: "/terminal" },
  { section: "logs", label: "Logs", icon: Terminal, href: "/logs" },
  { section: "browser", label: "Browser Relay", icon: Globe, href: "/browser" },
  { section: "audio", label: "Audio & Voice", icon: Volume2, href: "/audio" },
  { section: "search", label: "Web Search", icon: Search, href: "/search" },
  ...(!isAgentbayHosting ? [{ section: "tailscale", label: "Tailscale", icon: Waypoints, href: "/tailscale", beta: true } as NavItem] : []),
  { section: "config", label: "Config", icon: Settings, href: "/config" },
];

const hostedNavItems: NavItem[] = [
  // ── Core ──
  { group: "Core", section: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
  { section: "channels", label: "Channels", icon: Radio, href: "/channels" },
  { section: "tasks", label: "Tasks", icon: ListChecks, href: "/tasks" },
  { section: "skills", label: "Skills", icon: Wrench, href: "/skills" },
  { section: "accounts", label: "API Keys", icon: KeyRound, href: "/accounts" },
  { section: "help", label: "Help & Support", icon: HelpCircle, href: "/help" },
  // ── Overview ──
  { group: "Overview", section: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { section: "activity", label: "Activity", icon: Activity, href: "/activity" },
  { section: "usage", label: "Usage", icon: BarChart3, href: "/usage" },
  // ── Agents ──
  { group: "Agents", section: "agents", label: "Agents", icon: Users, href: "/agents" },
  { section: "agents", label: "Models", icon: Cpu, href: "/agents?tab=models", tab: "models", isSubItem: true },
  { section: "sessions", label: "Sessions", icon: MessageSquare, href: "/sessions" },
  // ── Work ──
  { group: "Work", section: "cron", label: "Cron Jobs", icon: TickingClockIcon, href: "/cron" },
  // ── Knowledge ──
  { group: "Knowledge", section: "memory", label: "Memory", icon: Brain, href: "/memory" },
  { section: "docs", label: "Documents", icon: FolderOpen, href: "/documents" },
  // ── Configure ──
  { group: "Configure", section: "settings", label: "Preferences", icon: Settings2, href: "/settings" },
  // ── Advanced ──
  { group: "Advanced", section: "agents", label: "Subagents", icon: Users2, href: "/agents?tab=subagents", tab: "subagents" },
  { section: "skills", label: "ClawHub", icon: Package, href: "/skills?tab=clawhub", tab: "clawhub", group: "Advanced" },
  { section: "cron", label: "Heartbeat", icon: Heart, href: "/heartbeat", tab: "heartbeat", group: "Advanced" },
  { section: "vectors", label: "Vector DB", icon: Database, href: "/vectors", group: "Advanced" },
  { section: "security", label: "Security", icon: ShieldCheck, href: "/security", group: "Advanced" },
  { section: "hooks", label: "Hooks", icon: Webhook, href: "/hooks", group: "Advanced" },
  { section: "terminal", label: "Terminal", icon: SquareTerminal, href: "/terminal", group: "Advanced" },
  { section: "logs", label: "Logs", icon: Terminal, href: "/logs", group: "Advanced" },
  { section: "browser", label: "Browser Relay", icon: Globe, href: "/browser", group: "Advanced" },
  { section: "audio", label: "Audio & Voice", icon: Volume2, href: "/audio", group: "Advanced" },
  { section: "search", label: "Web Search", icon: Search, href: "/search", group: "Advanced" },
  { section: "config", label: "Config", icon: Settings, href: "/config", group: "Advanced" },
];

const navItems = isAgentbayHosting ? hostedNavItems : defaultNavItems;

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";
const SIDEBAR_WIDTH_KEY = "sidebar_width";
const SIDEBAR_DEFAULT_WIDTH = 288;
const SIDEBAR_MIN_WIDTH = 260;
const SIDEBAR_MAX_WIDTH = 420;

function clampSidebarWidth(width: number) {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function deriveSectionFromPath(pathname: string): string | null {
  if (!pathname || pathname === "/") return null;
  if (pathname.startsWith("/skills/")) return "skills";
  const first = pathname.split("/").filter(Boolean)[0] || "";
  const aliases: Record<string, string> = {
    system: "dashboard",
    documents: "docs",
    memories: "memory",
    permissions: "security",
    heartbeat: "cron",
    models: "agents",
  };
  if (aliases[first]) return aliases[first];
  const known = new Set([
    "dashboard",
    "chat",
    "agents",
    "tasks",
    "calendar",
    "integrations",
    "sessions",
    "cron",
    "heartbeat",
    "memory",
    "docs",
    "vectors",
    "skills",
    "accounts",
    "channels",
    "audio",
    "browser",
    "search",
    "tailscale",
    "security",
    "permissions",
    "hooks",
    "doctor",
    "usage",
    "terminal",
    "logs",
    "config",
    "settings",
    "activity",
    "help",
  ]);
  return known.has(first) ? first : null;
}

function deriveTabFromPath(pathname: string): string | null {
  if (!pathname || pathname === "/") return null;
  const first = pathname.split("/").filter(Boolean)[0] || "";
  if (first === "heartbeat") return "heartbeat";
  if (first === "models") return "models";
  return null;
}

function SidebarNav({ onNavigate, collapsed }: { onNavigate?: () => void; collapsed?: boolean }) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const sectionFromPath = deriveSectionFromPath(pathname);
  const sectionFromQuery = searchParams.get("section") || "dashboard";
  const tabFromQuery = (searchParams.get("tab") || "").toLowerCase();
  const tabFromPath = deriveTabFromPath(pathname);
  const isSkillDetailRoute = pathname.startsWith("/skills/");
  const section = isSkillDetailRoute
    ? "skills"
    : sectionFromPath || sectionFromQuery;
  const tab = isSkillDetailRoute ? "skills" : (tabFromPath ?? tabFromQuery);
  const [skillsExpanded, setSkillsExpanded] = useState(false);
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const [cronExpanded, setCronExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);
  const isClawHubActive = section === "skills" && tab === "clawhub";
  const showSkillsChildren = isClawHubActive ? true : skillsExpanded;
  const isSubagentsActive = section === "agents" && tab === "subagents";
  const isModelsActive = section === "agents" && tab === "models";
  const showAgentsChildren = isSubagentsActive || isModelsActive ? true : agentsExpanded;
  const isHeartbeatActive = section === "cron" && tab === "heartbeat";
  const showCronChildren = isHeartbeatActive ? true : cronExpanded;

  // Subscribe to chat unread count reactively
  const chatUnread = useSyncExternalStore(
    subscribeChatStore,
    getChatUnreadCount,
    () => 0 // SSR fallback
  );

  return (
    <nav className={cn("flex flex-1 flex-col gap-0.5 overflow-y-auto pt-2", collapsed ? "px-2" : "px-3")}>
      {navItems.map((item, index) => {
        const isSkillsParent = item.section === "skills" && item.label === "Skills";
        const isAgentsParent = item.section === "agents" && item.label === "Agents";
        const isCronParent = item.section === "cron" && item.label === "Cron Jobs";
        const isAdvancedItem = isAgentbayHosting && item.group === "Advanced";
        const previousGroup = index > 0 ? navItems[index - 1]?.group : undefined;
        const showGroupHeader = item.group && item.group !== previousGroup;
        const Icon = item.icon;
        const isActive =
          !item.comingSoon &&
          section === item.section &&
          (item.tab
            ? tab === item.tab
            : (item.section !== "skills" || tab !== "clawhub") &&
              (item.section !== "agents" || (tab !== "subagents" && tab !== "models")));
        const tourId =
          !item.isSubItem && item.section === "dashboard"
            ? "nav-dashboard"
            : !item.isSubItem && item.section === "chat"
              ? "nav-chat"
              : !item.isSubItem && item.section === "tasks"
                ? "nav-tasks"
                : !item.isSubItem && item.section === "skills" && item.label === "Skills"
                  ? "nav-skills"
                  : !item.isSubItem && item.section === "accounts"
                    ? "nav-accounts"
                    : !item.isSubItem && item.section === "channels"
                      ? "nav-channels"
                      : undefined;

        if (collapsed && item.isSubItem) return null;
        if (item.isSubItem && item.section === "skills" && !showSkillsChildren) return null;
        if (item.isSubItem && item.section === "agents" && !showAgentsChildren) return null;
        if (item.isSubItem && item.section === "cron" && !showCronChildren) return null;
        const shouldHideAdvancedItem = isAdvancedItem && !advancedExpanded && !isActive;
        if (shouldHideAdvancedItem && !showGroupHeader) return null;

        const showBadge = item.section === "chat" && chatUnread > 0;
        const isDisabled = item.comingSoon;
        const linkClass = cn(
          // Navigation is an interactive control, so it uses the shared 6px
          // radius and resolves to full ink when active.
          "group relative flex items-center gap-2.5 rounded-control py-2 text-sm font-medium transition-colors duration-150",
          collapsed ? "justify-center px-2" : "px-2.5",
          item.isSubItem && !collapsed && "ml-6 py-1.5",
          isDisabled
            ? "cursor-not-allowed text-fg-subtle opacity-60"
            : isActive
              ? "bg-sidebar-accent text-sidebar-foreground"
              : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        );
        return (
          <div key={`${item.section}:${item.label}`}>
            {showGroupHeader && !collapsed && (
              isAgentbayHosting && item.group === "Advanced" ? (
                <button
                  type="button"
                  onClick={() => setAdvancedExpanded((prev) => !prev)}
                  className={cn(
                    "mb-1.5 flex w-full items-center justify-between rounded-lg px-2.5 py-1 text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle transition-colors hover:bg-sidebar-accent hover:text-fg-secondary",
                    index === 0 ? "mt-0" : "mt-6",
                  )}
                  aria-expanded={advancedExpanded}
                >
                  <span>Advanced</span>
                  <ChevronRight className={cn("h-3 w-3 transition-transform", advancedExpanded && "rotate-90")} />
                </button>
              ) : (
                <div
                  className={cn(
                    "mb-1.5 px-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle",
                    index === 0 ? "mt-0" : "mt-6",
                  )}
                >
                  {item.group}
                </div>
              )
            )}
            {showGroupHeader && collapsed && (
              <div className="my-2 mx-1 border-t border-sidebar-border" />
            )}
            {shouldHideAdvancedItem ? null : isDisabled ? (
              <span className={linkClass} aria-disabled>
                <Icon className="h-3 w-3 shrink-0 opacity-60" />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 whitespace-nowrap rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium uppercase tracking-[0.06em] text-fg-subtle">
                      Soon
                    </span>
                  </>
                )}
              </span>
            ) : (
              (isSkillsParent || isAgentsParent || isCronParent) && !collapsed ? (
                <div className={linkClass} data-tour={tourId}>
                  <Link
                    href={item.href || `/${item.section}`}
                    onClick={onNavigate}
                    className="flex min-w-0 flex-1 items-center gap-2.5"
                  >
                    <Icon className="h-3 w-3 shrink-0" />
                    <span className="flex-1">{item.label}</span>
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (isSkillsParent) {
                        setSkillsExpanded((prev) => !prev);
                      } else if (isAgentsParent) {
                        setAgentsExpanded((prev) => !prev);
                      } else {
                        setCronExpanded((prev) => !prev);
                      }
                    }}
                    className="rounded-md p-1.5 text-fg-secondary transition-colors hover:text-foreground"
                    aria-label={
                      isSkillsParent
                        ? (showSkillsChildren ? "Collapse skills submenu" : "Expand skills submenu")
                        : isAgentsParent
                          ? (showAgentsChildren ? "Collapse agents submenu" : "Expand agents submenu")
                          : (showCronChildren ? "Collapse cron submenu" : "Expand cron submenu")
                    }
                  >
                    <ChevronRight
                      className={cn(
                        "h-3 w-3 shrink-0 transition-transform duration-200",
                        (isSkillsParent ? showSkillsChildren : isAgentsParent ? showAgentsChildren : showCronChildren) && "rotate-90"
                      )}
                    />
                  </button>
                </div>
              ) : (
                <Link
                  href={item.href || `/${item.section}`}
                  onClick={onNavigate}
                  className={linkClass}
                  data-tour={tourId}
                  title={collapsed ? item.label : undefined}
                >
                  <span className="relative inline-flex shrink-0">
                    <Icon className="h-3 w-3" />
                    {collapsed && showBadge && (
                    <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-sidebar" title={`${chatUnread} unread`} aria-hidden />
                  )}
                </span>
                {!collapsed && <span className="flex-1">{item.label}</span>}
                {!collapsed && item.beta && (
                    <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-xs font-medium uppercase tracking-[0.06em] text-fg-subtle">
                      beta
                    </span>
                  )}
                {!collapsed && showBadge && (
                    <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-primary-foreground shadow-sm">
                      {chatUnread > 9 ? "9+" : chatUnread}
                    </span>
                  )}
                </Link>
              )
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  });
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === "undefined") return SIDEBAR_DEFAULT_WIDTH;
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    return Number.isFinite(raw) && raw > 0 ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT_WIDTH;
  });
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const closeMobile = useCallback(() => setMobileOpen(false), []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  const commitHash = process.env.NEXT_PUBLIC_COMMIT_HASH || "";

  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mobileOpen]);

  useEffect(() => {
    if (collapsed) return;
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
    } catch {
      /* ignore */
    }
  }, [sidebarWidth, collapsed]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const active = resizeStateRef.current;
      if (!active) return;
      const nextWidth = clampSidebarWidth(active.startWidth + (event.clientX - active.startX));
      setSidebarWidth(nextWidth);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };

    const handlePointerUp = () => {
      if (!resizeStateRef.current) return;
      resizeStateRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, []);

  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    resizeStateRef.current = { startX: event.clientX, startWidth: sidebarWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }, [collapsed, sidebarWidth]);

  const expandedWidthStyle = collapsed
    ? undefined
    : {
        width: `${sidebarWidth}px`,
        minWidth: `${sidebarWidth}px`,
      };

  return (
    <>
      {/* Mobile hamburger — visible only on small screens */}
      <button
        type="button"
        onClick={() => setMobileOpen(true)}
        className="fixed left-3 top-3 z-50 flex h-9 w-9 items-center justify-center rounded-lg glass-strong text-foreground md:hidden"
        aria-label="Open menu"
      >
        <Menu className="h-5 w-5" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 md:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar — always visible on desktop, slide-in drawer on mobile */}
      <aside
        data-tour="sidebar"
        style={expandedWidthStyle}
        className={cn(
          "relative flex h-full shrink-0 flex-col transition-[width,transform] duration-200 ease-in-out",
          "border-r border-sidebar-border bg-sidebar",
          collapsed ? "w-14 md:w-14" : "w-72 md:w-72",
          "max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-50 max-md:shadow-2xl",
          mobileOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        )}
      >
        {/* Mobile close button */}
        <div className={cn("flex items-center pt-3 md:hidden", collapsed ? "justify-center px-2" : "justify-end px-3")}>
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="rounded-lg p-1.5 text-muted-foreground hover:text-foreground"
            aria-label="Close menu"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className={cn("shrink-0", collapsed ? "px-2 pb-2" : "px-3 pb-3 pt-3")}>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-base">
                🦞
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-card text-base">
                  🦞
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold tracking-[-0.01em] text-foreground">
                      Mission Control
                    </span>
                    {commitHash && (
                      <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 font-mono text-xs font-medium text-fg-subtle">
                        {commitHash}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <Suspense fallback={<div className="flex-1" />}>
          <SidebarNav onNavigate={closeMobile} collapsed={collapsed} />
        </Suspense>
        {/* Collapse / expand toggle — desktop only */}
        <div className={cn("hidden border-t border-sidebar-border md:block", collapsed ? "px-2 py-2" : "px-3 py-2")}>
          <button
            type="button"
            onClick={toggleCollapsed}
            className={cn(
              "flex w-full items-center rounded-md py-1.5 text-fg-subtle transition-colors duration-150 hover:bg-muted hover:text-fg-secondary",
              collapsed ? "justify-center px-0" : "justify-start px-2.5"
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <ChevronRight className="h-4 w-4 shrink-0" />
            ) : (
              <ChevronLeft className="h-4 w-4 shrink-0" />
            )}
          </button>
        </div>
        {!collapsed && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            onPointerDown={startResize}
            className="absolute inset-y-0 right-0 hidden w-2 -translate-x-1/2 cursor-col-resize md:block"
          >
            <div className="mx-auto h-full w-px bg-transparent transition-colors hover:bg-border-strong dark:hover:bg-border-strong" />
          </div>
        )}
      </aside>
    </>
  );
}

export { Sidebar as AppSidebar };
