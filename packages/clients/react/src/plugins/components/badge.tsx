import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/cn";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tracking-wide uppercase",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        muted: "border-transparent bg-muted text-muted-foreground",
        get: "border-[var(--method-get)]/20 bg-[var(--method-get)]/10 text-[var(--method-get)]",
        post: "border-[var(--method-post)]/20 bg-[var(--method-post)]/10 text-[var(--method-post)]",
        put: "border-[var(--method-put)]/20 bg-[var(--method-put)]/10 text-[var(--method-put)]",
        delete: "border-[var(--method-delete)]/20 bg-[var(--method-delete)]/10 text-[var(--method-delete)]",
        destructive: "border-destructive/20 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function MethodBadge({ method }: { method: string }) {
  const variant = ({
    GET: "get",
    POST: "post",
    PUT: "put",
    PATCH: "put",
    DELETE: "delete",
  } as const)[method.toUpperCase()] ?? "outline";

  return <Badge variant={variant}>{method}</Badge>;
}
