import {
  CredentialResolverError,
  extractCredentialResolutionContext,
  makeCredentialResolver,
  sourceIdFromSourceKey,
  type ResolveToolCredentials,
} from "@executor-v2/engine";
import { type SqlControlPlanePersistence } from "@executor-v2/persistence-sql";
import { type OrganizationId, type WorkspaceId } from "@executor-v2/schema";
import * as Effect from "effect/Effect";

import { type SecretMaterialStore } from "./secret-material-store";

type CredentialResolverRows = {
  workspaces: Pick<SqlControlPlanePersistence["rows"]["workspaces"], "getById">;
  sourceAuthBindings: Pick<
    SqlControlPlanePersistence["rows"]["sourceAuthBindings"],
    "listByWorkspaceScope"
  >;
  authConnections: Pick<SqlControlPlanePersistence["rows"]["authConnections"], "getById">;
  authMaterials: Pick<SqlControlPlanePersistence["rows"]["authMaterials"], "getByConnectionId">;
  oauthStates: Pick<SqlControlPlanePersistence["rows"]["oauthStates"], "getByConnectionId">;
};

const toCredentialResolverError = (
  operation: string,
  message: string,
  details: string | null,
): CredentialResolverError =>
  new CredentialResolverError({
    operation,
    message,
    details,
  });

const normalizeString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
};

const toStringRecord = (value: Record<string, unknown>): Record<string, string> => {
  const normalized: Record<string, string> = {};

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeString(rawKey);
    const resolvedValue = normalizeString(rawValue);
    if (!key || !resolvedValue) {
      continue;
    }

    normalized[key] = resolvedValue;
  }

  return normalized;
};

const mergeHeaders = (...sets: ReadonlyArray<Record<string, string>>): Record<string, string> => {
  const merged: Record<string, string> = {};
  const keyByLower = new Map<string, string>();

  for (const set of sets) {
    for (const [rawKey, rawValue] of Object.entries(set)) {
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (key.length === 0 || value.length === 0) {
        continue;
      }

      const lower = key.toLowerCase();
      const existing = keyByLower.get(lower);
      if (existing && existing !== key) {
        delete merged[existing];
      }

      keyByLower.set(lower, key);
      merged[key] = value;
    }
  }

  return merged;
};

const base64Encode = (value: string): string =>
  Buffer.from(value, "utf8").toString("base64");

const buildSecretHeaders = (
  strategy: string,
  secret: string,
  metadataJson: string | null,
): Record<string, string> => {
  const trimmedSecret = secret.trim();
  if (trimmedSecret.length === 0) {
    return {};
  }

  const metadata = parseJsonObject(metadataJson);

  if (strategy === "api_key") {
    const headerName = normalizeString(metadata.apiKeyHeader) ?? "x-api-key";
    return {
      [headerName]: trimmedSecret,
    };
  }

  if (strategy === "bearer") {
    return {
      Authorization: `Bearer ${trimmedSecret}`,
    };
  }

  if (strategy === "basic") {
    const asJson = parseJsonObject(trimmedSecret);
    const username = normalizeString(asJson.username);
    const password = normalizeString(asJson.password);

    const pair = username && password
      ? `${username}:${password}`
      : trimmedSecret.includes(":")
        ? trimmedSecret
        : null;

    if (!pair) {
      return {};
    }

    return {
      Authorization: `Basic ${base64Encode(pair)}`,
    };
  }

  if (strategy === "custom") {
    const headerName = normalizeString(metadata.customHeaderName);
    if (!headerName) {
      return {};
    }

    return {
      [headerName]: trimmedSecret,
    };
  }

  return {};
};

export const createRuntimeHostResolveToolCredentials = (
  rows: CredentialResolverRows,
  secretMaterialStore: SecretMaterialStore,
): ResolveToolCredentials =>
  makeCredentialResolver((input) =>
    Effect.gen(function* () {
      const context = extractCredentialResolutionContext(input);
      if (context === null) {
        return {
          headers: {},
        };
      }

      const sourceId = sourceIdFromSourceKey(context.sourceKey);
      if (!sourceId) {
        return {
          headers: {},
        };
      }

      const workspaceId = context.workspaceId as WorkspaceId;

      const workspaceOption = yield* rows.workspaces.getById(workspaceId).pipe(
        Effect.mapError((error) =>
          toCredentialResolverError(
            "read_workspace",
            "Failed reading workspace while resolving credentials",
            error.details ?? error.message,
          ),
        ),
      );

      const workspace = workspaceOption._tag === "Some" ? workspaceOption.value : null;
      const organizationId = context.organizationId ?? workspace?.organizationId ?? null;
      if (organizationId === null) {
        return {
          headers: {},
        };
      }

      const bindings = yield* rows.sourceAuthBindings
        .listByWorkspaceScope(workspaceId, organizationId as OrganizationId)
        .pipe(
          Effect.mapError((error) =>
            toCredentialResolverError(
              "read_bindings",
              "Failed reading credential bindings",
              error.details ?? error.message,
            ),
          ),
        );

      const binding = bindings
        .filter((candidate) => candidate.sourceId === sourceId)
        .map((candidate) => {
          let score = -1;

          if (candidate.scopeType === "account") {
            if (context.accountId && candidate.accountId === context.accountId) {
              score = organizationId && candidate.organizationId === organizationId ? 30 : -1;
            }
          } else if (candidate.scopeType === "workspace") {
            score = candidate.workspaceId === context.workspaceId ? 20 : -1;
          } else if (candidate.scopeType === "organization") {
            score = organizationId && candidate.organizationId === organizationId ? 10 : -1;
          }

          return {
            candidate,
            score,
          };
        })
        .filter((entry) => entry.score >= 0)
        .sort((left, right) => {
          if (left.score !== right.score) {
            return right.score - left.score;
          }

          if (left.candidate.updatedAt !== right.candidate.updatedAt) {
            return right.candidate.updatedAt - left.candidate.updatedAt;
          }

          return right.candidate.createdAt - left.candidate.createdAt;
        })[0]?.candidate ?? null;

      if (binding === null) {
        return {
          headers: {},
        };
      }

      const connectionOption = yield* rows.authConnections.getById(binding.connectionId).pipe(
        Effect.mapError((error) =>
          toCredentialResolverError(
            "read_connection",
            "Failed reading auth connection",
            error.details ?? error.message,
          ),
        ),
      );

      const connection = connectionOption._tag === "Some"
        ? connectionOption.value
        : null;
      if (!connection || connection.status !== "active") {
        return {
          headers: {},
        };
      }

      const additionalHeaders = toStringRecord(
        parseJsonObject(connection.additionalHeadersJson),
      );

      if (connection.strategy === "oauth2") {
        const oauthStateOption = yield* rows.oauthStates
          .getByConnectionId(connection.id)
          .pipe(
            Effect.mapError((error) =>
              toCredentialResolverError(
                "read_oauth_state",
                "Failed reading oauth state",
                error.details ?? error.message,
              ),
            ),
          );
        const oauthState = oauthStateOption._tag === "Some" ? oauthStateOption.value : null;

        const accessToken = oauthState?.accessTokenHandle
          ? yield* secretMaterialStore
            .get({
              handle: oauthState.accessTokenHandle,
              scope: {
                organizationId: connection.organizationId,
                workspaceId: connection.workspaceId,
                accountId: connection.accountId,
                connectionId: connection.id,
                purpose: "oauth_access_token",
              },
            })
            .pipe(
              Effect.map(normalizeString),
              Effect.mapError((error) =>
                toCredentialResolverError(
                  "resolve_oauth_access_token",
                  error.message,
                  error.details,
                ),
              ),
            )
          : null;
        const oauthHeaders = accessToken
          ? ({ Authorization: `Bearer ${accessToken}` } as Record<string, string>)
          : {};

        return {
          headers: mergeHeaders(oauthHeaders, additionalHeaders),
        };
      }

      const materialOption = yield* rows.authMaterials
        .getByConnectionId(connection.id)
        .pipe(
          Effect.mapError((error) =>
            toCredentialResolverError(
              "read_auth_material",
              "Failed reading auth material",
              error.details ?? error.message,
            ),
          ),
        );
      const material = materialOption._tag === "Some" ? materialOption.value : null;

      if (!material) {
        return {
          headers: additionalHeaders,
        };
      }

      const secretValue = yield* secretMaterialStore
        .get({
          handle: material.materialHandle,
          scope: {
            organizationId: connection.organizationId,
            workspaceId: connection.workspaceId,
            accountId: connection.accountId,
            connectionId: connection.id,
            purpose: "auth_material",
          },
        })
        .pipe(
          Effect.mapError((error) =>
            toCredentialResolverError(
              "resolve_auth_material",
              error.message,
              error.details,
            ),
          ),
        );

      return {
        headers: mergeHeaders(
          buildSecretHeaders(
            connection.strategy,
            secretValue,
            connection.metadataJson,
          ),
          additionalHeaders,
        ),
      };
    }),
  );
