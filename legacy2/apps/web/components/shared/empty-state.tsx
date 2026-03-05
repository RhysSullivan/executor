import { cn } from "../../lib/utils";

type EmptyStateProps = {
  message: string;
  className?: string;
};

export function EmptyState({ message, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex items-center justify-center rounded-md border border-dashed border-border py-8 text-[13px] text-muted-foreground",
        className,
      )}
    >
      {message}
    </div>
  );
}
