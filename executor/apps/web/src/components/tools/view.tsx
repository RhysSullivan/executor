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

// ── Optimistic source helpers ──

type OptimisticAdd = { kind: "add"; source: ToolSourceRecord; addedAt: number };
type OptimisticRemove = { kind: "remove"; sourceName: string; removedAt: number };
type OptimisticOp = OptimisticAdd | OptimisticRemove;

/** Merge server sources with pending optimistic operations. */
function applyOptimisticOps(
  serverSources: ToolSourceRecord[],
  ops: OptimisticOp[],
): ToolSourceRecord[] {
  const serverNames = new Set(serverSources.map((s) => s.name));
  let result = [...serverSources];

  for (const op of ops) {
    if (op.kind === "add" && !serverNames.has(op.source.name)) {
      result.push(op.source);
    }
    if (op.kind === "remove") {
      result = result.filter((s) => s.name !== op.sourceName);
    }
  }

  return result;
}

/** Remove ops that the server has already reflected. */
function pruneStaleOps(
  ops: OptimisticOp[],
  serverSources: ToolSourceRecord[],
): OptimisticOp[] {
  const serverNames = new Set(serverSources.map((s) => s.name));
  return ops.filter((op) => {
    if (op.kind === "add") {
      return !serverNames.has(op.source.name);
    }
    if (op.kind === "remove") {
      return serverNames.has(op.sourceName);
    }
    return false;
  });
}

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
  const serverSourceItems = useMemo<ToolSourceRecord[]>(
    () => sources ?? [],
    [sources],
  );
  const sourcesLoading = !!context && sources === undefined;

  // ── Optimistic source state ──
  const [rawOptimisticOps, setOptimisticOps] = useState<OptimisticOp[]>([]);

  // Prune stale ops: if the server already reflects an add/remove, drop it.
  // This is a pure derivation — no side effects, no refs.
  const optimisticOps = useMemo(
    () => pruneStaleOps(rawOptimisticOps, serverSourceItems),
    [rawOptimisticOps, serverSourceItems],
  );

  const sourceItems = useMemo(
    () => applyOptimisticOps(serverSourceItems, optimisticOps),
    [serverSourceItems, optimisticOps],
  );

  // Source names that are optimistically loading (just added, tools not fetched yet)
  const optimisticallyLoadingNames = useMemo(
    () => optimisticOps
      .filter((op): op is OptimisticAdd => op.kind === "add")
      .map((op) => op.source.name),
    [optimisticOps],
  );

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

  // Merge optimistic loading with real loading sources
  const mergedLoadingSources = useMemo(() => {
    const combined = [...loadingSources];
    for (const name of optimisticallyLoadingNames) {
      if (!combined.includes(name)) {
        combined.push(name);
      }
    }
    return combined;
  }, [loadingSources, optimisticallyLoadingNames]);

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

  const handleSourceAdded = useCallback((source: ToolSourceRecord) => {
    setOptimisticOps((ops) => [
      ...ops,
      { kind: "add", source, addedAt: Date.now() },
    ]);
    setSelectedSource(source.name);
  }, []);

  const handleSourceDeleted = useCallback((sourceName: string) => {
    setOptimisticOps((ops) => [
      ...ops,
      { kind: "remove", sourceName, removedAt: Date.now() },
    ]);
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
      <div className="flex h-full min-h-0 flex-col">
        <div className="space-y-1 mb-4">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-64" />
        </div>
        <Skeleton className="h-9 w-80 mb-4" />
        <div className="rounded-lg border border-border/50 p-4 flex-1">
          <div className="flex">
            {/* Sidebar skeleton */}
            <div className="w-52 shrink-0 border-r border-border/30 pr-3 space-y-2 hidden lg:block">
              <Skeleton className="h-3 w-16 mb-3" />
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-8 w-full rounded-md" />
              ))}
            </div>
            {/* Main content skeleton */}
            <div className="flex-1 pl-3 space-y-1">
              <Skeleton className="h-8 w-full rounded-md mb-2" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1.5">
                  <Skeleton className="h-4 w-4 rounded" />
                  <Skeleton className="h-3 w-3" />
                  <Skeleton className="h-3.5" style={{ width: `${100 + i * 25}px` }} />
                </div>
              ))}
            </div>
          </div>
        </div>
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
              <div className="min-h-0 flex-1">
                <ToolExplorer
                  tools={tools}
                  sources={sourceItems}
                  loadingSources={mergedLoadingSources}
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
                        onSourceAdded={handleSourceAdded}
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
