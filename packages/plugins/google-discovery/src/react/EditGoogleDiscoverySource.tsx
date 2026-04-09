import { useAtomValue, Result } from "@effect-atom/atom-react";
import { sourceConfigAtom } from "@executor/react/api/atoms";
import { useScope } from "@executor/react/api/scope-context";
import { Badge } from "@executor/react/components/badge";
import { Button } from "@executor/react/components/button";

export default function EditGoogleDiscoverySource({
  sourceId,
  onSave,
}: {
  readonly sourceId: string;
  readonly onSave: () => void;
}) {
  const scopeId = useScope();
  const configResult = useAtomValue(sourceConfigAtom(sourceId, scopeId));

  const config = Result.isSuccess(configResult) ? configResult.value : null;
  const authKind = (config as any)?.auth?.kind ?? "none";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">
          Edit Google Discovery Source
        </h1>
        <p className="mt-1 text-[13px] text-muted-foreground">
          View configuration for this Google API source. To change authentication,
          remove and re-add the source with updated OAuth credentials.
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-card-foreground">
            {(config as any)?.name ?? sourceId}
          </p>
          {(config as any)?.discoveryUrl && (
            <p className="mt-0.5 text-xs text-muted-foreground font-mono truncate">
              {(config as any).discoveryUrl}
            </p>
          )}
        </div>
        <Badge variant="secondary" className="text-[10px]">
          Google Discovery
        </Badge>
      </div>

      {config && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Service</p>
              <p className="text-sm font-medium text-foreground">
                {(config as any)?.service ?? "unknown"}
              </p>
            </div>
            <div className="rounded-lg border border-border bg-card/50 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Version</p>
              <p className="text-sm font-medium text-foreground">
                {(config as any)?.version ?? "unknown"}
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-card/50 p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Authentication</p>
            <p className="text-sm font-medium text-foreground capitalize">
              {authKind === "oauth2" ? "OAuth 2.0" : authKind}
            </p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end border-t border-border pt-4">
        <Button onClick={onSave}>Done</Button>
      </div>
    </div>
  );
}
