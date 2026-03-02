import {
  type AuthConnection,
  type AuthMaterial,
  type OAuthState,
  type SourceAuthBinding,
} from "@executor-v2/schema";

import { tableNames } from "./schema";
import { type SqlBackend } from "./sql-internals";
import {
  type RowOperations,
  toBooleanEffect,
  toListEffect,
  toVoidEffect,
} from "./rows-effect-helpers";

export const createAuthRowsEffectApi = (
  backend: SqlBackend,
  operations: RowOperations,
) => ({
  authConnections: {
    list: () =>
      toListEffect<AuthConnection>(
        backend,
        "rows.authConnections.list",
        tableNames.authConnections,
        operations.listAuthConnectionRows,
      ),
    upsert: (connection: AuthConnection) =>
      toVoidEffect(
        backend,
        "rows.authConnections.upsert",
        tableNames.authConnections,
        () => operations.upsertAuthConnectionRow(connection),
      ),
    removeById: (connectionId: AuthConnection["id"]) =>
      toBooleanEffect(
        backend,
        "rows.authConnections.remove",
        tableNames.authConnections,
        () => operations.removeAuthConnectionRowById(connectionId),
      ),
  },

  sourceAuthBindings: {
    list: () =>
      toListEffect<SourceAuthBinding>(
        backend,
        "rows.sourceAuthBindings.list",
        tableNames.sourceAuthBindings,
        operations.listSourceAuthBindingRows,
      ),
    upsert: (binding: SourceAuthBinding) =>
      toVoidEffect(
        backend,
        "rows.sourceAuthBindings.upsert",
        tableNames.sourceAuthBindings,
        () => operations.upsertSourceAuthBindingRow(binding),
      ),
    removeById: (bindingId: SourceAuthBinding["id"]) =>
      toBooleanEffect(
        backend,
        "rows.sourceAuthBindings.remove",
        tableNames.sourceAuthBindings,
        () => operations.removeSourceAuthBindingRowById(bindingId),
      ),
  },

  authMaterials: {
    list: () =>
      toListEffect<AuthMaterial>(
        backend,
        "rows.authMaterials.list",
        tableNames.authMaterials,
        operations.listAuthMaterialRows,
      ),
    upsert: (material: AuthMaterial) =>
      toVoidEffect(
        backend,
        "rows.authMaterials.upsert",
        tableNames.authMaterials,
        () => operations.upsertAuthMaterialRow(material),
      ),
    removeByConnectionId: (connectionId: AuthMaterial["connectionId"]) =>
      toVoidEffect(
        backend,
        "rows.authMaterials.remove_by_connection",
        tableNames.authMaterials,
        () => operations.removeAuthMaterialRowsByConnectionId(connectionId),
      ),
  },

  oauthStates: {
    list: () =>
      toListEffect<OAuthState>(
        backend,
        "rows.oauthStates.list",
        tableNames.oauthStates,
        operations.listOAuthStateRows,
      ),
    upsert: (state: OAuthState) =>
      toVoidEffect(
        backend,
        "rows.oauthStates.upsert",
        tableNames.oauthStates,
        () => operations.upsertOAuthStateRow(state),
      ),
    removeByConnectionId: (connectionId: OAuthState["connectionId"]) =>
      toVoidEffect(
        backend,
        "rows.oauthStates.remove_by_connection",
        tableNames.oauthStates,
        () => operations.removeOAuthStateRowsByConnectionId(connectionId),
      ),
  },
});
