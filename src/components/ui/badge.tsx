import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center justify-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-2 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive transition-[color,box-shadow] overflow-hidden",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a&]:hover:bg-primary/88",
        secondary:
          "bg-secondary text-fg-secondary [a&]:hover:bg-secondary/75",
        destructive:
          "bg-danger-bg text-danger-fg border-danger-border [a&]:hover:bg-danger-bg/70",
        success:
          "bg-success-bg text-success-fg border-success-border [a&]:hover:bg-success-bg/70",
        warning:
          "bg-warning-bg text-warning-fg border-warning-border [a&]:hover:bg-warning-bg/70",
        info:
          "bg-info-bg text-info-fg border-info-border [a&]:hover:bg-info-bg/70",
        outline:
          "border-border text-fg-secondary [a&]:hover:bg-accent [a&]:hover:text-foreground",
        ghost: "text-muted-foreground [a&]:hover:bg-accent [a&]:hover:text-foreground",
        link: "text-foreground underline-offset-4 [a&]:hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
