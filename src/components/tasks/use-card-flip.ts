"use client";

/**
 * Cards that move on their own must be followed by the eye.
 *
 * The board relocates cards without anyone dragging them: an agent asks a
 * question and its card walks from In Progress to Review by itself. If that
 * happens as an instant swap, the user sees two unrelated boards and has to work
 * out what changed. So every move is animated from where the card was to where
 * it now is.
 *
 * The animation runs on a clone in a body-level overlay rather than on the card
 * itself. Columns are scroll containers with `overflow` set, so a card animating
 * across them would be clipped at the column edge — a clone parented to
 * `document.body` is clipped by nothing.
 */

import { useCallback, useLayoutEffect, useRef } from "react";

/** Below a couple of pixels, a "move" is just reflow noise. */
const MOVE_EPSILON = 4;
const DURATION_MS = 460;
/** Slight overshoot-free ease: decisive start, soft landing. */
const EASING = "cubic-bezier(0.22, 0.61, 0.36, 1)";

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type Rect = { top: number; left: number; width: number; height: number };

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/**
 * Watches every `[data-task-id]` inside `containerRef` and animates any that
 * changed position since the last render.
 *
 * Returns a ref to attach to the board root.
 */
export function useCardFlip<T extends HTMLElement>() {
  const containerRef = useRef<T | null>(null);
  const previous = useRef(new Map<string, Rect>());
  /** Cards mid-flight, so a re-render during the animation does not restart it. */
  const flying = useRef(new Set<string>());

  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return new Map<string, Rect>();
    const next = new Map<string, Rect>();
    container.querySelectorAll<HTMLElement>("[data-task-id]").forEach((node) => {
      const id = node.dataset.taskId;
      if (id) next.set(id, rectOf(node));
    });
    return next;
  }, []);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const next = measure();
    const prev = previous.current;

    if (prefersReducedMotion()) {
      previous.current = next;
      return;
    }

    container.querySelectorAll<HTMLElement>("[data-task-id]").forEach((node) => {
      const id = node.dataset.taskId;
      if (!id) return;
      const from = prev.get(id);
      const to = next.get(id);
      if (!from || !to) return; // new card, or one that just left
      if (flying.current.has(id)) return;

      const dx = from.left - to.left;
      const dy = from.top - to.top;
      if (Math.abs(dx) < MOVE_EPSILON && Math.abs(dy) < MOVE_EPSILON) return;

      // A move within one column is ordinary reflow — cheap transform is enough
      // and keeps the card in its own stacking context.
      const sameColumn = Math.abs(dx) < MOVE_EPSILON;
      if (sameColumn) {
        flying.current.add(id);
        const animation = node.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
          { duration: DURATION_MS, easing: EASING },
        );
        animation.finished.catch(() => {}).finally(() => flying.current.delete(id));
        return;
      }

      // Across columns: fly a clone over the top so nothing clips it.
      flying.current.add(id);
      const clone = node.cloneNode(true) as HTMLElement;
      clone.style.position = "fixed";
      clone.style.margin = "0";
      clone.style.top = `${from.top}px`;
      clone.style.left = `${from.left}px`;
      clone.style.width = `${from.width}px`;
      clone.style.height = `${from.height}px`;
      clone.style.zIndex = "40";
      clone.style.pointerEvents = "none";
      clone.style.willChange = "transform";
      clone.setAttribute("aria-hidden", "true");
      clone.removeAttribute("data-task-id");
      document.body.appendChild(clone);

      // Hide the real card only while its stand-in is in the air.
      const previousVisibility = node.style.visibility;
      node.style.visibility = "hidden";

      const animation = clone.animate(
        [
          { transform: "translate3d(0, 0, 0)", opacity: 1 },
          {
            transform: `translate3d(${to.left - from.left}px, ${to.top - from.top}px, 0)`,
            opacity: 1,
          },
        ],
        { duration: DURATION_MS, easing: EASING },
      );

      const cleanup = () => {
        clone.remove();
        node.style.visibility = previousVisibility;
        flying.current.delete(id);
      };
      animation.finished.then(cleanup).catch(cleanup);
    });

    previous.current = next;
  });

  return containerRef;
}
