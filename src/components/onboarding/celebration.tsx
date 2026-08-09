"use client";

import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

// Confetti reads the chart ramp so it stays inside the palette.
const CONFETTI_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/**
 * A small confetti burst + message shown when a step succeeds.
 * Pure CSS — no dependencies. Renders nothing after the burst settles
 * unless `sticky` keeps the banner visible.
 */
export function Celebration({
  message,
  sticky = true,
  className,
}: {
  message: string;
  sticky?: boolean;
  className?: string;
}) {
  const [burst, setBurst] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setBurst(false), 1600);
    return () => clearTimeout(timer);
  }, []);

  if (!burst && !sticky) return null;

  return (
    <div
      className={cn(
        "relative flex items-center gap-2.5 rounded-xl border border-success-border bg-success-bg px-3.5 py-3 animate-in fade-in zoom-in-95 duration-300",
        className,
      )}
      role="status"
    >
      <style>{`
        @keyframes mc-confetti-pop {
          0% { transform: translate(0, 0) rotate(0deg) scale(1); opacity: 1; }
          100% { transform: translate(var(--dx), var(--dy)) rotate(540deg) scale(0.4); opacity: 0; }
        }
      `}</style>
      <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-success text-primary-foreground">
        <Check className="h-3.5 w-3.5" />
        {burst && <span className="absolute inset-0 rounded-full bg-success animate-ping" />}
      </span>
      <p className="text-xs font-medium leading-relaxed text-success-fg">
        {message}
      </p>
      {burst && (
        <span aria-hidden className="pointer-events-none absolute left-3 top-1/2">
          {CONFETTI_COLORS.map((color, i) => (
            <span
              key={i}
              className="absolute h-1.5 w-1.5 rounded-[2px]"
              style={{
                backgroundColor: color,
                ["--dx" as string]: `${Math.cos((i / CONFETTI_COLORS.length) * Math.PI * 2) * 46}px`,
                ["--dy" as string]: `${Math.sin((i / CONFETTI_COLORS.length) * Math.PI * 2) * 34 - 18}px`,
                animation: "mc-confetti-pop 1.1s ease-out forwards",
                animationDelay: `${i * 40}ms`,
              }}
            />
          ))}
        </span>
      )}
    </div>
  );
}
