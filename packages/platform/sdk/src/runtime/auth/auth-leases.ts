import type {
  AuthArtifact,
  AuthLease,
  ProviderAuthGrant,
  RequestPlacementTemplate,
  SecretRef,
} from "#schema";
import {
  AuthLeaseIdSchema,
  decodeMcpOAuthAuthArtifactConfig,
  decodeProviderGrantRefAuthArtifactConfig,
  RefreshableOAuth2AuthorizedUserAuthArtifactKind,
  authLeaseSecretRefs,
  decodeBuiltInAuthArtifactConfig,
} from "#schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ExecutorStateStoreShape } from "../executor-state-store";
import { resolveAuthArtifactMaterial, type ResolvedSourceAuthMaterial } from "./auth-artifacts";
import {
  type DeleteSecretMaterial,
  type ResolveSecretMaterial,
  type SecretMaterialResolveContext,
  type StoreSecretMaterial,
} from "../workspace/secret-material-providers";
import { refreshOAuth2AccessToken } from "./oauth2-pkce";
import type { OAuth2TokenResponse } from "./oauth2-pkce";
import { createPersistedMcpAuthProvider } from "./mcp-auth-provider";
import { runtimeEffectError } from "../effect-errors";

const LEASE_REFRESH_SKEW_MS = 60_000;

const encodeLeasePlacementTemplatesJson = (templates: ReadonlyArray<RequestPlacementTemplate>): string =>
  JSON.stringify(templates);

const secretRefKey = (ref: SecretRef): string =>
  `${ref.providerId}:${ref.handle}`;

const cleanupAuthLeaseSecretRefs = (
  executorState: ExecutorStateStoreShape,
  input: {
    previous: Pick<AuthLease, "placementsTemplateJson"> | null;
    next: Pick<AuthLease, "placementsTemplateJson"> | null;
  },
  deleteSecretMaterial: DeleteSecretMaterial,
) =>
  Effect.gen(function* () {
    if (input.previous === null) {
      return;
    }
    const nextRefKeys = new Set(
      (input.next === null ? [] : authLeaseSecretRefs(input.next)).map(secretRefKey),
    );
    const refsToDelete = authLeaseSecretRefs(input.previous).filter(
      (ref) => !nextRefKeys.has(secretRefKey(ref)),
    );

    yield* Effect.forEach(
      refsToDelete,
      (ref) => Effect.either(deleteSecretMaterial(ref)),
      { discard: true },
    );
  });

const leaseIsFresh = (lease: AuthLease | null, now: number): boolean => {
  if (lease === null) {
    return false;
  }

  if (lease.refreshAfter !== null && now >= lease.refreshAfter) {
    return false;
  }

  if (lease.expiresAt !== null && now >= lease.expiresAt - LEASE_REFRESH_SKEW_MS) {
    return false;
  }

  return true;
};

const refreshRefreshableOauth2AuthorizedUserArtifact = (input: {
  executorState: ExecutorStateStoreShape;
  artifact: AuthArtifact;
  lease: AuthLease | null;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<AuthLease, Error, never> =>
  Effect.gen(function* () {
    const decoded = decodeBuiltInAuthArtifactConfig(input.artifact);
    if (
      decoded === null
      || decoded.artifactKind !== RefreshableOAuth2AuthorizedUserAuthArtifactKind
    ) {
      return yield* runtimeEffectError("auth/auth-leases", `Unsupported auth artifact kind: ${input.artifact.artifactKind}`);
    }

    const refreshToken = yield* input.resolveSecretMaterial({
      ref: decoded.config.refreshToken,
      context: input.context,
    });
    let clientSecret: string | null = null;
    if (decoded.config.clientSecret) {
      clientSecret = yield* input.resolveSecretMaterial({
        ref: decoded.config.clientSecret,
        context: input.context,
      });
    }

    const tokenResponse = yield* refreshOAuth2AccessToken({
      tokenEndpoint: decoded.config.tokenEndpoint,
      clientId: decoded.config.clientId,
      clientAuthentication: decoded.config.clientAuthentication,
      clientSecret,
      refreshToken,
    });

    const accessTokenRef = yield* input.storeSecretMaterial({
      purpose: "oauth_access_token",
      value: tokenResponse.access_token,
      name: `${decoded.config.clientId} Access Token`,
    });
    const now = Date.now();
    const expiresInMs =
      typeof tokenResponse.expires_in === "number" && Number.isFinite(tokenResponse.expires_in)
        ? Math.max(0, tokenResponse.expires_in * 1000)
        : null;
    const expiresAt = expiresInMs === null ? null : now + expiresInMs;
    const refreshAfter =
      expiresAt === null ? null : Math.max(now, expiresAt - LEASE_REFRESH_SKEW_MS);

    const nextLease: AuthLease = {
      id: input.lease?.id ?? AuthLeaseIdSchema.make(`auth_lease_${crypto.randomUUID()}`),
      authArtifactId: input.artifact.id,
      workspaceId: input.artifact.workspaceId,
      sourceId: input.artifact.sourceId,
      actorAccountId: input.artifact.actorAccountId,
      slot: input.artifact.slot,
      placementsTemplateJson: encodeLeasePlacementTemplatesJson([
        {
          location: "header",
          name: decoded.config.headerName,
          parts: [
            {
              kind: "literal",
              value: decoded.config.prefix,
            },
            {
              kind: "secret_ref",
              ref: accessTokenRef,
            },
          ],
        },
      ]),
      expiresAt,
      refreshAfter,
      createdAt: input.lease?.createdAt ?? now,
      updatedAt: now,
    };

    yield* input.executorState.authLeases.upsert(nextLease);
    yield* cleanupAuthLeaseSecretRefs(input.executorState, {
      previous: input.lease,
      next: nextLease,
    }, input.deleteSecretMaterial);

    return nextLease;
  });

const workspaceOauthClientSecretRef = (input: {
  clientSecretProviderId: string | null;
  clientSecretHandle: string | null;
}): SecretRef | null =>
  input.clientSecretProviderId && input.clientSecretHandle
    ? {
        providerId: input.clientSecretProviderId,
        handle: input.clientSecretHandle,
      }
    : null;

const cleanupProviderGrantRefreshToken = (executorState: ExecutorStateStoreShape, input: {
  previous: SecretRef;
  next: SecretRef;
}, deleteSecretMaterial: DeleteSecretMaterial) =>
  secretRefKey(input.previous) === secretRefKey(input.next)
    ? Effect.void
    : deleteSecretMaterial(input.previous).pipe(
        Effect.either,
        Effect.ignore,
      );

const refreshProviderGrantRefArtifact = (input: {
  executorState: ExecutorStateStoreShape;
  artifact: AuthArtifact;
  lease: AuthLease | null;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<AuthLease, Error, never> =>
  Effect.gen(function* () {
    const config = decodeProviderGrantRefAuthArtifactConfig(input.artifact);
    if (config === null) {
      return yield* runtimeEffectError("auth/auth-leases", `Unsupported auth artifact kind: ${input.artifact.artifactKind}`);
    }

    const grantOption = yield* input.executorState.providerAuthGrants.getById(config.grantId);
    if (Option.isNone(grantOption)) {
      return yield* runtimeEffectError("auth/auth-leases", `Provider auth grant not found: ${config.grantId}`);
    }
    const grant = grantOption.value;

    const oauthClientOption = yield* input.executorState.workspaceOauthClients.getById(grant.oauthClientId);
    if (Option.isNone(oauthClientOption)) {
      return yield* runtimeEffectError("auth/auth-leases", `Workspace OAuth client not found: ${grant.oauthClientId}`);
    }
    const oauthClient = oauthClientOption.value;

    const refreshToken = yield* input.resolveSecretMaterial({
      ref: grant.refreshToken,
      context: input.context,
    });
    const clientSecretRef = workspaceOauthClientSecretRef(oauthClient);
    const clientSecret = clientSecretRef
      ? yield* input.resolveSecretMaterial({
          ref: clientSecretRef,
          context: input.context,
        })
      : null;

    const tokenResponse = yield* refreshOAuth2AccessToken({
      tokenEndpoint: grant.tokenEndpoint,
      clientId: oauthClient.clientId,
      clientAuthentication: grant.clientAuthentication,
      clientSecret,
      refreshToken,
      scopes: config.requiredScopes.length > 0 ? config.requiredScopes : null,
    });

    const accessTokenRef = yield* input.storeSecretMaterial({
      purpose: "oauth_access_token",
      value: tokenResponse.access_token,
      name: `${grant.providerKey} Access Token`,
    });

    const rotatedRefreshTokenRef = tokenResponse.refresh_token
      ? yield* input.storeSecretMaterial({
          purpose: "oauth_refresh_token",
          value: tokenResponse.refresh_token,
          name: `${grant.providerKey} Refresh Token`,
        })
      : grant.refreshToken;

    const now = Date.now();
    const nextGrant: ProviderAuthGrant = {
      ...grant,
      refreshToken: rotatedRefreshTokenRef,
      lastRefreshedAt: now,
      updatedAt: now,
    };
    yield* input.executorState.providerAuthGrants.upsert(nextGrant);
    yield* cleanupProviderGrantRefreshToken(input.executorState, {
      previous: grant.refreshToken,
      next: rotatedRefreshTokenRef,
    }, input.deleteSecretMaterial);

    const expiresInMs =
      typeof tokenResponse.expires_in === "number" && Number.isFinite(tokenResponse.expires_in)
        ? Math.max(0, tokenResponse.expires_in * 1000)
        : null;
    const expiresAt = expiresInMs === null ? null : now + expiresInMs;
    const refreshAfter =
      expiresAt === null ? null : Math.max(now, expiresAt - LEASE_REFRESH_SKEW_MS);

    const nextLease: AuthLease = {
      id: input.lease?.id ?? AuthLeaseIdSchema.make(`auth_lease_${crypto.randomUUID()}`),
      authArtifactId: input.artifact.id,
      workspaceId: input.artifact.workspaceId,
      sourceId: input.artifact.sourceId,
      actorAccountId: input.artifact.actorAccountId,
      slot: input.artifact.slot,
      placementsTemplateJson: encodeLeasePlacementTemplatesJson([
        {
          location: "header",
          name: config.headerName,
          parts: [
            {
              kind: "literal",
              value: config.prefix,
            },
            {
              kind: "secret_ref",
              ref: accessTokenRef,
            },
          ],
        },
      ]),
      expiresAt,
      refreshAfter,
      createdAt: input.lease?.createdAt ?? now,
      updatedAt: now,
    };

    yield* input.executorState.authLeases.upsert(nextLease);
    yield* cleanupAuthLeaseSecretRefs(input.executorState, {
      previous: input.lease,
      next: nextLease,
    }, input.deleteSecretMaterial);

    return nextLease;
  });

export const removeAuthLeaseAndSecrets = (executorState: ExecutorStateStoreShape, input: {
  authArtifactId: AuthArtifact["id"];
}, deleteSecretMaterial: DeleteSecretMaterial): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const existingLease = yield* executorState.authLeases.getByAuthArtifactId(input.authArtifactId);
    if (Option.isNone(existingLease)) {
      return;
    }

    yield* executorState.authLeases.removeByAuthArtifactId(input.authArtifactId);
    yield* cleanupAuthLeaseSecretRefs(executorState, {
      previous: existingLease.value,
      next: null,
    }, deleteSecretMaterial);
  });

export const upsertOauth2AuthorizedUserLeaseFromTokenResponse = (input: {
  executorState: ExecutorStateStoreShape;
  artifact: AuthArtifact;
  tokenResponse: OAuth2TokenResponse;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
}): Effect.Effect<void, Error, never> =>
  Effect.gen(function* () {
    const decoded = decodeBuiltInAuthArtifactConfig(input.artifact);
    if (
      decoded === null
      || decoded.artifactKind !== RefreshableOAuth2AuthorizedUserAuthArtifactKind
    ) {
      return yield* runtimeEffectError("auth/auth-leases", `Unsupported auth artifact kind: ${input.artifact.artifactKind}`);
    }

    const existingLeaseOption = yield* input.executorState.authLeases.getByAuthArtifactId(input.artifact.id);
    const existingLease = Option.isSome(existingLeaseOption) ? existingLeaseOption.value : null;
    const accessTokenRef = yield* input.storeSecretMaterial({
      purpose: "oauth_access_token",
      value: input.tokenResponse.access_token,
      name: `${decoded.config.clientId} Access Token`,
    });
    const now = Date.now();
    const expiresInMs =
      typeof input.tokenResponse.expires_in === "number" && Number.isFinite(input.tokenResponse.expires_in)
        ? Math.max(0, input.tokenResponse.expires_in * 1000)
        : null;
    const expiresAt = expiresInMs === null ? null : now + expiresInMs;
    const refreshAfter =
      expiresAt === null ? null : Math.max(now, expiresAt - LEASE_REFRESH_SKEW_MS);

    const nextLease: AuthLease = {
      id: existingLease?.id ?? AuthLeaseIdSchema.make(`auth_lease_${crypto.randomUUID()}`),
      authArtifactId: input.artifact.id,
      workspaceId: input.artifact.workspaceId,
      sourceId: input.artifact.sourceId,
      actorAccountId: input.artifact.actorAccountId,
      slot: input.artifact.slot,
      placementsTemplateJson: encodeLeasePlacementTemplatesJson([
        {
          location: "header",
          name: decoded.config.headerName,
          parts: [
            {
              kind: "literal",
              value: decoded.config.prefix,
            },
            {
              kind: "secret_ref",
              ref: accessTokenRef,
            },
          ],
        },
      ]),
      expiresAt,
      refreshAfter,
      createdAt: existingLease?.createdAt ?? now,
      updatedAt: now,
    };

    yield* input.executorState.authLeases.upsert(nextLease);
    yield* cleanupAuthLeaseSecretRefs(input.executorState, {
      previous: existingLease,
      next: nextLease,
    }, input.deleteSecretMaterial);
  });

export const resolveAuthArtifactMaterialWithLeases = (input: {
  executorState: ExecutorStateStoreShape;
  artifact: AuthArtifact | null;
  resolveSecretMaterial: ResolveSecretMaterial;
  storeSecretMaterial: StoreSecretMaterial;
  deleteSecretMaterial: DeleteSecretMaterial;
  context?: SecretMaterialResolveContext;
}): Effect.Effect<ResolvedSourceAuthMaterial, Error, never> =>
  Effect.gen(function* () {
    if (input.artifact === null) {
      return yield* resolveAuthArtifactMaterial({
        artifact: null,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: input.context,
      });
    }

    const existingLeaseOption = yield* input.executorState.authLeases.getByAuthArtifactId(input.artifact.id);
    const existingLease = Option.isSome(existingLeaseOption) ? existingLeaseOption.value : null;
    const decoded = decodeBuiltInAuthArtifactConfig(input.artifact);
    const providerGrantConfig = decodeProviderGrantRefAuthArtifactConfig(input.artifact);
    const mcpOAuthConfig = decodeMcpOAuthAuthArtifactConfig(input.artifact);

    if (
      decoded !== null
      && decoded.artifactKind === RefreshableOAuth2AuthorizedUserAuthArtifactKind
    ) {
      const lease = leaseIsFresh(existingLease, Date.now())
        ? existingLease
        : yield* refreshRefreshableOauth2AuthorizedUserArtifact({
            executorState: input.executorState,
            artifact: input.artifact,
            lease: existingLease,
            resolveSecretMaterial: input.resolveSecretMaterial,
            storeSecretMaterial: input.storeSecretMaterial,
            deleteSecretMaterial: input.deleteSecretMaterial,
            context: input.context,
          });

      return yield* resolveAuthArtifactMaterial({
        artifact: input.artifact,
        lease,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: input.context,
      });
    }

    if (providerGrantConfig !== null) {
      const lease = leaseIsFresh(existingLease, Date.now())
        ? existingLease
        : yield* refreshProviderGrantRefArtifact({
            executorState: input.executorState,
            artifact: input.artifact,
            lease: existingLease,
            resolveSecretMaterial: input.resolveSecretMaterial,
            storeSecretMaterial: input.storeSecretMaterial,
            deleteSecretMaterial: input.deleteSecretMaterial,
            context: input.context,
          });

      return yield* resolveAuthArtifactMaterial({
        artifact: input.artifact,
        lease,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: input.context,
      });
    }

    if (mcpOAuthConfig !== null) {
      const material = yield* resolveAuthArtifactMaterial({
        artifact: input.artifact,
        resolveSecretMaterial: input.resolveSecretMaterial,
        context: input.context,
      });

      return {
        ...material,
        authProvider: createPersistedMcpAuthProvider({
          executorState: input.executorState,
          artifact: input.artifact,
          config: mcpOAuthConfig,
          resolveSecretMaterial: input.resolveSecretMaterial,
          storeSecretMaterial: input.storeSecretMaterial,
          deleteSecretMaterial: input.deleteSecretMaterial,
          context: input.context,
        }),
      };
    }

    return yield* resolveAuthArtifactMaterial({
      artifact: input.artifact,
      lease: existingLease,
      resolveSecretMaterial: input.resolveSecretMaterial,
      context: input.context,
    });
  });
