"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSmartPoll } from "@/hooks/use-smart-poll";
import {
  Bug,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  CircleX,
  Copy,
  ExternalLink,
  Globe,
  Info,
  Play,
  RefreshCw,
  RotateCw,
  Square,
  Sparkles,
} from "lucide-react";
import { SectionBody, SectionHeader, SectionLayout } from "@/components/section-layout";

type RelaySnapshot = {
  status: {
    enabled?: boolean;
    profile?: string;
    running?: boolean;
    cdpReady?: boolean;
    cdpHttp?: boolean;
    cdpPort?: number;
    cdpUrl?: string;
    detectedBrowser?: string | null;
    detectedExecutablePath?: string | null;
    chosenBrowser?: string | null;
    userDataDir?: string | null;
    detectError?: string | null;
    attachOnly?: boolean;
    headless?: boolean;
    color?: string;
  } | null;
  profiles?: Array<{
    name: string;
    cdpPort?: number;
    cdpUrl?: string;
    color?: string;
    running?: boolean;
    tabCount?: number;
    isDefault?: boolean;
    isRemote?: boolean;
  }>;
  tabs?: Array<Record<string, unknown>>;
  extension: {
    path: string | null;
    resolvedPath: string | null;
    manifestPath: string | null;
    installed: boolean;
    manifestName: string | null;
    manifestVersion: string | null;
    error: string | null;
  };
  health: {
    installed: boolean;
    running: boolean;
    cdpReady: boolean;
    tabConnected: boolean;
    relayReady: boolean;
  };
  errors: {
    status: string | null;
    profiles: string | null;
    tabs: string | null;
  };
};

type RelayGetResponse = {
  ok: boolean;
  profile?: string | null;
  snapshot?: RelaySnapshot;
  docsUrl?: string;
  error?: string;
};

type RelayPostResponse = {
  ok: boolean;
  action?: string;
  result?: Record<string, unknown>;
  snapshot?: RelaySnapshot;
  error?: string;
};

type RelayAction = "pair-extension" | "start" | "stop" | "restart" | "open-test-tab" | "snapshot-test" | "screenshot";

type PrimaryAction = {
  action: RelayAction;
  label: string;
  hint: string;
  payload?: Record<string, unknown>;
};

type BrowserMode = "extension" | "managed" | "remote";

type BrowserModeHealth = {
  ready: boolean;
  needsExtension: boolean;
  installed: boolean;
  running: boolean;
  cdpReady: boolean;
  tabConnected: boolean;
};

function formatObject(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function statusPill(label: string, ok: boolean) {
  return (
    <span
      className={
        ok
          ? "inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-300"
          : "inline-flex items-center gap-1 rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-1 text-xs text-zinc-300"
      }
    >
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <CircleX className="h-3.5 w-3.5" />}
      {label}
    </span>
  );
}

function actionSuccessMessage(action: RelayAction, mode: BrowserMode, hosted = false): string {
  switch (action) {
    case "pair-extension":
      return mode === "extension"
        ? "Pairing string ready. Load the unpacked extension from the path below, then click the OpenClaw toolbar icon and paste the string into the popup."
        : "Pairing string ready. It is only needed when using extension relay mode.";
    case "start":
      if (mode === "extension") {
        return "Relay started. Open a tab and click the OpenClaw extension icon to connect it.";
      }
      if (mode === "remote") {
        return "Remote browser connection started. If remote Chrome is reachable, control is ready.";
      }
      if (hosted) {
        return "Browser started in the background. Use Open Setup Tab to load a page.";
      }
      return "Browser profile started. Open any page to begin controlling it.";
    case "stop":
      return "Relay stopped.";
    case "restart":
      if (mode === "extension") {
        return "Relay reconnected. If tabs still do not appear, click the extension icon in Chrome.";
      }
      if (mode === "remote") {
        return "Remote connection refreshed. Verify the remote CDP endpoint is reachable from OpenClaw.";
      }
      return "Browser profile reconnected.";
    case "open-test-tab":
      return mode === "extension"
        ? "Opened a test tab. Click the OpenClaw extension icon in that tab."
        : "Opened a test tab in the selected browser profile.";
    case "snapshot-test":
      return "Connection test completed. If no errors appeared, browser control is ready.";
    default:
      return "Action completed.";
  }
}

function humanizeRelayError(
  rawError: string,
  snapshot: RelaySnapshot | null,
  mode: BrowserMode
): string {
  const err = rawError.toLowerCase();
  // `browser` is a bundled *plugin* command. Under a restrictive
  // `plugins.allow` with no root `browser` config block it is never registered,
  // so the CLI reports it as an unknown command rather than a browser failure.
  if (err.includes("does not know the command")) {
    return 'The OpenClaw browser plugin is not enabled, so the "browser" command is unavailable. Add "browser" to plugins.allow in openclaw.json, or set browser.enabled, then retry.';
  }
  if (err.includes("missing scope") || err.includes("operator.read")) {
    return "Browser relay is authenticated, but the paired device is missing operator.read. Update/re-pair the openclaw-control-ui device scopes, then retry.";
  }
  if (err.includes("403") && (err.includes("forbidden") || err.includes("scope"))) {
    return "Browser relay request was rejected (403). Check paired device scopes, especially operator.read, then retry.";
  }
  if (err.includes("econnrefused") || err.includes("connect") || err.includes("cdp")) {
    if (mode === "remote") {
      return "Could not reach remote CDP endpoint. Check node host/VPC networking, then retry reconnect.";
    }
    return "Could not reach Chrome debugging endpoint. Start or reconnect relay, then try again.";
  }
  if (err.includes("extension") || err.includes("manifest")) {
    if (mode !== "extension") {
      return "Browser setup check failed. Open advanced diagnostics for details and retry.";
    }
    return "Browser extension is missing or not loaded yet. Load it unpacked in Chrome and pair it.";
  }
  if (err.includes("tab") || err.includes("target")) {
    return mode === "extension"
      ? "No connected tab found. Open any tab and click the OpenClaw extension icon once."
      : "No controllable tab found. Open a tab in the selected profile, then test again.";
  }
  if (mode === "extension" && !snapshot?.extension.installed) {
    return "Extension files were not found. Get the pairing string, then load the unpacked extension in Chrome.";
  }
  return rawError;
}

function toText(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value == null) return fallback;
  return String(value);
}

function tabTitle(tab: Record<string, unknown>): string {
  return toText(tab.title, toText(tab.url, toText(tab.targetId, "Browser tab")));
}

function tabUrl(tab: Record<string, unknown>): string {
  return toText(tab.url, "");
}

function tabId(tab: Record<string, unknown>, idx: number): string {
  return toText(tab.targetId, toText(tab.id, `tab-${idx}`));
}

function prettyHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isValidBrowserUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    const allowed = ["http:", "https:"];
    return allowed.includes(parsed.protocol);
  } catch {
    return false;
  }
}

function isLoopbackHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

function inferBrowserMode(snapshot: RelaySnapshot | null, selectedProfile: string): BrowserMode {
  if (!snapshot) return "managed";
  const effectiveProfile = selectedProfile || snapshot.status?.profile || "";
  const profileMeta = (snapshot.profiles || []).find((p) => p.name === effectiveProfile);
  const cdpUrl = profileMeta?.cdpUrl || snapshot.status?.cdpUrl || "";
  const remoteByUrl = Boolean(cdpUrl) && !isLoopbackHost(cdpUrl);
  if (profileMeta?.isRemote || remoteByUrl) return "remote";
  if (!snapshot.status) {
    return profileMeta?.name.toLowerCase() === "chrome" ? "extension" : "managed";
  }
  if (snapshot.status?.userDataDir || snapshot.status?.chosenBrowser) return "managed";
  if (snapshot.status?.attachOnly) return "extension";
  if (!snapshot.status?.userDataDir && !snapshot.status?.chosenBrowser) return "extension";
  return "managed";
}

function computeModeHealth(snapshot: RelaySnapshot | null, mode: BrowserMode): BrowserModeHealth {
  const installed = Boolean(snapshot?.health.installed);
  const running = Boolean(snapshot?.health.running);
  const cdpReady = Boolean(snapshot?.health.cdpReady);
  const tabConnected = Boolean(snapshot?.health.tabConnected);
  const needsExtension = mode === "extension";
  const ready = running && cdpReady && tabConnected && (!needsExtension || installed);
  return { ready, needsExtension, installed, running, cdpReady, tabConnected };
}

export function BrowserRelayView({ isHosted = false }: { isHosted?: boolean }) {
  const [loading, setLoading] = useState(true);
  const [snapshot, setSnapshot] = useState<RelaySnapshot | null>(null);
  const [profile, setProfile] = useState<string>("");
  const [docsUrl, setDocsUrl] = useState("https://docs.openclaw.ai/tools/browser");
  const [testUrl, setTestUrl] = useState("https://example.com");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionOutput, setActionOutput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const loadAbortRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (silent = false) => {
      // Abort any previous inflight load to prevent race conditions on rapid profile switches
      loadAbortRef.current?.abort();
      const controller = new AbortController();
      loadAbortRef.current = controller;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const qs = profile ? `?profile=${encodeURIComponent(profile)}` : "";
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(`/api/browser/relay${qs}`, { cache: "no-store", signal: controller.signal });
        clearTimeout(timeoutId);
        const data = (await res.json()) as RelayGetResponse;
        if (!res.ok || !data.ok || !data.snapshot) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        setSnapshot(data.snapshot);
        if (data.docsUrl) setDocsUrl(data.docsUrl);

        const statusProfile = (data.snapshot.status?.profile || "").trim();
        if (!profile && statusProfile) {
          setProfile(statusProfile);
          return;
        }
        if (!profile && !statusProfile && (data.snapshot.profiles || []).length > 0) {
          const first = data.snapshot.profiles?.[0]?.name || "";
          if (first) setProfile(first);
        }
      } catch (err) {
        // Ignore aborted requests (from rapid profile switches or component unmount)
        if (err instanceof DOMException && err.name === "AbortError") return;
        const raw = err instanceof Error ? err.message : String(err);
        if (silent) {
          return;
        }
        setError(raw);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [profile]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useSmartPoll(() => load(true), { intervalMs: 15000 });

  const runAction = useCallback(
    async (action: RelayAction, payload?: Record<string, unknown>) => {
      setActionBusy(action);
      setError(null);
      setNotice(null);
      try {
        const res = await fetch("/api/browser/relay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            profile: profile || null,
            ...(payload || {}),
          }),
          signal: AbortSignal.timeout(30000),
        });
        const data = (await res.json()) as RelayPostResponse;
        if (!res.ok || !data.ok) {
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        if (data.snapshot) setSnapshot(data.snapshot);
        const noticeMode = inferBrowserMode(
          data.snapshot || snapshot,
          profile || data.snapshot?.status?.profile || snapshot?.status?.profile || ""
        );
        setActionOutput(formatObject(data.result || ""));
        setNotice(actionSuccessMessage(action, noticeMode, isHosted));
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        if (raw.includes("TimeoutError") || raw.includes("timed out") || raw.includes("aborted")) {
          setError("Action timed out after 30 seconds. The server may still be processing — try refreshing.");
        } else {
          setError(raw);
        }
      } finally {
        setActionBusy(null);
      }
    },
    [isHosted, profile, snapshot]
  );

  const copyPath = useCallback(async () => {
    const path = snapshot?.extension?.resolvedPath || snapshot?.extension?.path || "";
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      setNotice("Extension path copied to clipboard.");
    } catch {
      setError("Failed to copy extension path.");
    }
  }, [snapshot]);

  const copyTabUrl = useCallback(async (url: string) => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Page URL copied.");
    } catch {
      setError("Failed to copy URL.");
    }
  }, []);

  const captureScreenshot = useCallback(async () => {
    setScreenshotLoading(true);
    try {
      const res = await fetch("/api/browser/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "screenshot", profile: profile || null }),
        signal: AbortSignal.timeout(20000),
      });
      const data = (await res.json()) as RelayPostResponse;
      if (!res.ok || !data.ok) throw new Error(data.error || "Screenshot failed");
      const image = (data.result as { image?: string })?.image;
      if (image) setScreenshotSrc(image);
      else setError("No screenshot data returned.");
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(`Screenshot failed: ${raw}`);
    } finally {
      setScreenshotLoading(false);
    }
  }, [profile]);

  const isHeadless = Boolean(snapshot?.status?.headless) || isHosted;

  const activeTabs = snapshot?.tabs || [];
  const selectedProfile = profile || snapshot?.status?.profile || "";
  const inferredMode = useMemo<BrowserMode>(
    () => inferBrowserMode(snapshot, selectedProfile),
    [selectedProfile, snapshot]
  );
  // On hosted/VPC, extension mode is not useful — override to managed
  const mode = isHosted && inferredMode === "extension" ? "managed" : inferredMode;
  const isExtensionUnavailable = isHosted && inferredMode === "extension";
  const modeHealth = useMemo(() => computeModeHealth(snapshot, mode), [snapshot, mode]);
  const modeLabel =
    mode === "extension"
      ? "Extension relay"
      : mode === "remote"
        ? "Remote browser"
        : isHeadless
          ? "Background browser"
          : "Managed browser";
  const setupDocsUrl = useMemo(() => {
    if (mode === "extension") {
      return (
        docsUrl || "https://docs.openclaw.ai/tools/browser#chrome-extension-relay-use-your-existing-chrome"
      );
    }
    if (mode === "remote") {
      return "https://docs.openclaw.ai/concepts/browser-profiles";
    }
    return "https://docs.openclaw.ai/tools/browser";
  }, [docsUrl, mode]);
  const friendlyError = useMemo(
    () => (error ? humanizeRelayError(error, snapshot, mode) : null),
    [error, mode, snapshot]
  );

  const setupSteps = useMemo(() => {
    if (mode === "extension") {
      return [
        {
          key: "extension",
          title: "Load and pair the OpenClaw extension",
          hint: "Load the printed directory as an unpacked extension in Chrome, then paste the pairing string into its popup.",
          done: modeHealth.installed,
        },
        {
          key: "connect",
          title: "Connect an active tab",
          hint: "Open any page and click the OpenClaw extension icon once.",
          done: modeHealth.running && modeHealth.tabConnected,
        },
        {
          key: "verify",
          title: "Verify browser control",
          hint: "Run connection test to confirm relay + CDP + tab connectivity.",
          done: modeHealth.ready,
        },
      ];
    }
    if (mode === "remote") {
      return [
        {
          key: "remote",
          title: "Connect remote CDP endpoint",
          hint: "Ensure the remote browser endpoint is reachable from OpenClaw (node host/VPC).",
          done: modeHealth.running && modeHealth.cdpReady,
        },
        {
          key: "tab",
          title: "Open a target tab",
          hint: "Open a page in the remote browser profile or use Open Setup Tab.",
          done: modeHealth.tabConnected,
        },
        {
          key: "verify",
          title: "Verify browser control",
          hint: "Run connection test to confirm remote CDP + tab access.",
          done: modeHealth.ready,
        },
      ];
    }
    return [
      {
        key: "start",
        title: "Start managed browser profile",
        hint: "Start the selected OpenClaw browser profile.",
        done: modeHealth.running,
      },
      {
        key: "tab",
        title: "Open a target tab",
        hint: "Open a page in the managed profile or use Open Setup Tab.",
        done: modeHealth.tabConnected,
      },
      {
        key: "verify",
        title: "Verify browser control",
        hint: "Run connection test to confirm profile + CDP + tab connectivity.",
        done: modeHealth.ready,
      },
    ];
  }, [mode, modeHealth]);

  const primaryAction = useMemo<PrimaryAction | null>(() => {
    if (!snapshot) return null;
    if (!isHosted && mode === "extension" && !modeHealth.installed) {
      return {
        action: "pair-extension",
        label: "Pair Extension",
        hint: "First run setup: get the pairing string for the Chrome extension.",
      };
    }
    if (!modeHealth.running) {
      return {
        action: "start",
        label: mode === "remote" ? "Connect Remote Browser" : "Start Browser Profile",
        hint:
          mode === "remote"
            ? "Connect to remote CDP endpoint configured for this profile."
            : "Start selected profile so OpenClaw can control tabs.",
      };
    }
    if (!modeHealth.cdpReady) {
      return {
        action: "restart",
        label: mode === "remote" ? "Reconnect Remote CDP" : "Reconnect Relay",
        hint:
          mode === "remote"
            ? "Refresh remote CDP connectivity when endpoint is stale or unreachable."
            : "Reconnect CDP if browser debug channel is stale.",
      };
    }
    if (!modeHealth.tabConnected) {
      const isHeadless = Boolean(snapshot?.status?.headless) || isHosted;
      return {
        action: "open-test-tab",
        label: "Open Setup Tab",
        hint:
          mode === "extension"
            ? "Opens a tab where you can click the extension icon to connect."
            : isHeadless
              ? "Opens a tab in the background browser. Since the browser runs headless, use the screenshot preview below to see it."
              : "Opens a test tab in this profile so browser control has a live target.",
        payload: { url: testUrl },
      };
    }
    return {
      action: "snapshot-test",
      label: "Test Browser Connection",
      hint: "Runs a quick browser snapshot test to verify everything is ready.",
    };
  }, [isHosted, mode, modeHealth, snapshot, testUrl]);

  const guidance = useMemo(() => {
    const notes: string[] = [];
    if (!snapshot) return notes;
    if (isHeadless && !isHosted) {
      notes.push("Browser is running in headless mode. Use the screenshot preview to see what the browser is showing.");
    }
    if (isHosted) {
      notes.push("Running on a server \u2014 managed browser runs in the background. For cloud browsers, configure a remote browser profile.");
    }
    if (!isHosted && mode === "extension" && !modeHealth.installed) {
      notes.push("Open Chrome extensions, load the printed directory unpacked, then pair it.");
    }
    if (!isHosted && mode === "extension" && (snapshot.profiles || []).some((p) => p.isRemote)) {
      notes.push("For headless/VPC usage, switch Browser profile to a remote CDP profile (no extension click needed).");
    }
    if (!isHosted && mode === "extension" && (!modeHealth.running || !modeHealth.tabConnected)) {
      notes.push("Open any browser tab and click the OpenClaw extension icon once to attach.");
    }
    if (mode !== "extension" && !modeHealth.tabConnected) {
      notes.push("No extension click required. Open a tab in this profile or use Open Setup Tab.");
    }
    if (!modeHealth.cdpReady) {
      notes.push(
        mode === "remote"
          ? "CDP is not ready. Verify remote endpoint reachability (host, port, token/proxy), then reconnect."
          : "CDP is not ready. Try Reconnect Relay and ensure selected browser profile is running."
      );
    }
    if (snapshot.errors.status) {
      const statusErr = snapshot.errors.status.toLowerCase();
      if (statusErr.includes("missing scope") || statusErr.includes("operator.read")) {
        notes.push(
          "Relay status is blocked by missing scope. Add operator.read to the paired openclaw-control-ui device and reconnect."
        );
      } else {
        notes.push("Relay status check failed. Use Refresh and verify browser process is alive.");
      }
    }
    if (!isHosted && mode === "extension" && snapshot.extension.error) {
      notes.push("Extension diagnostics reported an issue. Re-pair the extension, or check that the browser plugin is enabled.");
    }
    if (mode !== "extension" && modeHealth.installed) {
      notes.push("Extension is optional in this mode; it is only required for extension relay profiles.");
    }
    return notes.slice(0, 4);
  }, [isHeadless, isHosted, mode, modeHealth, snapshot]);

  const primaryTab = activeTabs[0] || null;

  return (
    <SectionLayout>
      <SectionHeader
        title={
          <span className="inline-flex items-center gap-2">
            <Globe className="h-5 w-5 text-stone-700 dark:text-stone-200" />
            Browser Relay
          </span>
        }
        description="Guided setup for extension relay, managed profiles, and remote CDP."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAdvanced((prev) => !prev)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100"
            >
              {showAdvanced ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  Hide Advanced
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  Show Advanced
                </>
              )}
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 py-1.5 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-100 hover:text-stone-900 disabled:opacity-60 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100"
              disabled={loading || actionBusy !== null}
            >
              {loading ? (
                <span className="inline-flex items-center gap-0.5">
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                  <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                </span>
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              Refresh
            </button>
          </div>
        }
      />

      <SectionBody width="narrow" className="space-y-4">
        <div className="rounded-xl border border-border/70 bg-card p-4" role="region" aria-label="Quick start setup">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-foreground">Quick Start</p>
            {snapshot && statusPill("Ready", modeHealth.ready)}
          </div>

          {isExtensionUnavailable && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-2 text-xs text-blue-200">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                Extension relay requires a desktop browser and is not available on servers.
                Use Managed Browser (runs in the background) or Remote Browser (connect to a cloud browser service like Browserless).
              </span>
            </div>
          )}

          <div className="space-y-2">
            {setupSteps.map((step, idx) => (
              <div
                key={step.key}
                className="rounded-lg border border-foreground/10 bg-foreground/5 px-3 py-2"
              >
                <p className="text-xs font-medium text-foreground/90">
                  {idx + 1}. {step.title}
                  <span className={step.done ? "ml-2 text-emerald-400" : "ml-2 text-zinc-400"}>
                    {step.done ? "Done" : "Pending"}
                  </span>
                </p>
                <p className="mt-1 text-xs text-muted-foreground/70">{step.hint}</p>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                primaryAction &&
                void runAction(primaryAction.action, primaryAction.payload)
              }
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-60"
              disabled={loading || actionBusy !== null || !primaryAction}
              aria-label={primaryAction?.label || "Run next setup step"}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {actionBusy && primaryAction?.action === actionBusy
                ? "Working..."
                : primaryAction?.label || "Run Next Step"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!isValidBrowserUrl(testUrl)) {
                  setError("Invalid URL. Only http:// and https:// URLs are allowed.");
                  return;
                }
                void runAction("open-test-tab", { url: testUrl });
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              disabled={loading || actionBusy !== null}
              aria-label="Open a test tab in the browser"
            >
              <Globe className="h-3.5 w-3.5" />
              Open Setup Tab
            </button>
            <a
              href={setupDocsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted"
            >
              Setup Guide <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          {primaryAction && (
            <p className="mt-2 text-xs text-muted-foreground/70">{primaryAction.hint}</p>
          )}
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-4" role="region" aria-label="Browser status">
          <p className="mb-3 text-sm font-medium text-foreground">Current Status</p>
          {loading && !snapshot ? (
            <div className="space-y-2">
              <div className="h-4 w-64 animate-pulse rounded bg-muted" />
              <div className="h-4 w-56 animate-pulse rounded bg-muted" />
              <div className="h-4 w-60 animate-pulse rounded bg-muted" />
            </div>
          ) : (
            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Browser profile: <code>{selectedProfile || "default"}</code></p>
              <p>Browser: <code>{snapshot?.status?.detectedBrowser || "unknown"}</code></p>
              <p>Connected tabs: <code>{activeTabs.length}</code></p>
              <p>Connection mode: <code>{modeLabel}</code></p>
              <p>Debug connection: <code>{snapshot?.status?.cdpUrl || "not connected"}</code></p>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-4" role="region" aria-label="Browser controls">
          <p className="mb-3 text-sm font-medium text-foreground">Controls</p>

          <div className="mb-3 grid gap-2 md:grid-cols-2">
            <label className="space-y-1 md:min-w-56 md:max-w-56">
              <span className="text-xs text-muted-foreground">Browser profile</span>
              <select
                value={selectedProfile}
                onChange={(e) => setProfile(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                disabled={loading || actionBusy !== null}
                aria-label="Select a browser profile"
              >
                {(snapshot?.profiles || []).length === 0 && (
                  <option value="" disabled>No profiles available</option>
                )}
                {(snapshot?.profiles || []).map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}{p.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
              {(snapshot?.profiles || []).length === 0 && !loading && (
                <p className="text-xs text-amber-400">
                  No browser profiles found. Run <code className="rounded bg-muted px-1">openclaw browser create-profile</code> to create one.
                </p>
              )}
            </label>
            <label className="space-y-1 md:min-w-56 md:max-w-56">
              <span className="text-xs text-muted-foreground">Quick-open URL</span>
              <input
                value={testUrl}
                onChange={(e) => setTestUrl(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                placeholder="https://example.com"
                disabled={loading || actionBusy !== null}
                aria-label="URL to open in browser"
                type="url"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void runAction("start")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              disabled={loading || actionBusy !== null}
              aria-label={mode === "remote" ? "Connect to remote browser" : "Start browser profile"}
            >
              <Play className="h-3.5 w-3.5" />{" "}
              {mode === "remote" ? "Connect Remote Browser" : "Start Browser Profile"}
            </button>
            <button
              type="button"
              onClick={() => void runAction("restart")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              disabled={loading || actionBusy !== null}
              aria-label={mode === "remote" ? "Reconnect remote browser" : "Reconnect browser relay"}
            >
              <RotateCw className="h-3.5 w-3.5" />{" "}
              {mode === "remote" ? "Reconnect Remote" : "Reconnect Relay"}
            </button>
            <button
              type="button"
              onClick={() => void runAction("stop")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              disabled={loading || actionBusy !== null}
              aria-label="Stop browser relay"
            >
              <Square className="h-3.5 w-3.5" /> Stop Relay
            </button>
            <button
              type="button"
              onClick={() => void runAction("snapshot-test")}
              className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              disabled={loading || actionBusy !== null}
              aria-label="Test browser connection"
            >
              <Bug className="h-3.5 w-3.5" /> Test Connection
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-border/70 bg-card p-4" role="region" aria-label="Connected browser tabs">
          <p className="mb-3 text-sm font-medium text-foreground">Connected Tabs</p>
          {loading && !snapshot ? (
            <div className="space-y-2">
              <div className="h-12 animate-pulse rounded-lg bg-muted" />
              <div className="h-8 w-3/4 animate-pulse rounded bg-muted" />
            </div>
          ) : activeTabs.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {!isHosted && mode === "extension"
                ? "No connected tabs yet. Open any tab and click the OpenClaw extension icon."
                : "No connected tabs yet. Open a tab in this profile or use Open Setup Tab."}
            </p>
          ) : (
            <div className="space-y-3">
              {primaryTab && (
                <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2">
                  <p className="text-xs font-semibold text-emerald-300">Primary connected tab</p>
                  <p className="mt-1 text-sm text-foreground/90">{tabTitle(primaryTab)}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{tabUrl(primaryTab)}</p>
                  {tabUrl(primaryTab) && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="rounded border border-foreground/10 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
                        {prettyHost(tabUrl(primaryTab))}
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyTabUrl(tabUrl(primaryTab))}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                      >
                        <Copy className="h-3 w-3" /> Copy URL
                      </button>
                    </div>
                  )}
                </div>
              )}
              {activeTabs.slice(1, 10).map((tab, i) => (
                <div
                  key={`${tabId(tab, i + 1)}`}
                  className="rounded-md border border-border/60 bg-background/50 px-3 py-2 text-xs"
                >
                  <p className="font-medium text-foreground">{tabTitle(tab)}</p>
                  <p className="mt-1 text-muted-foreground">{tabUrl(tab)}</p>
                </div>
              ))}
            </div>
          )}
        </div>

        {isHeadless && modeHealth.running && modeHealth.cdpReady && (
          <div className="rounded-xl border border-border/70 bg-card p-4" role="region" aria-label="Browser preview">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-medium text-foreground">Browser Preview</p>
              <button
                type="button"
                onClick={() => void captureScreenshot()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-60"
                disabled={screenshotLoading || actionBusy !== null}
                aria-label="Capture a screenshot of the browser"
              >
                {screenshotLoading ? (
                  <span className="inline-flex items-center gap-0.5">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:0ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                  </span>
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                Capture Screenshot
              </button>
            </div>
            {screenshotSrc ? (
              <div className="overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshotSrc}
                  alt="Browser screenshot preview"
                  className="w-full"
                />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Browser is running in the background (headless). Click &ldquo;Capture Screenshot&rdquo; to see what the browser is showing.
              </p>
            )}
          </div>
        )}

        {guidance.length > 0 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="mb-2 inline-flex items-center gap-1 text-sm font-medium text-amber-200">
              <Sparkles className="h-4 w-4" />
              What to do next
            </div>
            <ul className="space-y-1 text-xs text-amber-100">
              {guidance.map((note, i) => (
                <li key={`${note}-${i}`}>- {note}</li>
              ))}
            </ul>
          </div>
        )}

        {friendlyError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-200" role="alert">
            {friendlyError}
            {showAdvanced && error && friendlyError !== error && (
              <p className="mt-2 text-[11px] text-red-100/70">Raw error: {error}</p>
            )}
          </div>
        )}

        {notice && (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200" role="status">
            {notice}
          </div>
        )}

        {showAdvanced && (
          <div className="rounded-xl border border-border/70 bg-card p-4">
            <p className="mb-3 text-sm font-medium text-foreground">Advanced Diagnostics</p>
            <div className="mb-3 flex flex-wrap gap-2">
              {!isHosted && statusPill("Extension", Boolean(snapshot?.health.installed))}
              {statusPill("Running", Boolean(snapshot?.health.running))}
              {statusPill("Connected", Boolean(snapshot?.health.cdpReady))}
              {statusPill("Tab Connected", Boolean(snapshot?.health.tabConnected))}
              {statusPill("Relay Ready", modeHealth.ready)}
            </div>

            <div className="space-y-1 text-sm text-muted-foreground">
              <p>Debug endpoint: <code>{snapshot?.status?.cdpUrl || "not connected"}</code></p>
              <p>Executable: <code>{snapshot?.status?.detectedExecutablePath || "unknown"}</code></p>
              {!isHosted && (
                <>
                  <p>Extension path: <code>{snapshot?.extension.path || "unknown"}</code></p>
                  <p>Resolved path: <code>{snapshot?.extension.resolvedPath || "unknown"}</code></p>
                  <p>
                    Manifest: <code>{snapshot?.extension.manifestName || "unknown"}</code>{" "}
                    {snapshot?.extension.manifestVersion ? `(${snapshot.extension.manifestVersion})` : ""}
                  </p>
                </>
              )}
            </div>

            {!isHosted && (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void runAction("pair-extension")}
                  className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
                  disabled={loading || actionBusy !== null}
                >
                  {actionBusy === "pair-extension" ? "Pairing..." : "Get Pairing String"}
                </button>
                <button
                  type="button"
                  onClick={() => void copyPath()}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
                  disabled={loading || !snapshot?.extension.path}
                >
                  <Copy className="h-3 w-3" /> Copy Extension Path
                </button>
              </div>
            )}

            {(snapshot?.errors.status || snapshot?.errors.tabs || snapshot?.extension.error) && (
              <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/5 p-2 text-xs text-amber-200/90">
                {snapshot?.errors.status && <p>Status error: {snapshot.errors.status}</p>}
                {snapshot?.errors.tabs && <p>Tabs error: {snapshot.errors.tabs}</p>}
                {snapshot?.extension.error && <p>Extension error: {snapshot.extension.error}</p>}
              </div>
            )}

            {actionOutput && (
              <pre className="mt-3 max-h-52 overflow-auto rounded-md border border-border bg-background p-2 text-xs text-muted-foreground">
                {actionOutput}
              </pre>
            )}
          </div>
        )}
      </SectionBody>
    </SectionLayout>
  );
}
