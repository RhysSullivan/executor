import { Button } from "../components/button";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Credential-status chrome — the actionable "needs sign-in/configure" notice a
// plugin can render to surface whether an integration's connection is ready.
// v2: the caller decides what "missing" means (e.g. no connection for this
// owner); this module only renders the result. The v1 scope-stack binding
// resolution (`source-credential-status-core`) is gone — connections replace
// per-source credential binding. The retired status/loading badges were a
// passive "Credentials ready/needed" display; only the call-to-action remains.
// ---------------------------------------------------------------------------

export function IntegrationCredentialNotice(props: {
  readonly missing: readonly string[];
  readonly action?: ReactNode;
  readonly onAction?: () => void;
}) {
  if (props.missing.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-border bg-muted/30 px-4 py-3">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">Credentials need attention</div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            Missing {props.missing.join(", ")}
          </div>
        </div>
        {props.action ??
          (props.onAction && (
            <Button size="sm" variant="outline" onClick={props.onAction}>
              Configure
            </Button>
          ))}
      </div>
    </div>
  );
}
