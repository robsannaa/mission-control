"use client";

import { cn } from "@/lib/utils";

type LoadingStateProps = {
  className?: string;
  size?: "sm" | "md" | "lg";
};

const spinnerSize: Record<NonNullable<LoadingStateProps["size"]>, string> = {
  sm: "size-3.5",
  md: "size-5",
  lg: "size-8",
};

export function InlineSpinner({
  className,
  size = "sm",
}: {
  className?: string;
  size?: LoadingStateProps["size"];
}) {
  const spinner = spinnerSize[size || "sm"];
  return (
    <span
      className={cn(
        "inline-block animate-spin rounded-full border-2 border-muted border-t-foreground",
        spinner,
        className,
      )}
      role="status"
      aria-label="Loading"
    >
      <span className="sr-only">Loading...</span>
    </span>
  );
}

export function LoadingState({
  className,
  size = "md",
}: LoadingStateProps) {
  return (
    <div
      className={cn(
        "flex flex-1 items-center justify-center",
        className
      )}
    >
      <InlineSpinner size={size} />
    </div>
  );
}

/**
 * Fills the content area while a section loads. The sidebar and header stay
 * put, because only the content is actually changing.
 *
 * The delayed fade means a fast navigation never flashes a spinner: if the
 * data arrives inside 150ms the user just sees the new page.
 */
export function ContentLoadingState({
  className,
  size = "md",
}: LoadingStateProps) {
  return (
    <LoadingState
      size={size}
      className={cn(
        "min-h-0 w-full animate-in fade-in duration-300 delay-150 [animation-fill-mode:backwards]",
        className,
      )}
    />
  );
}

/**
 * A true full-viewport overlay. Correct ONLY before the app shell exists —
 * setup and onboarding, which render above the sidebar. Inside a page it
 * covers the sidebar and header, which makes a section change look like a
 * full page reload.
 */
export function ScreenLoadingState({
  className,
  size = "md",
}: LoadingStateProps) {
  return (
    <LoadingState
      size={size}
      className={cn("fixed inset-0 z-50", className)}
    />
  );
}
