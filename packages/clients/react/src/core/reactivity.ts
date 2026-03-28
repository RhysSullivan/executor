import type { Execution, Source } from "@executor/platform-sdk/schema";

import type { ReactivityKeys } from "./types";

export const localInstallationReactivityKey = (): ReactivityKeys => ({
  localInstallation: [],
});

export const instanceConfigReactivityKey = (): ReactivityKeys => ({
  instanceConfig: [],
});

export const secretsReactivityKey = (): ReactivityKeys => ({
  secrets: [],
});

export const sourcesReactivityKey = (
  workspaceId: Source["scopeId"],
): ReactivityKeys => ({
  sources: [workspaceId],
});

export const executionsReactivityKey = (
  workspaceId: Execution["scopeId"],
): ReactivityKeys => ({
  executions: [workspaceId],
});

export const executionReactivityKey = (
  workspaceId: Execution["scopeId"],
  executionId: Execution["id"],
): ReactivityKeys => ({
  execution: [workspaceId, executionId],
});

export const sourceReactivityKey = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
): ReactivityKeys => ({
  source: [workspaceId, sourceId],
});

export const sourceInspectionReactivityKey = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
): ReactivityKeys => ({
  sourceInspection: [workspaceId, sourceId],
});

export const sourceInspectionToolReactivityKey = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
  toolPath?: string | null,
): ReactivityKeys => ({
  sourceInspectionTool:
    toolPath === undefined || toolPath === null
      ? [workspaceId, sourceId]
      : [workspaceId, sourceId, toolPath],
});

export const sourceDiscoveryReactivityKey = (
  workspaceId: Source["scopeId"],
  sourceId: Source["id"],
  query?: string,
  limit?: number | null,
): ReactivityKeys => ({
  sourceDiscovery:
    query === undefined
      ? [workspaceId, sourceId]
      : [workspaceId, sourceId, query, limit ?? null],
});
