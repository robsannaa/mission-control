"use client";

import { useCallback, useRef, useState } from "react";
import { Loader2, PartyPopper, Send, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Celebration } from "./celebration";
import { inputClass, primaryBtnClass, skipBtnClass } from "./types";
import { splitOnboardChatFrame } from "./error-frame";

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

      // Only the content BEFORE an error marker is ever shown as if the agent
      // said it — an error frame never reaches the transcript as prose.
      const setAssistantContent = (content: string) => {
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1];
          if (last?.role === "assistant") {
            next[next.length - 1] = { ...last, text: content };
          }
          return next;
        });
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
      };

      let raw = "";
      try {
        const res = await fetch("/api/onboarding/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: text }),
        });
        if (!res.ok || !res.body) {
          const detail = await res.text().catch(() => "");
          throw new Error(detail || `Chat returned ${res.status}`);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (chunk) {
            raw += chunk;
            setAssistantContent(splitOnboardChatFrame(raw).content);
          }
        }
        const { content, error: frameError } = splitOnboardChatFrame(raw);
        if (frameError) {
          throw new Error(frameError);
        }
        if (!content.trim()) {
          throw new Error("The agent sent an empty reply. Try again in a moment.");
        }
        setGotReply(true);
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
    <div className="flex min-h-full flex-col gap-5 animate-in fade-in slide-in-from-right-4 duration-300">
      <div className="space-y-0.5">
        <div className="mb-1 flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-fg-subtle" />
          <h2 className="text-base font-medium tracking-tight text-foreground">
            Say hello to your agent
          </h2>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">
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
              className="rounded-full border border-border bg-card px-3 py-1.5 text-xs text-fg-secondary hover:border-black/30 hover:text-[#111111] transition-colors"
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <div
          ref={scrollRef}
          className="max-h-56 space-y-3 overflow-y-auto rounded-xl border border-border bg-muted p-3.5"
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
                    ? "bg-primary text-primary-foreground"
                    : "bg-card text-fg-secondary ring-1 ring-border",
                )}
              >
                {turn.text ||
                  (turn.role === "assistant" && streaming ? (
                    <span className="flex items-center gap-1">
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:0ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:150ms]" />
                      <span className="h-1 w-1 animate-bounce rounded-full bg-muted-foreground [animation-delay:300ms]" />
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
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-all duration-200 hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-30"
          aria-label="Send message"
        >
          {streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>

      {error && (
        <p className="flex items-center gap-1.5 text-xs text-danger-fg">
          <span className="inline-block h-1 w-1 shrink-0 rounded-full bg-danger" />
          {error}
        </p>
      )}

      {gotReply && !streaming && (
        <Celebration message="That's your agent, live and thinking. You're all set!" />
      )}

      <div className="sticky bottom-0 z-10 mt-auto -mx-5 flex flex-col items-center gap-3 bg-white px-5 pb-6 pt-5 sm:-mx-8 sm:px-8 sm:pb-7">
        <button
          type="button"
          onClick={() => onDone({ chatted: gotReply })}
          disabled={!gotReply || streaming}
          className={primaryBtnClass}
        >
          <PartyPopper className="h-4 w-4" />
          Finish setup
        </button>
        <button type="button" onClick={onSkip} className={skipBtnClass}>
          Skip for now
        </button>
      </div>
    </div>
  );
}
