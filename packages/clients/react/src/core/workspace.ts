import type { LocalInstallation } from "@executor/platform-api";
import type { Source } from "@executor/platform-sdk/schema";
import * as React from "react";

import { getExecutorApiBaseUrl } from "./base-url";
import { localInstallationAtom } from "./api-atoms";
import { pendingLoadable, useLoadableAtom } from "./loadable";
import type { Loadable } from "./types";

const PLACEHOLDER_WORKSPACE_ID = "ws_placeholder" as Source["scopeId"];

export type WorkspaceContext = {
  installation: LocalInstallation;
  workspaceId: Source["scopeId"];
};

const useWorkspaceContext = (): Loadable<WorkspaceContext> => {
  const installation = useLoadableAtom(
    localInstallationAtom(getExecutorApiBaseUrl()),
  );

  return React.useMemo(() => {
    if (installation.status !== "ready") {
      return installation;
    }

    return {
      status: "ready",
      data: {
        installation: installation.data,
        workspaceId: installation.data.scopeId,
      },
    } satisfies Loadable<WorkspaceContext>;
  }, [installation]);
};

export const useWorkspaceRequestContext = () => {
  const workspace = useWorkspaceContext();
  const enabled = workspace.status === "ready";

  return React.useMemo(
    () => ({
      workspace,
      enabled,
      workspaceId: enabled
        ? workspace.data.workspaceId
        : PLACEHOLDER_WORKSPACE_ID,
    }),
    [enabled, workspace],
  );
};

export const useWorkspaceId = (): Source["scopeId"] => {
  const workspace = useWorkspaceRequestContext();
  if (!workspace.enabled) {
    throw new Error("Workspace is still loading.");
  }

  return workspace.workspaceId;
};

export { pendingLoadable };
