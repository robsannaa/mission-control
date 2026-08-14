"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * MeshGradient — soft, organic, ElevenLabs-style colour fields.
 *
 * Blurred colour blobs on a near-black base, screen-blended so overlaps glow,
 * dusted with film grain (see `.mesh-*` in globals.css). Pure CSS/SVG: crisp
 * at any size, theme-independent, no image hosting. Drop `children` in to
 * overlay content on top of the gradient.
 *
 *   <MeshGradient variant="aurora" className="h-40 rounded-2xl" />
 *   <MeshGradient variant="violet" className="h-32">{header}</MeshGradient>
 */

export type MeshVariant = "aurora" | "sunset" | "ocean" | "violet" | "lobster";

type Blob = { c: string; x: number; y: number; s: number; o?: number };

/** Each preset: a base ground colour + colour blobs positioned by percentage
 *  of the container, sized as a percentage of its width. Screen-blending on the
 *  dark base is what makes overlaps read as light, not mud. */
const PRESETS: Record<MeshVariant, { base: string; blobs: Blob[] }> = {
  // The "Dubbing v2" look: amber → green → violet → teal on near-black.
  aurora: {
    base: "#0b0d0c",
    blobs: [
      { c: "#e2653a", x: 16, y: 20, s: 66 },
      { c: "#1f8a54", x: 60, y: 30, s: 88 },
      { c: "#7c4dff", x: 86, y: 84, s: 74 },
      { c: "#2bb0a6", x: 28, y: 90, s: 64 },
    ],
  },
  sunset: {
    base: "#120a10",
    blobs: [
      { c: "#ff6a3d", x: 18, y: 22, s: 72 },
      { c: "#ff2e88", x: 72, y: 32, s: 74 },
      { c: "#7c3aed", x: 84, y: 88, s: 70 },
      { c: "#ffb03a", x: 22, y: 86, s: 58 },
    ],
  },
  ocean: {
    base: "#070d14",
    blobs: [
      { c: "#2f6bff", x: 20, y: 24, s: 78 },
      { c: "#12c2e9", x: 76, y: 30, s: 76 },
      { c: "#6d5efc", x: 84, y: 86, s: 72 },
      { c: "#1de3c6", x: 24, y: 88, s: 58 },
    ],
  },
  violet: {
    base: "#0d0a14",
    blobs: [
      { c: "#7c3aed", x: 22, y: 24, s: 80 },
      { c: "#c026d3", x: 76, y: 34, s: 72 },
      { c: "#3b3af0", x: 84, y: 88, s: 72 },
      { c: "#f472b6", x: 22, y: 88, s: 56 },
    ],
  },
  // Brand nod to the lobster: warm reds and coral.
  lobster: {
    base: "#140807",
    blobs: [
      { c: "#ff5a3c", x: 20, y: 24, s: 78 },
      { c: "#ff8a3d", x: 74, y: 30, s: 72 },
      { c: "#e11d48", x: 84, y: 86, s: 70 },
      { c: "#ffd08a", x: 24, y: 88, s: 54 },
    ],
  },
};

export function MeshGradient({
  variant = "aurora",
  animated = true,
  grain = true,
  className,
  children,
}: {
  variant?: MeshVariant;
  animated?: boolean;
  grain?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  const preset = PRESETS[variant];
  return (
    <div
      className={cn("relative overflow-hidden", animated && "mesh-animated", className)}
      style={{ backgroundColor: preset.base }}
    >
      {preset.blobs.map((b, i) => (
        <span
          key={i}
          className="mesh-blob"
          aria-hidden="true"
          style={{
            left: `${b.x}%`,
            top: `${b.y}%`,
            width: `${b.s}%`,
            aspectRatio: "1 / 1",
            opacity: b.o ?? 0.9,
            background: `radial-gradient(circle at center, ${b.c} 0%, ${b.c}00 70%)`,
            animationDelay: `${i * -2.3}s`,
          }}
        />
      ))}
      {grain && <span className="mesh-grain" aria-hidden="true" />}
      {children != null && <div className="relative z-10 h-full w-full">{children}</div>}
    </div>
  );
}
