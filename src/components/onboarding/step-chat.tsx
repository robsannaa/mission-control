"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2, PartyPopper, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Celebration } from "./celebration";
import { inputClass, primaryBtnClass, secondaryBtnClass } from "./types";

const SUGGESTED_PROMPTS = [
  "Introduce yourself — what can you do for me?",
  "What's on my machine that you can help with?",
  "Write me a haiku about getting set up.",
];

type ChatTurn = { role: "user" | "assistant"; text: string };

export function StepChat({
  onDone,
  onSkip,
}: {
  onDone: (meta?: Record<string, unknown>) => void;
  onSkip: () => void;
}) {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [gotReply, setGotReply] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text || streaming) return;
      setError(null);
      setInput("");
      setTurns((prev) => [...prev, { role: "user", text }, { role: "assistant", text: "" }]);
      setStreaming(true);

      const appendAssistant = (chunk: string) => {
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, text: last.text + chunk };
          }
          return next;
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      };

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: "main",
            messages: [
              {
                id: `onboarding-${Date.now()}`,
                role: "user",
                parts: [{ type: "text", text }],
              },
            ],
          }),
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new Error(detail || `Chat returned ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sawContent = false;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) {
            appendAssistant(chunk);
            if (!sawContent && chunk.trim()) {
              sawContent = true;
              setGotReply(true);
            }
          }
        }
        if (!sawContent) {
          throw new Error("The agent sent an empty reply. Try again in a moment.");
        }
      } catch (err) {
        setTurns((prev) => prev.slice(0, -1));
        setError(err instanceof Error ? err.message : "Chat failed. Please try again.");
      } finally {
        setStreaming(false);
      }
    },
    [streaming],
  );

  return (
    <div className="space-y-5 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="space-y-0.5">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-stone-400 dark:text-[#a8b0ba]" />
          <h2 className="text-base font-semibold tracking-tight text-stone-900 dark:text-[#f5f7fa]">
            Say hello to your agent
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-stone-500 dark:text-[#a8b0ba]">
          One last thing — send a message and watch the reply stream in.
        </p>
      </div>

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => void send(p)}
              disabled={streaming}
              className="rounded-full border border-stone-200 dark:border-[#23282e] bg-white dark:bg-[#0d1014] px-3 py-1.5 text-xs text-stone-600 dark:text-[#a8b0ba] hover:border-emerald-300 dark:hover:border-emerald-500/40 hover:text-emerald-700 dark:hover:text-emerald-400 transition-colors"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <div
          ref={scrollRef}
          className="max-h-56 space-y-3 overflow-y-auto rounded-xl border border-stone-200 dark:border-[#23282e] bg-stone-50 dark:bg-[#0d1014] p-3.5"
        >
          {turns.map((turn, i) => (
            <div
              key={i}
              className={cn("flex", turn.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-xl px-3 py-2 text-xs leading-relaxed",
                  turn.role === "user"
                    ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                    : "bg-white dark:bg-[#171a1d] text-stone-700 dark:text-[#d6dce3] ring-1 ring-stone-200 dark:ring-[#23282e]",
                )}
              >
                {turn.text ||
                  (turn.role === "assistant" && streaming ? (
                    <span className="flex items-center gap-1">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-stone-400 [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-stone-400 [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-stone-400 [animation-delay:300ms]" />
                    </span>
                  ) : (
                    ""
                  ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send(input);
          }}
          placeholder="Ask your agent anything…"
          disabled={streaming}
          className={cn(inputClass, "flex-1")}
        />
        <button
          type="button"
          onClick={() => void send(input)}
          disabled={!input.trim() || streaming}
          className={cn(primaryBtnClass, "px-3.5")}
          aria-label="Send message"
        >
          {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
          <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-red-500 dark:bg-red-400" />
          {error}
        </p>
      )}

      {gotReply && !streaming && (
        <Celebration message="That's your agent, live and thinking. You're all set!" />
      )}

      <div className="flex items-center justify-between gap-2 pt-1">
        <button type="button" onClick={onSkip} className={secondaryBtnClass}>
          Skip for now
        </button>
        <button
          type="button"
          onClick={() => onDone({ chatted: gotReply })}
          disabled={!gotReply || streaming}
          className={primaryBtnClass}
        >
          <PartyPopper className="h-4 w-4" />
          Finish setup
        </button>
      </div>
    </div>
  );
}
