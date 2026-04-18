import type { ReactNode } from "react";
import { SourceFavicon } from "./source-favicon";

export function SourceHeader(props: {
  url?: string;
  title: string;
  subtitle?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-white shadow-xs dark:bg-neutral-900 dark:shadow-none">
        <SourceFavicon url={props.url} size={20} />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-foreground">{props.title}</p>
        {props.subtitle !== undefined && (
          <p className="text-xs text-muted-foreground">{props.subtitle}</p>
        )}
      </div>
    </div>
  );
}
