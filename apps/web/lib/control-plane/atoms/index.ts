// ---------------------------------------------------------------------------
// Barrel re-export for all atom modules.
//
// Components import from "../../lib/control-plane/atoms" which resolves here.
// Each domain is defined in its own file; this barrel preserves the existing
// import surface so no component changes are needed.
// ---------------------------------------------------------------------------

export { type EntityState } from "./entity";
export { type EntityState as SourcesState } from "./entity";
export { type EntityState as SourceToolsState } from "./entity";
export { type EntityState as ApprovalsState } from "./entity";
export { type EntityState as PoliciesState } from "./entity";
export { type EntityState as CredentialBindingsState } from "./entity";
export { type EntityState as StorageInstancesState } from "./entity";
export { type EntityState as OrganizationsState } from "./entity";
export { type EntityState as WorkspacesState } from "./entity";

export {
  sourcesResultByWorkspace,
  sourcesByWorkspace,
  sourcesPendingByWorkspace,
  optimisticSourcesByWorkspace,
  upsertSource,
  removeSource,
  optimisticUpsertSources,
  optimisticRemoveSources,
  toUpsertSourceRequest,
  toRemoveSourceRequest,
} from "./sources";

export {
  workspaceToolsResultByWorkspace,
  workspaceToolsByWorkspace,
  sourceToolsResultBySource,
  toolDetailResult,
} from "./tools";

export {
  type ApprovalItem,
  approvalsResultByWorkspace,
  approvalsByWorkspace,
  approvalPendingByWorkspace,
  resolveApproval,
  optimisticResolveApproval,
  toResolveApprovalRequest,
} from "./approvals";

export {
  policiesResultByWorkspace,
  policiesByWorkspace,
  upsertPolicy,
  removePolicy,
  optimisticUpsertPolicy,
  optimisticRemovePolicy,
  toPolicyUpsertPayload,
  toPolicyUpsertRequest,
  toPolicyRemoveRequest,
  toPolicyRemoveResult,
} from "./policies";

export {
  credentialBindingsResultByWorkspace,
  credentialBindingsByWorkspace,
  upsertCredentialBinding,
  removeCredentialBinding,
  toCredentialBindingUpsertPayload,
  toCredentialBindingUpsertRequest,
  toCredentialBindingRemoveRequest,
  toCredentialBindingRemoveResult,
} from "./credentials";

export {
  storageResultByWorkspace,
  storageByWorkspace,
  openStorageInstance,
  closeStorageInstance,
  removeStorageInstance,
  listStorageDirectory,
  readStorageFile,
  listStorageKv,
  queryStorageSql,
  toOpenStoragePayload,
  toOpenStorageRequest,
  toCloseStorageRequest,
  toRemoveStorageRequest,
  toStorageRemoveResult,
  toListStorageDirectoryPayload,
  toReadStorageFilePayload,
  toListStorageKvPayload,
  toQueryStorageSqlPayload,
} from "./storage";

// Storage result types re-exported for components that reference them directly.
export type {
  ListStorageDirectoryResult,
  ReadStorageFileResult,
  ListStorageKvResult,
  QueryStorageSqlResult,
} from "./storage";

// Identity passthrough functions that some components still import.
// These are no-ops but kept for backwards compatibility — remove when components
// are updated to use the result types directly.
export const toStorageDirectoryResult = <T>(result: T): T => result;
export const toStorageReadFileResult = <T>(result: T): T => result;
export const toStorageKvResult = <T>(result: T): T => result;
export const toStorageSqlResult = <T>(result: T): T => result;

export {
  organizationsResult,
  organizationsState,
  upsertOrganization,
  toOrganizationUpsertPayload,
  toUpsertOrganizationRequest,
  workspacesResult,
  workspacesState,
  upsertWorkspace,
  toWorkspaceUpsertPayload,
  toUpsertWorkspaceRequest,
} from "./settings";
