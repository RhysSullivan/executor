import { startTransition, useEffect, type ReactNode } from "react";
import type {
  SourceInspectionToolDetail,
} from "../../index";

import {
  useSourceInspection,
  useSourceToolDetail,
} from "../../hooks/sources";
import { Badge } from "./badge";
import { LoadableBlock } from "./loadable";
import {
  SourceToolModelWorkbench,
} from "./source-tool-workbench";
import type { SourceToolExplorerSearch } from "./source-tool-explorer-search";

export const SourceToolExplorer = (props: {
  sourceId: string;
  title: string;
  kind: string;
  search: SourceToolExplorerSearch;
  selectedToolPath?: string | null;
  navigate?: (search: {
    tab: "model" | "discover";
    tool?: string;
    query?: string;
  }) => void | Promise<void>;
  actions?: ReactNode;
  summary?: ReactNode;
  renderDetail?: (detail: SourceInspectionToolDetail) => ReactNode;
}) => {
  const inspection = useSourceInspection(props.sourceId);
  const selectedToolPath = props.selectedToolPath ?? props.search.tool ?? null;
  const detail = useSourceToolDetail(
    props.sourceId,
    selectedToolPath,
  );
  const navigate = props.navigate;

  useEffect(() => {
    if (inspection.status !== "ready" || !navigate) {
      return;
    }

    const firstTool = inspection.data.tools[0]?.path;
    const nextToolPath = selectedToolPath ?? firstTool;
    if (!nextToolPath) {
      return;
    }

    if (props.search.tab !== "discover" && selectedToolPath) {
      return;
    }

    startTransition(() => {
      void navigate({
        tab: "model",
        tool: nextToolPath,
        query: "",
      });
    });
  }, [inspection, navigate, props.search.tab, selectedToolPath]);

  return (
    <LoadableBlock loadable={inspection} loading="Loading source...">
      {(loadedInspection) => {
        const selectedTool =
          loadedInspection.tools.find((candidate) => candidate.path === selectedToolPath)
          ?? loadedInspection.tools[0]
          ?? null;

        return (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur-sm">
              <div className="flex min-w-0 items-center gap-3">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {props.title}
                </h2>
                <Badge variant="outline">{props.kind}</Badge>
                <span className="hidden text-[11px] tabular-nums text-muted-foreground/50 sm:block">
                  {loadedInspection.toolCount} {loadedInspection.toolCount === 1 ? "tool" : "tools"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {props.actions}
              </div>
            </div>

            {props.summary && (
              <div className="shrink-0 border-b border-border bg-card/30 px-4 py-2">
                {props.summary}
              </div>
            )}

            <div className="flex min-h-0 flex-1 overflow-hidden">
              <SourceToolModelWorkbench
                bundle={loadedInspection}
                detail={detail}
                selectedToolPath={selectedTool?.path ?? null}
                onSelectTool={(nextToolPath) => {
                  if (!navigate) {
                    return;
                  }

                  startTransition(() => {
                    void navigate({
                      tab: "model",
                      tool: nextToolPath,
                      query: "",
                    });
                  });
                }}
                sourceId={props.sourceId}
                renderDetail={props.renderDetail}
              />
            </div>
          </div>
        );
      }}
    </LoadableBlock>
  );
};
