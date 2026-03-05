import type { WorkspaceId } from "@executor-v2/schema";

// ---------------------------------------------------------------------------
// Reactivity keys
//
// Queries subscribe to keys; mutations invalidate keys.
// Matching keys trigger auto-refetches.
//
// Workspace-scoped keys include the concrete workspace id so invalidation stays
// precise instead of refreshing unrelated workspace queries.
// ---------------------------------------------------------------------------

const workspaceScope = (workspaceId: WorkspaceId) => ({
  workspace: [workspaceId],
} as const);

export const sourcesKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  sources: ["list"],
} as const);

export const toolsKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  tools: ["list"],
} as const);

export const toolDetailKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  toolDetail: ["single"],
} as const);

export const approvalsKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  approvals: ["list"],
} as const);

export const policiesKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  policies: ["list"],
} as const);

export const credentialsKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  credentials: ["list"],
} as const);

export const storageKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  storage: ["list"],
} as const);

export const sourceMutationKeys = (workspaceId: WorkspaceId) => ({
  ...workspaceScope(workspaceId),
  sources: ["list"],
  tools: ["list"],
  toolDetail: ["single"],
} as const);

export const approvalsMutationKeys = approvalsKeys;
export const policiesMutationKeys = policiesKeys;
export const credentialsMutationKeys = credentialsKeys;
export const storageMutationKeys = storageKeys;

export const organizationsKeys = { organizations: ["list"] } as const;
export const workspacesKeys = { workspaces: ["list"] } as const;
