import { cn } from "../../lib/utils";

type StatusMessageProps = {
  message: string | null;
  variant?: "info" | "error";
  className?: string;
};

export function StatusMessage({ message, variant = "info", className }: StatusMessageProps) {
  if (!message) return null;

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-[13px]",
        variant === "error"
          ? "border-destructive/25 bg-destructive/5 text-destructive"
          : "border-border bg-muted/40 text-muted-foreground",
        className,
      )}
    >
      {message}
    </div>
  );
}
