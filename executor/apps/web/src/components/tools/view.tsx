"use client";

import { useMemo, useState } from "react";
import {
  Globe,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { ToolExplorer } from "@/components/tools/explorer";
import { TaskComposer } from "@/components/tasks/task-composer";
import { AddSourceDialog, SourceCard } from "@/components/tools/sources";
import { CredentialsPanel } from "@/components/tools/credentials";
import { ConnectionFormDialog } from "@/components/tools/connection-form-dialog";
import { useSession } from "@/lib/session-context";
import { useWorkspaceTools } from "@/hooks/use-workspace-tools";
import { useQuery } from "convex/react";
import { convexApi } from "@/lib/convex-api";
import type {
  ToolSourceRecord,
  CredentialRecord,
} from "@/lib/types";
import {
  credentialStatsForSource,
  toolSourceLabelForSource,
} from "@/lib/tools-source-helpers";
import { sourceLabel } from "@/lib/tool-source-utils";
import { workspaceQueryArgs } from "@/lib/workspace-query-args";

type ToolsTab = "catalog" | "credentials" | "editor";

function parseInitialTab(tab?: string | null): ToolsTab {
  if (tab === "runner" || tab === "editor") {
    return "editor";
  }
  if (tab === "catalog" || tab === "credentials") {
    return tab;
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
  } = useWorkspaceTools(context ?? null, { includeDetails: false, includeDtsUrls: false });
  const toolSourceNames = useMemo(
    () => new Set(tools.map((tool) => sourceLabel(tool.source))),
    [tools],
  );
  const activeSource = selectedSource
    && (sourceItems.some((source) => source.name === selectedSource) || toolSourceNames.has(selectedSource))
    ? selectedSource
    : null;
  const selectedSourceRecord = activeSource
    ? sourceItems.find((source) => source.name === activeSource) ?? null
    : null;

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
    <div className="flex h-full min-h-0 flex-col gap-6">
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
          <TabsTrigger value="editor" className="text-xs data-[state=active]:bg-background">
            Editor
          </TabsTrigger>
        </TabsList>

        <TabsContent value="editor" className="mt-4">
          <TaskComposer />
        </TabsContent>

        <TabsContent value="catalog" className="mt-4 min-h-0">
          <Card className="bg-card border-border min-h-0 flex flex-col">
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Globe className="h-4 w-4 text-muted-foreground" />
                  Tools + Sources
                  <span className="text-[10px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                    {loadingTools ? "..." : tools.length}
                  </span>
                </CardTitle>
                <div className="flex items-center gap-2">
                  {activeSource ? (
                    <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setSelectedSource(null)}>
                      Clear source filter
                    </Button>
                  ) : null}
                  <AddSourceDialog
                    existingSourceNames={new Set(sourceItems.map((s) => s.name))}
                  />
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {activeSource
                  ? `Filtering and managing ${activeSource}.`
                  : "Source management and tool inventory are unified here."}
              </p>
            </CardHeader>
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

              {selectedSourceRecord ? (
                <div className="space-y-1.5">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Selected source</p>
                  <SourceCard
                    source={selectedSourceRecord}
                    quality={sourceQuality[toolSourceLabelForSource(selectedSourceRecord)]}
                    qualityLoading={selectedSourceRecord.type === "openapi" && !sourceQuality[toolSourceLabelForSource(selectedSourceRecord)] && refreshingTools}
                    credentialStats={credentialStatsForSource(selectedSourceRecord, credentialItems)}
                    existingSourceNames={new Set(sourceItems.map((s) => s.name))}
                    sourceAuthProfiles={sourceAuthProfiles}
                    selected
                    onFocusSource={setSelectedSource}
                  />
                </div>
              ) : null}

              <div className="min-h-0 flex-1">
                <ToolExplorer
                  tools={tools}
                  sources={sourceItems}
                  loadingSources={loadingSources}
                  loading={loadingTools}
                  onLoadToolDetails={loadToolDetails}
                  warnings={warnings}
                  initialSource={initialSource}
                  activeSource={activeSource}
                  onActiveSourceChange={setSelectedSource}
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
