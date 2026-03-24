import type { ReactNode } from "react";

import type { Loadable } from "../../core/types";
import { IconEmpty, IconSpinner } from "./icons";

export function LoadableBlock<T>(props: {
  loadable: Loadable<T>;
  loading?: string;
  children: (data: T) => ReactNode;
}) {
  if (props.loadable.status === "loading") {
    return (
      <div className="flex h-full min-h-48 items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <IconSpinner />
          <span>{props.loading ?? "Loading..."}</span>
        </div>
      </div>
    );
  }

  if (props.loadable.status === "error") {
    return (
      <div className="flex h-full min-h-48 items-center justify-center">
        <div className="rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {props.loadable.error.message}
        </div>
      </div>
    );
  }

  return <>{props.children(props.loadable.data)}</>;
}

export function EmptyState(props: {
  title: string;
  description?: string;
  className?: string;
}) {
  return (
    <div className={`flex h-full items-center justify-center ${props.className ?? ""}`}>
      <div className="text-center">
        <IconEmpty className="mx-auto mb-3 text-muted-foreground/20" />
        <p className="text-[13px] text-muted-foreground/60">{props.title}</p>
        {props.description && (
          <p className="mt-1 text-[11px] text-muted-foreground/40">{props.description}</p>
        )}
      </div>
    </div>
  );
}
