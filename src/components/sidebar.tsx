"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, useCallback, useSyncExternalStore, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  Activity,
  Archive,
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
  Cpu,
  Users,
  Users2,
  BarChart3,
  Menu,
  X,
  Package,
  ChevronRight,
  ChevronLeft,
  Search,
  Heart,
  HelpCircle,
  Plug,
  Puzzle,
  Radio,
  CircleHelp,
  Handshake,
  ShieldCheck,
} from "lucide-react";
import { getChatUnreadCount, subscribeChatStore } from "@/lib/chat-store";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import { INTERACTIONS_CHANGED_EVENT } from "@/lib/interaction-events";

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
  /** Hidden entirely on the hosted (Agentbay) deployment. */
  selfHostedOnly?: true;
  /** Shown only when a G-Brain install is detected at runtime (see SidebarNav). */
  requiresGBrain?: true;
  /** Sits below the hairline separator pinned to the bottom of the rail. */
  pinnedBottom?: true;
};

const isAgentbayHosting = process.env.NEXT_PUBLIC_AGENTBAY_HOSTED === "true";

/**
 * ONE nav tree. Hosted degrades by omission (via `selfHostedOnly`), never by
 * maintaining a second hand-written tree — that's how Calendar silently
 * vanished from the old `hostedNavItems` and API Keys got promoted there
 * against its own page's advice. See e2e/sidebar-nav verification for the
 * filtered hosted set.
 */
/** Y Combinator "Y" glyph, drawn in the same stroked, monochrome style as the
 *  lucide icons around it (G-Brain is a Y Combinator project). */
function YCombinatorIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8.5 8l3.5 4.5L15.5 8" />
      <path d="M12 12.5V16" />
    </svg>
  );
}

const ALL_NAV_ITEMS: NavItem[] = [
  // ── top of the rail — no group label, this IS the product ──
  { section: "chat", label: "Chat", icon: MessageCircle, href: "/chat" },
  { section: "tasks", label: "Tasks", icon: ListChecks, href: "/tasks" },
  { section: "dashboard", label: "Dashboard", icon: LayoutDashboard, href: "/dashboard" },
  { section: "activity", label: "Activity", icon: Activity, href: "/activity" },
  { section: "questions", label: "Questions", icon: CircleHelp, href: "/questions" },
  { section: "commitments", label: "Commitments", icon: Handshake, href: "/commitments" },
  { section: "approvals", label: "Approvals", icon: ShieldCheck, href: "/approvals" },
  { section: "usage", label: "Usage", icon: BarChart3, href: "/usage" },
  { section: "sessions", label: "Sessions", icon: MessageSquare, href: "/sessions" },
  // Self-hosted only for now — hosted lacks a Google-connect flow. Product
  // gap, not an oversight; the flag stays until that flow exists.
  { section: "calendar", label: "Calendar", icon: Calendar, href: "/calendar", beta: true, selfHostedOnly: true },

  // ── Agents ──
  { group: "Agents", section: "agents", label: "Agents", icon: Users, href: "/agents" },
  { section: "agents", label: "Subagents", icon: Users2, href: "/agents?tab=subagents", tab: "subagents", isSubItem: true },
  { section: "agents", label: "Models", icon: Cpu, href: "/agents?tab=models", tab: "models", isSubItem: true },
  { section: "skills", label: "Skills", icon: Wrench, href: "/skills" },
  { section: "skills", label: "Marketplace", icon: Package, href: "/skills?tab=clawhub", tab: "clawhub", isSubItem: true },
  { section: "cron", label: "Cron Jobs", icon: TickingClockIcon, href: "/cron" },
  { section: "cron", label: "Heartbeat", icon: Heart, href: "/heartbeat", tab: "heartbeat", isSubItem: true },

  // ── Knowledge ──
  { group: "Knowledge", section: "memory", label: "Memory", icon: Brain, href: "/memory" },
  { section: "docs", label: "Documents", icon: FolderOpen, href: "/documents" },
  { section: "g-brain", label: "G-Brain", icon: YCombinatorIcon, href: "/g-brain", requiresGBrain: true },
  { section: "search", label: "Web Search", icon: Search, href: "/search" },

  // ── Connections ──
  { group: "Connections", section: "channels", label: "Channels", icon: Radio, href: "/channels" },
  { section: "mcp", label: "MCP", icon: Plug, href: "/mcp" },
  { section: "integrations", label: "Integrations", icon: Puzzle, href: "/integrations", beta: true },

  // ── pinned bottom, below a hairline separator ──
  { section: "logs", label: "Logs", icon: Terminal, href: "/logs", pinnedBottom: true, selfHostedOnly: true },
  { section: "backup", label: "Backup", icon: Archive, href: "/backup", pinnedBottom: true, selfHostedOnly: true },
  { section: "settings", label: "Settings", icon: Settings, href: "/settings", pinnedBottom: true },
  { section: "help", label: "Help & Support", icon: HelpCircle, href: "/help", pinnedBottom: true },
];

/** Pure filter — kept separate from the module-level `isAgentbayHosting`
 * read so it can be exercised both ways in tests without re-importing the
 * module under a different env. */
export function filterNavItemsForHosting(items: NavItem[], hosted: boolean): NavItem[] {
  return items.filter((item) => !item.selfHostedOnly || !hosted);
}

export { ALL_NAV_ITEMS };
export type { NavItem };

const navItems = filterNavItemsForHosting(ALL_NAV_ITEMS, isAgentbayHosting);

/** Sections that no longer have their own rail row — they live in the
 * Settings hub now, so visiting them should still light up "Settings". */
const SETTINGS_HUB_SECTIONS = new Set([
  "settings",
  "accounts",
  "security",
  "permissions",
  "hooks",
  "doctor",
  "terminal",
  "config",
  "browser",
  "audio",
  "tailscale",
]);

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
    "g-brain",
    "skills",
    "accounts",
    "channels",
    "mcp",
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
    "questions",
    "commitments",
    "approvals",
    "backup",
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
  const isClawHubActive = section === "skills" && tab === "clawhub";
  const showSkillsChildren = isClawHubActive ? true : skillsExpanded;
  const isSubagentsActive = section === "agents" && tab === "subagents";
  const isModelsActive = section === "agents" && tab === "models";
  const showAgentsChildren = isSubagentsActive || isModelsActive ? true : agentsExpanded;
  const isHeartbeatActive = section === "cron" && tab === "heartbeat";
  const showCronChildren = isHeartbeatActive ? true : cronExpanded;

  // G-Brain is a standalone install, not part of OpenClaw — its nav row only
  // appears when a brain is actually present on this machine. Detected at
  // runtime (there is no build-time flag for it); hidden until we know.
  const [gbrainInstalled, setGbrainInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/g-brain?scope=detect")
      .then((r) => r.json())
      .then((d) => { if (live) setGbrainInstalled(Boolean(d?.installed)); })
      .catch(() => { if (live) setGbrainInstalled(false); });
    return () => { live = false; };
  }, []);
  const items = gbrainInstalled ? navItems : navItems.filter((i) => !i.requiresGBrain);

  // Subscribe to chat unread count reactively
  const chatUnread = useSyncExternalStore(
    subscribeChatStore,
    getChatUnreadCount,
    () => 0 // SSR fallback
  );

  // Clarifications are separate from ordinary unread chat messages. Keep a
  // small attention dot visible until the user actually answers the question.
  const [chatNeedsInput, setChatNeedsInput] = useState(false);
  const refreshChatNeedsInput = useCallback(async () => {
    try {
      const response = await fetch("/api/interactions?status=open&limit=1", {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return;
      const payload = await response.json() as { count?: number; interactions?: unknown[] };
      setChatNeedsInput((payload.count ?? payload.interactions?.length ?? 0) > 0);
    } catch {
      // Preserve the last known state during a temporary connection failure.
    }
  }, []);

  useSmartPoll(refreshChatNeedsInput, { intervalMs: 5_000 });

  useEffect(() => {
    const refresh = () => void refreshChatNeedsInput();
    window.addEventListener(INTERACTIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(INTERACTIONS_CHANGED_EVENT, refresh);
  }, [refreshChatNeedsInput]);

  return (
    <nav className={cn("flex flex-1 flex-col gap-0.5 overflow-y-auto pt-2", collapsed ? "px-2" : "px-3")}>
      {items.map((item, index) => {
        const isSkillsParent = item.section === "skills" && !item.isSubItem;
        const isAgentsParent = item.section === "agents" && !item.isSubItem;
        const isCronParent = item.section === "cron" && !item.isSubItem;
        const previousItem = index > 0 ? items[index - 1] : undefined;
        const showGroupHeader = Boolean(item.group) && item.group !== previousItem?.group;
        const showPinnedSeparator = Boolean(item.pinnedBottom) && !previousItem?.pinnedBottom;
        const Icon = item.icon;
        let isActive =
          !item.comingSoon &&
          section === item.section &&
          (item.tab
            ? tab === item.tab
            : (item.section !== "skills" || tab !== "clawhub") &&
              (item.section !== "agents" || (tab !== "subagents" && tab !== "models")));
        // Rows that moved into the Settings hub no longer have their own
        // row — a visit to any of them should still light up "Settings".
        if (item.section === "settings" && !item.isSubItem) {
          isActive = !item.comingSoon && SETTINGS_HUB_SECTIONS.has(section);
        }
        const tourId =
          !item.isSubItem && item.section === "dashboard"
            ? "nav-dashboard"
            : !item.isSubItem && item.section === "chat"
              ? "nav-chat"
              : !item.isSubItem && item.section === "tasks"
                ? "nav-tasks"
                : !item.isSubItem && item.section === "skills" && item.label === "Skills"
                  ? "nav-skills"
                  : !item.isSubItem && item.section === "settings"
                    ? "nav-settings"
                    : !item.isSubItem && item.section === "channels"
                      ? "nav-channels"
                      : undefined;

        if (collapsed && item.isSubItem) return null;
        if (item.isSubItem && item.section === "skills" && !showSkillsChildren) return null;
        if (item.isSubItem && item.section === "agents" && !showAgentsChildren) return null;
        if (item.isSubItem && item.section === "cron" && !showCronChildren) return null;

        const isChatItem = item.section === "chat" && !item.isSubItem;
        const showBadge = isChatItem && chatUnread > 0;
        const showInputDot = isChatItem && chatNeedsInput;
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
              <div
                className={cn(
                  "mb-1.5 px-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-fg-subtle",
                  index === 0 ? "mt-0" : "mt-6",
                )}
              >
                {item.group}
              </div>
            )}
            {showPinnedSeparator && !collapsed && (
              <div
                className={cn(
                  "mx-2.5 border-t border-sidebar-border",
                  index === 0 ? "mt-0 mb-2" : "mt-6 mb-2",
                )}
              />
            )}
            {(showGroupHeader || showPinnedSeparator) && collapsed && (
              <div className="my-2 mx-1 border-t border-sidebar-border" />
            )}
            {isDisabled ? (
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
                    {collapsed && (showInputDot || showBadge) && (
                    <span
                      className={cn(
                        "absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full ring-2 ring-sidebar",
                        showInputDot ? "bg-amber-500" : "bg-primary",
                      )}
                      title={showInputDot ? "Chat needs your input" : `${chatUnread} unread`}
                      aria-hidden
                    />
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
                {!collapsed && showInputDot && (
                    <span
                      className="h-2 w-2 shrink-0 rounded-full bg-amber-500 ring-2 ring-amber-500/15"
                      title="Chat needs your input"
                      aria-label="Chat needs your input"
                    />
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
