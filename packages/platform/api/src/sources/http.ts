import { HttpApiBuilder } from "@effect/platform";
import * as Effect from "effect/Effect";

import { ExecutorApi } from "../api";
import {
  resolveRequestedLocalWorkspace,
} from "../local-context";

export const ExecutorSourcesLive = HttpApiBuilder.group(
  ExecutorApi,
  "sources",
  (handlers) =>
    handlers
      .handle("list", ({ path }) =>
        resolveRequestedLocalWorkspace("sources.list", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.sources.list()),
        ),
      )
      .handle("get", ({ path }) =>
        resolveRequestedLocalWorkspace("sources.get", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.sources.get(path.sourceId)),
        ),
      )
      .handle("inspection", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "sources.inspection",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) => executor.sources.inspection.get(path.sourceId)),
        ),
      )
      .handle("inspectionTool", ({ path }) =>
        resolveRequestedLocalWorkspace(
          "sources.inspection_tool",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.sources.inspection.tool({
                sourceId: path.sourceId,
                toolPath: path.toolPath,
              }),
          ),
        ),
      )
      .handle("inspectionDiscover", ({ path, payload }) =>
        resolveRequestedLocalWorkspace(
          "sources.inspection_discover",
          path.workspaceId,
        ).pipe(
          Effect.flatMap((executor) =>
            executor.sources.inspection.discover({
                sourceId: path.sourceId,
                payload,
              }),
          ),
        ),
      )
      .handle("remove", ({ path }) =>
        resolveRequestedLocalWorkspace("sources.remove", path.workspaceId).pipe(
          Effect.flatMap((executor) => executor.sources.remove(path.sourceId)),
          Effect.map((removed) => ({ removed })),
        ),
      )
);
