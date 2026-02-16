"use client";

import { useCallback, useMemo, useState } from "react";
import {
  Plus,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { ToolExplorer } from "@/components/tools/explorer";
import { TaskComposer } from "@/components/tasks/task-composer";
import { AddSourceDialog } from "@/components/tools/sources";
import { CredentialsPanel } from "@/components/tools/credentials";
import { ConnectionFormDialog } from "@/components/tools/connection/form-dialog";
import { PoliciesPanel } from "@/components/tools/policies";
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use/workspace-tools";
import { useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type {
  ToolSourceRecord,
  CredentialRecord,
} from "@/lib/types";
import {
  warningsBySourceName,
} from "@/lib/tools/source-helpers";
import { sourceLabel } from "@/lib/tool/source-utils";
import { workspaceQueryArgs } from "@/lib/workspace/query-args";
import type { SourceDialogMeta } from "@/components/tools/add/source-dialog";

type ToolsTab = "catalog" | "credentials" | "policies" | "editor";

function parseInitialTab(tab?: string | null): ToolsTab {
  if (tab === "runner" || tab === "editor") {
    return "editor";
  }
  if (tab === "catalog" || tab === "credentials") {
    return tab;
  }
  if (tab === "policies") {
    return "policies";
  }
  return "catalog";
}

// ── Tools View ──

export function ToolsView({
  initialSource,
  initialTab,
}: {
  initialSource?: string | null;
  initialTab?: string | null;
}) {
  const { context, loading: sessionLoading } = useSession();
  const [selectedSource, setSelectedSource] = useState<string | null>(initialSource ?? null);
  const [activeTab, setActiveTab] = useState<ToolsTab>(parseInitialTab(initialTab));
  const [connectionDialogOpen, setConnectionDialogOpen] = useState(false);
  const [connectionDialogEditing, setConnectionDialogEditing] = useState<CredentialRecord | null>(null);
  const [connectionDialogSourceKey, setConnectionDialogSourceKey] = useState<string | null>(null);

  const sources = useQuery(
    convexApi.workspace.listToolSources,
    workspaceQueryArgs(context),
  );
  const sourceItems: ToolSourceRecord[] = sources ?? [];
  const sourcesLoading = !!context && sources === undefined;

  const credentials = useQuery(
    convexApi.workspace.listCredentials,
    workspaceQueryArgs(context),
  );
  const credentialItems: CredentialRecord[] = credentials ?? [];
  const credentialsLoading = !!context && credentials === undefined;

  const {
    tools,
    warnings,
    sourceQuality,
    sourceAuthProfiles,
    loadingSources,
    loadingTools,
    refreshingTools,
    loadToolDetails,
  } = useWorkspaceTools(context ?? null, { includeDetails: false });
  const existingSourceNames = useMemo(() => new Set(sourceItems.map((source) => source.name)), [sourceItems]);
  const toolSourceNames = useMemo(
    () => new Set(tools.map((tool) => sourceLabel(tool.source))),
    [tools],
  );
  const warningsBySource = useMemo(() => warningsBySourceName(warnings), [warnings]);
  const sourceDialogMeta = useMemo(() => {
    const bySource: Record<string, SourceDialogMeta> = {};
    for (const source of sourceItems) {
      const label = `${source.type}:${source.name}`;
      bySource[source.name] = {
        quality: source.type === "openapi" ? sourceQuality[label] : undefined,
        qualityLoading: source.type === "openapi" && !sourceQuality[label] && refreshingTools,
        warnings: warningsBySource[source.name] ?? [],
      };
    }
    return bySource;
  }, [sourceItems, sourceQuality, refreshingTools, warningsBySource]);
  const activeSource = selectedSource
    && (sourceItems.some((source) => source.name === selectedSource) || toolSourceNames.has(selectedSource))
    ? selectedSource
    : null;

  const handleSourceDeleted = useCallback((sourceName: string) => {
    setSelectedSource((current) => (current === sourceName ? null : current));
  }, []);
  const openConnectionCreate = (sourceKey?: string) => {
    setConnectionDialogEditing(null);
    setConnectionDialogSourceKey(sourceKey ?? null);
    setConnectionDialogOpen(true);
  };

  const openConnectionEdit = (credential: CredentialRecord) => {
    setConnectionDialogEditing(credential);
    setConnectionDialogSourceKey(null);
    setConnectionDialogOpen(true);
  };

  const handleConnectionDialogOpenChange = (open: boolean) => {
    setConnectionDialogOpen(open);
    if (!open) {
      setConnectionDialogEditing(null);
      setConnectionDialogSourceKey(null);
    }
  };

  if (sessionLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Tools"
        description="Run tasks, manage sources, auth, connections, and available tools"
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setActiveTab(value as ToolsTab)}
        className="w-full min-h-0 flex-1"
      >
        <TabsList className="bg-muted/50 h-9">
          <TabsTrigger value="catalog" className="text-xs data-[state=active]:bg-background">
            Catalog
            <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
              {loadingTools ? "..." : tools.length}
            </span>
          </TabsTrigger>
          <TabsTrigger value="credentials" className="text-xs data-[state=active]:bg-background">
            Connections
            {credentials && (
              <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                {new Set(credentialItems.map((credential) => credential.id)).size}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="policies" className="text-xs data-[state=active]:bg-background">
            Policies
          </TabsTrigger>
          <TabsTrigger value="editor" className="text-xs data-[state=active]:bg-background">
            Editor
          </TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="mt-4">
          <TaskComposer />
        </TabsContent>

        <TabsContent value="catalog" className="mt-4 min-h-0">
          <Card className="bg-card border-border min-h-0 flex flex-col pt-4 gap-3">
            <CardContent className="pt-0 min-h-0 flex-1 flex flex-col gap-3">
              {sourcesLoading ? (
                <div className="space-y-2">
                  {Array.from({ length: 2 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : null}

              {!sourcesLoading && sourceItems.length === 0 ? (
                <div className="rounded-md border border-border/70 bg-muted/30 px-3 py-2.5">
                  <p className="text-[11px] text-muted-foreground">
                    No external sources yet. Add MCP, OpenAPI, or GraphQL to expand available tools.
                  </p>
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                <ToolExplorer
                  tools={tools}
                  sources={sourceItems}
                  loadingSources={loadingSources}
                  loading={loadingTools}
                  sourceDialogMeta={sourceDialogMeta}
                  sourceAuthProfiles={sourceAuthProfiles}
                  existingSourceNames={existingSourceNames}
                  onSourceDeleted={handleSourceDeleted}
                  onLoadToolDetails={loadToolDetails}
                  warnings={warnings}
                  initialSource={initialSource}
                  activeSource={activeSource}
                  onActiveSourceChange={setSelectedSource}
                  addSourceAction={
                    <AddSourceDialog
                        existingSourceNames={existingSourceNames}
                        trigger={
                          <Button
                            variant="default"
                            size="sm"
                            className="h-8 text-[11px]"
                          >
                            <Plus className="h-3.5 w-3.5 mr-1.5" />
                            Add Source
                          </Button>
                        }
                    />
                  }
                />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="credentials" className="mt-4">
          <CredentialsPanel
            sources={sourceItems}
            credentials={credentialItems}
            loading={credentialsLoading || sourcesLoading}
            onCreateConnection={openConnectionCreate}
            onEditConnection={openConnectionEdit}
          />
        </TabsContent>

        <TabsContent value="policies" className="mt-4">
          <PoliciesPanel />
        </TabsContent>

      </Tabs>

      <ConnectionFormDialog
        open={connectionDialogOpen}
        onOpenChange={handleConnectionDialogOpenChange}
        editing={connectionDialogEditing}
        initialSourceKey={connectionDialogSourceKey}
        sources={sourceItems}
        credentials={credentialItems}
        sourceAuthProfiles={sourceAuthProfiles}
        loadingSourceNames={loadingSources}
      />
    </div>
  );
}
