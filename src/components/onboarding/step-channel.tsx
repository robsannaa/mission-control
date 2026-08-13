"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { ChevronRight, ExternalLink, Loader2, MessageCircle, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { Celebration } from "./celebration";
import {
  cardClass,
  inputClass,
  labelClass,
  primaryBtnClass,
  secondaryBtnClass,
  type ChannelStatusPayload,
} from "./types";

const POLL_MS = 3000;

type DmRequest = {
  channel: string;
  code: string;
  account?: string;
  senderName?: string;
  message?: string;
};

// Stable identity for a pairing request across polls — used both to dedupe
// and to tell "already pending when we arrived" apart from "just arrived".
function requestKey(req: DmRequest): string {
  return `${req.channel}::${req.account || "default"}::${req.code}`;
}

export function StepChannel({
  onDone,
  onSkip,
}: {
  onDone: (meta?: Record<string, unknown>) => void;
  onSkip: () => void;
}) {
  const [status, setStatus] = useState<ChannelStatusPayload | null>(null);
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [connectedNow, setConnectedNow] = useState(false);
  const [firstMessage, setFirstMessage] = useState(false);
  const [pairing, setPairing] = useState<DmRequest[]>([]);
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [paired, setPaired] = useState(false);
  // lastInboundAt at the moment we started watching — anything newer is "the first message"
  const inboundBaselineRef = useRef<number | null | undefined>(undefined);
  const wasConnectedRef = useRef(false);
  // Pairing request ids already pending the moment we reached this step —
  // those are surfaced for a manual click; anything that shows up *after*
  // is auto-approved with zero clicks. null until the first pairing poll.
  const baselineRequestIdsRef = useRef<Set<string> | null>(null);
  const autoApprovedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/onboarding/channel", { cache: "no-store" });
      if (!res.ok) return;
      const data: ChannelStatusPayload = await res.json();
      setStatus(data);
      if (data.connected && !wasConnectedRef.current) {
        wasConnectedRef.current = true;
        setConnectedNow(true);
      }
      if (inboundBaselineRef.current === undefined) {
        inboundBaselineRef.current = data.lastInboundAt;
      } else if (
        typeof data.lastInboundAt === "number" &&
        data.lastInboundAt > (inboundBaselineRef.current ?? 0)
      ) {
        setFirstMessage(true);
      }
    } catch {
      // transient
    }
  }, []);

  // Approves one pairing request. Manual clicks show a spinner on that row;
  // auto-approvals stay silent and just resolve into the "Paired!" banner.
  const approveRequest = useCallback(async (req: DmRequest, opts?: { auto?: boolean }) => {
    const key = requestKey(req);
    if (!opts?.auto) setApproving(req.code);
    try {
      await fetch("/api/pairing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "approve-dm",
          channel: req.channel,
          code: req.code,
          account: req.account,
        }),
      });
      // Optimistically drop it locally; the next poll reconciles with the server.
      setPairing((prev) => prev.filter((r) => requestKey(r) !== key));
      if (opts?.auto) setPaired(true);
    } catch {
      // Network hiccup: un-mark it so a later poll can retry the auto-approve.
      if (opts?.auto) autoApprovedRef.current.delete(key);
    } finally {
      if (!opts?.auto) setApproving(null);
    }
  }, []);

  const refreshPairing = useCallback(async () => {
    try {
      const res = await fetch(`/api/pairing?_=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      const list: DmRequest[] = Array.isArray(data?.dm) ? data.dm : [];

      if (baselineRequestIdsRef.current === null) {
        // First poll on this step: whatever is already pending is "stale" —
        // shown for a manual approve, never auto-approved.
        baselineRequestIdsRef.current = new Set(list.map(requestKey));
        setPairing(list);
        return;
      }

      const stale = list.filter((req) => baselineRequestIdsRef.current!.has(requestKey(req)));
      setPairing(stale);

      // Anything new since baseline is a fresh "scan → /start" — pair it
      // instantly, no click required.
      for (const req of list) {
        const key = requestKey(req);
        if (baselineRequestIdsRef.current.has(key) || autoApprovedRef.current.has(key)) continue;
        autoApprovedRef.current.add(key);
        void approveRequest(req, { auto: true });
      }
    } catch {
      // transient
    }
  }, [approveRequest]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
      if (wasConnectedRef.current) void refreshPairing();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, refreshPairing]);

  const handleConnect = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed || connecting) return;
    setConnecting(true);
    setError(null);
    try {
      const res = await fetch("/api/onboarding/channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", token: trimmed }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Could not connect Telegram.");
        return;
      }
      // From here the polling loop takes over and flips to connected
      inboundBaselineRef.current = undefined;
      setStatus((prev) =>
        prev
          ? { ...prev, configured: true, botUsername: data.botUsername, deepLink: data.deepLink }
          : prev,
      );
    } catch {
      setError("Network error while connecting. Please try again.");
    } finally {
      setConnecting(false);
    }
  }, [token, connecting]);

  // Manual "Approve" click, for stale (pre-existing) requests only.
  const handleApprove = useCallback(
    (req: DmRequest) => {
      void approveRequest(req);
    },
    [approveRequest],
  );

  const connected = status?.connected === true;
  const configured = status?.configured === true;
  const deepLink = status?.deepLink;

  // Local QR render (no third-party service — the deep link never leaves
  // the browser). White quiet-zone forced regardless of theme so a phone
  // camera has enough contrast to scan it in dark mode too.
  useEffect(() => {
    if (!deepLink) {
      setQrDataUrl(null);
      setQrError(false);
      return;
    }
    let cancelled = false;
    setQrError(false);
    QRCode.toDataURL(deepLink, {
      width: 192,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setQrError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [deepLink]);

  return (
    <div className="flex min-h-full flex-col gap-6 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="space-y-0.5">
        <div className="mb-1 flex items-center gap-2">
          <MessageCircle className="h-3.5 w-3.5 text-fg-subtle" />
          <h2 className="text-base font-semibold tracking-tight text-foreground">
            Put your agent in your pocket
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Connect Telegram and chat with your agent from your phone. Message{" "}
          <a
            href="https://t.me/BotFather"
            target="_blank"
            rel="noopener noreferrer"
            className="text-foreground underline underline-offset-2"
          >
            @BotFather
          </a>{" "}
          , create a bot, and paste its token here.
        </p>
      </div>

      {!configured && (
        <div className="space-y-1.5">
          <label className={labelClass}>Telegram bot token</label>
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleConnect();
            }}
            placeholder="123456789:ABC-DEF..."
            disabled={connecting}
            className={inputClass}
          />
          {error && (
            <p className="flex items-center gap-1.5 text-xs text-danger-fg">
              <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-danger" />
              {error}
            </p>
          )}
          <button
            type="button"
            onClick={handleConnect}
            disabled={!token.trim() || connecting}
            className={cn(primaryBtnClass, "mt-2")}
          >
            {connecting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Verifying with Telegram…
              </>
            ) : (
              <>
                <Send className="h-3.5 w-3.5" />
                Connect Telegram
              </>
            )}
          </button>
        </div>
      )}

      {configured && !connected && (
        <div className={cn(cardClass, "flex items-center gap-3")}>
          <Loader2 className="h-4 w-4 animate-spin text-fg-subtle" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Token saved — the gateway is restarting and connecting to Telegram. This usually takes a
            few seconds…
          </p>
        </div>
      )}

      {connectedNow && connected && (
        <Celebration
          message={
            status?.botUsername
              ? `@${status.botUsername} is live on Telegram!`
              : "Telegram is connected!"
          }
        />
      )}

      {connected && deepLink && (
        <div className={cn(cardClass, "flex items-center gap-4")}>
          {qrDataUrl && !qrError ? (
            // Rendered locally from the public t.me link — no secrets, no
            // third-party service. Background is intentionally plain white
            // (not a theme token): QR codes need a real white quiet zone to
            // stay scannable by a phone camera, including in dark mode.
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={qrDataUrl}
              alt={`QR code for ${deepLink}`}
              width={96}
              height={96}
              className="h-24 w-24 shrink-0 rounded-lg bg-white p-1.5 ring-1 ring-border"
            />
          ) : (
            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-lg bg-white p-1.5 ring-1 ring-border">
              <Loader2 className="h-4 w-4 animate-spin text-fg-subtle" />
            </div>
          )}
          <div className="min-w-0 space-y-1">
            <p className="text-xs font-semibold text-foreground">
              Scan with your phone
            </p>
            <p className="text-xs leading-relaxed text-muted-foreground">
              or open{" "}
              <a
                href={deepLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-foreground underline underline-offset-2"
              >
                t.me/{status?.botUsername}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>{" "}
              and send your bot a message.
            </p>
            {!firstMessage && !paired && (
              <p className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting for your first message…
              </p>
            )}
          </div>
        </div>
      )}

      {paired && (
        <Celebration message="Paired! ✅ Your phone is connected to your agent." />
      )}

      {firstMessage && (
        <Celebration message="First message received — your agent heard you!" />
      )}

      {pairing.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-foreground">
            Approve access for:
          </p>
          {pairing.map((req) => (
            <div
              key={req.code}
              className={cn(cardClass, "flex items-center justify-between gap-3 py-3")}
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-fg-secondary">
                  {req.senderName || "Telegram user"}
                </p>
                {req.message && (
                  <p className="truncate text-[11px] text-fg-subtle">
                    &ldquo;{req.message}&rdquo;
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => handleApprove(req)}
                disabled={approving === req.code}
                className={cn(primaryBtnClass, "px-3 py-1.5 text-xs")}
              >
                {approving === req.code ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Approve"
                )}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onSkip} className={secondaryBtnClass}>
          Skip for now
        </button>
        <button
          type="button"
          onClick={() =>
            onDone({ botUsername: status?.botUsername ?? null, firstMessage, paired })
          }
          disabled={!connected}
          className={primaryBtnClass}
        >
          Continue
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
