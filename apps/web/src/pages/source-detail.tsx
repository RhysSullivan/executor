import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  useAtomValue,
  useAtomSet,
  useAtomRefresh,
  sourceToolsAtom,
  sourcesAtom,
  sourceAtom,
  removeSource,
  refreshSource,
  Result,
  ScopeId,
} from "@executor/react";
import { ToolTree } from "../components/tool-tree";
import { ToolDetail, ToolDetailEmpty } from "../components/tool-detail";
import type { ToolSummary } from "../components/tool-tree";

const DEFAULT_SCOPE = ScopeId.make("default");

export function SourceDetailPage(props: { namespace: string }) {
  const { namespace } = props;
  const source = useAtomValue(sourceAtom(namespace));
  const tools = useAtomValue(sourceToolsAtom(namespace));
  const refreshSources = useAtomRefresh(sourcesAtom());
  const refreshTools = useAtomRefresh(sourceToolsAtom(namespace));
  const doRemove = useAtomSet(removeSource, { mode: "promise" });
  const doRefresh = useAtomSet(refreshSource, { mode: "promise" });
  const navigate = useNavigate();

  const [selectedToolId, setSelectedToolId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const sourceData = Result.isSuccess(source) ? source.value : null;

  const sourceTools: ToolSummary[] = useMemo(() => {
    if (!Result.isSuccess(tools)) return [];
    return tools.value.map((t) => ({
      id: t.id,
      name: t.name,
      pluginKey: t.pluginKey,
      description: t.description,
    }));
  }, [tools]);

  const selectedTool = useMemo(
    () => sourceTools.find((t) => t.id === selectedToolId) ?? null,
    [sourceTools, selectedToolId],
  );

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await doRemove({
        path: { scopeId: DEFAULT_SCOPE, sourceId: namespace },
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
        path: { scopeId: DEFAULT_SCOPE, sourceId: namespace },
      });
      refreshTools();
      refreshSources();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Header bar */}
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3">
          <h2 className="truncate text-sm font-semibold text-foreground">
            {sourceData?.name ?? namespace}
          </h2>
          <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-secondary-foreground">
            {sourceData?.kind ?? "source"}
          </span>
          {Result.isSuccess(tools) && (
            <span className="hidden text-[11px] tabular-nums text-muted-foreground/50 sm:block">
              {sourceTools.length} {sourceTools.length === 1 ? "tool" : "tools"}
            </span>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>

          {confirmDelete ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-medium text-destructive">
                Confirm?
              </span>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
                className="inline-flex items-center rounded-md border border-border bg-background px-2.5 py-1 text-[12px] font-medium text-foreground transition-colors hover:bg-accent disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="inline-flex items-center rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center rounded-md border border-destructive/30 bg-background px-2.5 py-1 text-[12px] font-medium text-destructive transition-colors hover:bg-destructive/10"
            >
              Delete
            </button>
          )}
        </div>
      </div>

      {/* Content — split pane */}
      {Result.match(tools, {
        onInitial: () => (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ),
        onFailure: () => (
          <div className="p-6 text-sm text-destructive">Failed to load tools</div>
        ),
        onSuccess: () => (
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* Left: tool tree */}
            <div className="flex w-72 shrink-0 flex-col border-r border-border bg-card/30 lg:w-80 xl:w-[22rem]">
              <ToolTree
                tools={sourceTools}
                selectedToolId={selectedToolId}
                onSelect={setSelectedToolId}
              />
            </div>

            {/* Right: tool detail */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
              {selectedTool ? (
                <ToolDetail
                  toolId={selectedTool.id}
                  toolName={selectedTool.name}
                  toolDescription={selectedTool.description}
                  scopeId={DEFAULT_SCOPE}
                />
              ) : (
                <ToolDetailEmpty hasTools={sourceTools.length > 0} />
              )}
            </div>
          </div>
        ),
      })}
    </div>
  );
}
