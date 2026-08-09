"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle, X } from "lucide-react";

type ToastItem = {
  id: string;
  agentId: string;
  agentName: string;
  timestamp: number;
};

/**
 * Global toast that appears in the top-right corner when an agent
 * sends a new chat message and the user is NOT on the chat tab.
 *
 * Listens for the custom "openclaw:chat-message" event dispatched
 * by chat-store.ts.
 */
export function ChatNotificationToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const router = useRouter();

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        agentId: string;
        agentName: string;
      };
      if (!detail) return;

      const toast: ToastItem = {
        id: crypto.randomUUID(),
        agentId: detail.agentId,
        agentName: detail.agentName,
        timestamp: Date.now(),
      };

      setToasts((prev) => {
        // Collapse: if there's already a toast for this agent, replace it
        const filtered = prev.filter((t) => t.agentId !== detail.agentId);
        return [...filtered, toast];
      });
    };

    window.addEventListener("openclaw:chat-message", handler);
    return () => window.removeEventListener("openclaw:chat-message", handler);
  }, []);

  // Auto-dismiss after 6 seconds
  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setToasts((prev) => prev.filter((t) => now - t.timestamp < 6000));
    }, 1000);
    return () => clearInterval(timer);
  }, [toasts.length]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const goToChat = useCallback(
    (id: string) => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      router.push("/chat");
    },
    [router]
  );

  if (toasts.length === 0) return null;

  return (
    <div className="fixed right-2 top-14 z-50 flex max-w-full flex-col gap-2 sm:right-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="flex items-center gap-3 rounded-xl border border-border-strong bg-card/95 px-4 py-3 shadow-2xl backdrop-blur-sm animate-in slide-in-from-right-5 fade-in duration-300"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted-foreground/20">
            <MessageCircle className="h-4 w-4 text-fg-secondary" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-foreground">
              {toast.agentName} responded
            </p>
            <p className="text-xs text-muted-foreground">
              New message in chat
            </p>
          </div>
          <button
            type="button"
            onClick={() => goToChat(toast.id)}
            className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            View
          </button>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            className="shrink-0 rounded-md p-1 text-fg-subtle transition-colors hover:text-muted-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
