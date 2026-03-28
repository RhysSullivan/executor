import {
  RegistryContext,
  useAtomSet,
} from "@effect-atom/atom-react";
import type {
  Source,
  SourceInspection,
  SourceInspectionDiscoverResult,
  SourceInspectionToolDetail,
} from "@executor/platform-sdk/schema";
import * as React from "react";

import {
  sourceAtom,
  sourceDiscoveryAtom,
  sourceInspectionAtom,
  sourceInspectionToolAtom,
  sourcesAtom,
} from "../core/api-atoms";
import { disabledAtom, useLoadableAtom } from "../core/loadable";
import {
  sourceDiscoveryReactivityKey,
  sourceInspectionReactivityKey,
  sourceInspectionToolReactivityKey,
  sourceReactivityKey,
  sourcesReactivityKey,
} from "../core/reactivity";
import type { Loadable, SourceRemoveResult } from "../core/types";
import { pendingLoadable, useWorkspaceRequestContext } from "../core/workspace";
import { getExecutorApiHttpClient } from "../core/http-client";
import { useExecutorMutation } from "./mutations";

export const useSources = (): Loadable<ReadonlyArray<Source>> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? sourcesAtom(workspace.workspaceId)
    : disabledAtom<ReadonlyArray<Source>>();
  const sources = useLoadableAtom(atom);

  return workspace.enabled ? sources : pendingLoadable(workspace.workspace);
};

export const useSource = (sourceId: string): Loadable<Source> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? sourceAtom(workspace.workspaceId, sourceId as Source["id"])
    : disabledAtom<Source>();
  const source = useLoadableAtom(atom);

  return workspace.enabled ? source : pendingLoadable(workspace.workspace);
};

export const useSourceInspection = (
  sourceId: string,
): Loadable<SourceInspection> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? sourceInspectionAtom(workspace.workspaceId, sourceId as Source["id"])
    : disabledAtom<SourceInspection>();
  const inspection = useLoadableAtom(atom);

  return workspace.enabled ? inspection : pendingLoadable(workspace.workspace);
};

export const useSourceToolDetail = (
  sourceId: string,
  toolPath: string | null,
): Loadable<SourceInspectionToolDetail | null> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? sourceInspectionToolAtom(
        workspace.workspaceId,
        sourceId as Source["id"],
        toolPath,
      )
    : disabledAtom<SourceInspectionToolDetail | null>();
  const detail = useLoadableAtom(atom);

  return workspace.enabled ? detail : pendingLoadable(workspace.workspace);
};

export const useSourceDiscovery = (input: {
  sourceId: string;
  query: string;
  limit?: number;
}): Loadable<SourceInspectionDiscoverResult> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? sourceDiscoveryAtom(
        workspace.workspaceId,
        input.sourceId as Source["id"],
        input.query,
        input.limit ?? null,
      )
    : disabledAtom<SourceInspectionDiscoverResult>();
  const results = useLoadableAtom(atom);

  return workspace.enabled ? results : pendingLoadable(workspace.workspace);
};

export const usePrefetchToolDetail = () => {
  const registry = React.useContext(RegistryContext);
  const workspace = useWorkspaceRequestContext();

  return React.useCallback(
    (sourceId: string, toolPath: string): (() => void) => {
      if (!workspace.enabled) {
        return () => {};
      }

      return registry.mount(
        sourceInspectionToolAtom(
          workspace.workspaceId,
          sourceId as Source["id"],
          toolPath,
        ),
      );
    },
    [registry, workspace.enabled, workspace.workspaceId],
  );
};

export const useRemoveSource = () => {
  const workspace = useWorkspaceRequestContext();
  const mutate = useAtomSet(
    getExecutorApiHttpClient().mutation("sources", "remove"),
    { mode: "promise" },
  );

  return useExecutorMutation<Source["id"], SourceRemoveResult>(
    React.useCallback(
      (sourceId) => {
        if (!workspace.enabled) {
          return Promise.reject(
            new Error("Executor workspace context is not ready"),
          );
        }

        return mutate({
          path: {
            workspaceId: workspace.workspaceId,
            sourceId,
          },
          reactivityKeys: {
            ...sourcesReactivityKey(workspace.workspaceId),
            ...sourceReactivityKey(workspace.workspaceId, sourceId),
            ...sourceInspectionReactivityKey(workspace.workspaceId, sourceId),
            ...sourceInspectionToolReactivityKey(workspace.workspaceId, sourceId),
            ...sourceDiscoveryReactivityKey(workspace.workspaceId, sourceId),
          },
        });
      },
      [mutate, workspace.enabled, workspace.workspaceId],
    ),
  );
};
