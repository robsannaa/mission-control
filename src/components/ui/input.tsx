import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // Shared 6px control radius, hairline border, card fill — inputs read as recessed
        // surfaces rather than raised controls.
        "h-9 w-full min-w-0 rounded-control border border-input bg-card px-3 py-1 text-base transition-[color,box-shadow,border-color] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-fg-placeholder disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 md:text-sm",
        "focus-visible:border-border-strong focus-visible:ring-[3px] focus-visible:ring-ring/50",
        "aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
