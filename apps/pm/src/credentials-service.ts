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
  type WorkspaceId,
} from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import {
  createSqlSourceStoreErrorMapper,
  resolveWorkspaceOrganizationId,
} from "./control-plane-row-helpers";
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

type CredentialRows = Pick<
  SqlControlPlanePersistence["rows"],
  | "workspaces"
  | "authConnections"
  | "sourceAuthBindings"
  | "authMaterials"
  | "oauthStates"
>;

const sourceStoreError = createSqlSourceStoreErrorMapper("credentials");

export const createPmCredentialsService = (
  rows: CredentialRows,
): ControlPlaneCredentialsServiceShape =>
  makeControlPlaneCredentialsService({
    listCredentialBindings: (workspaceId) =>
      Effect.gen(function* () {
        const [bindings, connections, workspaces] = yield* Effect.all([
          rows.sourceAuthBindings.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.bindings.list", error),
            ),
          ),
          rows.authConnections.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.connections.list", error),
            ),
          ),
          rows.workspaces.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.workspaces.list", error),
            ),
          ),
        ]);

        const organizationId = resolveWorkspaceOrganizationId(workspaces, workspaceId);

        const scopedBindings = bindings.filter(
          (binding) =>
            binding.workspaceId === workspaceId
            || (binding.workspaceId === null && binding.organizationId === organizationId),
        );

        const compatBindings: Array<SourceCredentialBinding> = [];

        for (const binding of scopedBindings) {
          const connection = connections.find(
            (candidate) => candidate.id === binding.connectionId,
          );

          if (!connection) {
            continue;
          }

          compatBindings.push(toCompatSourceCredentialBinding(binding, connection));
        }

        return sortCredentialBindings(compatBindings);
      }),

    upsertCredentialBinding: (input) =>
      Effect.gen(function* () {
        const [bindings, connections, materials, oauthStates, workspaces] = yield* Effect.all([
          rows.sourceAuthBindings.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.bindings.list", error),
            ),
          ),
          rows.authConnections.list().pipe(
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
          rows.workspaces.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.workspaces.list", error),
            ),
          ),
        ]);

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

        const existingBinding = requestedBindingId
          ? bindings.find((binding) => binding.id === requestedBindingId) ?? null
          : null;

        const organizationId = resolveWorkspaceOrganizationId(workspaces, input.workspaceId);

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

        const existingConnection = connections.find(
          (connection) => connection.id === requestedConnectionId,
        ) ?? null;

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

        yield* Effect.all([
          rows.authConnections.upsert(nextConnection),
          rows.sourceAuthBindings.upsert(nextBinding),
        ]).pipe(
          Effect.mapError((error) =>
            sourceStoreError.fromRowStore("credentials.upsert_rows", error),
          ),
        );

        if (nextConnection.strategy === "oauth2") {
          const existingOAuth = oauthStates.find(
            (state) => state.connectionId === requestedConnectionId,
          ) ?? null;
          const refreshConfig = buildOAuthRefreshConfigFromPayload(
            input.payload,
            parseOAuthRefreshConfig(existingOAuth?.refreshConfigJson ?? null),
          );

          const oauthState: OAuthState = {
            id:
              existingOAuth?.id
              ?? (`oauth_state_${crypto.randomUUID()}` as OAuthState["id"]),
            connectionId: requestedConnectionId,
            accessTokenCiphertext: input.payload.secretRef,
            refreshTokenCiphertext:
              input.payload.oauthRefreshToken !== undefined
                ? normalizeString(input.payload.oauthRefreshToken)
                : existingOAuth?.refreshTokenCiphertext ?? null,
            keyVersion: existingOAuth?.keyVersion ?? "local",
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
        } else {
          const existingMaterial = materials.find(
            (material) => material.connectionId === requestedConnectionId,
          ) ?? null;

          const material: AuthMaterial = {
            id:
              existingMaterial?.id
              ?? (`auth_material_${crypto.randomUUID()}` as AuthMaterial["id"]),
            connectionId: requestedConnectionId,
            ciphertext: input.payload.secretRef,
            keyVersion: existingMaterial?.keyVersion ?? "local",
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
        }

        return toCompatSourceCredentialBinding(nextBinding, nextConnection);
      }),

    removeCredentialBinding: (input) =>
      Effect.gen(function* () {
        const [bindings, workspaces] = yield* Effect.all([
          rows.sourceAuthBindings.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.bindings.list", error),
            ),
          ),
          rows.workspaces.list().pipe(
            Effect.mapError((error) =>
              sourceStoreError.fromRowStore("credentials.workspaces.list", error),
            ),
          ),
        ]);

        const organizationId = resolveWorkspaceOrganizationId(workspaces, input.workspaceId);
        const binding = bindings.find(
          (item) =>
            item.id === input.credentialBindingId
            && (
              item.workspaceId === input.workspaceId
              || (item.workspaceId === null && item.organizationId === organizationId)
            ),
        );

        if (!binding) {
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

        const hasRemainingBindings = bindings.some(
          (candidate) =>
            candidate.id !== binding.id && candidate.connectionId === binding.connectionId,
        );

        if (!hasRemainingBindings) {
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
