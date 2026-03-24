import { Link } from "@tanstack/react-router";
import { sourcePluginsIndexPath } from "@executor/react/source-plugins";

import { IconEmpty } from "./icons";
import { cn } from "../lib/utils";

export function SourceNotFoundState() {
  return (
    <div className="flex h-full min-h-48 items-center justify-center px-6">
      <div className="flex max-w-sm flex-col items-center text-center">
        <IconEmpty className="mb-4 text-muted-foreground/20" />
        <h2 className="text-sm font-semibold text-foreground">Source not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          This source no longer exists in the current workspace.
        </p>
        <div className="mt-5 flex items-center gap-2">
          <Link
            to="/"
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-md border border-input bg-transparent px-2.5 text-xs font-medium transition-all",
              "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            Back to dashboard
          </Link>
          <Link
            to={sourcePluginsIndexPath}
            className={cn(
              "inline-flex h-7 items-center justify-center rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-all",
              "hover:bg-primary/90",
            )}
          >
            Add source
          </Link>
        </div>
      </div>
    </div>
  );
}
