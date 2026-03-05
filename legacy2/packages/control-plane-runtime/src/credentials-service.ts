import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import {
  makeControlPlaneCredentialsService,
  type ControlPlaneCredentialsServiceShape,
} from "@executor-v2/management-api";
import {
  type AuthConnection,
  type AuthMaterial,
  type OAuthState,
  type SourceAuthBinding,
  type SourceCredentialBinding,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { createSqlSourceStoreErrorMapper } from "./control-plane-row-helpers";
import {
  buildOAuthRefreshConfigFromPayload,
  encodeOAuthRefreshConfig,
  normalizeString,
  parseOAuthRefreshConfig,
  sortCredentialBindings,
  sourceIdFromSourceKey,
  sourceKeyFromSourceId,
  strategyFromProvider,
  toCompatSourceCredentialBinding,
} from "./credentials-helpers";
import {
  type SecretMaterialScope,
  type SecretMaterialStore,
} from "./secret-material-store";

type CredentialRows = Pick<
  SqlControlPlanePersistence["rows"],
  | "workspaces"
  | "authConnections"
  | "sourceAuthBindings"
  | "authMaterials"
  | "oauthStates"
  | "secretMaterials"
>;

const sourceStoreError = createSqlSourceStoreErrorMapper("credentials");

const toSecretScope = (input: {
  organizationId: AuthConnection["organizationId"];
  workspaceId: AuthConnection["workspaceId"];
  accountId: AuthConnection["accountId"];
  connectionId: AuthConnection["id"];
  purpose: SecretMaterialScope["purpose"];
}): SecretMaterialScope => ({
  organizationId: input.organizationId,
  workspaceId: input.workspaceId,
  accountId: input.accountId,
  connectionId: input.connectionId,
  purpose: input.purpose,
});

const uniqueHandles = (handles: ReadonlyArray<string | null | undefined>): Array<string> => {
  const seen = new Set<string>();
  const next: Array<string> = [];

  for (const handle of handles) {
    const trimmed = handle?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    next.push(trimmed);
  }

  return next;
};

export const createRuntimeHostCredentialsService = (
  rows: CredentialRows,
  secretMaterialStore: SecretMaterialStore,
): ControlPlaneCredentialsServiceShape =>
  makeControlPlaneCredentialsService({
    listCredentialBindings: (workspaceId) =>
      Effect.gen(function* () {
        const workspaceOption = yield* rows.workspaces.getById(workspaceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("credentials.workspaces.get_by_id", error),
          ),
        );

        const workspace = Option.getOrNull(workspaceOption);
        if (workspace === null) {
          return yield* sourceStoreError.fromMessage(
            "credentials.list",
            "Workspace not found",
            `workspace=${workspaceId}`,
          );
        }

        const [bindings, connections, authMaterials, oauthStates] = yield* Effect.all([
          rows.sourceAuthBindings
            .listByWorkspaceScope(workspaceId, workspace.organizationId)
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromRowStore("credentials.bindings.list", error),
              ),
            ),
          rows.authConnections.listByOrganizationId(workspace.organizationId).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.connections.list", error),
            ),
          ),
          rows.authMaterials.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.materials.list", error),
            ),
          ),
          rows.oauthStates.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.oauth_states.list", error),
            ),
          ),
        ]);

        const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
        const authMaterialByConnectionId = new Set(
          authMaterials
            .filter((material) => material.materialHandle.trim().length > 0)
            .map((material) => material.connectionId),
        );
        const oauthStateByConnectionId = new Set(
          oauthStates
            .filter((oauthState) => oauthState.accessTokenHandle.trim().length > 0)
            .map((oauthState) => oauthState.connectionId),
        );

        const compatBindings: Array<SourceCredentialBinding> = [];

        for (const binding of bindings) {
          const connection = connectionById.get(binding.connectionId);

          if (!connection) {
            continue;
          }

          const hasSecret = connection.strategy === "oauth2"
            ? oauthStateByConnectionId.has(connection.id)
            : authMaterialByConnectionId.has(connection.id);

          compatBindings.push(toCompatSourceCredentialBinding(binding, connection, hasSecret));
        }

        return sortCredentialBindings(compatBindings);
      }),

    upsertCredentialBinding: (input) =>
      Effect.gen(function* () {
        const workspaceOption = yield* rows.workspaces.getById(input.workspaceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("credentials.workspaces.get_by_id", error),
          ),
        );

        const workspace = Option.getOrNull(workspaceOption);
        if (workspace === null) {
          return yield* sourceStoreError.fromMessage(
            "credentials.upsert",
            "Workspace not found",
            `workspace=${input.workspaceId}`,
          );
        }

        const organizationId = workspace.organizationId;

        if (input.payload.scopeType === "account" && input.payload.accountId === null) {
          return yield* sourceStoreError.fromMessage(
            "credentials.upsert",
            "Account scope credentials require accountId",
            `workspace=${input.workspaceId}`,
          );
        }

        const sourceId = sourceIdFromSourceKey(input.payload.sourceKey);
        if (!sourceId) {
          return yield* sourceStoreError.fromMessage(
            "credentials.upsert",
            "Credentials require sourceKey in the form 'source:<id>'",
            `workspace=${input.workspaceId}`,
          );
        }

        const now = Date.now();
        const requestedId = input.payload.id;
        const requestedBindingId = requestedId as SourceAuthBinding["id"] | undefined;

        const existingBindingOption = requestedBindingId
          ? yield* rows.sourceAuthBindings.getById(requestedBindingId).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.binding.get_by_id", error),
            ),
          )
          : Option.none<SourceAuthBinding>();

        const existingBinding = Option.getOrNull(existingBindingOption);
        if (
          existingBinding !== null
          && existingBinding.workspaceId !== input.workspaceId
          && (
            existingBinding.workspaceId !== null
            || existingBinding.organizationId !== organizationId
          )
        ) {
          return yield* sourceStoreError.fromMessage(
            "credentials.upsert",
            "Credential binding is outside workspace scope",
            `workspace=${input.workspaceId} binding=${requestedBindingId}`,
          );
        }

        const scopeWorkspaceId =
          input.payload.scopeType === "workspace" ? input.workspaceId : null;
        const scopeAccountId =
          input.payload.scopeType === "account" ? (input.payload.accountId ?? null) : null;

        const resolvedBindingId = (
          existingBinding?.id
          ?? requestedBindingId
          ?? (`auth_binding_${crypto.randomUUID()}` as SourceAuthBinding["id"])
        ) as SourceAuthBinding["id"];

        const requestedConnectionId = (
          normalizeString(input.payload.credentialId)
          ?? existingBinding?.connectionId
          ?? (`conn_${crypto.randomUUID()}` as AuthConnection["id"])
        ) as AuthConnection["id"];

        const existingConnectionOption = yield* rows.authConnections
          .getById(requestedConnectionId)
          .pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.connection.get_by_id", error),
            ),
          );

        const existingConnection = Option.getOrNull(existingConnectionOption);

        if (existingConnection && existingConnection.organizationId !== organizationId) {
          return yield* sourceStoreError.fromMessage(
            "credentials.upsert",
            "Connection id belongs to another organization",
            `workspace=${input.workspaceId}`,
          );
        }

        const nextConnection: AuthConnection = {
          id: requestedConnectionId,
          organizationId,
          workspaceId: scopeWorkspaceId,
          accountId: scopeAccountId,
          ownerType:
            input.payload.scopeType === "organization"
              ? "organization"
              : input.payload.scopeType === "account"
                ? "account"
                : "workspace",
          strategy: strategyFromProvider(input.payload.provider),
          displayName:
            normalizeString(existingConnection?.displayName)
            ?? sourceKeyFromSourceId(sourceId),
          status: "active",
          statusReason: null,
          lastAuthErrorClass: null,
          metadataJson: existingConnection?.metadataJson ?? null,
          additionalHeadersJson:
            input.payload.additionalHeadersJson !== undefined
              ? input.payload.additionalHeadersJson
              : existingConnection?.additionalHeadersJson ?? null,
          createdByAccountId: existingConnection?.createdByAccountId ?? null,
          createdAt: existingConnection?.createdAt ?? now,
          updatedAt: now,
          lastUsedAt: existingConnection?.lastUsedAt ?? null,
        };

        const nextBinding: SourceAuthBinding = {
          id: resolvedBindingId,
          sourceId: sourceId as SourceAuthBinding["sourceId"],
          connectionId: requestedConnectionId,
          organizationId,
          workspaceId: scopeWorkspaceId,
          accountId: scopeAccountId,
          scopeType: input.payload.scopeType,
          selector: existingBinding?.selector ?? null,
          enabled: true,
          createdAt: existingBinding?.createdAt ?? now,
          updatedAt: now,
        };

        const removeHandles = (handles: ReadonlyArray<string | null | undefined>) =>
          Effect.forEach(
            uniqueHandles(handles),
            (handle) =>
              secretMaterialStore
                .remove({
                  handle,
                  scope: toSecretScope({
                    organizationId,
                    workspaceId: scopeWorkspaceId,
                    accountId: scopeAccountId,
                    connectionId: requestedConnectionId,
                    purpose: "auth_material",
                  }),
                })
                .pipe(Effect.catchAll(() => Effect.void)),
            { discard: true },
          );

        yield* Effect.all([
          rows.authConnections.upsert(nextConnection),
          rows.sourceAuthBindings.upsert(nextBinding),
        ]).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("credentials.upsert_rows", error),
          ),
        );

        if (nextConnection.strategy === "oauth2") {
          const existingOAuthOption = yield* rows.oauthStates
            .getByConnectionId(requestedConnectionId)
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromRowStore("credentials.oauth_states.get_by_connection", error),
              ),
            );
          const existingOAuth = Option.getOrNull(existingOAuthOption);
          const existingMaterialOption = yield* rows.authMaterials
            .getByConnectionId(requestedConnectionId)
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromRowStore("credentials.materials.get_by_connection", error),
              ),
            );
          const existingMaterial = Option.getOrNull(existingMaterialOption);

          const refreshConfigBase = buildOAuthRefreshConfigFromPayload(
            input.payload,
            parseOAuthRefreshConfig(existingOAuth?.refreshConfigJson ?? null),
          );

          const accessTokenHandle = yield* secretMaterialStore
            .put({
              value: input.payload.secret,
              scope: toSecretScope({
                organizationId,
                workspaceId: scopeWorkspaceId,
                accountId: scopeAccountId,
                connectionId: requestedConnectionId,
                purpose: "oauth_access_token",
              }),
            })
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromMessage(
                  "credentials.upsert_oauth_access_token",
                  error.message,
                  error.details,
                ),
              ),
            );

          const refreshTokenHandle = input.payload.oauthRefreshToken !== undefined
            ? (normalizeString(input.payload.oauthRefreshToken)
              ? yield* secretMaterialStore
                .put({
                  value: normalizeString(input.payload.oauthRefreshToken)!,
                  scope: toSecretScope({
                    organizationId,
                    workspaceId: scopeWorkspaceId,
                    accountId: scopeAccountId,
                    connectionId: requestedConnectionId,
                    purpose: "oauth_refresh_token",
                  }),
                })
                .pipe(
                  Effect.mapError((error) =>
                    sourceStoreError.fromMessage(
                      "credentials.upsert_oauth_refresh_token",
                      error.message,
                      error.details,
                    ),
                  ),
                )
              : null)
            : existingOAuth?.refreshTokenHandle ?? null;

          const clientSecretHandle = input.payload.oauthClientSecret !== undefined
            ? (normalizeString(input.payload.oauthClientSecret)
              ? yield* secretMaterialStore
                .put({
                  value: normalizeString(input.payload.oauthClientSecret)!,
                  scope: toSecretScope({
                    organizationId,
                    workspaceId: scopeWorkspaceId,
                    accountId: scopeAccountId,
                    connectionId: requestedConnectionId,
                    purpose: "oauth_client_secret",
                  }),
                })
                .pipe(
                  Effect.mapError((error) =>
                    sourceStoreError.fromMessage(
                      "credentials.upsert_oauth_client_secret",
                      error.message,
                      error.details,
                    ),
                  ),
                )
              : null)
            : parseOAuthRefreshConfig(existingOAuth?.refreshConfigJson ?? null).clientSecretHandle
              ?? existingOAuth?.clientSecretHandle
              ?? null;

          const refreshConfig = {
            ...refreshConfigBase,
            clientSecretHandle: clientSecretHandle ?? undefined,
          };

          const oauthState: OAuthState = {
            id:
              existingOAuth?.id
              ?? (`oauth_state_${crypto.randomUUID()}` as OAuthState["id"]),
            connectionId: requestedConnectionId,
            backend: secretMaterialStore.kind,
            accessTokenHandle,
            refreshTokenHandle,
            clientSecretHandle,
            expiresAt:
              input.payload.oauthExpiresAt !== undefined
                ? input.payload.oauthExpiresAt
                : existingOAuth?.expiresAt ?? null,
            scope:
              input.payload.oauthScope !== undefined
                ? input.payload.oauthScope
                : existingOAuth?.scope ?? null,
            tokenType: existingOAuth?.tokenType ?? "Bearer",
            issuer:
              input.payload.oauthIssuer !== undefined
                ? input.payload.oauthIssuer
                : existingOAuth?.issuer ?? null,
            refreshConfigJson: encodeOAuthRefreshConfig(refreshConfig),
            tokenVersion: (existingOAuth?.tokenVersion ?? 0) + 1,
            leaseHolder: null,
            leaseExpiresAt: null,
            leaseFence: existingOAuth?.leaseFence ?? 0,
            lastRefreshAt: existingOAuth?.lastRefreshAt ?? null,
            lastRefreshErrorClass: null,
            lastRefreshError: null,
            reauthRequiredAt: null,
            createdAt: existingOAuth?.createdAt ?? now,
            updatedAt: now,
          };

          yield* Effect.all([
            rows.oauthStates.upsert(oauthState),
            rows.authMaterials.removeByConnectionId(requestedConnectionId),
          ]).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.upsert_oauth", error),
            ),
          );

          yield* removeHandles([
            existingMaterial?.materialHandle ?? null,
            existingOAuth?.accessTokenHandle,
            existingOAuth?.refreshTokenHandle,
            existingOAuth?.clientSecretHandle,
            parseOAuthRefreshConfig(existingOAuth?.refreshConfigJson ?? null).clientSecretHandle,
          ].filter((handle) =>
            handle !== accessTokenHandle
            && handle !== refreshTokenHandle
            && handle !== clientSecretHandle,
          ));
        } else {
          const existingMaterialOption = yield* rows.authMaterials
            .getByConnectionId(requestedConnectionId)
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromRowStore("credentials.materials.get_by_connection", error),
              ),
            );
          const existingMaterial = Option.getOrNull(existingMaterialOption);
          const existingOAuthOption = yield* rows.oauthStates
            .getByConnectionId(requestedConnectionId)
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromRowStore("credentials.oauth_states.get_by_connection", error),
              ),
            );
          const existingOAuth = Option.getOrNull(existingOAuthOption);

          const materialHandle = yield* secretMaterialStore
            .put({
              value: input.payload.secret,
              scope: toSecretScope({
                organizationId,
                workspaceId: scopeWorkspaceId,
                accountId: scopeAccountId,
                connectionId: requestedConnectionId,
                purpose: "auth_material",
              }),
            })
            .pipe(
              Effect.mapError((error) =>
                sourceStoreError.fromMessage(
                  "credentials.upsert_secret",
                  error.message,
                  error.details,
                ),
              ),
            );

          const material: AuthMaterial = {
            id:
              existingMaterial?.id
              ?? (`auth_material_${crypto.randomUUID()}` as AuthMaterial["id"]),
            connectionId: requestedConnectionId,
            backend: secretMaterialStore.kind,
            materialHandle,
            createdAt: existingMaterial?.createdAt ?? now,
            updatedAt: now,
          };

          yield* Effect.all([
            rows.authMaterials.upsert(material),
            rows.oauthStates.removeByConnectionId(requestedConnectionId),
          ]).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.upsert_secret", error),
            ),
          );

          yield* removeHandles([
            existingMaterial?.materialHandle,
            existingOAuth?.accessTokenHandle,
            existingOAuth?.refreshTokenHandle,
            existingOAuth?.clientSecretHandle,
            parseOAuthRefreshConfig(existingOAuth?.refreshConfigJson ?? null).clientSecretHandle,
          ].filter((handle) => handle !== materialHandle));
        }

        return toCompatSourceCredentialBinding(nextBinding, nextConnection, true);
      }),

    removeCredentialBinding: (input) =>
      Effect.gen(function* () {
        const workspaceOption = yield* rows.workspaces.getById(input.workspaceId).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("credentials.workspaces.get_by_id", error),
          ),
        );

        const workspace = Option.getOrNull(workspaceOption);
        if (workspace === null) {
          return {
            removed: false,
          };
        }

        const bindingOption = yield* rows.sourceAuthBindings
          .getById(input.credentialBindingId)
          .pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.binding.get_by_id", error),
            ),
          );

        const binding = Option.getOrNull(bindingOption);
        if (
          binding === null
          || (
            binding.workspaceId !== input.workspaceId
            && (binding.workspaceId !== null || binding.organizationId !== workspace.organizationId)
          )
        ) {
          return {
            removed: false,
          };
        }

        const removed = yield* rows.sourceAuthBindings
          .removeById(binding.id)
          .pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.remove_binding", error),
            ),
          );

        if (!removed) {
          return {
            removed: false,
          };
        }

        const remainingBindings = yield* rows.sourceAuthBindings
          .listByConnectionId(binding.connectionId)
          .pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.bindings.list_by_connection", error),
            ),
          );

        const hasRemainingBindings = remainingBindings.some((candidate) => candidate.id !== binding.id);

        if (!hasRemainingBindings) {
          const [materialOption, oauthOption] = yield* Effect.all([
            rows.authMaterials.getByConnectionId(binding.connectionId),
            rows.oauthStates.getByConnectionId(binding.connectionId),
          ]).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.get_connection_material", error),
            ),
          );

          const material = Option.getOrNull(materialOption);
          const oauthState = Option.getOrNull(oauthOption);

          const removeScope = toSecretScope({
            organizationId: binding.organizationId,
            workspaceId: binding.workspaceId,
            accountId: binding.accountId,
            connectionId: binding.connectionId,
            purpose: "auth_material",
          });

          yield* Effect.forEach(
            uniqueHandles([
              material?.materialHandle,
              oauthState?.accessTokenHandle,
              oauthState?.refreshTokenHandle,
              oauthState?.clientSecretHandle,
              parseOAuthRefreshConfig(oauthState?.refreshConfigJson ?? null).clientSecretHandle,
            ]),
            (handle) =>
              secretMaterialStore
                .remove({
                  handle,
                  scope: removeScope,
                })
                .pipe(Effect.catchAll(() => Effect.void)),
            { discard: true },
          );

          yield* Effect.all([
            rows.authConnections.removeById(binding.connectionId),
            rows.authMaterials.removeByConnectionId(binding.connectionId),
            rows.oauthStates.removeByConnectionId(binding.connectionId),
          ]).pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.remove_connection_data", error),
            ),
          );
        }

        return {
          removed: true,
        };
      }),
  });
