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
