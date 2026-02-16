"use client";

import { useState } from "react";
import { Trash2 } from "lucide-react";
import { useMutation } from "convex/react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useSession } from "@/lib/session-context";
import { convexApi } from "@/lib/convex-api";
import type {
  OpenApiSourceQuality,
  SourceAuthProfile,
  ToolSourceScopeType,
  ToolSourceRecord,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { displaySourceName } from "@/lib/tool/source-utils";
import {
  compactEndpointLabel,
  formatSourceAuthBadge,
  readSourceAuth,
  sourceAuthProfileForSource,
  sourceEndpointLabel,
} from "@/lib/tools/source-helpers";
import { AddSourceDialog } from "./add/source-dialog";
import { SourceFavicon } from "./source-favicon";
import {
  OpenApiQualityDetails,
  SourceQualitySummary,
} from "./source/quality-details";

function ownerScopeBadge(scopeType: ToolSourceScopeType | undefined): string {
  return scopeType === "organization" ? "org shared" : "workspace";
}

export function SourceCard({
  source,
  quality,
  qualityLoading,
  credentialStats,
  existingSourceNames,
  sourceAuthProfiles,
  selected = false,
  onFocusSource,
}: {
  source: ToolSourceRecord;
  quality?: OpenApiSourceQuality;
  qualityLoading?: boolean;
  credentialStats: { workspaceCount: number; accountCount: number };
  existingSourceNames: Set<string>;
  sourceAuthProfiles: Record<string, SourceAuthProfile>;
  selected?: boolean;
  onFocusSource?: (sourceName: string) => void;
}) {
  const { context } = useSession();
  const deleteToolSource = useMutation(convexApi.workspace.deleteToolSource);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!context) {
      return;
    }
    setDeleting(true);
    try {
      await deleteToolSource({
        workspaceId: context.workspaceId,
        sessionId: context.sessionId,
        sourceId: source.id,
      });
      toast.success(`Removed "${source.name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
    } finally {
      setDeleting(false);
    }
  };

  const inferredProfile = sourceAuthProfileForSource(source, sourceAuthProfiles);
  const authBadge = formatSourceAuthBadge(source, inferredProfile);
  const auth = readSourceAuth(source, inferredProfile);
  const hasAuthConfigured = auth.type !== "none";
  const hasAnyCredential = credentialStats.workspaceCount + credentialStats.accountCount > 0;
  const sourceCanConfigure = source.type === "openapi" || source.type === "graphql";
  const prettyName = displaySourceName(source.name);
  const compactEndpoint = compactEndpointLabel(source);
  const showTypeSummary = source.type === "openapi" && (quality || qualityLoading);

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-lg border border-border/60 bg-gradient-to-b from-muted/45 to-muted/20 px-3 py-3",
        selected && "border-primary/35 bg-primary/5",
      )}
    >
      <div className="mt-0.5 h-9 w-9 rounded-md bg-muted/80 flex items-center justify-center shrink-0 overflow-hidden">
        <SourceFavicon source={source} iconClassName="h-4 w-4 text-muted-foreground" imageClassName="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium truncate" title={source.name}>
            {prettyName}
          </span>
          <Badge variant="outline" className="text-[9px] uppercase tracking-wide">
            {source.type}
          </Badge>
          <Badge variant="outline" className="text-[9px] uppercase tracking-wide">
            {ownerScopeBadge(source.scopeType)}
          </Badge>
          {!source.enabled && (
            <Badge
              variant="outline"
              className="text-[9px] uppercase tracking-wide text-terminal-red border-terminal-red/30"
            >
              disabled
            </Badge>
          )}
          {authBadge && (
            <Badge
              variant="outline"
              className="text-[9px] uppercase tracking-wide text-primary border-primary/30"
            >
              {authBadge}
            </Badge>
          )}
          {hasAuthConfigured && (
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] uppercase tracking-wide",
                hasAnyCredential
                  ? "text-terminal-green border-terminal-green/30"
                  : "text-terminal-amber border-terminal-amber/30",
              )}
            >
              {hasAnyCredential ? "connections ready" : "connection needed"}
            </Badge>
          )}
        </div>
        <span className="text-[11px] text-muted-foreground truncate block mt-0.5" title={sourceEndpointLabel(source)}>
          {compactEndpoint}
        </span>
        {showTypeSummary && <SourceQualitySummary quality={quality} qualityLoading={qualityLoading} />}
        {source.type === "openapi" && (
          <OpenApiQualityDetails quality={quality} qualityLoading={qualityLoading} />
        )}
      </div>
      <div className="flex items-center gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity shrink-0">
        {onFocusSource ? (
          <Button
            variant={selected ? "default" : "outline"}
            size="sm"
            className="h-7 text-[11px]"
            onClick={() => onFocusSource(source.name)}
          >
            {selected ? "Viewing" : "View tools"}
          </Button>
        ) : null}
        {sourceCanConfigure ? (
          <AddSourceDialog
            existingSourceNames={existingSourceNames}
            sourceToEdit={source}
            trigger={(
              <Button variant="outline" size="sm" className="h-7 text-[11px]">
                Edit API
              </Button>
            )}
          />
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-terminal-red"
          onClick={handleDelete}
          disabled={deleting}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
