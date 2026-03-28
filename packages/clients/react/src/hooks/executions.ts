import type {
  Execution,
  ExecutionEnvelope,
} from "@executor/platform-sdk/schema";

import {
  executionAtom,
  executionsAtom,
} from "../core/api-atoms";
import {
  disabledAtom,
  useLoadableAtom,
} from "../core/loadable";
import type {
  Loadable,
} from "../core/types";
import {
  pendingLoadable,
  useWorkspaceRequestContext,
} from "../core/workspace";

export const useExecutions = (): Loadable<ReadonlyArray<Execution>> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? executionsAtom(workspace.workspaceId)
    : disabledAtom<ReadonlyArray<Execution>>();
  const executions = useLoadableAtom(atom);

  return workspace.enabled
    ? executions
    : pendingLoadable(workspace.workspace);
};

export const useExecution = (
  executionId: string,
): Loadable<ExecutionEnvelope> => {
  const workspace = useWorkspaceRequestContext();
  const atom = workspace.enabled
    ? executionAtom(workspace.workspaceId, executionId as Execution["id"])
    : disabledAtom<ExecutionEnvelope>();
  const execution = useLoadableAtom(atom);

  return workspace.enabled
    ? execution
    : pendingLoadable(workspace.workspace);
};
