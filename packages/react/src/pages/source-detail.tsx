import { Suspense, useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue, useAtomSet, useAtomRefresh, Result } from "@effect-atom/atom-react";
import type { ScopeId, ToolId } from "@executor/sdk";
import {
  sourceToolsAtom,
  sourcesAtom,
  sourceAtom,
  removeSource,
  refreshSource,
  toolSchemaAtom,
} from "../api/atoms";
import { SourceOperations, type OperationEntry } from "../plugins/source-operations";
import { RunOperationPanel } from "../plugins/run-operation";
import { OperationDetail } from "../components/operation-detail";
import { useScope } from "../hooks/use-scope";
import type { SourcePlugin } from "../plugins/source-plugin";
import { Button } from "../components/button";
import { Badge } from "../components/badge";
import { Skeleton } from "../components/skeleton";
import { FilterTabs } from "../components/filter-tabs";
import { SourceHeader } from "../components/source-header";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/dropdown-menu";
import { MoreHorizontal } from "lucide-react";

function ToolSchemaPanel({ scopeId, toolId }: { scopeId: ScopeId; toolId: ToolId }) {
  const contract = useAtomValue(toolSchemaAtom(scopeId, toolId));

  return Result.match(contract, {
    onInitial: () => (
      <div className="text-sm text-muted-foreground">Loading…</div>
    ),
    onFailure: () => (
      <div className="text-sm text-destructive">Failed to load schema</div>
    ),
    onSuccess: (v) => {
      const definitions = Object.entries(v.value.typeScriptDefinitions ?? {}).map(
        ([name, code]) => ({ name, code }),
      );
      return (
        <OperationDetail
          data={{
            inputSchema: v.value.inputSchema,
            outputSchema: v.value.outputSchema,
            inputTypeScript: v.value.inputTypeScript
              ? `type Input = ${v.value.inputTypeScript}`
              : null,
            outputTypeScript: v.value.outputTypeScript
              ? `type Output = ${v.value.outputTypeScript}`
              : null,
            definitions,
          }}
          runPanel={
            <RunOperationPanel
              toolId={toolId}
              inputSchema={v.value.inputSchema}
            />
          }
        />
      );
    },
  });
}

export function SourceDetailPage(props: {
  namespace: string;
  sourcePlugins?: readonly SourcePlugin[];
}) {
  const { namespace, sourcePlugins } = props;
  const scopeId = useScope();
  const source = useAtomValue(sourceAtom(namespace, scopeId));
  const tools = useAtomValue(sourceToolsAtom(namespace, scopeId));
  const refreshSources = useAtomRefresh(sourcesAtom(scopeId));
  const refreshTools = useAtomRefresh(sourceToolsAtom(namespace, scopeId));
  const doRemove = useAtomSet(removeSource, { mode: "promise" });
  const doRefresh = useAtomSet(refreshSource, { mode: "promise" });
  const navigate = useNavigate();

  // HMR: refresh source tools when the backend is hot-reloaded
  useEffect(() => {
    if (!import.meta.hot) return;
    const refresh = () => {
      refreshTools();
      refreshSources();
    };
    import.meta.hot.on("executor:backend-updated", refresh);
    return () => {
      import.meta.hot?.off("executor:backend-updated", refresh);
    };
  }, [refreshTools, refreshSources]);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<"settings" | "operations">("operations");

  const sourceData = Result.isSuccess(source) ? source.value : null;
  const canRefresh = sourceData ? (sourceData.canRefresh ?? true) : false;
  const canRemove = sourceData ? (sourceData.canRemove ?? true) : false;
  const canEdit = sourceData ? (sourceData.canEdit ?? false) : false;

  // Find the plugin edit component based on source kind
  const editPlugin = useMemo(() => {
    if (!sourceData || !sourcePlugins) return null;
    return sourcePlugins.find((p) => p.key === sourceData.kind) ?? null;
  }, [sourceData, sourcePlugins]);

  const toolCount = Result.isSuccess(tools) ? tools.value.length : 0;

  const operationEntries: OperationEntry[] = useMemo(() => {
    if (!Result.isSuccess(tools)) return [];
    return tools.value.map((t) => ({
      id: t.id,
      path: t.name,
      summary: t.description,
      renderDetail: () => (
        <ToolSchemaPanel scopeId={scopeId} toolId={t.id as ToolId} />
      ),
    }));
  }, [tools, scopeId]);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await doRemove({
        path: { scopeId, sourceId: namespace },
      });
      refreshSources();
      void navigate({ to: "/" });
    } catch {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await doRefresh({
        path: { scopeId, sourceId: namespace },
      });
      refreshTools();
      refreshSources();
    } finally {
      setRefreshing(false);
    }
  };

  const handleEditSave = () => {
    refreshSources();
    refreshTools();
  };

  const hasSettings = canEdit && editPlugin !== null;

  const hasActions = canRefresh || canRemove;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full max-w-4xl flex-col gap-6 px-6 py-8 pb-24">
          {/* Source header — favicon + name + url */}
          <div className="flex items-center gap-3">
            <SourceHeader
              url={sourceData?.url}
              title={sourceData?.name ?? namespace}
            />
            {sourceData?.runtime && (
              <Badge className="bg-muted text-muted-foreground">built-in</Badge>
            )}
          </div>

          {/* Tabs + actions */}
          <div className="flex items-center justify-between gap-2">
            {hasSettings ? (
              <FilterTabs
                tabs={[
                  { label: "Operations", value: "operations", count: toolCount },
                  { label: "Settings", value: "settings" },
                ]}
                value={activeTab}
                onChange={setActiveTab}
              />
            ) : (
              <div />
            )}

            {hasActions && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="size-8 rounded-full p-0"
                    aria-label="Source actions"
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canRefresh && (
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        void handleRefresh();
                      }}
                      disabled={refreshing}
                    >
                      {refreshing ? "Refreshing..." : "Refresh"}
                    </DropdownMenuItem>
                  )}
                  {canRefresh && canRemove && <DropdownMenuSeparator />}
                  {canRemove && (
                    <DropdownMenuItem
                      onSelect={(e) => {
                        e.preventDefault();
                        setConfirmDelete(true);
                      }}
                      disabled={deleting}
                      className="text-destructive focus:text-destructive"
                    >
                      Delete
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {confirmDelete && (
            <div className="flex items-center justify-end gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
              <span className="mr-auto text-xs font-medium text-destructive">
                Delete this source?
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => void handleDelete()}
                disabled={deleting}
              >
                {deleting ? "Deleting..." : "Delete"}
              </Button>
            </div>
          )}

          {sourceData?.runtime && (
            <div className="rounded-lg border border-border/50 bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
              <p className="mb-1 font-medium text-foreground">
                Built-in Executor functions
              </p>
              <p>
                These operations are provided by Executor itself rather than an
                external source. Agents (and you) can run them to manage the
                catalog — previewing specs, adding new sources, and performing
                plugin actions. Select an operation below to see its schema and
                try it out.
              </p>
            </div>
          )}

          {hasSettings && activeTab === "settings" && editPlugin ? (
            <Suspense fallback={<EditFormSkeleton />}>
              <editPlugin.edit sourceId={namespace} onSave={handleEditSave} />
            </Suspense>
          ) : (
            Result.match(tools, {
              onInitial: () => <ListSkeleton />,
              onFailure: () => (
                <div className="text-sm text-destructive">Failed to load tools</div>
              ),
              onSuccess: () => <SourceOperations operations={operationEntries} />,
            })
          )}
        </div>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border/50 p-2">
      <Skeleton className="mb-1 h-8 w-full rounded-md" />
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-2 py-2.5">
          <Skeleton className="size-3.5 shrink-0 rounded" />
          <Skeleton
            className="h-3.5"
            style={{ width: `${40 + ((i * 13) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

function EditFormSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-9 w-full rounded-md" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-24 w-full rounded-md" />
      </div>
      <div className="flex justify-end gap-2 pt-2">
        <Skeleton className="h-9 w-20 rounded-md" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
    </div>
  );
}
